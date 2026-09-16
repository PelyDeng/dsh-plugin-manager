/**
 * 测试双实现：node:sqlite 版工作台索引（原 src/store.ts，随 T1-4 退出运行路径移入测试）。
 *
 * 这里只剩两个用途：
 *
 * 1. 业务语义断言的测试夹具（owner 隔离、digest 冲突、首次固定守卫、损坏分类等继续在这里跑）；
 * 2. tests/migrate-storage.test.ts 等价性验收的基准：同一 fixture 两路（直导 vs 副本先经
 *    TaskStore 的 migrate() 旧链升 8 再导）逐列比对。
 *
 * 生产运行路径只有 PostgresTaskStorage（src/storage/postgres.ts）；本文件不进 dist、不被
 * 生产代码导入。migrate 链保留是为了让等价性验收有真实旧链可走，不再是运行时升级路径。
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { AccessError, type Actor, type AgentArtifact } from '@dsh-plugin-manager/plugin-kit'
import { isTerminal, type SubtaskState, type TaskState } from '../../src/task-model.ts'
import { parseArtifacts, parseDependsOn, parseDependsOnStrict, parseInputRefs, parseMemberReturn } from '../../src/storage/parse.ts'
import type {
  ButlerInputRef,
  ButlerMemberReturn,
  ButlerStorage,
  ConversationSummary,
  HistoryQuery,
  NewSubtask,
  RequestRecord,
  SubtaskRecord,
  TaskCounts,
  TaskInput,
  TaskRecord,
  TaskSummary,
} from '../../src/storage/types.ts'

/**
 * 工作台索引的数据结构版本。
 *
 * 2：子任务增加 `artifacts`（材料引用）与 `conversation_id`（原会话）。
 * 3：新增 `requests` 表，把写请求的幂等占用**在执行前**落库。
 * 4：任务增加输入版本两列，新增 `task_inputs` 表，记录每一次被接受的需求与补充。
 * 5：子任务增加 `logical_id`（同一目标的稳定标识）与 `supersedes`（替代了哪一条尝试）。
 * 6：子任务增加 `depends_on`（前置目标的标识列表）。
 * 7：子任务增加 `requires_external_action`（这一步是否真的需要外部动作已经办完）。
 */
const SCHEMA_VERSION = 8

/**
 * 能从这些旧版本就地升上来。
 *
 * 不在这张表里的版本（比当前新、或者来历不明）一律拒绝：拿错版本的结构去读写，比起不来
 * 严重得多。这条链只服务于等价性验收，生产升级走 migrations/postgres/。
 */
