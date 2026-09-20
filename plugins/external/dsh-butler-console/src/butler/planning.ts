/**
 * 计划返工（拆分 v2 批 2）：逻辑步骤的重派次数预算与返工计划；子任务报告拼装。
 */

import type { SubtaskVerdict } from '../storage/types.ts'
import type { SubtaskState } from '../task-model.ts'
import { effectiveSubtasks } from './dispatch-brief.ts'
import { REPLAY_REJECTED_PREFIX, dispatchFailureDetail } from './verdict.ts'
import type { SettleTaskInput } from './verdict.ts'

/**
 * 同一个目标（`logicalId`）最多允许几条尝试。
 *
 * **D-3 的定案**：协调侧按 `logicalId` 数"已有尝试条数"设硬限，**不做 0.5 折算** —— 那次折算
 * 只影响运行时侧的内部记账（`definition.ts` 的 `maxSelfRetries` 注释），协调侧不引入第二个
 * 记账口径。计数一律**读时聚合**（设计 §5.4）：落成字段的话，每次重做新建一行都会把它归零
 * ⇒ 内环无界。
 */
export const MAX_ATTEMPTS_PER_LOGICAL = 2

/** {@link planReworkAttempts} 的结论：要追加哪些、哪些因为预算用尽而不追加。 */
export type ReworkAttemptPlan = {
  readonly appended: readonly {
    readonly id: string
    readonly goal: string
    readonly agentId: string
    /** 沿用原目标的标识：聚合按它算"这是同一个目标的第几条尝试"。 */
    readonly logicalId: string
    /** 被替代的那条尝试。`supersedes` 与派单时的 `reworkOf` **同源于它**。 */
    readonly supersedes: string
    readonly acceptance?: string | undefined
  }[]
  /** 预算用尽、不再追加的步骤 id（**如实说清**，不静默丢弃）。 */
  readonly exhausted: readonly string[]
}

/**
 * 从裁决结论算出"要追加哪些尝试"（设计 §5.4 第 2 步：有重做且预算允许 ⇒ 追加尝试、回调度）。
 *
 * **纯函数**：不读时钟、不碰存储、不调模型。追加的**动作**（写库 / 派单 / 回调度）在
 * `ButlerConsole#applyReworkAttempts` 里。这么拆是为了让"预算算得对不对""替代者换没换对"
 * 能被**直接测到**：把它埋在收尾里就只能靠"跑一整轮汇总"来验。
 *
 * ⚠️ **在这里纠正一句被误传了三批的话**（原文写在 `dispatchFailureDetail` 的注释附近）：
 * "汇总轮要模型驱动、那条路会让用例挂在超时上"。实测**不成立**，而且它是两件事被混成一件：
 *
 * - **`planTool.execute()` 不派单** —— 它只校验并登记计划，派单发生在 `turnBody` 的第二段。
 *   所以"派单抛错会让 `planTool.execute` 挂住"这个说法本身就不成立（它根本没有派单那一步）。
 * - **真正的原因是驱动轮数不够**：`settleTask` 在有观众时先置 `summarizing` 再跑 `summarize`，
 *   而 `summarize` 等的是模型（`followup` + `turn/end`）；`rework` 还会经
 *   `applyReworkAttempts` **再收尾一次**。只驱动一次就等不到终态，表现像"夹具坏了"。
 *
 * 可复用夹具见 `tests/helpers/butler-driver.ts`（文件头写了机制与"能/不能驱动什么"），
 * 端到端判据见 `tests/verdict-e2e.test.ts`（含 409 区分、rework 追加、预算用尽、口径进提示词）。
 */
