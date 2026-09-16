/**
 * Agent 的声明式定义。
 *
 * 这个文件是「机制在运行时、策略在业务」的分界线：业务把 persona、工具、输出变换与结果投影
 * 声明成钩子，**时序与状态由运行时代管**（何时调、按什么顺序调、失败了怎么办、按什么节奏发布）。
 *
 * ## 钩子为什么这样切
 *
 * 早期方案把 `redact` 设计成一个有状态签名 `(text, { opaqueValues, releaseTail }) => string`。
 * 那不是"参数不够"，而是**表达不了**：
 *
 * - `opaqueValues` 只在 `tool/result` 事件到达时产生（`closedoff/src/participant.ts:152-156`），
 *   而那个签名拿不到工具结果 → 它**恒为空** → 敏感值替换永不发生。这是**安全失效**，不是展示问题。
 * - `releaseTail` 在 `turn/end` 才翻转，签名同样拿不到那一刻。
 * - 思考快照要按 step 累积、并在 `assistant/attempt` 失败时**丢弃**该 step 的累积（`live-output.ts:122`
 *   的 `discard(step)`）——"删除已经发生的输入"用纯函数表达不了。
 *
 * 所以拆成三个钩子（`redact` / `opaqueFromToolResult` / `projectReasoning`），每个只做**纯文本变换**，
 * 触发权与按步状态都留在运行时。
 *
 * 同理，结果投影合并为一个 `projectResult`，而不是 `extractAnswer` / `classifyResult` /
 * `composeResult` / `artifacts` / `externalPending` 五个：它们共享同一份会话历史与业务状态
 * （blog 判候选稿要 `await storage.get()`，组装又要用同一批候选取长度预算），拆开会让业务在
 * 四处重复查询同一份数据。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type Schema from '@deepseek-ai/schemastery'
import type { ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type {
  ParticipantArtifact,
  ParticipantExternalPending,
  ParticipantStatus,
} from './contract.ts'
import type { AgentStoragePort } from './storage/ports.ts'

/** 业务注册工具时拿到的上下文。 */
export interface AgentToolContext {
  /** 业务自己的存储门面；`createParticipant` 没有注入 storage 时为 `undefined`。 */
  readonly storage: AgentStoragePort | undefined
  /** 当前会话 id；工具在会话作用域外被调用时为 `undefined`。 */
  readonly conversationId: string | undefined
}

/** 会话历史里的一条消息。 */
export interface TurnMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  /** 可展示的思考快照（已按业务口径脱敏）。 */
  readonly thinking?: string
  readonly time: number
}

/** 一轮会话的历史，供结果投影与自检使用。 */
export interface TurnHistory {
  readonly messages: readonly TurnMessage[]
  /** 会话 id；没有会话时为空串。 */
  readonly conversationId: string
  /** 本轮模型给出的最终正文（可能为空：模型只调了工具没说话）。 */
  readonly finalText: string
}

/** 结果投影的输入。 */
export interface ResultContext {
  readonly history: TurnHistory
  /**
   * 派单时收到的请求。
   *
   * `acceptance` 是这一步的验收口径（可能没有）；`reworkOf` 表示这次是重做、填被重做的子任务 id。
   * 两者都由协调方给出，业务只用它们做自检与措辞，**不要**据此改变业务语义。
   */
  readonly request: {
    readonly message: string
    readonly acceptance?: string
    readonly reworkOf?: string
  }
  /** 业务自己的存储门面；「查候选稿」这类投影需要它读业务状态。 */
  readonly storage: AgentStoragePort | undefined
}

/** 一轮会话投影出的交回结果。 */
export interface ProjectedResult {
  readonly status: ParticipantStatus
  readonly text: string
  readonly artifacts?: readonly ParticipantArtifact[]
  readonly externalPending?: ParticipantExternalPending
  /** `status: 'waiting'` 时要用户回答的问题。 */
  readonly question?: string
}

/** `judge` 的输入（⑧ 有界自修正用）。 */
export interface JudgeInput {
  readonly result: ProjectedResult
  /** 这一步的验收口径；没有声明时为 `undefined`。 */
  readonly acceptance: string | undefined
}

/** `judge` 的结论。 */
export interface JudgeResult {
  /** `true` 表示达标，不必重跑。 */
  readonly ok: boolean
  /** 不达标时交给下一次尝试的说明（会进重做请求）。 */
  readonly reason?: string
}

/** 思考投影的上下文。 */
export interface ReasoningProjectionContext {
  /**
   * 从工具结果里提取出的、**不可外传的标识**。
   *
   * 由运行时代管累积：每次 `tool/result` 到达就调一次
   * {@link AgentDefinition.opaqueFromToolResult}，把结果并进这个集合，再传给投影。
   */
  readonly opaqueValues: readonly string[]
  /** 本轮是否已收尾：`true` 时最后一段还没写完的内容也可以发布。 */
  readonly releaseTail: boolean
}

