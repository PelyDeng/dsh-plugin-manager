/**
 * 交活工具：模型**显式**把这一轮的结论交回宿主。
 *
 * ## 为什么要有它，以及为什么它是兜底而不是唯一路径
 *
 * §4.3 的驱动模型是"**显式交活 + 事件投影**"：
 *
 * - 完成判定以 `report_result` 的调用为准 —— 模型自己说"我交回什么"；
 * - 但**保留会话投影作为兜底事实源**：没调工具时用投影里的正文交付，**不判失败**。
 *   这一条是刻意保留的：blog 现在的完成判定本来就来自**客观投影**（`projectResult`），
 *   改成"没调工具就算失败"是**语义降级**——一个只是回答了一句话的 Agent 会因此被判失败。
 *
 * ## 账本（{@link HandoffLedger}）
 *
 * 工具的实现只做一件事：把交回的内容写进账本。运行时在收尾时读账本决定：
 * **用工具交回的内容**，还是走投影兜底，还是触发一次补交轮。
 *
 * 账本是**每轮一个**的：补交轮会 {@link HandoffLedger.reset} 后重新记录，
 * 这样"第二轮到底交没交"能被独立判断。
 *
 * ## 接线（本文件不自己注册）
 *
 * 工具要在 **agent 作用域**里注册（宿主拒绝插件级限制与注册）。注册由装配侧做：
 * 业务在它的工具注册路径里把 {@link reportResultTool} 的结果注册进去，或者由
 * `ConversationLifecycle` 的 `setup(agentCtx)` 追加；注册时**必须**同时调
 * `ledger.install()` —— 账本靠它知道"模型真的能交活"。
 *
 * **没接线时的行为要说清**（别把它写成"照常工作"）：
 * - **兜底投影照常工作**：没调工具就用会话投影的正文交付，不判失败；
 * - **补交轮不跑**：模型手里没有那个工具，补交只会让它把同一件事再答一遍，白花一轮
 *   （而那一轮吃的是同一个超时预算）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
import type { ParticipantArtifact, ParticipantExternalPending, ParticipantStatus } from './contract.ts'
import type { ProjectedResult } from './definition.ts'

/** 交活工具名。模型可见，改动等于换契约。 */
export const REPORT_RESULT_TOOL = 'report_result'

/** 工具交回的原始参数（`execute` 收到的形状）。 */
interface ReportResultArgs {
  readonly status?: unknown
  readonly text?: unknown
  readonly question?: unknown
  readonly artifacts?: unknown
  readonly externalPendingReason?: unknown
  readonly externalPendingNext?: unknown
}

/**
 * 一轮的交活账本。
 *
 * `called` 与 `result` 分开记：**调了工具但参数不合法**（例如既没给正文也没给问题）也算
 * "调过"——补交轮问的是"模型有没有主动交活这个动作"，不是"交回的内容好不好"。
 */
export interface HandoffLedger {
  /**
   * 交活工具**是否已经在本会话注册**。
   *
   * ⚠️ 它决定补交轮跑不跑：模型手里没有那个工具时，补交只会让它把同一件事再答一遍，
   * 白花一轮（而那一轮吃的是同一个超时预算）。**没注册就不补交**，直接用投影兜底交付。
   * 装配侧在注册 `reportResultTool(...)` 时调 {@link install}。
   */
  readonly available: boolean
  /** 装配侧注册交活工具时调用（标记"模型真的能交活"）。 */
  install(): void
  /** 本轮是否调用过交活工具。 */
  readonly called: boolean
  /** 模型交回的结论；没调或参数不合法时为 `undefined`。 */
  readonly result: ProjectedResult | undefined
  /** 由工具实现调用。 */
  submit(result: ProjectedResult): void
  /** 标记"调过但没交回可用内容"。 */
  markCalled(): void
  /** 收尾时取走本轮记录。 */
  take(): { readonly called: boolean; readonly result: ProjectedResult | undefined }
  /** 开始新的一轮（补交轮或自修正轮再跑时调用）。 */
  reset(): void
}

