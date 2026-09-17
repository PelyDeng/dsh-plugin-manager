/**
 * ⑦ 程序性校验：四条，全部**不需要额外模型调用**。
 *
 * 输入是**一步的结果**（`ProjectedResult` + 该步收到的 `acceptance` + 是否调过交活工具），
 * 输出是逐条结论。结论有三种取值，**不能压成一个布尔**：
 *
 * - `ok` —— 这条通过；
 * - `unverified` —— 如实标记"没顾上核验"（没有口径、执行方没实现自检、没调交活工具）。
 *   **不计入不达标**——它是"没顾上过目"，不是"活没干好"。
 * - `failed` —— 这条不达标。
 *
 * ## 两处与主方案字面不同，是本期的实现口径
 *
 * **1. 自检是四态，不是"非 `unverifiable` 即通过"。**
 * 主方案 §4.6 原文写"`selfCheck.status !== 'unverifiable'` 才算自检通过"——按字面读，
 * **缺省（`undefined`）也满足 ⇒ 也算通过**。那等于把所有交付都标记成"自检通过"，与 kit 的
 * `AgentSelfCheck` 注释（缺省表示执行方没有自检能力）和 §10.2(a)（未声明按未核验、不计不达标）
 * **互相矛盾**。正确口径是四态：
 *
 * | 取值 | 含义 | 算通过？ | 计入不达标？ |
 * | --- | --- | --- | --- |
 * | `passed` | 对照口径自检通过 | ✅ | — |
 * | `unverifiable` | 这一轮没有可核验的产出 | ❌ | 否 |
 * | `failed` | 自检发现产出与口径不符 | ❌ | ✅ |
 * | `absent` | **缺省**：执行方没实现自检 | ❌ | 否 |
 *
 * 异构期两个真实执行方（closedoff / blog）**都还没有读这三个字段**，所以它们的自检恒为
 * `absent`——按旧口径实现，整段异构期里所有交付都会被标成"自检通过"。
 *
 * **2. 第 3 条是"口径非空 ⇒ 材料非空"，不是"逐 `kind` 对照"。**
 * 主方案写的是"验收口径提到的产出物 `kind` 必须在该步 `artifacts` 里出现"，但 `acceptance`
 * 是**自由文本（中文）**、`ParticipantArtifact.kind` 是固定英文枚举
 * （`'conversation' | 'draft' | 'confirmation' | 'report'`），契约里**没有"文本 → kind"的映射**。
 * 按字面实现只有三条路，都不行：不实现 / 搜英文 kind（中文口径永远搜不到 ⇒ 系统性误伤全部
 * 口径）/ 新增词表（设计里没有）。
 *
 * 所以实现的强度是：**它证明"有材料交回"，不证明"交的是口径点名的那一种"**。要真正做到
 * 逐 `kind` 对照，需要 `acceptance` 结构化——那是后续期的事。**不要**在注释或文档里把它
 * 说成"交付完整性判定"。
 */
