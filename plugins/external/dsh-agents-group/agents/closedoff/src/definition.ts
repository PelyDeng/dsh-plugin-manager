/**
 * 封闭化助手的业务声明：把散在 `index.ts` / `participant.ts` / `web.ts` 里的业务口径收成一份
 * `AgentDefinition`，逐条对应既有实现，**不改行为**。
 *
 * ## 每个钩子的出处（都读源码写，不猜）
 *
 * | 钩子 | 旧实现 | 语义 |
 * | --- | --- | --- |
 * | `persona` | `index.ts:152`（读 `persona.txt` 并 trim） | 由装配侧传入 |
 * | `tools` | `index.ts:164` | 插件级注册一次；**限制**由运行时在 agent 作用域做 |
 * | `redact` | `redaction.ts` 的 `redactVisibleText` | 正文与状态行的脱敏 |
 * | `opaqueFromToolResult` | `participant.ts:152-156` | **安全钩子**：业务主键不进思考正文 |
 * | `projectReasoning` | `participant.ts:102-103` + `presentation.ts` | 页面同一套思考投影 |
 * | `stageText` | `participant.ts:149-151` | `tool/call` 的状态行文案 |
 * | `projectResult` | `participant.ts:125-136` | 回合结局 → 交回结果（见下面的边界说明） |
 * | `projectHistory` | `web.ts:276` + `agent.ts:81-84` | 侧栏预览 |
 * | `liveMode` | `participant.ts:58` 的 `createVisibleThinking` | 增量通道 |
 *
 * ⚠️ **本文件不注册任何东西**：它只声明。注册（工具、清单、路由、侧栏入口）留在装配侧，
 * 由 `createAgentRuntime()` 与群组的 `mount()` 负责——"声明与调用点分家"正是工具从未被注册
 * 那类缺陷的成因，所以这里刻意一个副作用都没有。
 */
import type { ToolAuthorizer } from '@dsh-plugin-manager/plugin-kit'
import type {
  AgentDefinition,
  ProjectedResult,
  ReasoningProjectionContext,
  ResultContext,
} from '../../../packages/runtime/src/definition.ts'
import { Config as ConfigSchema, type Config } from './config.ts'
import type { ClosedoffGateway } from './gateway.ts'
import { collectOpaqueResultValues, projectHistory, projectReasoning } from './presentation.ts'
import { redactVisibleText } from './redaction.ts'
import { TOOL_BY_NAME } from './specs.ts'
import { registerTools } from './tools.ts'

/** 造声明要的东西：都是装配侧已经有的实例与已定稿的配置。 */
export interface ClosedoffDefinitionInput {
  /** 业务网关：工具的执行体（`index.ts:155`）。 */
  readonly gateway: ClosedoffGateway
  /** 已合并默认值的业务配置（`index.ts:146` 的 `schemaDefaults() + context.config`）。 */
  readonly config: Config
  /**
   * 人设正文（`index.ts:148-153` 从 `persona.txt` 读入并 `trim`）。
   *
   * 由装配侧读文件：读资源要 `import.meta.url` 与打包布局的知识，那是装配的事，不是声明的。
   */
  readonly persona: string
  /**
   * 工具调用前的授权复核（`index.ts:164` 传的是 `agent => manager.authorizeAgent(agent)`）。
   *
   * 运行时路径上换成 `lifecycle.authorizeAgent`——判定不变（按发起这一轮的登录会话复核），
   * 只是从业务管理器挪到了运行时。
   */
  readonly authorize: ToolAuthorizer
  /**
   * 本 Agent 的工具分类标签，由群组从清单注入。
   *
   * 子包**不要自己写字符串**：两处各写一份会漂移，而漂移的后果是本 Agent 的工具全部不可见，
   * 且这种失效在界面上完全看不出来。
   */
  readonly category: string
}

/** 会话材料定位：告诉用户在哪能看到这场对话。与旧实现（`participant.ts:133-136`）逐字相同。 */
function conversationArtifact(routePrefix: string, conversationId: string) {
  return {
    kind: 'conversation' as const,
    title: '查看封闭化会话',
    path: `${routePrefix}?conversationId=${encodeURIComponent(conversationId)}`,
  }
}