/** 造一个空账本（`available` 为假 —— 装配侧注册工具后才是真的）。 */
export function createHandoffLedger(): HandoffLedger {
  let called = false
  let result: ProjectedResult | undefined
  let available = false
  return {
    get available() { return available },
    install() { available = true },
    get called() { return called },
    get result() { return result },
    submit(value) { called = true; result = value },
    markCalled() { called = true },
    take() { return { called, result } },
    reset() { called = false; result = undefined },
  }
}

/** 把工具参数里的 `status` 收窄成契约允许的取值。 */
function toStatus(value: unknown): ParticipantStatus {
  switch (value) {
    case 'completed': case 'waiting': case 'cancelled': case 'failed': case 'external_pending':
      return value
    case 'succeeded': return 'completed'
    default: return 'completed'
  }
}

/** 把工具参数里的 `artifacts` 收窄成契约形状；缺字段的条目整条丢弃，不编造。 */
function toArtifacts(value: unknown): readonly ParticipantArtifact[] {
  if (!Array.isArray(value)) return []
  const kinds = new Set(['conversation', 'draft', 'confirmation', 'report'])
  const items: ParticipantArtifact[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as { title?: unknown; path?: unknown; kind?: unknown }
    if (typeof item.title !== 'string' || typeof item.path !== 'string' || item.title.trim() === '') continue
    // `kind` 是**固定四值**枚举；认不出来的按 `report` 收（它是"一份结论"的兜底分类），
    // 而不是丢弃整条材料——材料的位置比分类更有价值。
    const kind = typeof item.kind === 'string' && kinds.has(item.kind)
      ? item.kind as ParticipantArtifact['kind']
      : 'report'
    items.push({ title: item.title.trim(), path: item.path, kind })
  }
  return items
}

/** 把工具参数整理成投影结果。**参数不合法时返回 `undefined`**（由调用方标记"调过但没交回"）。 */
export function projectedFromToolArgs(args: ReportResultArgs): ProjectedResult | undefined {
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  const question = typeof args.question === 'string' ? args.question.trim() : ''
  const status = toStatus(args.status)
  const artifacts = toArtifacts(args.artifacts)
  const reason = typeof args.externalPendingReason === 'string' ? args.externalPendingReason.trim() : ''
  const next = typeof args.externalPendingNext === 'string' ? args.externalPendingNext.trim() : ''
  const externalPending: ParticipantExternalPending | undefined = reason === ''
    ? undefined
    : { reason, ...(next === '' ? {} : { next }) }
  // 一条都不给等于没交：让调用方走"调过但没交回"，而不是造一个空结果冒充交付。
  if (text === '' && question === '' && artifacts.length === 0 && externalPending === undefined) return undefined
  // `waiting` 必须有 question：缺了它用户会面对一个"没有问题"的等待（`ParticipantResult.question`
  // 的注释写明了这一点）。工具没给就如实退成 `completed`，不编一个问题。
  const settled: ParticipantStatus = status === 'waiting' && question === ''
    ? (text === '' ? 'failed' : 'completed')
    : status
  return {
    status: settled,
    text: text === '' && question !== '' ? question : text,
    ...(artifacts.length === 0 ? {} : { artifacts }),
    ...(question === '' ? {} : { question }),
    ...(externalPending === undefined ? {} : { externalPending }),
  }
}

/**
 * 交活工具本体。
 *
 * `execute` 只写账本、**不做业务判断**：状态是什么就记什么，缺字段就不传（与桥接那层同一条
 * 原则——不从文案里推断"它大概是想结束这一轮"）。
 */
