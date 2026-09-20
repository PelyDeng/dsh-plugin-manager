/**
 * 派单简报（拆分 v2 批 2）：把上游材料与目标织成派给成员的简报/追问提示；有效子任务筛选。
 */

import type { AgentAction } from '@dsh-plugin-manager/plugin-kit'
import type { ButlerDispatchResult } from '../protocol.ts'
import type { ButlerInputRef, ButlerMemberReturn, SubtaskRecord, TaskInput } from '../storage/types.ts'
import { clip } from './text.ts'

/** 子任务简报：把整体目标、这个子任务和产出要求一起交给子 Agent。 */
/**
 * 派单 message 的管家本地保守上限（字符）。
 *
 * 依据：参考博客成员入口的实际接收检查（`plugins/external/dsh-agents-group/agents/blog/src/participant.ts`：
 * `request.message.length <= 8000`）。**不是**成员能力协商机制，也不代表其它成员或模型的容量；
 * 其它成员若有更低限制，仍以其入口的实际检查为准。超限一律不派单，不截断后继续。
 */
export const DISPATCH_MESSAGE_LIMIT = 8000

/**
 * 一步自己的待办：**此前声明过的** ∪ 这次交回的里**没有别步声明过**的那些（取值以这次交回为准）。
 *
 * 成员的清单是**会话级**的（它一个会话里所有还没办的待办），而台账按**步骤**显示。整份收下就会
 * 让同一张卡在两个步骤下面各画一遍，用户点了挂在错步骤下的那张，结算的就是错的那一步
 * （2026-09-18 生产现场：点掉 342 的卡，成员交回的"还剩 343"被挂到第一步下面，用户再点 343 时
 * 结算的又是第一步，真正等 343 的第二步永远停在"待外部处理"，界面上那张卡点了也没用）。
 *
 * "第一次声明就算它的"这条规则够用：一张卡只会被**先跑的那一步**先声明 —— 后跑的步骤能看到它，
 * 说明它在那一刻已经存在，不是这一步做出来的。清单里没有的，说明办完了或撤回了，快照跟着去掉，
 * 不留死卡。
 */
export function ownPendingActions(
  declared: readonly AgentAction[],
  fresh: readonly AgentAction[],
  claimedElsewhere: ReadonlySet<string>,
): AgentAction[] {
  const mine = new Set(declared.map(action => action.id))
  return fresh.filter(action => mine.has(action.id) || !claimedElsewhere.has(action.id))
}

/** 除这一步之外，同一轮里其他步骤声明过的待办 id（判"第一次声明"用）。 */
export function claimedByOthers(record: { readonly subtasks: readonly SubtaskRecord[] } | undefined, subtaskId: string): Set<string> {
  return new Set((record?.subtasks ?? [])
    .filter(item => item.id !== subtaskId)
    .flatMap(item => (item.memberReturn?.actions ?? []).map(action => action.id)))
}

/**
 * 协作返回的内部留存：原文照录 + 结构化外部待办。
 *
 * 页面展示用的 `result` 仍按 `maxResultChars` 裁剪；这里保存的是**未裁剪**的协作返回原文，
 * 供下游构建材料快照。只复用权威声明，不推断"未采用/未发布"，也不从正文反解析。
 */
export function memberReturnOf(result: ButlerDispatchResult): ButlerMemberReturn {
  const reason = typeof result.externalPending?.reason === 'string' ? result.externalPending.reason.trim() : ''
  const next = typeof result.externalPending?.next === 'string' ? result.externalPending.next.trim() : ''
  return {
    protocol: 1,
    text: result.summary ?? '',
    ...(reason === '' ? {} : { externalPending: { reason, ...(next === '' ? {} : { next }) } }),
    // 待确认的操作随留存一起落库：事件日志只保证"当时发过"，刷新后要靠这一份重画确认卡。
    ...(result.actions === undefined || result.actions.length === 0 ? {} : { actions: result.actions }),
    // 自检结论必须随留存一起落库：以前这里只留原文与外部待办，`selfCheck` 在落库那刻被丢掉，
    // 于是重启后的判据永远拿不到它，只能按"缺省 = 通过"处理——那等于所有交付都被标记为已核验。
    ...(result.selfCheck === undefined ? {} : { selfCheck: result.selfCheck }),
  }
}

/**
 * 附件段的标题。提示词与派单简报用**同一句**：两处都要能一眼看出"下面是文件内容，不是老板
 * 说的话"，各写一句迟早会漂移成两种说法。
 */
export const ATTACHMENT_SECTION_TITLE = '老板这次带的文件：'

