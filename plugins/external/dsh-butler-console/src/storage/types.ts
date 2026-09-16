/**
 * 牛马大总管工作台的异步存储接口与记录类型。
 *
 * 接口蓝本是原 SQLite 版 `TaskStore`（现为测试双实现 tests/helpers/sqlite-test-store.ts）的
 * 全部公开操作（31 个方法异步化），原子性语义在存储实现内闭合：多行写入由实现收敛为单事务，
 * 调用方不拼多步读写。绑定规格见《非框架插件业务库 PostgreSQL 默认方案》§2 与 §3。
 *
 * 这里的记录类型从原 `store.ts` 平移而来；任务与子任务的状态取值仍复用 `task-model.ts`，
 * 不在别处另造。
 */

import type { Actor, AgentArtifact } from '@dsh-plugin-manager/plugin-kit'
import type { SubtaskState, TaskState } from '../task-model.ts'

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
  /**
   * 已接受的需求版本，从 1 开始。
   *
   * 第一条需求就是版本 1，之后每接受一条补充加一。**接受不等于处理完成**：汇总前要
   * `acceptedVersion === processedVersion` 才算处理到了最新输入。
   */
  readonly acceptedVersion: number
  /** 管家已经处理到的版本。 */
  readonly processedVersion: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly finishedAt: number | null
  readonly subtasks: readonly SubtaskRecord[]
}

/**
 * 一次被接受的需求或补充。
 *
 * 原文留着：汇总要能核对「最新一条到底说了什么」，只存一个版本号是不够的。
 */
export interface TaskInput {
  readonly version: number
  readonly text: string
  /** `chat` 是最初那条需求，`supplement` 是后来的补充。 */
  readonly source: 'chat' | 'supplement'
  readonly createdAt: number
}

/** 派单时固定下来的上游材料来源快照项；管家内部结构，不进公共协议。 */
export interface ButlerInputRef {
  readonly subtaskId: string
  readonly logicalId: string
  /** 上游该次有效尝试的状态；只记录权威值，不推断。 */
  readonly state: SubtaskState
  /** 上游协作返回原文（未裁剪）；位置型材料不构成可消费材料。 */
  readonly text: string
  /** 上游交回的位置型材料，仅作为来源记录。 */
  readonly artifacts: readonly AgentArtifact[]
  /** 上游结构化外部待办；取自权威声明，不作推断。 */
  readonly externalPending?: { readonly reason: string; readonly next?: string }
}

/**
 * 派单材料快照的读取结论。**只有 `unfixed` 允许首次固定**，其余三种都不许拿当前上游结果补造。
 *
 * - `unfixed`：确实还没派出去过（列是空的、状态还是排队中、从未开始）；
 * - `unknown`：派出过但没留下材料（旧版本记录），来源未知；
 * - `damaged`：列里有值但读不出来（损坏 JSON／形状或版本非法）；
 * - `fixed`：已固定的合法快照。
 */
export type ButlerInputRefsKind = 'unfixed' | 'unknown' | 'damaged' | 'fixed'

/** 员工一次协作返回的内部留存：原文与结构化外部待办。 */
export interface ButlerMemberReturn {
  readonly protocol: 1
  readonly text: string
  readonly externalPending?: { readonly reason: string; readonly next?: string }
}

/**
 * `depends_on` 列的读取结论。
 *
 * `valid` 是已解析的合法列表；`damaged` 是解析失败或形状非法（损坏即拒）。损坏时
 * `dependsOn` 为空数组，编排层必须拒派 —— 与 inputRefs/memberReturn 同原则，不再静默
 * 降级为「没有前置」（依赖重判方案 §3 条目 4）。拒派语义由编排层消费，存储层只暴露分类。
 */
export type ButlerDependsOnKind = 'valid' | 'damaged'

