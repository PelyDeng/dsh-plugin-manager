/**
 * 就地确认（用户在**台账**上点的那一下）。
 *
 * ## 为什么单独一个模块
 *
 * 它是"通用操作架构"在博客这一侧的唯一落点：投影（`definition.ts` 的 `pendingActionsOf`）负责
 * **画得出来**，这里负责**办得了**。两者一起构成"新增一种操作只需要在博客侧写代码、协调方
 * 一行都不用改"的完整闭环，所以它必须能被单独测——三条不可让步的性质都在这里：
 *
 * 1. **归属自己核**：按 `owner` 读回操作记录，核它属于本次派活的会话；不属于就 403。
 * 2. **凭据不出业务**：`nonce` 从**我们自己的**记录里取，不从调用方拿、也不回传。
 *    模型与协调方都拿不到它 —— 这是"Agent 不能自己确认自己的操作"的落点。
 * 3. **幂等**：已经办过的操作不重复执行（用户会双击、网络会重试），如实回报它现在的状态。
 */
import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import type { ProjectedResult } from '../../../packages/runtime/src/definition.ts'
import type { ParticipantAction } from '../../../packages/runtime/src/contract.ts'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'

/** 业务侧要用到的三个门面（都从装配处传入，模块自己不 import 具体实现）。 */
export interface ApplyActionPorts {
  /** 读一条操作记录（含凭据与当前状态）。 */
  operation(owner: string, id: string): Promise<{
    readonly id: string
    readonly mode: string
    readonly title: string
    readonly status: string
    readonly nonce?: string
    readonly chat?: { conversationId?: string } | null
  }>
  /** 执行确认 / 撤回（内部会用记录里的 nonce 复核，所以调用方不需要凭据）。 */
  perform(input: { readonly actor: Actor; readonly conversationId: string; readonly id: string; readonly decision: 'confirm' | 'cancel'; readonly nonce?: string }): Promise<void>
  /**
   * 重算"这个会话里还剩哪些待办"（办完一条之后要一起交回）。
   *
   * 返回空数组表示没有待办。**刻意不是** `ProjectedResult['actions']`：后者含 `undefined`，
   * 而本仓开了 `exactOptionalPropertyTypes`，`actions: undefined` 赋不进可选字段，
   * 于是每个调用点都得写一次兜底——那种"运行期相等、类型不认"的噪声没有必要。
   */
  remaining(owner: string, conversationId: string): Promise<readonly ParticipantAction[]>
  /** owner 键（`namespace:userId`）；由装配侧给，模块不猜。 */
  ownerOf(actor: Actor): string
}

/** 一次决策请求（形状与运行时 `ActionApplyContext` 对齐，但只取本模块用到的字段）。 */
export interface ApplyActionInput {
  readonly actionId: string
  readonly decision: 'confirm' | 'cancel'
  readonly taskId: string
  readonly subtaskId: string
  readonly actor: Actor
  readonly conversationId?: string
}

export function createApplyAction(ports: ApplyActionPorts) {
  return async (action: ApplyActionInput): Promise<ProjectedResult> => {
    const owner = ports.ownerOf(action.actor)
    const operation = await ports.operation(owner, action.actionId)
    const conversationId = operation.chat?.conversationId ?? action.conversationId ?? ''
    if (action.conversationId !== undefined && operation.chat?.conversationId !== action.conversationId) {
      throw new AccessError(403, '这条操作不属于本次派活的会话')
    }
    // 幂等：`prepared` 之外的都说明它已经办过或正在办，不再执行第二次。
    if (action.decision === 'confirm' && operation.status !== 'prepared') {
      const done = operation.status === 'succeeded'
      return {
        status: done ? 'completed' : 'external_pending',
        text: done ? '这条操作已经办完了。' : `这条操作现在是「${operation.status}」，没有重复执行。`,
        ...(done ? {} : { externalPending: { reason: `操作状态：${operation.status}` } }),
        actions: await ports.remaining(owner, conversationId),
      }
    }
    try {
      await ports.perform({
        actor: action.actor,
        conversationId,
        id: action.actionId,
        decision: action.decision,
        // 凭据就在这里从**我们自己的记录**里补上：调用方从来没有它，也拿不到它。
        ...(operation.nonce === undefined ? {} : { nonce: operation.nonce }),
      })
    } catch (error) {
      return {
        status: 'failed',
        text: action.decision === 'confirm' ? '这次确认没有成功。' : '这次撤回没有成功。',
        actions: await ports.remaining(owner, conversationId),
        externalPending: { reason: `操作没有成功：${error instanceof Error && error.message ? error.message : '原因不明'}` },
      }
    }
    const after = await ports.remaining(owner, conversationId)
    return {
      status: (after?.length ?? 0) > 0 ? 'external_pending' : 'completed',
      text: action.decision === 'confirm' ? '已经按你确认的办了。' : '已经撤回，没有执行。',
      ...((after?.length ?? 0) > 0
        ? { actions: after, externalPending: { reason: '这个会话里还有别的待确认操作。' } }
        : {}),
    }
  }
}