export function reportResultTool(ledger: HandoffLedger) {
  return defineTool({
    name: REPORT_RESULT_TOOL,
    description: [
      '把这一轮的结论交回宿主。',
      '**跑完就该调用它**：宿主按它判定这一轮完成了什么、交回了哪些材料。',
      '确实没有可交付的内容时也要调一次并如实写明（例如「没查到」），不要不声不响地结束。',
    ].join(''),
    parameters: {
      status: {
        type: 'string', required: true,
        description: '这一轮的结局：completed（拿到结果）/ waiting（需要用户补一句话）/ external_pending（材料已交回、剩下的事在别处办）/ failed（没干成）/ cancelled（被取消）。',
      },
      text: { type: 'string', description: '交回的正文：结论、关键数据与下一步。这是给用户看的内容。' },
      question: { type: 'string', description: 'status 为 waiting 时，要用户回答的那一句话。' },
      artifacts: {
        type: 'array',
        description: '这一轮交回的材料位置（不是内容本身）。列表、链接、稿件、确认单都放这里。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '给用户看的标题，例如「在博客查看并采用候选稿」。' },
            path: { type: 'string', required: true, description: '材料所在位置，只允许本站插件内的路径。' },
            kind: { type: 'string', required: true, description: '材料种类：conversation / draft / confirmation / report。' },
          },
        },
      },
      externalPendingReason: { type: 'string', description: 'status 为 external_pending 时必填：在等什么、由谁处理。这句会直接显示给用户。' },
      externalPendingNext: { type: 'string', description: '外部处理完之后可以做什么，可空。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { accepted: { type: 'boolean', required: true }, status: { type: 'string', required: true } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.accepted ? `已收到你的交回（${value.status}）。` : '交回内容为空，宿主会按会话投影兜底。',
      }],
    },
    execute: async (args) => {
      const projected = projectedFromToolArgs(args as ReportResultArgs)
      if (projected === undefined) {
        // 调了但什么都没交：记下"调过"，让补交轮与判据知道模型**确实动过手**。
        ledger.markCalled()
        return { accepted: false, status: 'empty' }
      }
      ledger.submit(projected)
      return { accepted: true, status: projected.status }
    },
  })
}

/**
 * 补交轮注入的 user message。
 *
 * 措辞的三个约束：① 说清"这一轮结束了但没看到交活"，而不是指责；② 给一条**如实的退路**
 * （确实没有可交付的就照实写）——逼模型编一个结果比不交更糟；③ 不承诺任何它做不到的事。
 */
export const HANDOFF_RETRY_PROMPT = [
  '这一轮已经结束了，但我没有收到你用 report_result 交回的结论。',
  '请现在调用 report_result，把这一轮**实际**得到的东西交回来：结论、关键数据、材料位置。',
  '如果这一轮确实没有可交付的内容（例如没查到、只是回答了一句话），也请照实说明，不要为了交差而编造。',
].join('\n')

/**
 * 自修正轮注入的 user message。
 *
 * `reason` 来自 `AgentDefinition.judge` 的结论——把"哪里不达标"原样告诉模型，
 * 让它**换做法**而不是原样重跑一遍。
 */
export function reworkPrompt(reason: string): string {
  const detail = reason.trim() === '' ? '上一次的产出没有达到验收要求。' : `上一次的产出没有达到验收要求：${reason.trim()}`
  return [
    detail,
    '请针对这一点重新做一遍，并再次用 report_result 交回。不要只是重复上一次的内容。',
  ].join('\n')
}

/** 供测试与装配判断"这一轮是不是交活轮"。 */
export function isHandoffTool(name: string): boolean {
  return name === REPORT_RESULT_TOOL
}

/** 交活轮在轮次状态里的标记（补交轮单列状态，见 `participant.ts`）。 */
export type TurnAttempt = 'initial' | 'report_retry' | 'self_retry'

/** 自检结论的透传口：`participant.ts` 把 ⑦ 的结论放在这里回报。 */
export type HandoffSelfCheck = AgentSelfCheck