/** 一条子任务记录。 */
export interface SubtaskRecord {
  readonly id: string
  readonly seq: number
  /**
   * 这条尝试对应的**目标**标识。
   *
   * 同一个目标重做几次，几次尝试共用它 —— 结论按目标算，不按尝试算，否则「重试成功」
   * 会被前面那次已经作废的失败拉低。
   */
  readonly logicalId: string
  /** 替代了哪一条尝试；首次尝试为空字符串。 */
  readonly supersedes: string
  /**
   * 前置目标的标识；空数组表示没有前置。
   *
   * 只在**前置成功**时才派这一步。前置失败、取消、还在等人回话、或者带着外部待办时都不派，
   * 并如实说明「前提没有满足」—— 不伪造一次员工报错。取值是否可信看 {@link dependsOnState}。
   */
  readonly dependsOn: readonly string[]
  /** `depends_on` 列的读取结论（见 {@link ButlerDependsOnKind}）；`damaged` 时一律拒派。 */
  readonly dependsOnState: ButlerDependsOnKind
  /** 这一步是否真的需要外部动作（采用、确认、发布）已经办完；由计划声明。 */
  readonly requiresExternalAction: boolean
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
  /**
   * 派单时固定的上游材料快照；只在 {@link inputRefsState} 为 `fixed` 时有值。
   *
   * `undefined` 本身分不出三种情况（还没派过／旧记录没留材料／读不出来），判断能不能首次
   * 固定要看 `inputRefsState`，只看这个字段会把「未知」当成「还没固定」。
   */
  readonly inputRefs: readonly ButlerInputRef[] | undefined
  /**
   * 快照为什么是这个值 —— **只有 `unfixed` 允许首次固定**（取值含义见 {@link ButlerInputRefsKind}）。
   *
   * 旧已派出的未知与损坏都必须拒绝派单：拿此刻的上游结果补一份来源等于伪造历史；损坏的那份
   * 又写不回库，员工收到的材料会和库里记的对不上。
   */
  readonly inputRefsState: ButlerInputRefsKind
  /** 员工协作返回原文与结构化外部待办；`undefined` 表示未知（旧记录）。 */
  readonly memberReturn: ButlerMemberReturn | undefined
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

/** 状态计数，供右栏指标卡使用。 */
export interface TaskCounts {
  readonly running: number
  readonly waitingUser: number
  /** 材料已交回、还有事在别处等着办。与「等人回话」分开计数：等的东西不一样。 */
  readonly externalPending: number
  /** 一部分成、一部分没成。与「已交差」分开：那是后端给的结论，不是界面数出来的。 */
  readonly partial: number
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
  /** 目标标识；不传时由存储层按顺序分配（`g1`、`g2`…）。 */
  readonly logicalId?: string
  /** 替代了哪一条尝试；首次尝试不传。 */
  readonly supersedes?: string
  /** 前置目标的标识；不传表示没有前置。 */
  readonly dependsOn?: readonly string[]
  /** 这一步是否真的需要外部动作（采用、确认、发布）已经办完；不传按不需要算。 */
  readonly requiresExternalAction?: boolean
}

/** 运行历史查询条件。 */
export interface HistoryQuery {
  readonly offset: number
  readonly limit: number
  readonly keyword: string
  /** 空字符串表示不按状态过滤。 */
  readonly state: string
  /**
   * 只取某个会话的活；省略或空串表示不按会话过滤。
   *
   * 打开历史会话时按会话取，而不是「拉一页再在页面上筛」：会话一多，更早的那个
   * 就会落在第一页之外，页面把它显示成没派过活 —— 记录明明在库里，只是没被取到。
   */
  readonly conversationId?: string
}

/**
 * 牛马大总管工作台的异步业务存储。
 *
 * 所有查询都按 owner 过滤：会话和任务属于登录用户，不因为知道 id 就能读到。所有权校验、
 * 幂等、输入版本、快照首次固定与 unknown/damaged 分类语义与原 `TaskStore` 一致，只是异步化。
 *
 * 错误约定：可用性/结构故障以 {@link StorageError}（`./errors.ts` 的稳定码）抛出，调用方映射
 * 503；业务拒绝（归属不存在、版本冲突、终态后写入）仍以 kit 的 `AccessError`（404/409）抛出。
 */
export interface ButlerStorage {
  /**
   * 校验库结构与版本（方案 §2.5 启动序列）。
   *
   * 建池后调用；`schema_version` 缺表归类 `storage_schema_missing`，版本不符归类
   * `storage_schema_version`（版本号只核验、不自动改写：迁移由显式工具执行）。校验失败或
   * 未先通过校验时，其余读写一律以同一错误拒绝 —— 未就绪即不服务。
   */
  init(): Promise<void>

  /**
   * 【§3 新增专用原子操作】等待超时原子结账。
   *
   * 仅当子任务此刻仍处于 `waiting_user` 时，用单条条件 UPDATE 把它置为 `failed`（只写
   * `error`，不碰 `result`：材料是成员已经交回的东西，超时不该把它抹掉），返回是否发生了
   * 结账。原「读 task→判 waiting_user→写 failed」的检查-写入窗口由守卫闭合；任务终态的
   * 归并仍由调用方在结账成功后按既有口径处理。
   */
  expireWaitingSubtask(taskId: string, subtaskId: string, error: string): Promise<boolean>

  /** 读取该用户的成员别名；没有配过别名的成员不在表里。 */
  aliases(actor: Actor): Promise<Map<string, { displayName: string; accent: string }>>

  /**
   * 写入一位成员的显示别名。
   *
   * 空字符串表示「恢复默认」，此时直接删除该行，页面回落到插件声明的名称。
   */
  setAlias(actor: Actor, agentId: string, displayName: string, accent: string): Promise<void>

