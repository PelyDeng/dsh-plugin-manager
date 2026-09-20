/**
 * SSE 事件分发（拆分设计 v2 批 1d）：handleEvent/handleSubtask 把服务端事件路由到各域。
 * 处于依赖图上层（send 回调进来），本域不依赖 send/panels。
 */

import { STATE_TEXT, STREAM_RICH_LIMIT } from './config.js'
import { attachToDispatch, mountDispatch, settleCardForSummary } from './dcard.js'
import { announce, append, clear, displayNameOf, formatElapsed, make, scheduleFollowScroll, scheduleFrame, stabilizeViewport } from './dom.js'
import { renderTaskRecord } from './history.js'
import { ensureProgress, memberMessage, renderMemberMaterials, setThinking, settleMarkdown, settleMemberBody, settleMemberDynamics } from './member.js'
import { applySummaryRail, setRail } from './rail.js'
import { appendPreviewText, butlerDelta, butlerSettle, butlerThinking, dropThinkingOnlySpeech, userMessage } from './speech.js'
import { rememberConversation, state } from './state.js'
import { askCard, mountMemberActions, summaryCard } from './cards.js'
import { chat } from '../api.js'
import { richText } from '../markdown.js'

/* ── 中栏：事件分发 ───────────────────────────────────────────────────── */

export function handleEvent(event) {
  switch (event.type) {
    case 'conversation':
      state.conversationId = event.conversationId
      rememberConversation(event.conversationId)
      return

    case 'user': {
      // 发送时已经预渲染过同一条：受理回放对得上就不重复画。对不上（历史回放、
      // 其他入口）照常渲染。任务数量与派发事实只由 plan 与 subtask 事件表达。
      if (state.pendingUser !== null && state.pendingUser.text === event.text) {
        state.pendingUser = null
        break
      }
      dropThinkingOnlySpeech()
      state.butlerThinking = ''
      userMessage(event.text, event.time)
      break
    }

    case 'chat':
      butlerSettle(event.text, event.time)
      // 落定正文记下来：汇总与之相同就不再整段重复（S12）。
      state.lastChatText = event.text
      break

    case 'chat_delta':
      butlerDelta(event.text)
      break

    case 'chat_thinking':
      butlerThinking(event.thinking)
      break

    case 'chat_reset':
      // 模型重试开始（S08）：当前预览作废，下一段增量从新气泡起头，
      // 两次尝试的正文不拼在一起；被重试掉那一版的思考也不该留在页面上
      // ——只有思考、还没吐字的那条气泡在这里撤掉（有正文的留给落定替换）。
      dropThinkingOnlySpeech()
      state.butlerThinking = ''
      break

    case 'input': {
      // 使用者改了目标。先留一行痕迹，随后的分派与汇总照旧走原来的分支。
      state.taskId = event.taskId
      append(make('p', 'msg__meta',
        event.source === 'supplement'
          ? `补充已收到（第 ${event.version} 版）：${event.text}`
          : event.text))
      break
    }

    case 'plan': {
      state.taskId = event.taskId
      state.bubbles.clear()
      state.asks.clear()
      setRail('parse', 'done')
      setRail('dispatch', 'active')
      // 调度卡是新的一条消息：先收掉可能还开着的大总管气泡，别把两段话并到一条里。
      // 这里不替大总管编话：拆了几份、派给谁、有没有喊到人，由卡片和后续 subtask 事件
      // 按服务端事实呈现（方案 S02）。用户的折叠偏好按 taskId 记着，重建时先读偏好再渲染。
      dropThinkingOnlySpeech()
      append(mountDispatch(event.subtasks, { taskId: event.taskId, live: true }))
      break
    }

    case 'subtask':
      handleSubtask(event)
      break

    case 'subtask_delta': {
      const view = state.bubbles.get(event.id)
      // 终态之后不再追加（S08）：迟到帧不把已校准的结论再改掉。
      if (view === undefined || view.terminal === true || view.live === false) break
      view.body += event.delta
      // 按帧合并（I12）：增量先累积，一帧只写一次 DOM、推进一次进度。
      if (view.framePending === true) break
      view.framePending = true
      scheduleFrame(() => {
        view.framePending = false
        // terminal（已校准）或 live=false（已离开执行态，如等待）都不再写：
        // 迟到帧会把刚收起的光标重新点亮（浏览器验证发现的等待态复亮）。
        if (view.terminal === true || view.live === false) return
        // 流式与终态同一格式；超长正文降级纯文本追加（与 butlerDelta 同一分级）。
        if (view.body.length > STREAM_RICH_LIMIT) appendPreviewText(view.text, view, view.body)
        else view.text = richText(view.text, view.body, { streaming: true })
        view.caret.hidden = false
        // 不确定指示（复核 3）：增量不再换算百分比——没有可信分母不显示伪精度，
        // 真实阶段由工具行文字表达。
        ensureProgress(view)
      })
      break
    }

    case 'subtask_thinking':
      setThinking(state.bubbles.get(event.id), event.thinking)
      break

    case 'summary':
      // 汇总是这一轮的定论：链路条按最终状态推进，已走过的步骤保持点亮。
      applySummaryRail(event.state)
      for (const view of state.bubbles.values()) view.caret.hidden = true
      // 还在"进行中/排队"的格子在这一刻一律收口：这一轮已经有了定论，不能让某一格继续
      // 显示进行中、秒数还往上跳（成员自己那条终态事件可能因为取消/失败没有到达）。
      settleCardForSummary(event.state, event.time ?? Date.now())
      announce(`这一轮${
        event.state === 'completed' ? '已完成' : event.state === 'failed' ? '失败' : event.state === 'cancelled' ? '已喊停' : event.state === 'partial' ? '部分完成' : event.state === 'waiting_user' ? '等你回话' : '待外部处理'}`)
      // 正文只展示一次（S12）：总结气泡已经承载的正文，汇总卡不再整段重复；
      // 历史回放没有对应气泡时（renderTaskRecord），卡片照常承载。
      append(summaryCard(event.text !== '' && event.text === state.lastChatText
        ? { ...event, text: '' }
        : event))
      state.bubbles.clear()
      state.asks.clear()
      break

    case 'error':
      append(make('p', 'error-line', event.message))
      break

    default:
      break
  }
  scheduleFollowScroll()
}

