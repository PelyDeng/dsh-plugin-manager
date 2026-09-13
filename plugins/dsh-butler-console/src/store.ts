/**
 * 牛马大总管工作台的持久化索引。
 *
 * 这里只保存牛马大总管自己的工作台数据：会话归属、任务计划、子任务状态和运行历史。
 * 牛马大总管与用户的对话正文仍然存放在 DSH 官方会话日志里，本文件不复制一份，也不改写
 * 宿主日志。
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { AccessError, type Actor, type AgentArtifact } from '@dsh-plugin-manager/plugin-kit'
import { isTerminal, type SubtaskState, type TaskState } from './task-model.ts'

/**
 * 工作台索引的数据结构版本。
 *
 * 2：子任务增加 `artifacts`（材料引用）与 `conversation_id`（原会话）。
 * 3：新增 `requests` 表，把写请求的幂等占用**在执行前**落库。
 *
 * 升级只增列、增表，不动已有数据；但**旧代码读到新版本会拒绝启动**，所以回滚插件版本之前
 * 要先把库降回去，不能直接换回旧包。
 */
const SCHEMA_VERSION = 3

/**
 * 能从这些旧版本就地升上来。
 *
 * 不在这张表里的版本（比当前新、或者来历不明）一律拒绝启动：拿错版本的结构去读写，
 * 比起不来严重得多。
 */
const MIGRATABLE_VERSIONS: readonly number[] = [1, 2]

/** 侧栏里的一条会话。 */
export interface ConversationSummary {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly taskCount: number
}

/** 历史列表里的一条任务。 */
export interface TaskSummary {
  readonly id: string
  readonly conversationId: string
  readonly goal: string
  readonly state: TaskState
  readonly createdAt: number
  readonly updatedAt: number
  readonly subtaskTotal: number
  readonly subtaskDone: number
}

/** 一条完整的任务记录，含全部子任务。 */
export interface TaskRecord {
  readonly id: string
  readonly conversationId: string
  readonly goal: string
  readonly state: TaskState
  readonly note: string
  readonly summary: string
  readonly error: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly finishedAt: number | null
  readonly subtasks: readonly SubtaskRecord[]
}

