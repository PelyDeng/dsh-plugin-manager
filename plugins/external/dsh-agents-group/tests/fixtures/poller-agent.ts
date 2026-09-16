/**
 * P3.5 的被测对象：一个**故意不同构**的 Agent（**只在测试里存在**，不随包发布）。
 *
 * ## 它为什么长这样
 *
 * 这一期是**证伪测试**：回答"运行时到底是通用机制，还是一个刚好能装下 closedoff 的便利层"。
 * 所以被测对象必须与存量那两个 Agent **处处不同**，每一条都对着这个问题：
 *
 * | 维度 | closedoff（存量最规整的） | **本 Agent** |
 * | --- | --- | --- |
 * | 一轮的形态 | 多步工具调用 + 实时正文 | **只轮询一次外部 API** |
 * | 完成判定 | 会话投影 | **不调交活工具** —— 只有兜底路径可用 |
 * | 产出 | 分析正文 + 原生会话材料 | **只有一段事实**，`projectResult` 不声明任何材料 |
 * | 会话 | 两段握手 + 预留发布 | 一样走运行时（那是机制，不是业务） |
 *
 * 它**不进 `AGENTS_MANIFESTS`**、不注册页面、不碰任何业务存储 —— 装配方式仿
 * `tests/fixtures/chain-member.ts`：只在测试内装配。
 *
 * ## 一条刻意的设计
 *
 * 它**不注册交活工具**（不调 `participant.handoff.install()`）。这正是 A2/A3 要测的：
 * 「没调交活工具」时 §4.3 的**兜底事实源**是否真的工作、⑦ 第 3 条是否仍按预期触发。
 * 想测"调了工具"的那一例时，用 {@link pollerWithHandoff} 的装配（测试里显式 install）。
 */
import type { ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type { AgentDefinition, ProjectedResult, ResultContext } from '../../packages/runtime/src/definition.ts'

export const POLLER_AGENT_ID = 'poller'

/**
 * 夹具"外部 API"返回的**哨兵值**。
 *
 * 断言必须落在它身上：只断 `status === 'completed'` 是**恒真**的（§4.3 规定未交活按
 * `unverifiable` 交付、不判失败，§4.6 又用投影兜底 + `summary` 非空）—— 一个什么都不产出的
 * Agent 也会落 `completed`。**必须断内容。**
 */
export const POLL_SENTINEL = 'POLL-SENTINEL-7f3a91'

/** 轮询到的原始载荷（模拟外部 API 的响应体）。 */
export const POLL_PAYLOAD = `{"site":"fuling","devices":42,"sentinel":"${POLL_SENTINEL}"}`

/** 这个 Agent 唯一声明的工具：轮询外部 API。 */
export const POLLER_TOOLS: readonly ToolDescriptor[] = [{
  name: 'poller_fetch',
  displayName: '轮询园区接口',
  description: '向外部园区接口发一次只读查询，拿回当前状态。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { path: { type: 'string', required: true, description: '要查询的相对路径。' } },
  },
  permission: 'poller:access',
}]

export interface PollerInput {
  /**
   * `projectResult` 是否声明材料。**缺省 false** —— 这个 Agent 的产出是"轮询到的事实"，
   * 不是可点开的材料。缺省值正是 A3 要的形态：口径非空而材料为空。
   * 置 true 用来做**反向对照**（材料非空时第 3 条应当通过）。
   */
  readonly artifacts?: boolean
  /** 每次 `projectResult` 被调用时回调（用来证明投影真的走了业务钩子）。 */
  readonly onProject?: (context: ResultContext) => void
}

/**
 * 声明这个 Agent。
 *
 * 只用 `AgentDefinition` 的既有字段 —— **没有任何为本 Agent 新增的钩子**。A1（运行时 diff = 0）
 * 的意义就在这里：一个新 Agent 应当只写一份声明，而不是去动机制。
 */
export function pollerDefinition(input: PollerInput = {}): AgentDefinition {
  return {
    id: POLLER_AGENT_ID,
    displayName: '外部接口轮询器',
    description: '只轮询外部接口拿回当前状态，不做多轮分析，也不交回材料。',
    persona: '你是一个只做一件事的轮询器：查询外部接口，把结果原样报告给用户。回答要短。',
    tools: () => POLLER_TOOLS,
    /**
     * 结果投影：正文取本轮最终消息，**缺省不带材料**。
     *
     * 这个钩子存在的意义是让"投影"这条路可观测（`onProject` 回调），从而区分
     * "运行时用了业务投影"与"运行时静默走了内部兜底"。
     */
    projectResult: async (context: ResultContext): Promise<ProjectedResult> => {
      input.onProject?.(context)
      return {
        status: 'completed',
        text: context.history.finalText,
        ...(input.artifacts === true
          ? { artifacts: [{ kind: 'report' as const, title: '轮询结果', path: '/poller/report' }] }
          : {}),
      }
    },
    // 运行时路径不读 `config`（它由 `mount()` 校验），这里只给出形状。
    config: {} as AgentDefinition['config'],
  }
}

/**
 * 一个**必须使用逃生通道**的 Agent（A4 的负极对照）。
 *
 * 它的业务是运行时**表达不了**的：回答来自一处进程内缓存，**根本不创建宿主会话**。
 * 运行时默认路径的第一步就是 `lifecycle.open(...)`（`createMissing = true` 时会铸会话并
 * 预留归属），所以"不建会话"这件事只能靠自定义 participant —— 那正是逃生通道的用途。
 *
 * 它存在的理由与 A4 的其余部分一样：**没有这个对照，计数器没接上时"使用次数 = 0"天然成立，
 * 判据会恒绿。**
 */
export const SESSIONLESS_AGENT_ID = 'sessionless'

export function sessionlessDefinition(): AgentDefinition {
  return {
    id: SESSIONLESS_AGENT_ID,
    displayName: '无会话直答器',
    description: '从进程内缓存答题，不使用宿主会话。',
    persona: '你从缓存里取答案。',
    tools: () => [],
    config: {} as AgentDefinition['config'],
  }
}
