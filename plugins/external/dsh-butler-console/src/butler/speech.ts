/**
 * 话术与思考快照（拆分 v2 批 2）：等待超时/喊停文案、汇总提示片段、思考滚动快照、进度队列文案。
 */

import type { ButlerEvent, ButlerInnerEvent } from '../butler.ts'

/** 末行还在生成时的占位：页面据此知道这一段还没写完。 */
export const THINKING_TAIL = '正在生成…'

/** 取出内部事件的正文；不是内部事件时返回 null。 */
export function summaryTextOf(event: ButlerInnerEvent): string | null {
  return event.type === 'summary_text' ? event.text : null
}

/**
 * 执行期间到达的进度事件。
 *
 * 执行方是在 `await dispatch/reply` 期间回调 `onProgress` 的，而生成器只能在自己体内
 * `yield`，所以用「队列 + 唤醒」把回调推入和生成器产出接起来：事件一到就产出，页面才
 * 看得见成员边说边出字；攒到子任务结束再一次性补发等于没有流式。
 */
export function progressQueue() {
  const queued: ButlerEvent[] = []
  let wake: (() => void) | undefined
  let settled = false
  const notify = () => { const resume = wake; wake = undefined; resume?.() }
  return {
    push(event: ButlerEvent) { queued.push(event); notify() },
    /** 执行已经结束：队列排空后产出随之结束。 */
    settle() { settled = true; notify() },
    async *drain(): AsyncGenerator<ButlerEvent> {
      while (queued.length > 0 || !settled) {
        if (queued.length === 0) { await new Promise<void>(resolve => { wake = resolve }); continue }
        yield queued.shift()!
      }
    },
  }
}

/** 等待超时收尾时给用户看的说明。要让人知道材料还在、重说一遍就能继续。 */
export const WAITING_EXPIRED = '等太久了，这次等待已经过期；材料都还在，重新描述你的目标就能接着办。'

/** 等待超时后任务级的失败说明，比子任务那句短。 */
export const WAITING_EXPIRED_TASK = '等用户回话超时，材料保留'

/** 喊停收掉等待中步骤时给用户看的说明。 */
export const WAITING_STOPPED = '老板喊停：这一轮的等待作废，材料都保留着，重述目标就能接着办。'

/** 喊停后任务级的说明。 */
export const WAITING_STOPPED_TASK = '老板喊停，等待中的步骤已作废，材料保留'

/**
 * 读对话正文时往前多读多少个事件，用来重建「这条消息属于第几回合」。
 *
 * `assistant/message` 自带回合号，`user/message` 不带 —— 它的回合得从前面那条
 * `turn/start` 推出来。翻页从回合中间开始时，不往前看一段就认不出归属，而往前读的成本
 * 只是一个回合的事件量。
 */
export const TRANSCRIPT_LEAD_EVENTS = 200

/** 汇总轮提示词的开头两句（{@link summarize} 拼装）：transcript 据此识别"这是发给模型的
 * 内件"而不是老板的话（两个标志同时命中才滤）。改这两句必须连同 transcript 过滤一起改。 */
export const SUMMARY_PROMPT_GOAL = '我的原始目标是：'

export const SUMMARY_PROMPT_RESULTS = '各子 Agent 已经返回结果'

/** 尾读模式的扫描块大小：会话日志只有正向读取原语，整段扫过去再取末尾。 */
export const TRANSCRIPT_SCAN_CHUNK = 512

/**
 * 把本轮推理整理成可发布的快照。
 *
 * 只发布**完整行**：末尾那一行还在生成，先只留一个占位，页面上的字就不会来回跳；
 * 回合结束时（`done`）把全部内容发出去，包括最后一行。全空时返回空串，调用方据此跳过，
 * 不发空事件。
 */
export function thinkingSnapshot(raw: string, done: boolean): string {
  const text = raw.replace(/\s+$/u, '')
  if (text === '') return ''
  if (done) return text
  const cut = text.lastIndexOf('\n')
  const head = cut < 0 ? '' : text.slice(0, cut)
  return head === '' ? THINKING_TAIL : `${head}\n${THINKING_TAIL}`
}
