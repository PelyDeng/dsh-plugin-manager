import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccessError, actorKey, type Actor } from '@dsh-plugin-manager/plugin-kit'
import type { CrewId, ParticipantArtifact, ParticipantStatus } from './protocol.ts'

export type MissionState = 'running' | 'stopping' | 'completed' | 'partial' | 'waiting' | 'cancelled' | 'failed' | 'interrupted'
export type Speaker = 'jack' | CrewId | 'user' | 'system'
export type SceneStage = 'thinking' | 'commanding' | 'working' | 'returning' | 'aggregating' | 'waiting' | 'failed' | 'cancelled'
export interface Mission {
  id: string
  title: string
  state: MissionState
  updatedAt: number
  sessionId: string
  sessionReady: number
  runId: string | null
}
export interface MissionEvent {
  seq: number
  time: number
  type: 'message' | 'status' | 'artifact' | 'topic'
  role: Speaker
  text: string
  artifact?: ParticipantArtifact
  stage?: SceneStage
}
export interface CrewSession { role: CrewId; conversationId: string }

/** 仅保存入口交付记录与业务会话引用，业务数据和模型日志仍属于原插件及宿主。 */
export class MissionStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version
    if (version !== 0 && version !== 1 && version !== 2) { this.db.close(); throw new Error('不支持的海盗协作历史版本') }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS missions(
        id TEXT PRIMARY KEY,owner TEXT NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,sessionId TEXT NOT NULL,runId TEXT,sessionReady INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS missions_owner ON missions(owner,updatedAt DESC,id);
      CREATE TABLE IF NOT EXISTS events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,missionId TEXT NOT NULL REFERENCES missions(id),
        time INTEGER NOT NULL,type TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,artifact TEXT);
      CREATE INDEX IF NOT EXISTS events_mission ON events(missionId,seq);
      CREATE TABLE IF NOT EXISTS crew_sessions(
        missionId TEXT NOT NULL REFERENCES missions(id),role TEXT NOT NULL,conversationId TEXT NOT NULL,
        PRIMARY KEY(missionId,role));
      CREATE TABLE IF NOT EXISTS submissions(owner TEXT NOT NULL,requestId TEXT NOT NULL,
        signature TEXT NOT NULL,missionId TEXT NOT NULL REFERENCES missions(id),PRIMARY KEY(owner,requestId));
      CREATE TABLE IF NOT EXISTS crew_outcomes(missionId TEXT NOT NULL REFERENCES missions(id),
        role TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(missionId,role));
      `)
    if (version !== 2) this.db.exec('ALTER TABLE events ADD COLUMN stage TEXT; PRAGMA user_version=2;')
    // 官方 profile 中每个插件实例持有自己的历史库；崩溃后的任务不得自动重做。
    this.db.exec(`BEGIN IMMEDIATE;
      INSERT INTO events(missionId,time,type,role,text)
        SELECT id,unixepoch()*1000,'status','system','宿主重启，上次协作已中断；查看记录不会重新执行。'
        FROM missions WHERE state IN ('running','stopping');
      UPDATE missions SET state='interrupted',runId=NULL WHERE state IN ('running','stopping');
      COMMIT;`)
  }

  get(actor: Actor, id: string): Mission {
    const row = this.db.prepare('SELECT id,title,state,updatedAt,sessionId,runId,sessionReady FROM missions WHERE id=? AND owner=?').get(id, actorKey(actor))
    if (!row) throw new AccessError(404, '协作不存在或无权访问')
    return row as unknown as Mission
  }
  list(actor: Actor, offset = 0): Mission[] {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AccessError(400, '分页无效')
    return this.db.prepare('SELECT id,title,state,updatedAt,sessionId,runId,sessionReady FROM missions WHERE owner=? ORDER BY updatedAt DESC,id LIMIT 30 OFFSET ?').all(actorKey(actor), offset) as unknown as Mission[]
  }
  submitted(actor: Actor, requestId: string, signature: string): Mission | undefined {
    const row = this.db.prepare('SELECT signature,missionId FROM submissions WHERE owner=? AND requestId=?').get(actorKey(actor), requestId)
    if (!row) return
    if (row.signature !== signature) throw new AccessError(409, '请求标识已用于另一条指令')
    return this.get(actor, String(row.missionId))
  }
  begin(actor: Actor, message: string, id?: string, submission?: { requestId: string; signature: string }): Mission {
    const runId = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (id) {
        const existing = this.get(actor, id)
        if (existing.runId !== null) throw new AccessError(409, '这轮协作仍在执行或停止中')
        this.db.prepare("UPDATE missions SET state='running',runId=?,updatedAt=? WHERE id=? AND owner=?").run(runId, Date.now(), id, actorKey(actor))
      } else {
        id = 'pirate-' + randomUUID()
        this.db.prepare("INSERT INTO missions(id,owner,title,state,updatedAt,sessionId,runId) VALUES(?,?,?,'running',?,?,?)").run(id, actorKey(actor), message.slice(0, 80), Date.now(), id, runId)
      }
      if (submission) this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?)').run(actorKey(actor), submission.requestId, submission.signature, id)
      this.add(actor, id, { type: 'message', role: 'user', text: message }, runId)
      this.db.exec('COMMIT')
      return this.get(actor, id)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  sessionReady(actor: Actor, id: string, runId: string): void {
    if (this.get(actor, id).runId === runId) this.db.prepare('UPDATE missions SET sessionReady=1 WHERE id=?').run(id)
  }
  supplement(actor: Actor, id: string, runId: string, message: string, submission?: { requestId: string; signature: string }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.get(actor, id)
      if (current.runId !== runId || current.state !== 'running') throw new AccessError(409, '正在停止或本轮已结束，请稍后发送')
      if (submission) this.db.prepare('INSERT INTO submissions VALUES(?,?,?,?)').run(actorKey(actor), submission.requestId, submission.signature, id)
      this.add(actor, id, { type: 'message', role: 'user', text: message }, runId)
      this.add(actor, id, { type: 'status', role: 'jack', text: '已接收补充；将在当前处理步骤结束后纳入协调。' }, runId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  outcome(actor: Actor, id: string, runId: string, role: CrewId, status: ParticipantStatus): void {
    if (this.get(actor, id).runId !== runId) return
    this.db.prepare('INSERT INTO crew_outcomes VALUES(?,?,?) ON CONFLICT(missionId,role) DO UPDATE SET status=excluded.status').run(id, role, status)
  }
  outcomes(actor: Actor, id: string): { role: CrewId; status: ParticipantStatus }[] {
    this.get(actor, id)
    return this.db.prepare('SELECT role,status FROM crew_outcomes WHERE missionId=? ORDER BY role').all(id) as { role: CrewId; status: ParticipantStatus }[]
  }
  events(actor: Actor, id: string, after = 0): MissionEvent[] {
    this.get(actor, id)
    if (!Number.isSafeInteger(after) || after < 0) throw new AccessError(400, '记录游标无效')
    return this.db.prepare('SELECT seq,time,type,role,text,artifact,stage FROM events WHERE missionId=? AND seq>? ORDER BY seq LIMIT 200').all(id, after).map(row => ({
      seq: Number(row.seq), time: Number(row.time), type: row.type as MissionEvent['type'], role: row.role as Speaker,
      text: String(row.text), ...(row.artifact ? { artifact: JSON.parse(String(row.artifact)) as ParticipantArtifact } : {}),
      ...(row.stage ? { stage: row.stage as SceneStage } : {}),
    }))
  }
  /** runId 拦住旧任务晚到的回调，不能污染后续协作。 */
  add(actor: Actor, id: string, event: Omit<MissionEvent, 'seq' | 'time'>, runId: string): boolean {
    if (this.get(actor, id).runId !== runId) return false
    if (event.text.length > 64000) throw new AccessError(413, '协作消息过长')
    this.db.prepare('INSERT INTO events(missionId,time,type,role,text,artifact,stage) VALUES(?,?,?,?,?,?,?)').run(
      id, Date.now(), event.type, event.role, event.text, event.artifact ? JSON.stringify(event.artifact) : null, event.stage ?? null)
    this.db.prepare('UPDATE missions SET updatedAt=? WHERE id=?').run(Date.now(), id)
    return true
  }
  crew(actor: Actor, id: string): CrewSession[] {
    this.get(actor, id)
    return this.db.prepare("SELECT role,conversationId FROM crew_sessions WHERE missionId=? AND conversationId!='' ORDER BY role").all(id) as unknown as CrewSession[]
  }
  usedCrew(actor: Actor, id: string): CrewId[] {
    this.get(actor, id)
    return this.db.prepare('SELECT role FROM crew_sessions WHERE missionId=? ORDER BY role').all(id).map(row => row.role as CrewId)
  }
  reserveCrew(actor: Actor, id: string, runId: string, role: CrewId): void {
    if (this.get(actor, id).runId !== runId) throw new AccessError(409, '本轮协作已结束')
    // 即使业务创建失败、尚未交回会话 ID，已经返回的正文也必须受原插件权限约束。
    this.db.prepare("INSERT INTO crew_sessions VALUES(?,?,'') ON CONFLICT(missionId,role) DO NOTHING").run(id, role)
  }
  link(actor: Actor, id: string, runId: string, role: CrewId, conversationId: string): boolean {
    if (this.get(actor, id).runId !== runId) return false
    if (!conversationId || conversationId.length > 160) throw new Error('业务会话标识无效')
    this.db.prepare('INSERT INTO crew_sessions VALUES(?,?,?) ON CONFLICT(missionId,role) DO UPDATE SET conversationId=excluded.conversationId').run(id, role, conversationId)
    return true
  }
  stopping(actor: Actor, id: string): Mission {
    const mission = this.get(actor, id)
    if (mission.runId) this.db.prepare("UPDATE missions SET state='stopping',updatedAt=? WHERE id=?").run(Date.now(), id)
    return this.get(actor, id)
  }
  finish(actor: Actor, id: string, runId: string, state: Exclude<MissionState, 'running' | 'stopping'>): boolean {
    if (this.get(actor, id).runId !== runId) return false
    this.db.prepare('UPDATE missions SET state=?,runId=NULL,updatedAt=? WHERE id=? AND runId=?').run(state, Date.now(), id, runId)
    return true
  }
  close(): void { this.db.close() }
}