export function handleSubtask(event) {
  const view = state.bubbles.get(event.id) ?? memberMessage(event.agentId, event.id)
  // 成员的真实输出收进调度卡；成员名下待确认的操作也画在同一个结果区里。
  attachToDispatch(view, event)
  mountMemberActions(view, event)
  // 材料行（产出区）：终态事件带 artifacts 时整块重画；undefined（老事件）不动。
  renderMemberMaterials(view, event.artifacts)
  view.status.textContent = STATE_TEXT[event.state] ?? event.state
  view.status.style.color =
    event.state === 'failed' ? 'var(--bt-error)'
      : event.state === 'waiting_user' || event.state === 'external_pending' ? 'var(--bt-warn)'
        : event.state === 'succeeded' ? 'var(--bt-ok)'
          : 'var(--bt-ink-soft)'

  if (event.state === 'dispatched') {
    // 新一次尝试从头开始（S08）：同一子任务重派时清掉上次的预览与终态标记，
    // 旧尝试的迟到增量不串进新版。上一轮交回的材料也一并撤下——它属于被重做的那次尝试。
    view.body = ''
    view.rendered = ''
    view.text.textContent = ''
    view.terminal = false
    view.live = true
    renderMemberMaterials(view, [])
    view.bubble.appendChild(make('div', 'typing')).appendChild(make('i'))
    const typing = view.bubble.querySelector('.typing')
    typing.appendChild(make('i'))
    typing.appendChild(make('i'))
    view.bubble.appendChild(make('div', 'msg__meta', `刚把活交给 ${displayNameOf(event.agentId)}`))
    setRail('work', 'active')
    return
  }

  view.bubble.querySelector('.typing')?.remove()

  if (event.state === 'running') {
    // 有增量正文时不要再塞状态文字，否则会和正文打架。
    if (view.body === '' && event.detail) {
      let line = view.bubble.querySelector('.tool-line')
      if (line === null) {
        line = make('div', 'tool-line')
        view.bubble.appendChild(line)
      }
      clear(line)
      line.appendChild(make('span', null, event.phase === 'tool' ? '正在翻资料：' : ''))
      line.appendChild(make('span', 'tool-line__name', event.tool ?? event.detail))
    } else if (event.tool !== undefined) {
      let line = view.bubble.querySelector('.tool-line')
      if (line === null) {
        line = make('div', 'tool-line')
        view.bubble.appendChild(line)
      }
      clear(line)
      line.appendChild(make('span', null, '正在翻资料：'))
      line.appendChild(make('span', 'tool-line__name', event.tool))
    }
    view.caret.hidden = false
    ensureProgress(view)
    setRail('work', 'active')
    return
  }

  // 到不了 running 往下的都是「不再执行」的状态：光标收起，动态痕迹一次清完（方案 I06）。
  view.caret.hidden = true
  settleMemberDynamics(view, event.state)

  if (event.state === 'waiting_user') {
    view.bubble.classList.add('bubble--wait')
    // 卡片正文用服务端给的正文（`detail`），**不要用 `question`**：问题是请示卡的内容
    // （`askCard` 自己会渲染），混进正文会让"正文"变成一句提问，与刷新后读到的不一样。
    settleMemberBody(view, event.detail)
    // 等你回话不是在计算：链路条给静态的等待态，不再转圈（方案 6.1）。
    setRail('work', 'waiting')
    announce(`${displayNameOf(event.agentId)} 等你回话`)
    askCard(view, event)
    return
  }

  if (event.state === 'external_pending') {
    // 材料交回来了，但还有事在外面办。这里**不给回复入口**：要办的事不在这一页，
    // 让用户在这里写一句话并不能把候选稿采用掉。也不显示成「完成」。
    view.bubble.classList.add('bubble--wait')
    settleMemberBody(view, event.detail)
    view.footer.appendChild(make('div', 'msg__meta', '待外部处理，办好之后可以新开一轮'))
    announce(`${displayNameOf(event.agentId)} 交回材料，还有事待外部处理`)
    return
  }

  if (event.state === 'succeeded') {
    view.bubble.classList.add('bubble--done')
    view.terminal = true
    // 终态正文是权威结论（S09）：成功那一刻按它校准并落成受控 Markdown（C 批）——
    // 丢段或重试残留的预览不会留在页面上；落定前后的布局变化不抢阅读位置（I11）。
    // ⚠️ 用"非空"判断而不是 `??`：服务端给的正文是空串时 `??` 不会回落，卡片会被清空。
    const authoritative = typeof event.detail === 'string' ? event.detail.trim() : ''
    const finalText = authoritative !== '' ? event.detail : view.body
    stabilizeViewport(() => {
      view.text = settleMarkdown(view.text, finalText)
      if (view.progress !== null) {
        view.progress.fill.classList.remove('progress__fill--indeterminate')
        view.progress.fill.style.width = '100%'
        view.progress.label.textContent = '完成'
      }
      // 耗时行也是这次落定的一部分：一并收进钉扎范围，别在补偿之后又顶开视口。
      view.footer.appendChild(make('div', 'msg__meta', `耗时 ${formatElapsed(view.startedAt, event.time)}`))
    })
    view.body = finalText
    return
  }

  if (event.state === 'failed' || event.state === 'cancelled') {
    view.terminal = true
    // classList.add('') 会抛 TypeError（取消态没样式类）：错误文本曾因此漏进线程。
    if (event.state === 'failed') view.bubble.classList.add('bubble--fail')
    /**
     * 正文同样以**服务端那一份**为准（它才是刷新后会重新读到的内容）。
     *
     * 失败/取消时服务端给的 `detail` 是这一轮的结论正文（可能是一句兜底话术），而攒下来的
     * 内容常常只是模型半路说的话——两者不一致正是"刷新前后不一样"的来源之一。
     * 只在服务端什么都没给时，才回落到攒下来的内容，别让卡片空着。
     */
    const settled = settleMemberBody(view, event.detail)
    // 「只看结论」不能把这一行藏掉——那是用户最需要看到的一句话。
    if (settled !== '' && typeof event.detail === 'string' && event.detail.trim() !== '' && event.detail.trim() !== settled) {
      view.bubble.appendChild(make('div', 'msg__meta msg__meta--keep', event.detail))
    }
    announce(event.state === 'failed' ? `${displayNameOf(event.agentId)} 失败：${event.detail ?? '原因不明'}` : `${displayNameOf(event.agentId)} 的活已取消`)
    return
  }
}