  /** 保存一位成员的头像。只接受已核验过的图片类型，大小由调用方限制。 */
  setAvatar(actor: Actor, agentId: string, bytes: Uint8Array, contentType: string): Promise<void>

  /** 读取一位成员的头像；没有上传过时返回 undefined。 */
  avatar(actor: Actor, agentId: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined>

  /** 删除一位成员的头像，保留别名。 */
  clearAvatar(actor: Actor, agentId: string): Promise<void>

  /** 为用户登记一个牛马大总管会话；重复登记不改变已有归属。 */
  reserveConversation(id: string, actor: Actor): Promise<void>

  /**
   * 为「打开一个会话」登记归属，新会话就地创建。
   *
   * 与 {@link assertOwner} 的区别在于**新会话应该被接受**：会话 id 由页面在客户端生成，
   * 首次发消息时库里还没有这条记录。已经属于他人时不泄露存在性：与 {@link assertOwner}
   * 返回同样的错误。
   */
  openOrReserveConversation(id: string, actor: Actor): Promise<void>

  /** 校验会话归属。未知、他人或已删除的会话返回同一个结果，不泄露存在性。 */
  assertOwner(conversationId: string, actor: Actor): Promise<void>

  /** 记录一条用户消息，首条消息决定会话标题。 */
  touchConversation(conversationId: string, actor: Actor, title?: string): Promise<void>

  /** 侧栏列表；按最近使用排序。 */
  listConversations(actor: Actor, limit: number): Promise<ConversationSummary[]>

  /**
   * 写入一份新计划。任务、首版输入与全部子任务在**同一个事务**里落盘，避免出现半个计划。
   *
   * 开头那条需求就是**版本 1**，与它一起写进输入表。子任务编号（seq）与目标标识
   * （logicalId）的分配在这个事务里完成：新任务的行锁由本次 INSERT 取得，并发的追加
   * 编号操作会在行锁上排队，不会撞号（§3 createTask 规格）。
   */
  createTask(input: {
    id: string
    conversationId: string
    actor: Actor
    goal: string
    note: string
    subtasks: readonly NewSubtask[]
  }): Promise<void>

  /** 更新任务状态；`finishedAt` 只在结束态写入一次。 */
  setTaskState(id: string, state: TaskState, patch?: { note?: string; summary?: string; error?: string }): Promise<void>

  /**
   * 写下「这一轮干完了」的终态，**并与输入版本核对合并为同一条条件 UPDATE**（§3）。
   *
   * 宣称成功的终态（`completed` / `partial`）只在 `accepted_version <= processed_version`
   * 的行上生效并 RETURNING 确认；还有已接受未处理的输入时**什么都不写**并返回 `false`。
   * 取消与失败没有宣称成功，直接按 {@link setTaskState} 写入并返回 `true`。
   */
  commitTaskState(id: string, state: TaskState, patch?: { note?: string; summary?: string; error?: string }): Promise<boolean>

  /**
   * 更新子任务状态。`startedAt` 在首次进入执行态时写入，之后保持不变。
   *
   * 保持**单条 UPDATE** 写法（SET 表达式引用旧值），禁止读-改-写（§3）：
   *
   * - `artifacts`、`conversationId`、`result`、`error`、`memberReturn` 只在传了的时候覆盖；
   * - `inputRefs` 按**首次固定**守卫落库：只有「列还是空、从未开始（started_at 为空且状态
   *   还是排队中）」才写入；已固定的、旧已派出却留空的未知、以及损坏的值一律原样保留；
   * - 状态迁移按 `task-model.ts` 的转移表设守卫（依赖重判方案 §3 条目 5）：表外迁移与
   *   相同状态幂等重放之外的条件不满足时，本条 UPDATE 不生效（保持原样返回，不抛错、
   *   不产生新的拒绝路径）；`failed→queued` 不放开。
   */
  setSubtaskState(
    taskId: string,
    subtaskId: string,
    state: SubtaskState,
    patch?: {
      result?: string
      error?: string
      artifacts?: readonly AgentArtifact[]
      /** 派单材料快照。只在「确实还没派出去过」时才落库（首次固定）。 */
      inputRefs?: readonly ButlerInputRef[]
      /** 协作返回原文：不传表示保留旧值；合法空文本要编码成含 protocol/text 的 JSON。 */
      memberReturn?: ButlerMemberReturn
      conversationId?: string
    },
  ): Promise<void>

  /** 读取一条任务的完整记录；不存在或不属于该用户时返回 undefined。 */
  task(actor: Actor, id: string): Promise<TaskRecord | undefined>

  /** 运行历史分页。`nextOffset` 为 null 表示没有更多。 */
  history(actor: Actor, query: HistoryQuery): Promise<{ items: TaskSummary[]; total: number; nextOffset: number | null }>

  /**
   * 该用户的任务里，每位成员此刻占着的活。
   *
   * `queued` **不算占用** —— 那是计划里还没派出去的步骤。同一位成员出现多条时留**最早
   * 派出去**的那条（started_at 为空的排在最前，与原 SQLite 排序方向一致）。
   */
  busy(actor: Actor): Promise<Map<string, { taskId: string; subtaskId: string; state: SubtaskState }>>

  /**
   * 接受一条新的需求或补充，返回新版本号。
   *
   * 版本递增、原文落库、终态与 expectedVersion 复核在**同一个事务**里完成：先对任务行
   * `SELECT … FOR UPDATE`，再在行锁内复核（§3 addInput 规格），调用方在事务外的旧结论
   * 不参与判定。任务不存在抛 `task_not_found`（404），已终态抛 `task_already_finished`
   * （409），版本对不上抛 `version_conflict`（409）。输入表 (task_id, version)
   * 主键冲突同样映射 `version_conflict`（409 语义，不是 500）。
   *
   * @param expectedVersion 调用方认为的当前版本；对不上就拒（并发依据）。不传表示不校验。
   */
  addInput(actor: Actor, taskId: string, text: string, source: 'chat' | 'supplement', expectedVersion?: number): Promise<number>

  /** 这一轮接受与处理到的输入版本；任务不存在时返回 undefined。 */
  inputVersions(taskId: string): Promise<{ accepted: number; processed: number } | undefined>

  /** 一条任务收到过的全部需求与补充，按版本排序。 */
  inputs(taskId: string): Promise<TaskInput[]>

  /** 把处理进度追平到某个版本（只往前追，不回退已处理记录）。 */
  setProcessedVersion(taskId: string, version: number): Promise<void>

  /**
   * 往一个已经存在的任务追加子任务，返回它们的编号。
   *
   * seq 与 logicalId 的分配在事务内、对任务行 `SELECT … FOR UPDATE` 之后进行（§3）：
   * 编号接着现有的往下排，不复用也不跳号，并发的追加在行锁上串行化。任务不存在或不属于
   * 该用户抛 `task_not_found`（404）。
   */
  appendSubtasks(actor: Actor, taskId: string, subtasks: readonly NewSubtask[]): Promise<string[]>

  /** 用户的全局状态计数，用于右栏指标卡。 */
  counts(actor: Actor): Promise<TaskCounts>

  /** 最近失败的任务摘要，最多若干条。 */
  recentFailures(actor: Actor, limit: number): Promise<{ id: string; goal: string; error: string; updatedAt: number }[]>

  /**
   * 把上次进程退出时仍在执行的任务标记为中断，避免页面上出现永远转圈的状态。
   *
   * 任务与子任务两条 UPDATE 在**同一个事务**里完成（§3 重启恢复规格），返回受影响的
   * 任务数。归入启动序列：init 通过后、对外服务前调用一次。
   */
  failInterrupted(): Promise<number>

  /** 读一条写请求的幂等记录；没有受理过时返回 undefined。 */
  request(actor: Actor, kind: string, requestId: string): Promise<RequestRecord | undefined>

  /**
   * 占住一个 `requestId`，**在执行之前**落库，并原子地决出唯一胜者（§3 claimRequest 规格）。
   *
   * 唯一约束 (owner_namespace, owner_id, kind, request_id) 兜底：`INSERT … ON CONFLICT
   * DO NOTHING` 之后同事务回读。赢（插入成功）返回 `undefined`；已经有人占过则返回那条
   * 既有记录，调用方据它做 digest 冲突与结果不明判定，绝不第二次执行。
   *
   * 顺带清掉过期记录，**只清已完成的**：`claimed` 意味着「可能已经执行过、结果不明」，
   * 它是防重的唯一依据，永不按时间清除。
   *
   * @returns 赢了返回 `undefined`；已经有人占过则返回那条既有记录。
   */
  claimRequest(actor: Actor, kind: string, requestId: string, digest: string, runId: string, conversationId: string, ttlMs: number): Promise<RequestRecord | undefined>

  /** 把受理阶段才知道的会话与轮次标识补进占位记录（只补空标识，不覆盖已绑定的）。 */
  bindRequest(actor: Actor, kind: string, requestId: string, runId: string, conversationId: string): Promise<void>

  /** 标记这一轮已经跑完。 */
  finishRequest(actor: Actor, kind: string, requestId: string): Promise<void>

  /**
   * 撤掉一次占位。只在「受理本身失败了」时用：那次请求根本没有开始执行，留着记录会让
   * 同一个 `requestId` 再提交时被当成「结果不明」。
   */
  releaseRequest(actor: Actor, kind: string, requestId: string): Promise<void>

  /**
   * 有界关闭（§2.6）：等待在途事务与连接归位，超过上限（5 秒）放弃等待并记录，池终结
   * 交给进程退出。关闭后其余操作一律拒绝。
   */
  close(): Promise<void>
}
