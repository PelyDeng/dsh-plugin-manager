/**
 * 收尾裁决（拆分 v2 批 2）：验收证据提取与裁决决策（D-2 映射）、重放拒绝与失败明细。
 */

import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import { dependencyVerdict } from '../task-model.ts'
import type { Actor, AgentArtifact, AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
import type { SubtaskVerdict } from '../storage/types.ts'
import type { SubtaskState, TaskState } from '../task-model.ts'
import { clip } from './text.ts'
import { planReworkAttempts, reportOf } from './planning.ts'
import { WAITING_EXPIRED_TASK } from './speech.ts'
import type { Conversation } from './domain.ts'

/**
 * {@link ButlerConsole.decideSettlement} 的结论：要么落一个终态，要么还不到给结论的时候。
 *
 * `waiting_user` / `external_pending` 与 `defer` 都是「先不写终态」，它们之间只差停在哪一步；
 * 分成四种而不是一个布尔，是为了让每条收尾路径都能照同一张表决定自己该做什么。
 */
export type Settlement =
  /** 到给结论的时候了：落 `state`，`failed` 用于拼用户可见的失败说明。 */
  | { readonly kind: 'settle'; readonly state: TaskState; readonly failed: number; readonly stopped: boolean }
  /** 还有已接受未处理的输入：先不结账，交给那条输入自己的回合。 */
  | { readonly kind: 'defer' }
  /** 还有人在等用户回话：停在 `waiting_user`，等补话那条路径回来。 */
  | { readonly kind: 'waiting_user'; readonly waiting: number }
  /** 材料已交回、剩下的事在别处办：停在 `external_pending`，本轮到此为止。 */
  | { readonly kind: 'external_pending'; readonly external: number; readonly failed: number }

/**
 * 四条收尾路径（派活轮 / 补充轮 / 补话之后 / 等待超时）**共用**的输入。
 *
 * 它们的差异全部以参数表达，不再各写一份收尾实现：
 *
 * | 路径 | `summarize` | `conversation` | `settleErrorOverride` |
 * | --- | --- | --- | --- |
 * | 派活轮（`turnBody`） | `true` | 有 | — |
 * | 补充轮 | `true` | 有 | — |
 * | 补话之后（`closeAfterReply`） | `true` | 拿不到时为 `undefined` ⇒ 跳过汇总但照常落终态 | — |
 * | 等待超时（`expireWaiting`） | **`false`** | 恒 `undefined`（后台路径没有会话句柄） | `WAITING_EXPIRED_TASK` |
 *
 * `acceptance` / `artifacts` 是给 §5.2 的两条消费点（汇总提示词带口径、汇总前核验口径提到的
 * 产出物）预留的：**本批只把数据取到签名里**，提示词改动排在下一批。先扩签名再写提示词，
 * 否则会退化成"给 `summarize` 加一个永远为空的参数"。
 */
export type SettleTaskInput = {
  readonly taskId: string
  /**
   * 任务的归属。
   *
   * 收尾里有两处**必须按 owner 写库**：裁决结论（`setSubtaskVerdict` 的 owner 条件）与重做追加
   * （`appendSubtasks` / `drainQueue` 都收 `actor`）。没有它，裁决就只能"记在内存里"而不能落地
   * ——那正是本项目反复出现的"中间的线没接"。
   */
  readonly actor: Actor
  /** 汇总要用的牛马大总管会话；拿不到时跳过汇总，仍然把终态落下。 */
  readonly conversation: Conversation | undefined
  readonly goal: string
  readonly subtasks: readonly {
    readonly id: string
    /**
     * 这一步所属的**目标**标识（同一目标重做时不变）。
     *
     * 裁决要求重做时，追加的新尝试**沿用**它 —— 预算按它读时聚合（{@link planReworkAttempts}），
     * 少了它，"这个目标已经试过几次"就只能按 `id` 数，而每次重做都是新 `id` ⇒ 内环无界。
     */
    readonly logicalId?: string | undefined
    readonly goal: string
    readonly agentId: string
    readonly state: SubtaskState
    /** 这一步的验收口径；缺省/空串 = 没有声明。 */
    readonly acceptance?: string | undefined
    /** 这一步交回的材料（定位型，不含内容）。 */
    readonly artifacts?: readonly AgentArtifact[] | undefined
    /**
     * 这一步的结果正文与协作返回原文。
     *
     * 裁决的 `evidence` 要**程序化核验**"能在该步结果里找得到"，靠的就是这两个字段 ——
     * 少了它们，核验只能退化成"看模型给的理由像不像真的"。
     */
    readonly result?: string | undefined
    readonly memberReturnText?: string | undefined
    /**
     * 成员自报的自检结论（执行侧的 `selfCheck`）。
     *
     * ⚠️ 它**不是**裁决结论：`selfCheck` 是成员对自己产出的自检，`verdict` 是牛马大总管对
     * 这一步的裁决。D-2 的映射（`failed` ⇒ 强制 `rework`；`absent`/`unverifiable` ⇒ 最多
     * `accept` 且降级 `unverified`）在 `verdictDecisionFor` 里。
     */
    readonly selfCheck?: AgentSelfCheck | undefined
    /** 已经裁决过的结论；空串 = 还没裁决过（**不是"默认通过"**）。 */
    readonly verdict?: SubtaskVerdict | undefined
  }[]
  /** 任务级验收口径；缺省 = 没有声明。 */
  readonly acceptance?: string | undefined
  readonly reports: readonly string[]
  readonly signal: AbortSignal
  /** 这一轮是否已经被喊停。子任务里有取消的同样按停止处理。 */
  readonly stopped: boolean
  /**
   * 是否跑汇总轮。
   *
   * 后台等待超时（路径 4）为 `false` —— 没有观众，也没有会话句柄，跑一轮汇总只是白烧一次
   * 模型调用（设计 §5.4 的既定口径，D-5）。
   */
  readonly summarize: boolean
  /**
   * `settle` 分支落终态时的 error 文案覆盖。
   *
   * 路径 4 传固定的超时说明（`WAITING_EXPIRED_TASK`）：那条路径的结论对用户来说是"没人回话
   * 所以停了"，而不是"N 个子任务失败"。
   */
  readonly settleErrorOverride?: string | undefined
}

/** 模型通过 `butler_verdict` 交回的一条裁决。 */
export type VerdictDecision = {
  readonly subtaskId: string
  /** ⚠️ 模型只能给这三种；`unverified` 是**我们**在核验不过时降级出来的，不接受模型自报。 */
  readonly verdict: 'accept' | 'rework' | 'replace'
  readonly evidence?: string
  readonly reason?: string
  /** `replace` 时必填：换给谁。 */
  readonly newAgentId?: string
}

/**
 * 一次汇总轮里"待裁决"的上下文。
 *
 * 它只活在**一轮收尾**之内：`settleTask` 在跑汇总**之前**设置、跑完（含异常）清除。
 * `verdictTool.execute` 靠它判断"此刻是不是在裁决上下文里"——工具是**每会话注册一次、
 * 对所有轮次都生效**的，没有这道判断，派活轮的模型也会去调 `butler_verdict`。
 */
export type VerdictContext = {
  readonly actor: Actor
  readonly taskId: string
  /** 这一轮**可以**裁决的步骤（已终结的有效尝试，且还没裁决过）。 */
  readonly open: readonly {
    readonly id: string
    readonly goal: string
    readonly agentId: string
    readonly result: string
    readonly artifacts: readonly AgentArtifact[]
    readonly memberReturnText: string
    readonly selfCheck: AgentSelfCheck | undefined
  }[]
  /** 已经裁决过的子任务 id：**同一个 id 不得重复裁决**（设计 §5.4）。 */
  readonly decided: Set<string>
  /**
   * 这一轮落下的**最终**结论（已含 D-2 与证据核验带来的降级），供 `settleTask` 决定去路。
   *
   * `requested` / `newAgentId` 保留**模型这一次的原始意图**：`verdict` 可能已被降级成
   * `unverified`，而"要不要追加尝试"只认最终的 `rework` / `replace`；但 `replace` 换给谁
   * 只在原始意图里（降级不该抹掉它，否则追加时会把它当成 `rework` 派回原成员）。
   */
  readonly decisions: {
    readonly subtaskId: string
    readonly verdict: SubtaskVerdict
    readonly requested: 'accept' | 'rework' | 'replace'
    readonly newAgentId?: string | undefined
  }[]
  /** 裁决过程里如实记下的问题（模型给了非法输入、写后核验为 0 行等）。 */
  readonly problems: string[]
}

/**
 * 从落库的子任务记录重建交给汇总的材料。 *
 * 补话之后要重新汇总，而那时派活阶段的 `reports` 早已不在内存里（进程可能都换过一次），
 * 所以按同一种口径从库里重建：成功取结果正文，失败与取消带上原因，还没答复的带上已交回的
 * 材料和待答事项。
 */
/**
 * **重启重放被拒**时落在子任务 `error` 里的固定前缀（判据 D-1）。
 *
 * 运行时在"同一个 `requestId` 的那一轮此前已经结算过"时抛 `AccessError(409, …)`（进程重启后
 * 重放同一轮请求），显式拒绝再跑一遍 —— 因为外部副作用（候选稿、归档）已经发生过一次。
 *
 * 这件事**不是"活没干好"**：成员没有失败，是这一次请求本来就不该重跑。它落到
 * {@link dispatchSubtask} 的 catch 里时，必须与一次普通的成员失败**分得开**：否则页面与汇总
 * 材料都会写成"这位成员失败了"，而真相是"这一轮早就交付过"。分开的手段就是这个前缀 ——
 * {@link reportOf} 按它渲染一句说明，而不是"失败："。
 *
 * 判定只看 `AccessError.status === 409`：运行时那条 409 不带 `reason`，而管家侧自己的 409
 * （`run_busy` / `task_already_finished` 等）都发生在**受理阶段**、走不到这里的 catch。
 */
export const REPLAY_REJECTED_PREFIX = '这一轮此前已经结算过（重启重放被拒）'

/** 这个错误是不是"重启重放被拒"（运行时抛的 409）。 */
export function isReplayRejection(error: unknown): boolean {
  return error instanceof AccessError && error.status === 409
}

/**
 * 一次派单失败的**归类**（判据 D-1 的判定部分）：重启重放被拒 ⇒ 带固定前缀，普通失败 ⇒ 原样。
 *
 * 抽成纯函数是为了让它**能被直接测到**：端到端那条路上，拒绝发生在派单循环内部，而用例很难
 * 稳定摆出"这一轮还在跑"这个前提（实测：走 `planAndSettle` 时派单由执行泵驱动，
 * `planTool.execute` 会等它，一旦派单抛错用例就挂在超时上）。判定与渲染各有一个可直测的入口
 * （本函数与 {@link reportOf}），"接线有没有接上"由两处的调用点静态保证。
 */
export function dispatchFailureDetail(error: unknown, raw: string): string {
  return isReplayRejection(error) ? `${REPLAY_REJECTED_PREFIX}：${raw}` : raw
}

/**
 * 把**执行侧**的自检结论渲染成给模型看的一句话（裁决提示词用）。
 *
 * ⚠️ **缺省不是"通过"**：它必须说清"这一步没有人核验过"，否则模型会把缺省当成"没问题"，
 * 而 §4.6 的四态表明确写了缺省（`absent`）**不得等价于 `passed`**。
 */
export function selfCheckLabel(selfCheck: AgentSelfCheck | undefined): string {
  const status = selfCheck?.status
  if (status === 'passed') return '成员自检通过'
  if (status === 'failed') {
    const detail = selfCheck?.detail?.trim() ?? ''
    return detail === '' ? '成员自检**不达标**' : `成员自检**不达标**：${detail}`
  }
  if (status === 'unverifiable') return '成员声明这一轮没有可核验的产出'
  return '成员没有回报自检结论（缺省不等于通过）'
}

/**
 * `accept` 的证据核验：那段证据要**原样出现**在该步的结果 / 材料位置 / 协作返回原文里。
 *
 * 核验的是"**这句话确实来自这一步**"，不是"这句话听起来像真的"。它挡不住成员自己写一段
 * 漂亮的假结论（那需要业务侧的证据链），但它能挡住"模型凭印象编一个 evidence"——那是最常见
 * 的一种：裁决者并没有真的去看那一步交回了什么。
 */
export function verdictEvidenceFound(evidence: string, input: {
  readonly result: string
  readonly memberReturnText: string
  readonly artifacts: readonly AgentArtifact[]
}): boolean {
  const haystacks = [
    input.result,
    input.memberReturnText,
    // 材料的核验字段也算"这一步交回的话"：证据引用的是链接或状态（`https://…/p/1.html`、
    // `published`）时，它们就在 url / state 里，不在 title / path 里——不比这两处会把真证据判成编的。
    ...input.artifacts.flatMap(item => [item.title, item.path, item.kind, ...(item.url === undefined ? [] : [item.url]), ...(item.state === undefined ? [] : [item.state])]),
  ]
  return haystacks.some(text => text.includes(evidence))
}

/**
 * 把"模型的裁决意图 + 这一步成员自报的自检"映射成**最终要落库的裁决**。
 *
 * 两条独立来源都要过：
 *
 * 1. **D-2（自检四态）**：`failed` ⇒ **强制 `rework`**（成员自己说产出和口径不符，证据看都不看）；
 *    `absent`（含运行时内部的 `damaged`，落库时已归成它）/ `unverifiable` ⇒ 最多 `accept`，
 *    且**强制降级 `unverified`**；`passed` ⇒ 允许 `accept`，但仍须过第 2 条。
 * 2. **证据核验**：`accept` 必须附 `evidence`，且它要能在该步结果里找到；找不到 ⇒ 降级
 *    `unverified` —— **不是静默 accept**。
 *
 * ⚠️ 三个同名的 "verdict" 别混：这里的输入 `selfCheck` 是**执行侧**的自检；`dependencyVerdict`
 * 是**依赖侧**"前置能不能派"的判定；输出才是**裁决侧**的结论。
 *
 * 导出成纯函数是为了让它可直测：工具本身要经模型驱动，测起来又慢又脆。
 */
export function verdictDecisionFor(input: {
  readonly requested: 'accept' | 'rework' | 'replace'
  readonly evidence: string
  readonly selfCheck: AgentSelfCheck | undefined
  readonly result: string
  readonly memberReturnText: string
  readonly artifacts: readonly AgentArtifact[]
}): { readonly verdict: SubtaskVerdict; readonly downgraded: boolean; readonly why: string } {
  const status = input.selfCheck?.status
  // 1. 自检不达标 ⇒ 强制重做。这条**优先于**模型给的 accept/replace：成员自己说产出不符口径。
  if (status === 'failed') {
    return {
      verdict: 'rework',
      downgraded: input.requested !== 'rework',
      why: '成员自检不达标（selfCheck=failed）',
    }
  }
  if (input.requested !== 'accept') return { verdict: input.requested, downgraded: false, why: '' }
  // 2. 只有走到这里才是 accept 意图。
  //    成员没有自检能力（缺省 / 显式 absent）或声明"这一轮没有可核验的产出"时，它**没有资格**
  //    被称作"核验通过"—— 最多如实标"未核验"，而不进终态（设计 §5.4）。
  if (status === undefined || status === 'absent') {
    return { verdict: 'unverified', downgraded: true, why: '成员没有回报自检结论（缺省不等于通过）' }
  }
  if (status === 'unverifiable') {
    return { verdict: 'unverified', downgraded: true, why: '成员声明这一轮没有可核验的产出' }
  }
  // 3. selfCheck === 'passed'：仍须过证据核验。
  const evidence = input.evidence.trim()
  if (evidence === '') return { verdict: 'unverified', downgraded: true, why: 'accept 没有附证据' }
  if (!verdictEvidenceFound(evidence, input)) {
    return { verdict: 'unverified', downgraded: true, why: `证据在该步结果里找不到：${clip(evidence, 40)}` }
  }
  return { verdict: 'accept', downgraded: false, why: '' }
}