/** 一条子任务记录。 */
export interface SubtaskRecord {
  readonly id: string
  readonly seq: number
  readonly goal: string
  readonly agentId: string
  readonly reason: string
  readonly state: SubtaskState
  readonly result: string
  readonly error: string
  /** 员工交回的材料引用；没有可点开的位置时为空数组。 */
  readonly artifacts: readonly AgentArtifact[]
  /** 员工在别处用的会话标识，便于用户回到原页面继续；没拿到时为空字符串。 */
  readonly conversationId: string
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

/** 状态计数，供右栏指标卡使用。 */
export interface TaskCounts {
  readonly running: number
  readonly waitingUser: number
  /** 材料已交回、还有事在别处等着办。与「等人回话」分开计数：等的东西不一样。 */
  readonly externalPending: number
  readonly failed: number
  readonly completed: number
  readonly queued: number
}

/** 一条写请求的幂等记录。 */
export interface RequestRecord {
  readonly kind: string
  /** 请求指纹：同一个 id 换了正文要能认出来并拒绝。 */
  readonly digest: string
  /**
   * `claimed`：已经受理，但还没有任何终态证据 —— 进程在这里断掉的话，这一次的结果
   * **不明**，绝不能重跑。`finished`：这一轮已经跑完了。
   */
  readonly state: 'claimed' | 'finished'
  readonly runId: string
  readonly conversationId: string
  readonly updatedAt: number
}

/** 新建任务时写入的一份计划。 */
export interface NewSubtask {
  readonly id: string
  readonly goal: string
  readonly agentId: string
  readonly reason: string
}

/** 运行历史查询条件。 */
export interface HistoryQuery {
  readonly offset: number
  readonly limit: number
  readonly keyword: string
  /** 空字符串表示不按状态过滤。 */
  readonly state: string
}

const STORE_ERROR = '工作台数据不可用，请稍后重试'

/**
 * 牛马大总管工作台的 SQLite 索引。
 *
 * 所有查询都按 owner 过滤：会话和任务属于登录用户，不因为知道 id 就能读到。
 */
export class TaskStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600)
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version !== 0 && version !== SCHEMA_VERSION && !MIGRATABLE_VERSIONS.includes(version)) {
      this.db.close()
      throw new Error(`不支持的工作台数据结构版本：${version}`)
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        owner_namespace TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_owner
        ON conversations(owner_namespace, owner_id, updated_at DESC, id);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        owner_namespace TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        state TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS tasks_owner
        ON tasks(owner_namespace, owner_id, created_at DESC, id);
      CREATE INDEX IF NOT EXISTS tasks_conversation
        ON tasks(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS subtasks (
        task_id TEXT NOT NULL,
        id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        goal TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        artifacts TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        started_at INTEGER,
        finished_at INTEGER,
        PRIMARY KEY (task_id, id)
      );
      CREATE INDEX IF NOT EXISTS subtasks_task ON subtasks(task_id, seq);
      CREATE TABLE IF NOT EXISTS agent_aliases (
        owner_namespace TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        accent TEXT NOT NULL DEFAULT '',
        avatar BLOB,
        avatar_type TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_namespace, owner_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS requests (
        owner_namespace TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        request_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        state TEXT NOT NULL,
        run_id TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (owner_namespace, owner_id, kind, request_id)
      );
    `)
    // 版本号**最后**才写：迁移中途失败时它不该已经前移，否则下次启动会跳过迁移、
    // 直接去查一个还不存在的列。
    if (version !== 0 && version !== SCHEMA_VERSION) this.migrate(version)
    else if (version === 0) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  }

  /**
   * 把旧库升到当前版本。
   *
   * 新表由上面那句 `CREATE TABLE IF NOT EXISTS` 建（对旧库同样有效），需要单独补的只有
   * 加不出来的**列**：`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作。
   *
   * 整体放在一个事务里，中途失败时版本号也不会前移，不会留下「改了一半、版本还以为没改」
   * 的状态。只增列增表，不动任何已有数据。
   */
  private migrate(from: number): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (from <= 1) {
        this.db.exec(`
          ALTER TABLE subtasks ADD COLUMN artifacts TEXT NOT NULL DEFAULT '';
          ALTER TABLE subtasks ADD COLUMN conversation_id TEXT NOT NULL DEFAULT '';
        `)
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 读取该用户的成员别名。
   *
   * 返回 Map 便于按 agentId 直接取用；没有配过别名的成员不在表里，页面回落到插件声明
   * 的名称。别名只影响显示，不改写插件身份。
   */
  aliases(actor: Actor): Map<string, { displayName: string; accent: string }> {
    const rows = this.db.prepare(`SELECT agent_id AS agentId, display_name AS displayName, accent
      FROM agent_aliases WHERE owner_namespace=? AND owner_id=?`)
      .all(actor.namespace, actor.userId) as unknown as { agentId: string; displayName: string; accent: string }[]
    return new Map(rows.map(row => [row.agentId, { displayName: row.displayName, accent: row.accent }]))
  }

  /**
   * 写入一位成员的显示别名。
   *
   * 空字符串表示「恢复默认」，此时直接删除该行，页面回落到插件声明的名称。
   */
  setAlias(actor: Actor, agentId: string, displayName: string, accent: string): void {
    const name = Array.from(displayName.replace(/\s+/gu, ' ').trim()).slice(0, 24).join('')
    const color = /^#[0-9a-f]{6}$/iu.test(accent) ? accent.toLowerCase() : ''
    if (name === '' && color === '') {
      this.db.prepare('DELETE FROM agent_aliases WHERE owner_namespace=? AND owner_id=? AND agent_id=?')
        .run(actor.namespace, actor.userId, agentId)
      return
    }
    this.db.prepare(`INSERT INTO agent_aliases(owner_namespace,owner_id,agent_id,display_name,accent,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(owner_namespace,owner_id,agent_id) DO UPDATE SET display_name=excluded.display_name, accent=excluded.accent, updated_at=excluded.updated_at`)
      .run(actor.namespace, actor.userId, agentId, name, color, Date.now())
  }

  /** 保存一位成员的头像。只接受已核验过的图片类型，大小由调用方限制。 */
  setAvatar(actor: Actor, agentId: string, bytes: Uint8Array, contentType: string): void {
    this.db.prepare(`INSERT INTO agent_aliases(owner_namespace,owner_id,agent_id,avatar,avatar_type,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(owner_namespace,owner_id,agent_id) DO UPDATE SET avatar=excluded.avatar, avatar_type=excluded.avatar_type, updated_at=excluded.updated_at`)
      .run(actor.namespace, actor.userId, agentId, bytes, contentType, Date.now())
  }

  /** 读取一位成员的头像；没有上传过时返回 undefined。 */
  avatar(actor: Actor, agentId: string): { bytes: Uint8Array; contentType: string } | undefined {
    const row = this.db.prepare(`SELECT avatar AS bytes, avatar_type AS contentType FROM agent_aliases
      WHERE owner_namespace=? AND owner_id=? AND agent_id=? AND avatar IS NOT NULL`)
      .get(actor.namespace, actor.userId, agentId) as unknown as { bytes: Uint8Array; contentType: string } | undefined
    return row === undefined ? undefined : { bytes: row.bytes, contentType: row.contentType }
  }

  /** 删除一位成员的头像，保留别名。 */
  clearAvatar(actor: Actor, agentId: string): void {
    this.db.prepare(`UPDATE agent_aliases SET avatar=NULL, avatar_type='', updated_at=?
      WHERE owner_namespace=? AND owner_id=? AND agent_id=?`)
      .run(Date.now(), actor.namespace, actor.userId, agentId)
  }

  /** 为用户登记一个牛马大总管会话；重复登记不改变已有归属。 */
  reserveConversation(id: string, actor: Actor): void {
    const now = Date.now()
    this.db.prepare(`INSERT OR IGNORE INTO conversations(id, owner_namespace, owner_id, created_at, updated_at)
      VALUES(?,?,?,?,?)`).run(id, actor.namespace, actor.userId, now, now)
  }

  /**
   * 为「打开一个会话」登记归属，新会话就地创建。
   *
   * 与 {@link assertOwner} 的区别在于**新会话应该被接受**：会话 id 由页面在客户端生成，
   * 首次发消息时库里还没有这条记录。若先断言归属再创建，新会话会被判成「不存在」而拒绝 ——
   * 这正是页面第一次发消息开不出会话的原因。
   *
   * 已经属于他人时不泄露存在性：与 {@link assertOwner} 返回同样的错误。
   */
  openOrReserveConversation(id: string, actor: Actor): void {
    const now = Date.now()
    this.db.prepare(`INSERT OR IGNORE INTO conversations(id, owner_namespace, owner_id, created_at, updated_at)
      VALUES(?,?,?,?,?)`).run(id, actor.namespace, actor.userId, now, now)
    this.assertOwner(id, actor)
  }

  /** 校验会话归属。未知、他人或已删除的会话返回同一个结果，不泄露存在性。 */
  assertOwner(conversationId: string, actor: Actor): void {
    const row = this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_namespace=? AND owner_id=?')
      .get(conversationId, actor.namespace, actor.userId)
    if (row === undefined) throw new AccessError(404, '会话不存在或无权访问', 'conversation_not_found')
  }

  /** 记录一条用户消息，首条消息决定会话标题。 */
  touchConversation(conversationId: string, actor: Actor, title?: string): void {
    this.assertOwner(conversationId, actor)
    const trimmed = Array.from((title ?? '').replace(/\s+/gu, ' ').trim()).slice(0, 80).join('')
    this.db.prepare(`UPDATE conversations SET updated_at=?, title=CASE WHEN title='' THEN ? ELSE title END WHERE id=?`)
      .run(Date.now(), trimmed, conversationId)
  }

  /** 侧栏列表；按最近使用排序。 */
  listConversations(actor: Actor, limit: number): ConversationSummary[] {
    return this.db.prepare(`SELECT c.id AS id, c.title AS title, c.created_at AS createdAt, c.updated_at AS updatedAt,
        (SELECT count(*) FROM tasks t WHERE t.conversation_id = c.id) AS taskCount
      FROM conversations c
      WHERE c.owner_namespace=? AND c.owner_id=?
      ORDER BY c.updated_at DESC, c.id LIMIT ?`)
      .all(actor.namespace, actor.userId, limit) as unknown as ConversationSummary[]
  }

  /** 写入一份新计划。任务与全部子任务在同一个事务里落盘，避免出现半个计划。 */
  createTask(input: {
    id: string
    conversationId: string
    actor: Actor
    goal: string
    note: string
    subtasks: readonly NewSubtask[]
  }): void {
    this.assertOwner(input.conversationId, input.actor)
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO tasks(id,conversation_id,owner_namespace,owner_id,goal,state,note,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(
        input.id, input.conversationId, input.actor.namespace, input.actor.userId,
        input.goal, 'running', input.note, now, now,
      )
      const insert = this.db.prepare(`INSERT INTO subtasks(task_id,id,seq,goal,agent_id,reason,state)
        VALUES(?,?,?,?,?,?,?)`)
      input.subtasks.forEach((subtask, index) => {
        insert.run(input.id, subtask.id, index + 1, subtask.goal, subtask.agentId, subtask.reason, 'queued')
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 更新任务状态；`finishedAt` 只在结束态写入一次。 */
  setTaskState(id: string, state: TaskState, patch: { note?: string; summary?: string; error?: string } = {}): void {
    const terminal = isTerminal(state)
    this.db.prepare(`UPDATE tasks SET state=?, updated_at=?,
        note=COALESCE(?,note), summary=COALESCE(?,summary), error=COALESCE(?,error),
        finished_at=CASE WHEN ?=1 THEN COALESCE(finished_at,?) ELSE finished_at END
      WHERE id=?`).run(
      state, Date.now(),
      patch.note ?? null, patch.summary ?? null, patch.error ?? null,
      terminal ? 1 : 0, Date.now(), id,
    )
  }

  /**
   * 更新子任务状态。`startedAt` 在首次进入执行态时写入，之后保持不变。
   *
   * `artifacts` 与 `conversationId` 只在传了的时候覆盖：状态事件是多次上报的，后面那些
   * 没带材料的上报不该把先前交回的材料擦掉。
   */
  setSubtaskState(
    taskId: string,
    subtaskId: string,
    state: SubtaskState,
    patch: {
      result?: string
      error?: string
      artifacts?: readonly AgentArtifact[]
      conversationId?: string
    } = {},
  ): void {
    const now = Date.now()
    const started = state === 'dispatched' || state === 'running'
    const terminal = isTerminal(state)
    this.db.prepare(`UPDATE subtasks SET state=?,
        result=COALESCE(?,result), error=COALESCE(?,error),
        artifacts=COALESCE(?,artifacts), conversation_id=COALESCE(?,conversation_id),
        started_at=CASE WHEN ?=1 THEN COALESCE(started_at,?) ELSE started_at END,
        finished_at=CASE WHEN ?=1 THEN COALESCE(finished_at,?) ELSE finished_at END
      WHERE task_id=? AND id=?`).run(
      state,
      patch.result ?? null, patch.error ?? null,
      patch.artifacts === undefined ? null : JSON.stringify(patch.artifacts),
      patch.conversationId === undefined || patch.conversationId === '' ? null : patch.conversationId,
      started ? 1 : 0, now,
      terminal ? 1 : 0, now,
      taskId, subtaskId,
    )
  }

  /** 读取一条任务的完整记录；不存在或不属于该用户时返回 undefined。 */
  task(actor: Actor, id: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT id,conversation_id AS conversationId,goal,state,note,summary,error,
        created_at AS createdAt,updated_at AS updatedAt,finished_at AS finishedAt
      FROM tasks WHERE id=? AND owner_namespace=? AND owner_id=?`)
      .get(id, actor.namespace, actor.userId)
    if (row === undefined) return undefined
    const rows = this.db.prepare(`SELECT id,seq,goal,agent_id AS agentId,reason,state,result,error,
        artifacts,conversation_id AS subtaskConversationId,started_at AS startedAt,finished_at AS finishedAt
      FROM subtasks WHERE task_id=? ORDER BY seq`).all(id) as unknown as (Omit<SubtaskRecord, 'artifacts' | 'conversationId'> & {
        readonly artifacts: string
        readonly subtaskConversationId: string
      })[]
    const subtasks = rows.map(({ artifacts, subtaskConversationId, ...rest }) => ({
      ...rest,
      artifacts: parseArtifacts(artifacts),
      conversationId: subtaskConversationId,
    }))
    return { ...(row as unknown as Omit<TaskRecord, 'subtasks'>), subtasks }
  }

  /** 运行历史分页。`nextOffset` 为 null 表示没有更多。 */
  history(actor: Actor, query: HistoryQuery): { items: TaskSummary[]; total: number; nextOffset: number | null } {
    const filters = ['t.owner_namespace=?', 't.owner_id=?']
    const values: SQLInputValue[] = [actor.namespace, actor.userId]
    if (query.keyword !== '') {
      filters.push('instr(lower(t.goal), lower(?))>0')
      values.push(query.keyword)
    }
    if (query.state !== '') {
      filters.push('t.state=?')
      values.push(query.state)
    }
    const where = filters.join(' AND ')
    const total = Number(this.db.prepare(`SELECT count(*) AS total FROM tasks t WHERE ${where}`).get(...values)?.total ?? 0)
    const items = this.db.prepare(`SELECT t.id AS id, t.conversation_id AS conversationId, t.goal AS goal, t.state AS state,
        t.created_at AS createdAt, t.updated_at AS updatedAt,
        (SELECT count(*) FROM subtasks s WHERE s.task_id=t.id) AS subtaskTotal,
        (SELECT count(*) FROM subtasks s WHERE s.task_id=t.id AND s.state IN ('succeeded','failed','cancelled','external_pending')) AS subtaskDone
      FROM tasks t WHERE ${where} ORDER BY t.created_at DESC, t.id LIMIT ? OFFSET ?`)
      .all(...values, query.limit, query.offset) as unknown as TaskSummary[]
    const next = query.offset + items.length
    return { items, total, nextOffset: next < total ? next : null }
  }

  /**
   * 该用户的任务里，每位成员此刻占着的活。
   *
   * 只查当前用户自己的任务：占用排的是他自己的活，看别人的任务既没用也越界。
   *
   * `queued` **不算占用** —— 那是计划里还没派出去的步骤，成员并没有接手。真正占住一位
   * 成员的是「已派出、正在干、或等着他回话」这三类，与游戏侧 `claim` 的
   * `one-subtask-per-staff` 是同一组状态。
   */
  busy(actor: Actor): Map<string, { taskId: string; subtaskId: string; state: SubtaskState }> {
    const rows = this.db.prepare(`SELECT s.agent_id AS agentId, s.task_id AS taskId, s.id AS subtaskId, s.state AS state
      FROM subtasks s JOIN tasks t ON t.id = s.task_id
      WHERE t.owner_namespace=? AND t.owner_id=?
        AND s.state IN ('dispatched','running','waiting_user')
      ORDER BY s.seq`).all(actor.namespace, actor.userId) as unknown as {
        readonly agentId: string
        readonly taskId: string
        readonly subtaskId: string
        readonly state: SubtaskState
      }[]
    const busy = new Map<string, { taskId: string; subtaskId: string; state: SubtaskState }>()
    for (const row of rows) {
      // 同一位成员出现多条时留最先派出的那条：占用从派发那一刻起算，后来的顶不掉它。
      if (!busy.has(row.agentId)) {
        busy.set(row.agentId, { taskId: row.taskId, subtaskId: row.subtaskId, state: row.state })
      }
    }
    return busy
  }

  /** 用户的全局状态计数，用于右栏指标卡。 */  counts(actor: Actor): TaskCounts {
    const rows = this.db.prepare(`SELECT state, count(*) AS total FROM tasks
      WHERE owner_namespace=? AND owner_id=? GROUP BY state`)
      .all(actor.namespace, actor.userId) as unknown as { state: TaskState; total: number }[]
    const pick = (...states: TaskState[]) => rows.filter(row => states.includes(row.state)).reduce((sum, row) => sum + row.total, 0)
    return {
      running: pick('running', 'summarizing'),
      waitingUser: pick('waiting_user'),
      externalPending: pick('external_pending'),
      failed: pick('failed'),
      completed: pick('completed'),
      queued: pick('queued'),
    }
  }

  /** 最近失败的任务摘要，最多若干条。 */
  recentFailures(actor: Actor, limit: number): { id: string; goal: string; error: string; updatedAt: number }[] {
    return this.db.prepare(`SELECT t.id AS id, t.goal AS goal,
        COALESCE(NULLIF(t.error,''), (SELECT s.error FROM subtasks s WHERE s.task_id=t.id AND s.error!='' ORDER BY s.seq LIMIT 1), '') AS error,
        t.updated_at AS updatedAt
      FROM tasks t WHERE t.owner_namespace=? AND t.owner_id=? AND t.state='failed'
      ORDER BY t.updated_at DESC LIMIT ?`)
      .all(actor.namespace, actor.userId, limit) as unknown as { id: string; goal: string; error: string; updatedAt: number }[]
  }

  /** 把上次进程退出时仍在执行的任务标记为中断，避免页面上出现永远转圈的状态。 */
  failInterrupted(): number {
    const now = Date.now()
    const changed = this.db.prepare(`UPDATE tasks SET state='failed', error=?, updated_at=?, finished_at=COALESCE(finished_at,?)
      WHERE state IN ('queued','running','waiting_user','summarizing')`)
      .run('服务已重启，这次任务没有跑完', now, now).changes
    if (Number(changed) > 0) {
      this.db.prepare(`UPDATE subtasks SET state='failed', error=?, finished_at=COALESCE(finished_at,?)
        WHERE state IN ('queued','dispatched','running','waiting_user')`)
        .run('服务已重启，这个子任务没有跑完', now)
    }
    return Number(changed)
  }

  /**
   * 读一条写请求的幂等记录；没有受理过时返回 undefined。
   *
   * 记录在**执行前**就写下了，所以它能回答两种问法：这一轮跑完了吗（`finished`），
   * 还是受理之后就没有下文（`claimed`）。
   */
  request(actor: Actor, kind: string, requestId: string): RequestRecord | undefined {
    const row = this.db.prepare(`SELECT kind,digest,state,run_id AS runId,
        conversation_id AS conversationId,updated_at AS updatedAt
      FROM requests WHERE owner_namespace=? AND owner_id=? AND kind=? AND request_id=?`)
      .get(actor.namespace, actor.userId, kind, requestId) as unknown as RequestRecord | undefined
    return row
  }

  /**
   * 占住一个 `requestId`，**在执行之前**落库。
   *
   * 这是整件事的关键：只在结束时记结果的话，「受理了、跑了一半、进程没了」这一段在库里
   * 什么都没有，重启后同一个请求会被当成新的一次再跑一遍 —— 而那些可能带外部副作用的活
   * 正是最不该重跑的。先占位就没有这个窗口。
   *
   * 顺手清掉过期记录，表不会只涨不消。过期判定与内存版同源（`idempotencyTtlMs`）。
   */
  claimRequest(actor: Actor, kind: string, requestId: string, digest: string, runId: string, conversationId: string, ttlMs: number): void {
    const now = Date.now()
    this.db.prepare(`DELETE FROM requests WHERE owner_namespace=? AND owner_id=? AND updated_at < ?`)
      .run(actor.namespace, actor.userId, now - ttlMs)
    this.db.prepare(`INSERT INTO requests(owner_namespace,owner_id,kind,request_id,digest,state,run_id,conversation_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_namespace,owner_id,kind,request_id) DO UPDATE SET
        digest=excluded.digest, state=excluded.state, run_id=excluded.run_id,
        conversation_id=excluded.conversation_id, updated_at=excluded.updated_at`)
      .run(actor.namespace, actor.userId, kind, requestId, digest, 'claimed', runId, conversationId, now, now)
  }

  /** 标记这一轮已经跑完。 */
  finishRequest(actor: Actor, kind: string, requestId: string): void {
    this.db.prepare(`UPDATE requests SET state='finished', updated_at=?
      WHERE owner_namespace=? AND owner_id=? AND kind=? AND request_id=?`)
      .run(Date.now(), actor.namespace, actor.userId, kind, requestId)
  }

  /**
   * 撤掉一次占位。
   *
   * 只在「受理本身失败了」时用（参数不合法、上一轮还没完）：那次请求根本没有开始执行，
   * 留着记录会让同一个 `requestId` 再提交时被当成「结果不明」，把一个没发生过的执行
   * 报成需要恢复的状态。
   */
  releaseRequest(actor: Actor, kind: string, requestId: string): void {
    this.db.prepare(`DELETE FROM requests WHERE owner_namespace=? AND owner_id=? AND kind=? AND request_id=?`)
      .run(actor.namespace, actor.userId, kind, requestId)
  }

  /** 关闭索引；不删除任何用户数据。 */  close(): void {
    try { this.db.close() } catch { /* 已关闭时重复调用是安全的。 */ }
  }
}

/**
 * 解析落库的材料引用。
 *
 * 库里存的是 JSON 文本。一条脏记录不该让整个任务详情读不出来，所以解析失败按「没有材料」
 * 处理 —— 详情页少一行链接，比整页报错好。逐条校验字段，避免把半个对象交给页面去渲染。
 */
function parseArtifacts(raw: string): readonly AgentArtifact[] {
  if (raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is AgentArtifact => {
      if (typeof item !== 'object' || item === null) return false
      const candidate = item as Partial<AgentArtifact>
      return typeof candidate.title === 'string' && typeof candidate.path === 'string' && typeof candidate.kind === 'string'
    })
  } catch {
    return []
  }
}

export { STORE_ERROR }
