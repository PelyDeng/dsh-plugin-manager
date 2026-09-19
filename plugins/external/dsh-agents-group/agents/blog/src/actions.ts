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
import type { ParticipantAction, ParticipantArtifact } from '../../../packages/runtime/src/contract.ts'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'

/** 业务侧要用到的三个门面（都从装配处传入，模块自己不 import 具体实现）。 */
export interface ApplyActionPorts {
  /** 读一条操作记录（含凭据与当前状态；办结材料也从它取——`result` 是业务库写下的权威值）。 */
  operation(owner: string, id: string): Promise<{
    readonly id: string
    readonly mode: string
    readonly title: string
    readonly status: string
    readonly nonce?: string
    /** 办结结果（`confirm` 成功后由业务库写入）；发布类操作带可访问的 `url`。 */
    readonly result?: { readonly url?: string | null } | null
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
  /** 材料行里"在成员页面打开"的位置（装配侧拼路由前缀，模块不知道路由）。 */
  materialPath(conversationId: string): string
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

/**
 * 办结后的核验材料：从**业务库操作记录**取，不从调用方拿、也不从措辞猜。
 *
 * 只有产出"用户可核对的东西"的操作给材料：发布 → 已发布文章（可访问链接），保存 → 草稿。
 * 删除/管理没有可点开核对的公开产出，如实不给——**没有材料是事实，编一份材料是谎**。
 *
 * 这是对「办了，但没递东西给我核」的闭环：协调方拿到 `{ url, state, fields }` 之后，
 * 产出区能画出一行可点开核对的链接，裁决能拿 `state` 对照口径，不必解析正文。
 */
function materialOf(
  operation: { readonly mode: string; readonly title: string; readonly status: string; readonly result?: { readonly url?: string | null } | null },
  path: string,
): { readonly artifact: ParticipantArtifact; readonly note: string } | undefined {
  if (operation.status !== 'succeeded') return undefined
  const title = operation.title === '' ? '这篇文章' : operation.title
  if (operation.mode === 'publish') {
    // 桥接没交回 url 也照样给 `state: 'published'`：状态是事实，链接缺失另算（渲染层降级为无链接行）。
    const url = operation.result?.url
    const usable = typeof url === 'string' && url !== '' ? url : undefined
    return {
      note: `《${title}》已发布。`,
      artifact: {
        kind: 'article',
        title: `《${title}》已发布`,
        path,
        state: 'published',
        ...(usable === undefined ? {} : { url: usable }),
        fields: [
          { label: '发布状态', value: '已发布' },
          ...(usable === undefined ? [] : [{ label: '链接', value: usable }]),
        ],
      },
    }
  }
  if (operation.mode === 'draft') {
    return {
      note: `《${title}》已保存为草稿。`,
      artifact: {
        kind: 'draft',
        title: `《${title}》已保存为草稿`,
        path,
        state: 'draft',
        fields: [{ label: '状态', value: '已保存为草稿（不是已发布）' }],
      },
    }
  }
  return undefined
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
      // 重入同样交回办结材料（从操作记录重取，不重算）：同一操作无论点几次，台账看到的
      // 产出区是同一行——材料不稳定比没有材料更难核对。
      const replayMaterial = done ? materialOf(operation, ports.materialPath(conversationId)) : undefined
      return {
        status: done ? 'completed' : 'external_pending',
        text: done
          ? `这条操作已经办完了。${replayMaterial === undefined ? '' : replayMaterial.note}`
          : `这条操作现在是「${operation.status}」，没有重复执行。`,
        ...(done === false ? { externalPending: { reason: `操作状态：${operation.status}` } } : {}),
        ...(replayMaterial === undefined ? {} : { artifacts: [replayMaterial.artifact] }),
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
    const hasRemaining = (after?.length ?? 0) > 0
    // 办结材料在 perform 之后从业务库**重取**：那条记录此刻才有 result 与最终状态，
    // 用开头的快照拼材料等于拿旧值充新事实。
    const settled = await ports.operation(owner, action.actionId)
    const material = action.decision === 'confirm' && settled.status === 'succeeded'
      ? materialOf(settled, ports.materialPath(conversationId))
      : undefined
    return {
      // 「先不办」是老板的终态结论：没有别的卡要等时这一步是 cancelled，不是"已完成"——
      // 投影成 completed 会让裁决把撤回读成"没经过确认就收了"，转头再派一轮重做（K2）。
      status: hasRemaining ? 'external_pending' : action.decision === 'cancel' ? 'cancelled' : 'completed',
      text: action.decision === 'confirm'
        ? `已经按你确认的办了。${material === undefined ? '' : material.note}`
        : '已经撤回，没有执行。',
      ...(material === undefined ? {} : { artifacts: [material.artifact] }),
      // 交回了结构化材料时按"对照业务库操作记录"给自检结论；没有材料（撤回/删除/管理）
      // 就不表态，运行时按"这一轮没有可核验产出"如实标——不冒充通过。
      ...(material === undefined ? {} : {
        selfCheck: { status: 'passed' as const, detail: '材料与状态取自业务库操作记录，操作已办结。' },
      }),
      ...(hasRemaining
        ? { actions: after, externalPending: { reason: '这个会话里还有别的待确认操作。' } }
        : {}),
    }
  }
}