import type { AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
import type { ParticipantArtifact } from './contract.ts'
import type { ProjectedResult } from './definition.ts'

/**
 * 自检结论的取值。
 *
 * 前四态是**对外语义**（`absent` 是缺省——执行方没实现自检，不是任何一种声明过的结论）；
 * `damaged` 是**内部**多出来的一态：上游回报的形状非法（`status` 拼错、缺 `status`、不是对象、
 * 是 `null`）。它既不等于"执行方声明自己没有自检能力"，也不等于"执行方没实现自检"。
 *
 * ⚠️ **它为什么必须单独一态**：把损坏归进 `absent`，等于上游写错一个枚举值、协调方就记下一条
 * 关于"这个执行方能力"的断言——**静默**，而且没有任何计数或分类看得出来。本仓对"损坏"的
 * 既有处置是先例（`storage/parse.ts` 的 `inputRefs` / `dependsOn` 都给 `damaged` 分类，
 * 编排层据此拒派而不是降级）。对外的 `AgentSelfCheck.status` 仍是**四态**：`damaged` 与
 * `absent` 都报 `absent`（协调方视角一样是"没有可用的自检结论"），但 `detail` 与
 * {@link SelfCheckOutcome.selfCheck} 能把"形状损坏（上游的 bug）"与"声明缺省"分开。
 */
export type SelfCheckState = 'passed' | 'unverifiable' | 'failed' | 'absent' | 'damaged'

/** 四条规则的标识。 */
export type SelfCheckRule =
  /** 1. `summary` 非空 */
  | 'summary'
  /** 2. 自检真的通过（四态） */
  | 'self-check'
  /** 3. 口径-产物自洽（口径非空 ⇒ 材料非空） */
  | 'acceptance-artifacts'
  /** 4. 调过交活工具 */
  | 'report-called'

/** 单条规则的结论。 */
export interface SelfCheckFinding {
  readonly rule: SelfCheckRule
  readonly verdict: 'ok' | 'unverified' | 'failed'
  /** 给日志与协调方看的一句话；`ok` 时为空串。 */
  readonly detail: string
}

/** 一次程序性校验的完整结论。 */
export interface SelfCheckOutcome {
  readonly findings: readonly SelfCheckFinding[]
  /** 有没有**不达标**的条目（只有 `failed` 算）。 */
  readonly failed: boolean
  /** 如实标记为"未核验"的条数（`unverified`）。 */
  readonly unverified: number
  /**
   * **执行方自报**的那份结论归到哪一态（`selfCheckState()` 的结果）。
   *
   * 单列出来是因为汇总（`toSelfCheck`）必须把 `absent` 与 `unverifiable` 分开报出去，而只看
   * `findings` 时两者都是 `unverified`——折成一个值之后，协调方就只剩 `detail` 文本能区分
   * 「执行方说这一轮没有可核验的产出」与「执行方根本没有自检能力」，而文本不能当判据。
   */
  readonly selfCheck: SelfCheckState
}

/** 这一步的自检结论。 */
export interface SelfCheckInput {
  readonly result: ProjectedResult
  /** 这一步的验收口径；没有声明时为 `undefined`。 */
  readonly acceptance: string | undefined
  /** 执行方回报的自检结论（`ParticipantResult.selfCheck` 那一份）。 */
  readonly selfCheck?: AgentSelfCheck | undefined
  /** 本轮是否调过交活工具。 */
  readonly reported: boolean
}

/**
 * 把执行方的自检结论归类。
 *
 * 缺省**不是** `passed`——它表示"执行方没有自检能力"（老执行方），与"自检通过"是两件事。
 * `status: 'absent'` 与整个字段缺省归到同一态：前者是执行方**显式声明**自己没有自检能力
 * （运行时把内部结论透出去时就写这个值），后者是它压根没报；协调方对两者的处置相同。
 *
 * ⚠️ **形状损坏单独归 `damaged`**，不混进 `absent`：`{}`、`'PASSED'`（拼错）、`null`、非对象
 * 都是**上游的 bug**，不是"这个执行方没有自检能力"。混在一起会让一个写错的枚举值变成一条关于
 * 能力的断言，且完全静默。`null` 尤其要在这里挡住——`typeof null === 'object'`，直接读
 * `.status` 会抛 `TypeError`，整轮以一条看不懂的异常 reject。
 *
 * **不猜、不降级成通过**：这条对四态与 `damaged` 一视同仁。
 */
export function selfCheckState(selfCheck: AgentSelfCheck | undefined): SelfCheckState {
  if (selfCheck === undefined) return 'absent'
  if (selfCheck === null || typeof selfCheck !== 'object') return 'damaged'
  const status = (selfCheck as { status?: unknown }).status
  if (status === 'passed' || status === 'unverifiable' || status === 'failed' || status === 'absent') return status
  return 'damaged'
}

/** 逐条跑四条规则。**纯函数**：不读时钟、不碰存储、不调用模型。 */
export function runSelfCheck(input: SelfCheckInput): SelfCheckOutcome {
  const findings: SelfCheckFinding[] = []

  // —— 1. summary 非空 ——
  // 空结果是最容易被放过的失败：一轮跑完什么都没交回，却因为"没报错"被当成成功。
  const text = input.result.text.trim()
  findings.push(text === ''
    ? { rule: 'summary', verdict: 'failed', detail: '这一步没有交回任何正文（空结果不是成功）' }
    : { rule: 'summary', verdict: 'ok', detail: '' })

  // —— 2. 自检真的通过（四态） ——
  const state = selfCheckState(input.selfCheck)
  findings.push(stateFinding(state, input.selfCheck))

  // —— 3. 口径-产物自洽 ——
  findings.push(consistencyFinding(input.acceptance, input.result.artifacts))

  // —— 4. 调过交活工具 ——
  // 没调工具**不判失败**：§4.3 明确要求"没调工具时用投影里的 tail 兜底"，因为 blog 现在的
  // 完成判定本来就来自客观投影——改成纯模型调用是语义降级。补交轮会先补一次，补不上才按
  // `unverifiable` 交付。
  findings.push(input.reported
    ? { rule: 'report-called', verdict: 'ok', detail: '' }
    : {
      rule: 'report-called',
      verdict: 'unverified',
      detail: '这一轮没有调用交活工具，结论来自会话投影的兜底',
    })

  const failed = findings.some(finding => finding.verdict === 'failed')
  const unverified = findings.filter(finding => finding.verdict === 'unverified').length
  return { findings, failed, unverified, selfCheck: state }
}

/** 自检那一条的结论：只有 `passed` 算通过；`unverifiable` / `absent` / `damaged` 未核验；`failed` 不达标。 */
function stateFinding(state: SelfCheckState, selfCheck: AgentSelfCheck | undefined): SelfCheckFinding {
  switch (state) {
    case 'passed':
      return { rule: 'self-check', verdict: 'ok', detail: '' }
    case 'failed':
      return {
        rule: 'self-check',
        verdict: 'failed',
        detail: selfCheck?.detail?.trim() === undefined || selfCheck.detail.trim() === ''
          ? '自检结论是不达标'
          : `自检结论是不达标：${selfCheck.detail.trim()}`,
      }
    case 'unverifiable':
      return { rule: 'self-check', verdict: 'unverified', detail: '执行方声明这一轮没有可核验的产出' }
    case 'absent':
      return { rule: 'self-check', verdict: 'unverified', detail: '执行方没有回报自检结论（缺省不等于通过）' }
    case 'damaged':
      // 措辞必须与 `absent` 明显不同：这是**上游的 bug**，不是"这个执行方没有自检能力"。
      return {
        rule: 'self-check',
        verdict: 'unverified',
        detail: '执行方回报的自检结论形状非法（status 拼错、缺字段、不是对象或为 null）：如实按未核验处理——不猜成通过，也不记成"执行方没有自检能力"',
      }
  }
}

/** 口径-产物自洽那一条：口径非空才施加；施加时只要求"有材料交回"。 */
function consistencyFinding(acceptance: string | undefined, artifacts: readonly ParticipantArtifact[] | undefined): SelfCheckFinding {
  if (acceptance === undefined || acceptance.trim() === '') {
    // 没有口径就不施加这条——这正是"按参与者能力豁免"的落地：豁免判据是**该步是否真的
    // 收到了非空口径**，而不是"参与者有没有声明某种能力"（`capabilities` 实际装的是
    // 分类与自述文本，不是能力位，按它判不可实现）。
    return { rule: 'acceptance-artifacts', verdict: 'unverified', detail: '这一步没有声明验收口径' }
  }
  const count = artifacts?.length ?? 0
  return count > 0
    ? { rule: 'acceptance-artifacts', verdict: 'ok', detail: '' }
    : {
      rule: 'acceptance-artifacts',
      verdict: 'failed',
      // 措辞刻意不夸大成"口径点名的那一种"：实现只看得见"有没有材料"。
      detail: `这一步声明了验收口径，却没有交回任何材料（口径：${clip(acceptance, 60)}）`,
    }
}

/** 压平空白并截断，供 detail 用。 */
function clip(value: string, limit: number): string {
  const trimmed = value.replace(/\s+/gu, ' ').trim()
  return trimmed.length > limit ? `${[...trimmed].slice(0, Math.max(1, limit - 1)).join('')}…` : trimmed
}

/**
 * 把 ⑦ 的结论整理成要回报给协调方的 `selfCheck`。
 *
 * 约定：**有 `failed` 就报 `failed`**；否则只要执行方没有自检能力（`absent`）就报 `absent`；
 * 再否则只要有一条 `unverified` 就报 `unverifiable`（"没顾上过目"）；全通过才报 `passed`。
 * 这样协调方拿到的结论是**这一步真实的强弱**，而不是一个恒为"通过"的字段；而"执行方有没有
 * 自检能力"与"这一轮有没有可核验的产出"也**跨边界分得开**，不用靠 `detail` 文本去猜。
 */
export function toSelfCheck(outcome: SelfCheckOutcome): AgentSelfCheck {
  const failed = outcome.findings.filter(finding => finding.verdict === 'failed')
  if (failed.length > 0) {
    return { status: 'failed', detail: failed.map(finding => finding.detail).join('；') }
  }
  const unverified = outcome.findings.filter(finding => finding.verdict === 'unverified')
  if (unverified.length > 0) {
    const detail = unverified.map(finding => finding.detail).join('；')
    // **执行方没有自检能力时报 `absent`，不折成 `unverifiable`。** 两者在"不计入不达标"上
    // 相同，含义却不同：`absent` 是这个**执行方的能力事实**（自检这一环没落地），
    // `unverifiable` 是**这一轮的性质**（没有可核验的产出）。折成一个值之后，协调方只能去
    // 读 `detail` 文本才能分清——而文本不能当判据（P3 评审 P-2）。`absent` 优先于
    // `unverifiable`：能力事实比这一轮的具体原因更根本，而具体原因仍全在 `detail` 里。
    //
    // `damaged`（上游形状损坏）对外也报 `absent`——协调方视角都是"没有可用的自检结论"；两者
    // 的区别留在 `detail` 与 {@link SelfCheckOutcome.selfCheck} 里，运行时另外对 `damaged`
    // 发一次告警（那是上游的 bug，不该静默）。
    return outcome.selfCheck === 'absent' || outcome.selfCheck === 'damaged'
      ? { status: 'absent', detail }
      : { status: 'unverifiable', detail }
  }
  return { status: 'passed' }
}