const MIGRATABLE_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7]

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
        accepted_version INTEGER NOT NULL DEFAULT 1,
        processed_version INTEGER NOT NULL DEFAULT 1,
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
        logical_id TEXT NOT NULL DEFAULT '',
        supersedes TEXT NOT NULL DEFAULT '',
        depends_on TEXT NOT NULL DEFAULT '',
        requires_external_action INTEGER NOT NULL DEFAULT 0,
        input_refs TEXT NOT NULL DEFAULT '',
        member_return TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS task_inputs (
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, version)
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
      if (from <= 3) {
        // 老任务没有输入版本这回事，一律按「只有最初那条需求」算。
        this.db.exec(`
          ALTER TABLE tasks ADD COLUMN accepted_version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE tasks ADD COLUMN processed_version INTEGER NOT NULL DEFAULT 1;
        `)
      }
      if (from <= 4) {
        this.db.exec(`
          ALTER TABLE subtasks ADD COLUMN logical_id TEXT NOT NULL DEFAULT '';
          ALTER TABLE subtasks ADD COLUMN supersedes TEXT NOT NULL DEFAULT '';
        `)
        // 老数据没有目标标识，把每一条子任务各自当成一个目标（它本来就是只跑过一次的尝试）。
        this.db.exec(`UPDATE subtasks SET logical_id = 'g' || seq WHERE logical_id = ''`)
      }
      if (from <= 5) {
        // 老任务没有依赖关系：已有的子任务一律按「没有前置」算。
        this.db.exec(`ALTER TABLE subtasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT ''`)
      }
      if (from <= 6) {
        // 老任务没有「这一步是否真的等外部动作」的声明，一律按不需要算 —— 与加这一列之前的
        // 行为一致（那时只认前置成功），不会让旧任务凭空多等或凭空放行。
        this.db.exec(`ALTER TABLE subtasks ADD COLUMN requires_external_action INTEGER NOT NULL DEFAULT 0`)
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      if (from <= 7) {
        // 8：派单材料快照与协作返回原文。旧库一律留空 = 未知：旧 result 是裁剪过的展示摘要，
        // 不能当作可交付材料，也不反推、不补造。
        this.db.exec("ALTER TABLE subtasks ADD COLUMN input_refs TEXT NOT NULL DEFAULT ''; ALTER TABLE subtasks ADD COLUMN member_return TEXT NOT NULL DEFAULT '';")
      }

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

  /**
   * 写入一份新计划。任务与全部子任务在同一个事务里落盘，避免出现半个计划。
   *
   * 开头那条需求就是**版本 1**，与它一起写进 `task_inputs`：输入历史要完整，不能只有
   * 后来的补充、没有最初那句。
   */
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
      this.db.prepare(`INSERT INTO task_inputs(task_id,version,text,source,created_at) VALUES(?,1,?,?,?)`)
        .run(input.id, input.goal, 'chat', now)
      const insert = this.db.prepare(`INSERT INTO subtasks(task_id,id,seq,goal,agent_id,reason,state,logical_id,supersedes,depends_on,requires_external_action)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      input.subtasks.forEach((subtask, index) => {
        // 没给目标标识就按顺序分配：首次计划里一条子任务就是一个目标。
        insert.run(
          input.id, subtask.id, index + 1, subtask.goal, subtask.agentId, subtask.reason, 'queued',
          subtask.logicalId ?? `g${index + 1}`, subtask.supersedes ?? '', JSON.stringify(subtask.dependsOn ?? []),
          subtask.requiresExternalAction === true ? 1 : 0,
        )
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
   * 写下「这一轮干完了」的终态，**并与输入版本核对放在同一个事务里**。
   *
   * 只在收尾开始前核对一次是不够的：汇总那一轮是异步的，跑到一半又进来一条补充时，那份
   * 结论已经不算数了 —— 它总结的是**旧范围**。写入与核对必须原子完成，否则旧结论会盖在
   * 「还有一条新说法没处理」上面，任务报成完成、新目标被丢掉。
   *
   * 只对宣称成功的终态（`completed` / `partial`）设这道关卡：取消与失败没有宣称成功，
   * 可以带着未处理的输入结束 —— 那一轮的输入留给后续处理。
   *
   * @returns 写成功返回 `true`；还有已接受未处理的输入时**什么都不写**并返回 `false`。
   */
  commitTaskState(id: string, state: TaskState, patch: { note?: string; summary?: string; error?: string } = {}): boolean {
    if (state !== 'completed' && state !== 'partial') {
      this.setTaskState(id, state, patch)
      return true
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(`SELECT accepted_version AS accepted, processed_version AS processed
        FROM tasks WHERE id=?`).get(id) as unknown as { accepted: number; processed: number } | undefined
      if (row === undefined || row.accepted > row.processed) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare(`UPDATE tasks SET state=?, updated_at=?,
          note=COALESCE(?,note), summary=COALESCE(?,summary), error=COALESCE(?,error),
          finished_at=COALESCE(finished_at,?)
        WHERE id=?`).run(
        state, Date.now(),
        patch.note ?? null, patch.summary ?? null, patch.error ?? null,
        Date.now(), id,
      )
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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
      /**
       * 派单材料快照。**只在「确实还没派出去过」时才落库**（首次固定）。
       *
       * 已固定的（含表示「已核验无需上游材料」的空数组）、旧已派出却留空的未知、以及读不出来的
       * 损坏值，写入层一律原样保留：这个子任务当时收到的材料是什么，历史来源就是什么。
       * 调用方要沿用已固定的快照，不能拿此刻的上游状态重算一份新材料盖上去。
       */
      inputRefs?: readonly ButlerInputRef[]
      /** 协作返回原文：不传表示保留旧值；合法空文本要编码成含 protocol/text 的 JSON。 */
      memberReturn?: ButlerMemberReturn
      conversationId?: string
    } = {},
  ): void {
    const now = Date.now()
    const started = state === 'dispatched' || state === 'running'
    const terminal = isTerminal(state)
    // 快照只在「可证明还没派出去过」时才落库：列还是空串，而且这条记录真的没开始过
    // （`started_at` 为空、状态还是排队中）。已固定的、旧已派出却留空的、以及损坏的值一律
    // 原样保留。`state`、`started_at` 在这个 CASE 里都是**更新前**的旧值。
    const inputRefs = patch.inputRefs === undefined ? null : JSON.stringify(patch.inputRefs)
    this.db.prepare(`UPDATE subtasks SET state=?,
        result=COALESCE(?,result), error=COALESCE(?,error),
        artifacts=COALESCE(?,artifacts), conversation_id=COALESCE(?,conversation_id),
        input_refs=CASE WHEN ? IS NULL THEN input_refs
          WHEN input_refs<>'' THEN input_refs
          WHEN started_at IS NOT NULL OR state<>'queued' THEN input_refs
          ELSE ? END,
        member_return=COALESCE(?,member_return),
        started_at=CASE WHEN ?=1 THEN COALESCE(started_at,?) ELSE started_at END,
        finished_at=CASE WHEN ?=1 THEN COALESCE(finished_at,?) ELSE finished_at END
      WHERE task_id=? AND id=?`).run(
      state,
      patch.result ?? null, patch.error ?? null,
      patch.artifacts === undefined ? null : JSON.stringify(patch.artifacts),
      patch.conversationId === undefined || patch.conversationId === '' ? null : patch.conversationId,
      inputRefs, inputRefs,
      patch.memberReturn === undefined ? null : JSON.stringify(patch.memberReturn),
      started ? 1 : 0, now,
      terminal ? 1 : 0, now,
      taskId, subtaskId,
    )
  }

  /**
   * 读一条子任务的状态；不存在时返回 undefined。
   *
   * 本文件配套：等待超时条件结账要按主键读状态而不带 owner 过滤（PG 侧为同语义的单条
   * 条件 UPDATE）；生产代码不使用。
   */
  subtaskState(taskId: string, subtaskId: string): SubtaskState | undefined {
    const row = this.db.prepare('SELECT state FROM subtasks WHERE task_id=? AND id=?')
      .get(taskId, subtaskId) as unknown as { state: SubtaskState } | undefined
    return row?.state
  }

  /** 读取一条任务的完整记录；不存在或不属于该用户时返回 undefined。 */
  task(actor: Actor, id: string): TaskRecord | undefined {
    const row = this.db.prepare(`SELECT id,conversation_id AS conversationId,goal,state,note,summary,error,
        accepted_version AS acceptedVersion,processed_version AS processedVersion,
        created_at AS createdAt,updated_at AS updatedAt,finished_at AS finishedAt
      FROM tasks WHERE id=? AND owner_namespace=? AND owner_id=?`)
      .get(id, actor.namespace, actor.userId)
    if (row === undefined) return undefined
    const rows = this.db.prepare(`SELECT id,seq,goal,logical_id AS logicalId,supersedes,depends_on AS dependsOnRaw,
        agent_id AS agentId,reason,state,result,error,
        artifacts,conversation_id AS subtaskConversationId,started_at AS startedAt,finished_at AS finishedAt,
        requires_external_action AS requiresExternalActionRaw,
        input_refs AS inputRefsRaw,member_return AS memberReturnRaw
      FROM subtasks WHERE task_id=? ORDER BY seq`).all(id) as unknown as (Omit<SubtaskRecord, 'artifacts' | 'conversationId' | 'dependsOn' | 'dependsOnState' | 'requiresExternalAction' | 'inputRefs' | 'inputRefsState' | 'memberReturn'> & {
        readonly artifacts: string
        readonly subtaskConversationId: string
        readonly dependsOnRaw: string
        readonly requiresExternalActionRaw: number
        readonly inputRefsRaw: string
        readonly memberReturnRaw: string
      })[]
    const subtasks = rows.map(({ artifacts, subtaskConversationId, dependsOnRaw, requiresExternalActionRaw, inputRefsRaw, memberReturnRaw, ...rest }) => {
      // 「确实还没派出去过」= 从未开始过（`started_at` 为空）且状态还是排队中。别的状态都说明
      // 已经派出去过：那时列还是空串只能表示旧记录没留材料，是未知，不是「等着首次固定」。
      const snapshot = parseInputRefs(inputRefsRaw, rest.startedAt === null && rest.state === 'queued')
      const depends = parseDependsOnStrict(dependsOnRaw)
      return {
        ...rest,
        artifacts: parseArtifacts(artifacts),
        conversationId: subtaskConversationId,
        // 取值保持原有行为（合法列表照旧）；分类如实暴露：损坏的前置列表必须拒派，由编排层
        // 消费 dependsOnState，存储层不静默改写原值、也不把损坏伪装成「没有前置」。
        dependsOn: depends.kind === 'valid' ? depends.items : parseDependsOn(dependsOnRaw),
        dependsOnState: depends.kind,
        requiresExternalAction: requiresExternalActionRaw === 1,
        inputRefs: snapshot.kind === 'fixed' ? snapshot.inputRefs : undefined,
        inputRefsState: snapshot.kind,
        memberReturn: parseMemberReturn(memberReturnRaw),
      }
    })
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
    if (query.conversationId !== undefined && query.conversationId !== '') {
      filters.push('t.conversation_id=?')
      values.push(query.conversationId)
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
      ORDER BY s.started_at, s.task_id, s.id`).all(actor.namespace, actor.userId) as unknown as {
        readonly agentId: string
        readonly taskId: string
        readonly subtaskId: string
        readonly state: SubtaskState
      }[]
    const busy = new Map<string, { taskId: string; subtaskId: string; state: SubtaskState }>()
    for (const row of rows) {
      // 同一位成员出现多条时留**最早派出去**的那条：占用从派发那一刻起算，后来的顶不掉它。
      // 排序按 `started_at` 而不是 `seq` —— 两条不同任务里的子任务 seq 都可能从 1 开始，
      // 按 seq 排等于没排。
      if (!busy.has(row.agentId)) {
        busy.set(row.agentId, { taskId: row.taskId, subtaskId: row.subtaskId, state: row.state })
      }
    }
    return busy
  }

  /**
   * 接受一条新的需求或补充，返回新版本号。
   *
   * **版本递增与原文落库在同一个事务里**：只加版本不存原文，汇总时就无从核对「最新那条
   * 到底说了什么」；只存原文不加版本，又表达不了「处理到哪儿了」。
   *
   * 递增读的是库里的当前值而不是调用方传来的：两次补充几乎同时到达时，谁先谁后由这里
   * 定，不由客户端定。
   *
   * 版本核验与「任务还能不能改」也在**同一个事务里**复核一遍，不接受调用方在事务外先查过
   * 的结论：受理前要打开会话，那是一段异步窗口，任务可能就在这期间被别人收尾了。放在事务
   * 外查等于用旧结论写新数据 —— 实测两个客户端同时带 `expectVersion:1` 提交，两次都会被
   * 接受，版本一路涨到 3；终态任务也能在这段窗口里被塞进一条补充。
   *
   * @param expectedVersion 调用方认为的当前版本；对不上就拒（并发依据）。不传表示不校验。
   */
  addInput(actor: Actor, taskId: string, text: string, source: 'chat' | 'supplement', expectedVersion?: number): number {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(`SELECT accepted_version AS acceptedVersion, state AS state FROM tasks
        WHERE id=? AND owner_namespace=? AND owner_id=?`)
        .get(taskId, actor.namespace, actor.userId) as unknown as { acceptedVersion: number; state: TaskState } | undefined
      if (row === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
      if (isTerminal(row.state)) {
        throw new AccessError(409, '这一轮已经结束，改目标请用 /chat 开新的一轮', 'task_already_finished')
      }
      if (expectedVersion !== undefined && expectedVersion !== row.acceptedVersion) {
        throw new AccessError(409, `这一轮已经更新到第 ${row.acceptedVersion} 版，请按最新内容重新提交`, 'version_conflict')
      }
      const next = row.acceptedVersion + 1
      this.db.prepare('UPDATE tasks SET accepted_version=?, updated_at=? WHERE id=?').run(next, now, taskId)
      this.db.prepare('INSERT INTO task_inputs(task_id,version,text,source,created_at) VALUES(?,?,?,?,?)')
        .run(taskId, next, text, source, now)
      this.db.exec('COMMIT')
      return next
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 这一轮接受与处理到的输入版本。
   *
   * 收尾前要拿它核对「最新接受的输入都处理完了」：只按某个回合开始时的版本记账，
   * 中途进来的补充会被漏掉，任务却已经报成完成。
   */
  inputVersions(taskId: string): { accepted: number; processed: number } | undefined {
    const row = this.db.prepare(`SELECT accepted_version AS accepted, processed_version AS processed
      FROM tasks WHERE id=?`).get(taskId) as unknown as { accepted: number; processed: number } | undefined
    return row
  }

  /** 一条任务收到过的全部需求与补充，按版本排序。 */
  inputs(taskId: string): TaskInput[] {
    return this.db.prepare(`SELECT version,text,source,created_at AS createdAt
      FROM task_inputs WHERE task_id=? ORDER BY version`).all(taskId) as unknown as TaskInput[]
  }

  /** 把处理进度追平到某个版本。 */
  setProcessedVersion(taskId: string, version: number): void {
    // 只往前追：回调乱序或者重放时不可能把已经处理过的输入退回未处理。
    this.db.prepare(`UPDATE tasks SET processed_version=?, updated_at=?
      WHERE id=? AND processed_version < ?`).run(version, Date.now(), taskId, version)
  }

  /**
   * 往一个已经存在的任务追加子任务，返回它们的编号。
   *
   * 补充改了范围时用：新活是**同一个任务**里多出来的步骤，不是另开一轮 —— 分开之后
   * 「这一轮的最终结论」就没人给得出了。
   *
   * 编号接着现有的往下排，不复用也不跳号。
   */
  appendSubtasks(actor: Actor, taskId: string, subtasks: readonly NewSubtask[]): string[] {
    const record = this.task(actor, taskId)
    if (record === undefined) throw new AccessError(404, '任务不存在或无权访问', 'task_not_found')
    const start = record.subtasks.reduce((max, item) => Math.max(max, item.seq), 0)
    // 新目标的标识从现有最大值往下排，不与已有的撞号。
    const nextLogical = record.subtasks
      .map(item => Number.parseInt(item.logicalId.replace(/^g/u, ''), 10))
      .filter(value => Number.isSafeInteger(value))
      .reduce((max, value) => Math.max(max, value), 0)
    const insert = this.db.prepare(`INSERT INTO subtasks(task_id,id,seq,goal,agent_id,reason,state,logical_id,supersedes,depends_on,requires_external_action)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    const ids: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      subtasks.forEach((subtask, index) => {
        insert.run(
          taskId, subtask.id, start + index + 1, subtask.goal, subtask.agentId, subtask.reason, 'queued',
          subtask.logicalId ?? `g${nextLogical + index + 1}`, subtask.supersedes ?? '', JSON.stringify(subtask.dependsOn ?? []),
          subtask.requiresExternalAction === true ? 1 : 0,
        )
        ids.push(subtask.id)
      })
      this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now(), taskId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return ids
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
      partial: pick('partial'),
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
   * 占住一个 `requestId`，**在执行之前**落库，并原子地决出唯一胜者。
   *
   * 这是整件事的关键：只在结束时记结果的话，「受理了、跑了一半、进程没了」这一段在库里
   * 什么都没有，重启后同一个请求会被当成新的一次再跑一遍 —— 而那些可能带外部副作用的活
   * 正是最不该重跑的。先占位就没有这个窗口。
   *
   * 「先查有没有、再写占位」是两步，两个并发请求会双双通过查询、后写的覆盖先写的，同一次
   * 提交于是被调度两遍 —— 实测就是这样。所以判定与写入必须在**同一个事务**里完成：已经
   * 有人占过就原样返回那条记录，调用方据此给回原凭据，绝不第二次执行。
   *
   * 顺带清掉过期记录，**只清已完成的**：`claimed` 意味着「可能已经执行过、结果不明」，
   * 它是防重的唯一依据，按时间清掉等于把那次请求放行重跑。运行中的活超过 TTL 也很正常
   * （模型跑十几分钟很常见），不能按时间判它已经死了。
   *
   * @returns 赢了返回 `undefined`；已经有人占过则返回那条既有记录。
   */
  claimRequest(actor: Actor, kind: string, requestId: string, digest: string, runId: string, conversationId: string, ttlMs: number): RequestRecord | undefined {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`DELETE FROM requests
        WHERE owner_namespace=? AND owner_id=? AND state='finished' AND updated_at < ?`)
        .run(actor.namespace, actor.userId, now - ttlMs)
      const existing = this.db.prepare(`SELECT kind,digest,state,run_id AS runId,
          conversation_id AS conversationId,updated_at AS updatedAt
        FROM requests WHERE owner_namespace=? AND owner_id=? AND kind=? AND request_id=?`)
        .get(actor.namespace, actor.userId, kind, requestId) as unknown as RequestRecord | undefined
      if (existing !== undefined) {
        this.db.exec('COMMIT')
        return existing
      }
      this.db.prepare(`INSERT INTO requests(owner_namespace,owner_id,kind,request_id,digest,state,run_id,conversation_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(actor.namespace, actor.userId, kind, requestId, digest, 'claimed', runId, conversationId, now, now)
      this.db.exec('COMMIT')
      return undefined
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 把受理阶段才知道的会话与轮次标识补进占位记录。
   *
   * 占位必须早于一切副作用落下（否则并发同 `requestId` 会各自产生副作用），但会话标识要
   * 等受理完成才有。期间的重放会读到空标识，按「结果不明」如实回答；补上之后重放就能
   * 找到那一轮的事件了。
   */
  bindRequest(actor: Actor, kind: string, requestId: string, runId: string, conversationId: string): void {
    this.db.prepare(`UPDATE requests SET run_id=?, conversation_id=?, updated_at=?
      WHERE owner_namespace=? AND owner_id=? AND kind=? AND request_id=? AND conversation_id=''`)
      .run(runId, conversationId, Date.now(), actor.namespace, actor.userId, kind, requestId)
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
    this.db.prepare('DELETE FROM requests WHERE owner_namespace=? AND owner_id=? AND kind=? AND request_id=?')
      .run(actor.namespace, actor.userId, kind, requestId)
  }

  /** 关闭索引；不删除任何用户数据。 */  close(): void {
    try { this.db.close() } catch { /* 已关闭时重复调用是安全的。 */ }
  }
}

/**
 * 测试适配器：用同步 TaskStore（node:sqlite）实现异步 ButlerStorage 接口。
 *
 * **仅测试**：方法体把同步调用包成 Promise，语义直通、不做任何改写；生产装配（index.ts）
 * 只允许 PostgresTaskStorage。两处例外说明：
 *
 * - `init()` 是空操作：TaskStore 在构造函数里同步完成建库与版本校验（含不支持版本的
 *   同步 throw），启动序列里没有第二次校验可做；
 * - `expireWaitingSubtask()` 退回「读-核-写」：TaskStore 没有条件更新原语，但整段在
 *   同一个同步调用里完成、没有 await 窗口，与原 butler.ts 实现语义一致；单条条件
 *   UPDATE 语义由 PostgresTaskStorage 提供。
 */
export class SqliteButlerStorage implements ButlerStorage {
  constructor(private readonly store: TaskStore) {}

  async init(): Promise<void> {
    // TaskStore 构造函数已同步完成结构与版本校验（不支持版本直接 throw），这里无事可做。
  }

  async readyProbe(): Promise<void> {
    // 同 init() 的理由：夹具同步打开、同步校验，构造成功即就绪；生产装配（index.ts）只允许
    // PostgresTaskStorage，运行期探测语义在那里实现并验证。
  }

  async expireWaitingSubtask(taskId: string, subtaskId: string, error: string): Promise<boolean> {
    if (this.store.subtaskState(taskId, subtaskId) !== 'waiting_user') return false
    this.store.setSubtaskState(taskId, subtaskId, 'failed', { error })
    return true
  }

  async aliases(actor: Actor): Promise<Map<string, { displayName: string; accent: string }>> {
    return this.store.aliases(actor)
  }

  async setAlias(actor: Actor, agentId: string, displayName: string, accent: string): Promise<void> {
    this.store.setAlias(actor, agentId, displayName, accent)
  }

  async setAvatar(actor: Actor, agentId: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.store.setAvatar(actor, agentId, bytes, contentType)
  }

  async avatar(actor: Actor, agentId: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    return this.store.avatar(actor, agentId)
  }

  async clearAvatar(actor: Actor, agentId: string): Promise<void> {
    this.store.clearAvatar(actor, agentId)
  }

  async reserveConversation(id: string, actor: Actor): Promise<void> {
    this.store.reserveConversation(id, actor)
  }

  async openOrReserveConversation(id: string, actor: Actor): Promise<void> {
    this.store.openOrReserveConversation(id, actor)
  }

  async assertOwner(conversationId: string, actor: Actor): Promise<void> {
    this.store.assertOwner(conversationId, actor)
  }

  async touchConversation(conversationId: string, actor: Actor, title?: string): Promise<void> {
    this.store.touchConversation(conversationId, actor, title)
  }

  async listConversations(actor: Actor, limit: number): Promise<ConversationSummary[]> {
    return this.store.listConversations(actor, limit)
  }

  async createTask(input: {
    id: string
    conversationId: string
    actor: Actor
    goal: string
    note: string
    subtasks: readonly NewSubtask[]
  }): Promise<void> {
    this.store.createTask(input)
  }

  async setTaskState(id: string, state: TaskRecord['state'], patch?: { note?: string; summary?: string; error?: string }): Promise<void> {
    this.store.setTaskState(id, state, patch)
  }

  async commitTaskState(id: string, state: TaskRecord['state'], patch?: { note?: string; summary?: string; error?: string }): Promise<boolean> {
    return this.store.commitTaskState(id, state, patch)
  }

  async setSubtaskState(
    taskId: string,
    subtaskId: string,
    state: Parameters<TaskStore['setSubtaskState']>[2],
    patch?: Parameters<TaskStore['setSubtaskState']>[3],
  ): Promise<void> {
    this.store.setSubtaskState(taskId, subtaskId, state, patch)
  }

  async task(actor: Actor, id: string): Promise<TaskRecord | undefined> {
    return this.store.task(actor, id)
  }

  async history(actor: Actor, query: HistoryQuery): Promise<{ items: TaskSummary[]; total: number; nextOffset: number | null }> {
    return this.store.history(actor, query)
  }

  async busy(actor: Actor): Promise<Map<string, { taskId: string; subtaskId: string; state: TaskRecord['subtasks'][number]['state'] }>> {
    return this.store.busy(actor)
  }

  async addInput(actor: Actor, taskId: string, text: string, source: 'chat' | 'supplement', expectedVersion?: number): Promise<number> {
    return this.store.addInput(actor, taskId, text, source, expectedVersion)
  }

  async inputVersions(taskId: string): Promise<{ accepted: number; processed: number } | undefined> {
    return this.store.inputVersions(taskId)
  }

  async inputs(taskId: string): Promise<TaskInput[]> {
    return this.store.inputs(taskId)
  }

  async setProcessedVersion(taskId: string, version: number): Promise<void> {
    this.store.setProcessedVersion(taskId, version)
  }

  async appendSubtasks(actor: Actor, taskId: string, subtasks: readonly NewSubtask[]): Promise<string[]> {
    return this.store.appendSubtasks(actor, taskId, subtasks)
  }

  async counts(actor: Actor): Promise<TaskCounts> {
    return this.store.counts(actor)
  }

  async recentFailures(actor: Actor, limit: number): Promise<{ id: string; goal: string; error: string; updatedAt: number }[]> {
    return this.store.recentFailures(actor, limit)
  }

  async failInterrupted(): Promise<number> {
    return this.store.failInterrupted()
  }

  async request(actor: Actor, kind: string, requestId: string): Promise<RequestRecord | undefined> {
    return this.store.request(actor, kind, requestId)
  }

  async claimRequest(actor: Actor, kind: string, requestId: string, digest: string, runId: string, conversationId: string, ttlMs: number): Promise<RequestRecord | undefined> {
    return this.store.claimRequest(actor, kind, requestId, digest, runId, conversationId, ttlMs)
  }

  async bindRequest(actor: Actor, kind: string, requestId: string, runId: string, conversationId: string): Promise<void> {
    this.store.bindRequest(actor, kind, requestId, runId, conversationId)
  }

  async finishRequest(actor: Actor, kind: string, requestId: string): Promise<void> {
    this.store.finishRequest(actor, kind, requestId)
  }

  async releaseRequest(actor: Actor, kind: string, requestId: string): Promise<void> {
    this.store.releaseRequest(actor, kind, requestId)
  }

  async close(): Promise<void> {
    this.store.close()
  }
}