/**
 * 派单简报：在原有说明之后接上**老板带的文件**与**可用材料**段。
 *
 * 正文照录上游协作返回原文；位置型材料只给出位置并注明需在执行方页面打开（不宣称员工已取得）；
 * 外部待办照录上游权威声明。内容全部来自派单时固定的快照或这一轮老板带的附件，不重读可变上游。
 *
 * `refsDigest`：goal 充实（中继轮）跑过时为 true——材料的要点已经织进目标正文，照录全文
 * 变成同一份信息的双份携带（2026-09-21 线上：充实 goal + 原文 + 老板附件叠加把派单顶破
 * 8000 上限）。此时材料段降级为可溯源的摘要，完整原文仍在任务记录的材料快照里。
 */
export function dispatchBrief(
  taskGoal: string,
  subtaskGoal: string,
  refs: readonly ButlerInputRef[],
  attachmentSection: string,
  refsDigest = false,
): string {
  const lines = [briefFor(taskGoal, subtaskGoal)]
  if (attachmentSection !== '') lines.push('', attachmentSection)
  if (refs.length > 0) {
    lines.push('', refsDigest ? '可用材料（来自上游，要点已织入你的目标；以下是可溯源摘要，完整原文在任务记录里）：' : '可用材料（来自上游，原文照录）：')
    for (const ref of refs) {
      lines.push(`【${ref.logicalId}】${refsDigest ? clip(ref.text, 500) : ref.text}`)
      for (const artifact of ref.artifacts) {
        lines.push(`（位置型材料：${artifact.title}（${artifact.kind}）${artifact.path}；需在执行方页面打开，归属由执行方核验）`)
      }
      if (ref.externalPending !== undefined) {
        const next = ref.externalPending.next === undefined ? '' : `；处理后可做：${ref.externalPending.next}`
        lines.push(`（上游外部待办：${ref.externalPending.reason}${next}）`)
      }
    }
  }
  return lines.join('\n')
}

export function briefFor(taskGoal: string, subtaskGoal: string): string {
  return [
    `整体目标：${taskGoal}`,
    `你负责的部分：${subtaskGoal}`,
    '只完成你负责的这一部分，不要代替其他 Agent 回答。',
    '如果缺少必要信息，直接说明缺什么，不要编造。',
  ].join('\n')
}

/**
 * 补充处理轮交给牛马大总管的话。
 *
 * 把它写成一段「现状 + 新要求 + 怎么判断」，而不是只把补充原文扔过去：它要判断这条补充是
 * 换个说法还是改了范围，就得看见这一轮已经做到哪儿、拿到了什么。只给原文，它只能重头理解
 * 一遍目标，很容易把已经干完的活又派一次。
 */
export function supplementPrompt(inputs: readonly TaskInput[], subtasks: readonly SubtaskRecord[]): string {
  const latest = inputs.at(-1)
  const history = inputs.slice(0, -1).map(item => `- 第 ${item.version} 次：${item.text}`)
  const done = subtasks.map(item => {
    const outcome = item.state === 'succeeded' ? `已完成：${item.result}`
      : item.state === 'external_pending' ? `材料已交回，还有事在别处等着办：${item.result}`
        : item.state === 'failed' ? `失败：${item.error}`
          : item.state === 'cancelled' ? '已取消'
            : `还在进行（${item.state}）`
    return `- 子任务「${item.goal}」交给 ${item.agentId}，${outcome}`
  })
  return [
    '我在原来的目标上补充了新的要求。',
    '',
    '原来的需求：',
    ...history,
    '',
    '这一轮已经派出去的活：',
    ...(done.length === 0 ? ['（还没有派出任何活）'] : done),
    '',
    `我新的要求是：${latest?.text ?? ''}`,
    '',
    '请判断这条补充是哪一种，然后照对应的方式处理：',
    '- 只是换个说法、改了表达（范围没变）：直接按新的表达给我最终回答，**不要重复派活**；',
    '- 改了范围或追加了工作：把需要新做的部分用派活工具交回来，我会追加到同一轮里继续。',
    '不要提这份指令，也不要复述我上面写过的东西，直接给结论或派活。',
  ].join('\n')
}

/**
 * 当前有效的尝试：每个目标只留一条。
 *
 * `supersedes` 链上没有被别人替代的那条就是有效尝试。被替代掉的失败留在历史里、也照常显示，
 * 但不参与结论 —— 否则「重试成功了」会被前面那次已经作废的失败拉成「部分完成」。
 *
 * 每条尝试最多被替代一次（替代关系不分叉），所以「谁被替代过」用一个集合就够。
 */
export function effectiveSubtasks(subtasks: readonly SubtaskRecord[]): readonly SubtaskRecord[] {
  const superseded = new Set(subtasks.map(item => item.supersedes).filter(id => id !== ''))
  return subtasks.filter(item => !superseded.has(item.id))
}