export function planReworkAttempts(input: {
  readonly decided: readonly {
    readonly subtaskId: string
    readonly verdict: SubtaskVerdict
    readonly requested: 'accept' | 'rework' | 'replace'
    readonly newAgentId?: string | undefined
  }[]
  readonly subtasks: SettleTaskInput['subtasks']
  /**
   * **全部历史尝试**（未去重，含被替代掉的旧尝试）：预算统计必须用它。
   *
   * ⚠️ 缺省退回 `subtasks` 只为兼容既有调用，**真实调用点必须传它** —— 理由见下面统计处那段注释。
   */
  readonly allSubtasks?: readonly { readonly id: string; readonly logicalId?: string | undefined }[] | undefined
  /** 库里已有的子任务条数：新尝试的 id 从它往后编号（与补充轮同一套 `s${n}` 约定）。 */
  readonly baseCount: number
  readonly limit?: number | undefined
}): ReworkAttemptPlan {
  const limit = input.limit ?? MAX_ATTEMPTS_PER_LOGICAL
  // **读时聚合**：每个目标（`logicalId`，缺省退回 `id`）现在已经有几条尝试。
  //
  // ⚠️ **必须统计全部历史，不能统计有效尝试**：`effectiveSubtasks()` 会把被替代的旧尝试剔除，
  // 于是"同一个目标已经有 2 条尝试"在有效集合里只剩 1 条 ⇒ `used` 恒为 1 ⇒ **预算永不耗尽**，
  // 每一轮裁决都追加一次；同时 `s${baseCount + …}` 的基数也被去重缩小，追加出来的 id 会与
  // 历史撞车。设计 §5.4 第 798 行专门警告过"落字段会因重做新建行而每轮归零 ⇒ 内环无界"——
  // 这里是**去重导致的同一种归零**，形态不同、后果相同。
  // 实测（`tests/verdict-e2e.test.ts` 的"预算用尽"用例）：连续裁 `rework` 会撞
  // `UNIQUE constraint failed: subtasks.task_id, subtasks.id` 并让整轮中断。
  const attempts = new Map<string, number>()
  for (const item of input.allSubtasks ?? input.subtasks) {
    const key = item.logicalId === undefined || item.logicalId === '' ? item.id : item.logicalId
    attempts.set(key, (attempts.get(key) ?? 0) + 1)
  }
  const appended: ReworkAttemptPlan['appended'][number][] = []
  const exhausted: string[] = []
  for (const decision of input.decided) {
    // 只认**已经落地的结论**：`accept` / `unverified` 都不追加（降级出来的 `unverified` 不是重做）。
    if (decision.verdict !== 'rework' && decision.verdict !== 'replace') continue
    const target = input.subtasks.find(item => item.id === decision.subtaskId)
    if (target === undefined) continue
    const key = target.logicalId === undefined || target.logicalId === '' ? target.id : target.logicalId
    const used = attempts.get(key) ?? 0
    if (used >= limit) { exhausted.push(decision.subtaskId); continue }
    attempts.set(key, used + 1)
    // `replace` 换人、`rework` 沿用原成员；替代者在 `readVerdictDecision` 里已经预检过可调度。
    const agentId = decision.verdict === 'replace' ? (decision.newAgentId ?? target.agentId) : target.agentId
    appended.push({
      id: `s${input.baseCount + appended.length + 1}`,
      goal: target.goal,
      agentId,
      logicalId: key,
      supersedes: target.id,
      // 口径沿用原步的那一份：重做的是同一件事，换一份口径等于换了个目标。
      ...(target.acceptance === undefined || target.acceptance === ''
        ? {}
        : { acceptance: target.acceptance }),
    })
  }
  return { appended, exhausted }
}

/**
 * 从落库的子任务记录重建交给汇总的材料。 *
 * 补话之后要重新汇总，而那时派活阶段的 `reports` 早已不在内存里（进程可能都换过一次），
 * 所以按同一种口径从库里重建：成功取结果正文，失败与取消带上原因，还没答复的带上已交回的
 * 材料和待答事项。
 */
export function reportOf(subtask: {
  readonly state: SubtaskState
  readonly agentId: string
  readonly result: string
  readonly error: string
}): string {
  switch (subtask.state) {
    case 'succeeded': return subtask.result
    // 失败也把已经交回的材料带上。超时就是一个例子：成员把候选稿交回来了，只是用户一直
    // 没回话 —— 只说「失败：超时」会让人以为材料也丢了。
    case 'failed': {
      /**
       * 重启重放被拒**不是**活没干好：那一轮此前已经交付过，运行时只是拒绝再跑一遍。
       * 渲染成"失败"会让老板以为成员出了问题，所以这里换一句说明（判据 D-1）。
       */
      if (subtask.error.startsWith(REPLAY_REJECTED_PREFIX)) {
        return subtask.result === ''
          ? `【${subtask.agentId}】${subtask.error}`
          : `【${subtask.agentId}】${subtask.error}；已交回的材料：${subtask.result}`
      }
      return subtask.result === ''
        ? `【${subtask.agentId}】失败：${subtask.error}`
        : `【${subtask.agentId}】失败：${subtask.error}；已交回的材料：${subtask.result}`
    }
    case 'cancelled': return `【${subtask.agentId}】${subtask.error === '' ? '已停止' : subtask.error}`
    case 'external_pending': return `【${subtask.agentId}】材料已交回，还有事在别处等着办：${subtask.result}`
    default: return `【${subtask.agentId}】交回材料，还等着答复：${subtask.result}`
  }
}