/** 造封闭化助手的 `AgentDefinition`。 */
export function createClosedoffDefinition(input: ClosedoffDefinitionInput): AgentDefinition {
  const { gateway, config, persona, authorize, category } = input
  return {
    id: 'closedoff',
    displayName: '封闭化管理智能助手',
    description: '通过原有只读业务工具查询园区、通行与车辆信息，返回脱敏分析和原生会话。',
    persona,
    config: ConfigSchema,
    // 插件级注册一次（装配侧调用本钩子）；本 Agent 能用哪些工具由运行时的 `restrict` 在
    // agent 作用域内限制，分类标签由群组注入。
    tools: ({ ctx }) => registerTools(ctx, gateway, config, authorize, category),
    redact: redactVisibleText,
    /**
     * **安全钩子**：工具结果里的业务主键不能出现在思考正文里。
     *
     * 旧实现在 `participant.ts:152-156`：先 `textBlocks(block.content)` 取正文，再交给
     * `collectOpaqueResultValues`。运行时在调用本钩子**之前**已经把那段正文取好了
     * （`participant.ts:566-569` 用 `textOf(block.content)`），所以这里拿到的 `resultText`
     * **已经是纯文本**——再套一层 `textBlocks` 会把正文丢空（它期望的是内容块数组），
     * opaque 集合只剩 `meta` 那一半，而这是**静默**的安全失效。
     */
    opaqueFromToolResult: (resultText, meta) => collectOpaqueResultValues(resultText, meta),
    // 页面同一套思考投影：脱敏、只含稳定语句、隐藏工具结果里的内部标识。
    // 时序（按 step 累积、废弃尝试丢弃、回合结束收尾）全在运行时，这里只做纯变换。
    projectReasoning: (raw: string, context: ReasoningProjectionContext): string =>
      projectReasoning(raw, context.releaseTail, context.opaqueValues),
    // 执行方发的是增量：运行时代管前缀单调与发布边界。
    liveMode: 'delta',
    /**
     * 结果投影：与旧实现（`participant.ts:125-136`）逐字等价——正文取最终消息并脱敏，
     * 材料固定一条"查看封闭化会话"。
     *
     * ⚠️ **边界：它只负责 `status === 'completed'` 的那一支。**
     * 运行时只在回合结局是 `completed` 时才调用本钩子
     * （`participant.ts:393-395` 的 `taken.result ?? (status === 'completed' ? await project(...) : {...})`），
     * 取消与失败用的是运行时自己的固定文案（`'协作已取消。'` / `` `${displayName}未能完成本回合，请查看原会话。` ``）。
     * 所以这里**不要**写成"我负责所有状态的文案"——那两句在本钩子里写了也永远不会被执行。
     *
     * 材料必须**显式给出**：`projected.artifacts` 为 `undefined` 时运行时会补一条自己的会话材料
     * （`title: '查看会话'`、路径用 `config.routePrefix`），侧栏标题会因此变样。
     */
    projectResult: async (context: ResultContext): Promise<ProjectedResult> => ({
      status: 'completed',
      text: redactVisibleText(context.history.finalText),
      artifacts: [conversationArtifact(config.routePrefix, context.history.conversationId)],
    }),
    /**
     * 侧栏预览：业务页面那套会话投影（`web.ts:276` 用的就是它），半径由闭包捕获。
     *
     * 运行时的预览契约只读 `role` / `text` / `reasoning` / `time`（`storage/adapter.ts` 按角色
     * 分派），而业务侧思考字段的名字是 `thinking`（`presentation.ts` 的 `HistoryAssistant`），
     * 所以助手条目要**补一个 `reasoning`**——不补就把思考整段丢掉。其余字段（`tracks` /
     * `cards` / `tools` …）原样保留：它们是这次投影的结果，半径、设备组、卡片都在里面。
     *
     * 与旧侧栏实现（`agent.ts:81-84`）的**唯一**差别：旧实现额外追加了工具行，而运行时的
     * `projectHistory` 只有 `user` / `assistant` 两种角色，**表达不了**工具行。
     */
    projectHistory: events => projectHistory(events, config.trackDeviceRadiusMeters).map(entry => entry.role === 'user'
      ? entry
      : { ...entry, reasoning: entry.thinking }),
    stageText: event => {
      // 运行时只在 `tool/call` 上问本钩子（`participant.ts:571-573`），其余事件类型不该由业务编文案。
      if (event.type !== 'tool/call') return undefined
      const tool = TOOL_BY_NAME.get(event.data.name as `closedoff_${string}`)
      return tool === undefined ? '正在执行封闭化业务查询。' : `正在执行：${tool.displayName}`
    },
  }
}
