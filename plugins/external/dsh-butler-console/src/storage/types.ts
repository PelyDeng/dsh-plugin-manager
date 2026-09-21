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

import type { Actor, AgentAction, AgentArtifact, AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
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
  /**
   * 这次的**验收口径**：交回什么才算完成。空串表示没有声明口径。
   *
   * 由 `butler_plan` 在定目标时给出，落库后随每一次派单交给执行方，也用来核验「口径里
   * 提到的产出物」是否真的以材料交回。它约束的是自洽（口径与材料都是执行侧自报的），
   * 不是交付完整性判定。
   */
  readonly acceptance: string
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

/**
 * 员工一次协作返回的内部留存：原文、结构化外部待办，以及**自检结论**。
 *
 * ⚠️ `selfCheck` 必须留在这里。执行结果里带着它，而落库这一步一度把它丢掉——那样重启之后
 * ⑦ 的自检判据永远拿不到值，只能按"缺省 = 通过"处理，**等于所有交付都被标记为自检通过**。
 * 判据要能区分 `passed` / `unverifiable` / `failed` 和**缺省**（执行方没实现自检）四种情形。
 */
export interface ButlerMemberReturn {
  readonly protocol: 1
  readonly text: string
  readonly externalPending?: { readonly reason: string; readonly next?: string }
  /**
   * 待用户确认的操作（**呈现数据**，形状来自 kit 的 `AgentAction`）。
   *
   * 它与 `text`/`externalPending` 一起落库：操作卡必须在**刷新之后**还能画出来，而事件日志只
   * 保证"当时发过"。这里存的是呈现面；确认凭据（nonce）不在其中——它始终留在执行方自己的记录里。
   */
  readonly actions?: readonly AgentAction[]
  readonly selfCheck?: AgentSelfCheck
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
/**
 * 一条子任务的裁决结论。
 *
 * ⚠️ **与另外两个同名的 "verdict" 不是一回事**，读代码时别混：
 * - 执行侧的 `selfCheck`（`AgentSelfCheck`，运行时回报的四态）—— 是**成员自己**对产出的自检；
 * - 依赖侧的 `dependencyVerdict`（`butler.ts`）—— 是"前置能不能派"的判定；
 * - 这里的 `SubtaskVerdict` —— 是**协调方（牛马大总管）对已终结子任务的裁决**。
 *
 * 取值：
 * - `''`：**还没裁决过**（列默认值），**不是**"默认通过"；
 * - `accept`：采纳，但必须附 `evidence` 且程序化核验它能在该步结果里找到；
 * - `rework`：重做（追加一次尝试）；
 * - `replace`：换人重做（要预检 `newAgentId` 可调度）；
 * - `unverified`：如实标注"没顾上过目"——`accept` 的证据核验不过、或成员没有自检能力时**降级**
 *   到这里。它**不进终态**（设计 §5.4）。
 */
export type SubtaskVerdict = '' | 'accept' | 'rework' | 'replace' | 'unverified'

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
  /**
   * 这一步自己的验收口径；**空串就是这一步没有口径**（不是"沿用任务级口径"）。
   *
   * 与任务级分开存：同一次任务里，不同子任务的产出物种类不同（一个交草稿、一个交发布
   * 确认），只看任务级口径会把它们判成同一个标准。
   */
  readonly acceptance: string
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
  /**
   * 裁决结论（`butler_verdict` 写入面的读回值）。
   *
   * **空串 = 还没裁决过**，不是"默认通过"——这一列从建库起默认就是空串，把空串读成 `accept`
   * 会让所有历史行凭空获得一次没人做过的裁决。
   */
  readonly verdict: SubtaskVerdict
  /** 裁决理由（模型给的一句话）；没裁决过时为空串。 */
  readonly verdictReason: string
  /**
   * `accept` 的证据。
   *
   * 它与 `reason` 分开存：`accept` 必须**程序化核验**证据能在该步结果里找到，核验不过要
   * 降级成 `unverified`，而"为什么降级"要能看出来是"证据找不到"而不是"模型没说理由"。
   *
   * ⚠️ 类型是 `unknown` 而不是 `string`：**新库这一列是 JSONB**（pg 驱动读回对象/数组），
   * 插件自带的旧表本次仍是 TEXT（读回字符串）。当字符串用会在切库后静默出错。
   */
  readonly verdictEvidence: unknown
  /**
   * 裁决时的观察记录（当前留给后续期用）；没裁决过时为空串。
   *
   * ⚠️ 同 {@link verdictEvidence}：新库是 JSONB，类型不能标成 `string`。
   */
  readonly observation: unknown
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
  /** 这一步的验收口径；**不传就是这一步没有口径**（不沿用任务级口径）。 */
  readonly acceptance?: string
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
 * 附件状态。
 *
 * `uploading` → `parsing` → `ready` 是正常路径；`failed` 与 `removed` **都留行**：
 * 失败要能说清"这个文件没成、为什么"，用户删掉的要能证明它确实被删过，而不是凭空消失。
 */
export type ButlerAttachmentStatus = 'uploading' | 'parsing' | 'ready' | 'failed' | 'removed'

/** 解析出来的一个单元（`页` / `段` / `行` / `图`）。 */
export interface ButlerAttachmentUnit {
  readonly number: number
  readonly text: string
}

/**
 * 附件的解析结果。
 *
 * 形状与 `@dsh-agents-group/document-parse` 的 `ParsedDocument` 一致，**原样落库**：存下来有两个
 * 用处——同一份文件不必每轮重解析；页面能直接显示"解析了多少页/段"。
 */
export interface ButlerAttachmentParsed {
  readonly kind: string
  readonly unit: string
  readonly totalUnits: number
  readonly characters: number
  readonly partial: boolean
  readonly units: readonly ButlerAttachmentUnit[]
}

/**
 * 一条附件记录。
 *
 * 字节本体**不在这里**：它按内容寻址存在宿主的附件服务里，这里只有 {@link original} 那个引用。
 * 表结构见 `private-deploy/db/0001_init.sql` 的 `butler_attachments`。
 */
export interface ButlerAttachmentRecord {
  readonly id: string
  /** 上传时所在的会话；还没开新会话时是空串（先传文件、再写需求是正常路径）。 */
  readonly conversationId: string
  /** 派出去时绑定的任务；还没派出去时是空串。 */
  readonly taskId: string
  readonly name: string
  /** 解析种类（`text` / `pdf` / `docx` / `image` / `binary` …）。 */
  readonly kind: string
  /** HTTP 媒体类型；只用于回放下载与展示，类型判定不看它。 */
  readonly mediaType: string
  readonly bytes: number
  readonly status: ButlerAttachmentStatus
  /** 给用户看的一句话（失败原因、解析范围提示等）。 */
  readonly message: string
  /** 由 URL 抓取而来时的原地址；本地上传为空串。 */
  readonly sourceUrl: string
  /** 宿主附件服务写回的引用（不透明结构，只原样交回读接口）；还没存好时是 undefined。 */
  readonly original: unknown
  readonly parsed: ButlerAttachmentParsed | undefined
  readonly createdAt: number
  readonly updatedAt: number
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
   * 运行时就绪探针（方案 §2.5 口径：已配置但运行中 PG 不可达 = 已装载未就绪，业务与
   * /ready 503）。
   *
   * 启动校验的缓存只证明「装载时通过」；本探针用一条有界（约 1.5 秒上限）的独立连接
   * 核实 PG 此刻可达且 schema 版本仍符合，失败以对应稳定码抛 StorageError
   * （storage_unreachable / storage_auth / storage_schema_version / storage_timeout /
   * storage_closed）。调用方据此在运行期翻转就绪状态；实现不做结果缓存。
   */
  readyProbe(): Promise<void>

  /**
   * 【§3 新增专用原子操作】等待超时原子结账。
   *
   * 仅当子任务此刻仍处于 `waiting_user` 时，用单条条件 UPDATE 把它置为 `failed`（只写
   * `error`，不碰 `result`：材料是成员已经交回的东西，超时不该把它抹掉），返回是否发生了
   * 结账。原「读 task→判 waiting_user→写 failed」的检查-写入窗口由守卫闭合；任务终态的
   * 归并仍由调用方在结账成功后按既有口径处理。
   */
  expireWaitingSubtask(taskId: string, subtaskId: string, error: string): Promise<boolean>

  /**
   * 【喊停收等待】把一个会话里所有「等你回话」的子任务收成 `cancelled`。
   *
   * 等待中的步骤没有活跃 run，喊停只看执行中的轮次时它们永远喊不停（#14）。这里按
   * **会话 + owner** 圈定范围，单条条件 UPDATE 批量收掉（守卫与 `expireWaitingSubtask`
   * 同款：只有此刻仍是 `waiting_user` 的行会被改写），返回受影响的 `(taskId, subtaskId)`
   * 列表供调用方做任务级收尾。材料（`result` / `memberReturn`）不动。
   */
  cancelWaitingSubtasks(actor: Actor, conversationId: string, error: string, taskId?: string): Promise<readonly { taskId: string; subtaskId: string }[]>

  /**
   * 【等待超时兜底】列出该 owner 名下明显超过时限仍挂在等待里的子任务。
   *
   * 等待超时靠进程内存闹钟；闹钟丢失时（挂不上、进程内被清）等待会挂到下次重启
   * （生产实测 50+ 分钟，#6）。这里按 `started_at < now - minAgeMs` 圈定：`started_at`
   * 是首次进入执行的时间，等待必然发生在它之后，拿它当兜底口径只会提前收、不会漏收。
   * 只读不改写：结账仍走 {@link expireWaitingSubtask} 的原子路径。
   */
  staleWaitingSubtasks(actor: Actor, minAgeMs: number): Promise<readonly { taskId: string; subtaskId: string; agentId: string }[]>

  /**
   * 【跨任务待办归属】同一成员会话里、别的任务已经声明过的待办 id 集合。
   *
   * 待办清单按成员会话共享，而「一张卡只归第一次声明它的那一步」的判定此前只在本任务
   * 内做——同会话先后两个任务时，后者的步骤会把前者已声明的卡整份收进名下（生产 #13：
   * 点挂错的那张卡，结算的是错的任务）。返回集合供派发落库前过滤。
   */
  siblingClaimedActionIds(actor: Actor, memberConversationId: string, excludeTaskId: string): Promise<ReadonlyMap<string, string>>

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

  /** 新建一条附件记录。此时字节还没存好，状态是 `uploading`。 */
  attachmentInsert(actor: Actor, record: ButlerAttachmentRecord): Promise<void>

  /**
   * 整条改写一条附件记录的可变列，返回受影响行数。
   *
   * 做成"整条写"而不是"按字段打补丁"：调用方本来就持有整条记录，而 `original` / `parsed`
   * 是 JSONB，用 `COALESCE` 式的补丁写法分不出"没打算改"和"要写成 null"——那正是这一列
   * 最需要分清的地方。
   */
  attachmentWrite(actor: Actor, record: ButlerAttachmentRecord): Promise<number>

  /** 读一条附件；不存在或不属于该用户时返回 undefined。 */
  attachment(actor: Actor, id: string): Promise<ButlerAttachmentRecord | undefined>

  /**
   * 某个会话下**还没绑到任务**的附件（也就是输入框上方那一条"待发"），按创建时间倒序。
   *
   * 绑上去的已经发出去了，不再算待发：混进来的话，用户刷新页面会看到一个自己明明已经发出去的
   * 文件还挂在输入框上，于是又发一遍。
   */
  attachments(actor: Actor, conversationId: string): Promise<ButlerAttachmentRecord[]>

  /**
   * 把若干附件绑到一个任务上（写 `task_id` 与会话），返回真正被改写的行数。
   *
   * ⚠️ **已删除的附件不绑**：把一条 `removed` 的行绑上去，派单简报里就会出现一个用户以为
   * 已经删掉的文件。调用方据返回的行数核对"是不是都绑上了"。
   */
  attachmentBind(actor: Actor, ids: readonly string[], taskId: string, conversationId: string): Promise<number>

  /**
   * 某个任务收到的附件（派单时读）。
   *
   * 只有 `taskId` 没有 actor，与 `inputs(taskId)` 同一口径：`butler_tasks.id` 是主键，
   * 一个 task 只对应一个 owner，任务归属在派单之前已经核验过。
   */
  taskAttachments(taskId: string): Promise<ButlerAttachmentRecord[]>

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
   * **全量**管家会话与移除围栏状态（正常会话 `state=''`）。启动时加载进同步镜像——
   * kit 的 `conversationRemover` 在同步上下文里调 `record`（存在性判定）与 `mark`。
   */
  conversationRemovals(): Promise<{ key: string; state: string }[]>

  /**
   * 落库一条围栏状态（`pending` / `failed` / `removed`）。由同步镜像 write-behind 调用，
   * 失败由调用方记录——镜像先行保证运行期拦截不落空，落库保证重启后状态还在。
   */
  markConversationRemoved(actor: Actor, conversationId: string, state: string): Promise<void>

  /**
   * 清理会话的管家业务数据：任务、子任务、任务输入、幂等请求与附件索引一并删除。
   * 在移除围栏标成 `removed` 之后调用；不删 `dsh_conversations` 行（行由共享表的生命周期管理）。
   */
  deleteConversationRows(actor: Actor, conversationIds: readonly string[]): Promise<number>

  /**
   * 删除一条**终态**任务（失败记录清理用）：子任务、任务输入与附件索引一并删除。
   * 活跃（queued/running/waiting_user/summarizing 任务或活跃子任务）返回 `false`，由调用方拒绝。
   */
  deleteTask(actor: Actor, taskId: string): Promise<boolean>

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
    /** 这次的验收口径（`butler_plan` 顶层声明）；不传表示没有声明。 */
    acceptance?: string
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
   *
   * **返回受影响行数**：0 表示这次迁移不合法（或这条子任务不存在）。写入白名单由迁移表生成
   * （{@link import('../task-model.ts').subtaskTransitionSources}），所以 0 行只该出现在
   * "并发抢先改写"上 —— **结账写入**（成员交回结论、老板办完确认）必须核验它，否则一次
   * 静默丢弃就等于"这件事从没发生过"，等它的下游会永远留在队列里。
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
      /** goal 充实（中继轮）的 v2 目标：不传表示保留旧值。v1 留痕在计划快照里。 */
      goal?: string
    },
  ): Promise<number>

  /**
   * 落一条裁决结论（`butler_verdict` 的写入面）。
   *
   * **一次只写一条**：裁决是按子任务给出的，批量裁决由调用方逐条调用——这样"哪一条写不进去"
   * 能精确定位，一条失败也不会让整批静默回滚。
   *
   * **返回受影响行数**，调用方必须做**写后核验**：0 表示这条子任务不存在或不属于该任务，
   * 那是编程错误，不能静默吞掉（设计 §5.4）。
   *
   * 与 `setSubtaskState` 同样保持**单条 UPDATE** 写法。这里**没有状态迁移守卫**：裁决发生在
   * 子任务已经终结之后，它不改状态，只记结论。
   *
   * ⚠️ **`actor` 是任务的归属，不是"谁点的裁决"**：裁决由牛马大总管自己发起（不是用户请求），
   * 但写入必须带 owner 条件——漏了它，一次编程错误就会改到别人 owner 的任务上。
   */
  setSubtaskVerdict(
    actor: Actor,
    taskId: string,
    subtaskId: string,
    patch: {
      verdict: SubtaskVerdict
      /** 裁决理由（模型给的一句话）。 */
      reason?: string
      /** `accept` 的证据；程序化核验能在该步结果里找到才允许 `accept`。 */
      evidence?: string
      /** 观察记录，留给后续期。 */
      observation?: string
    },
  ): Promise<number>

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