/**
 * 一个 Agent 的全部业务声明。
 *
 * **身份与声明不在这里重复**：`id` / `displayName` / `description` / 分类由 `mount()` 从
 * `AgentMountContext` 取（`host.ts:51-57` 写明分类只有那一个权威来源，子包自己再写一份就会与
 * 清单漂移，而漂移的后果是本 Agent 的工具全部不可见、界面上还完全看不出来）。这里的三项是
 * 运行时需要的那一份，取值由 `mount()` 注入。
 */
export interface AgentDefinition {
  /** 与插件清单 `deepseekPlugin.id` 一致。 */
  readonly id: string
  readonly displayName: string
  readonly description: string

  // —— 业务内容 ——

  /** 系统提示词里这个 Agent 的人设。 */
  readonly persona: string
  /**
   * 业务工具。
   *
   * 运行时在 **agent 作用域**内注册与限制：宿主不允许在插件上下文里做工具限制，
   * 落到插件级会波及所有 Agent 并被直接拒绝。
   */
  readonly tools: (ctx: AgentToolContext) => readonly ToolDescriptor[]

  // —— 输出管线：三个独立钩子，时序与状态由运行时代管 ——

  /** 正文与状态行的**无状态**文本变换（脱敏）。缺省 = 不改写。 */
  readonly redact?: (text: string) => string

  /**
   * 从工具结果里提取**不可外传的标识**（业务主键、内部 id）。
   *
   * **这是安全钩子。** 运行时在每次 `tool/result` 到达时调用它，把结果累积进 opaque 集合，
   * 并据此替换思考快照里的敏感值。缺省 = 不替换。
   */
  readonly opaqueFromToolResult?: (resultText: string, meta: unknown) => readonly string[]

  /**
   * 思考投影：把模型原始推理转成可展示快照。
   *
   * 运行时负责全部时序（按 step 累积、废弃尝试丢弃、回合结束收尾补发），只把 `opaqueValues`
   * 与 `releaseTail` 传进来——业务做纯文本变换。
   */
  readonly projectReasoning?: (raw: string, ctx: ReasoningProjectionContext) => string

  /**
   * 实时通道语义。
   *
   * `'delta'`（缺省）：执行方发的是**增量**，运行时代管前缀单调与发布边界。
   * `'cumulative'`：执行方发的是**累计值**，运行时按前缀算差后再走同一条发布路径
   * （blog 的思考通道是累计值）。
   */
  readonly liveMode?: 'delta' | 'cumulative'

  // —— 结果投影：一个钩子，覆盖四件事 ——

  /**
   * 把一轮会话投影成交回结果：答案抽取 / 状态判定 / 文本组装 / 产物声明。
   *
   * 缺省时运行时用**兜底投影**：正文取最终消息、状态按回合结局判定、材料为空。
   * 这条兜底必须存在——"没调交活工具"不等于失败（见 §4.3）。
   */
  readonly projectResult?: (ctx: ResultContext) => Promise<ProjectedResult>

  /** ⑧ 有界自修正的判定；缺省 = 不做业务判定（只跑程序性校验）。 */
  readonly judge?: (input: JudgeInput) => Promise<JudgeResult>

  /** 会话事件 → 状态行文案。缺省 = 不发状态行。 */
  readonly stageText?: (event: SessionEvent) => string | undefined

  /**
   * 会话事件 → 侧栏预览消息（缺省只取用户与助手的正文）。
   *
   * 有自己展示口径的业务要覆盖它：closedoff 的 `projectHistory` 会带上设备轨迹半径、
   * 工具调用摘要与思考快照，blog 的是另一套。缺省实现的强度刻意很弱——**宁可少显示，
   * 也不替业务编一份它没要求的预览**。
   */
  readonly projectHistory?: (events: readonly SessionEvent[]) => readonly {
    readonly role: 'user' | 'assistant'
    readonly text: string
    readonly reasoning?: string
    readonly time: number
  }[]

  // —— 交互与呈现 ——

  /**
   * 本轮是否需要用户补一句话才能继续。
   *
   * 这是 `status: 'waiting'` 的**唯一来源**。缺省 = 永不等待。
   * 协调侧要求子任务确实进入 `waiting_user`，且**重启后仍能恢复"在等什么"**，所以运行时
   * 必须把它持久化（`dsh_turns` 的待答问题列），不能只留在内存。
   */
  readonly needsReply?: (ctx: ResultContext) => boolean

  /** 会话标题的来源与更新；运行时复用 kit 的 `registerConversationTitles`。 */
  readonly title?: (history: TurnHistory) => string | undefined

  // —— 存储与配置 ——

  /** 业务表迁移（PG，按版本顺序）。机制表由运行时管理。 */
  readonly businessMigrations?: readonly string[]

  /** 业务配置 schema；运行时用它校验 `mount()` 收到的原始配置。 */
  readonly config: Schema<unknown>

  /**
   * ⑥ 观察的声明位，缺省 `'signal'`（本期只给信号：进度、耗时、重试次数）。
   *
   * 它**不改契约**：跨边界进度契约是封闭枚举 + 白名单投影，`'process'` 要真正生效需要另开通道。
   */
  readonly observe?: 'signal' | 'process'
}
