/**
 * 发送与回合流（拆分设计 v2 批 1d）：sendMessage/runAct/runReply、事件消费、快照校准与
 * 断线跟随（followUntilTerminal）、忙碌态与续接。reportFailure→…→finishTurn 连续块整体搬入。
 */

import { attachmentChipsRow, attachmentsForSend, hideAttachUrl, renderAttachments, takeSentAttachments } from './attachments.js'
import { announce, append, autosize, reportFailure, clear, make, resetFollowing, scheduleFollowScroll, scrollToBottom, streamTraceEnabled, threadInner, traceEvent } from './dom.js'
import { renderTaskRecord } from './history.js'
import { refreshChatList, refreshPanels } from './panels.js'
import { applySummaryRail, resetRail, setRail } from './rail.js'
import { userMessage } from './speech.js'
import { el, newConversationId, recallConversation, state } from './state.js'
import { summaryCard } from './cards.js'
import { handleEvent } from './events.js'
import { act, api, chat, events, eventsHead, reply } from '../api.js'

/* ── 发送与回复 ───────────────────────────────────────────────────────── */

export function setBusy(on) {
  state.streaming = on
  el.send.disabled = on
  el.stop.hidden = !on
  el.topStatus.textContent = on ? '正在处理' : '已上线'
  // 只锁发送不锁输入（I02/C 批预编辑）：执行中可以写下一句，输入法组合不受影响；
  // 这句草稿也不会被异步完成、恢复或视图切换清掉——清空只发生在真正送出的那次提交。
  // 提示带红笔批注（空闲态「先听明白需求」红波浪）：固定文案走 DOM 构建，不拼 HTML。
  if (on) el.hint.textContent = '正在处理；下一句可以先写好，这轮完事再发'
  else el.hint.replaceChildren(
    document.createTextNode('牛马大总管'),
    Object.assign(make('span', 'red-wavy'), { textContent: '先听明白需求' }),
    document.createTextNode('，再替你分派成员'),
  )
  // 执行中进设置页的提示随状态同步（方案 I18）。
  el.settingsLive.hidden = !(state.settingsOpen && on)
  el.settingsLive.textContent = state.settingsOpen && on ? '有任务正在执行：回群聊可查看进度或喊停' : ''
}


/**
 * 刷新或重新打开页面时，接上正在跑的那一轮。
 *
 * 关掉页面不再等于取消任务（见服务端 `/events` 的说明），所以「活还在干，页面得能看」
 * 是这套语义的另一半。先问一句有没有在跑的一轮：没有就直接返回，什么都不改 ——
 * 历史照旧由左栏按需渲染，不在这里抢界面，也不为一个没在跑的任务白拉整轮事件。
 *
 * 确认在跑之后才接管中栏，从这一轮的第一条事件重放回来并继续跟随。
 */
export async function resumeLiveTurn() {
  const conversationId = recallConversation()
  if (conversationId === null || conversationId === '' || state.streaming) return

  // 探测有网络往返：等回包的这段时间里用户可能已经打开了别的会话或发起了新消息。
  // 先记下当前视图代次，回包后复核——不是当前视图就不接管（方案 I09）。
  const tokenAtProbe = state.viewToken
  let head
  try {
    head = await eventsHead(conversationId)
  } catch (error) {
    if (tokenAtProbe !== state.viewToken) return
    // 接续检查失败不能静默吞掉（方案 S04）：用户会以为一切正常，其实连不上。
    append(make('p', 'error-line', `接续检查失败：${error instanceof Error ? error.message : '网络异常'}；刷新页面可重试`))
    return
  }
  if (head === null || head.state !== 'running') return
  if (tokenAtProbe !== state.viewToken || state.streaming) return

  const controller = new AbortController()
  // 接管视图：作废之前还在路上的历史读取回包，它们的结论属于旧视图。
  state.viewToken += 1
  state.conversationId = conversationId
  state.abort = controller
  clear(el.thread)
  threadInner()
  state.bubbles.clear()
  state.asks.clear()
  resetRail()
  resetFollowing()
  setBusy(true)
  // 只读订阅接续：reset 时按快照校准并从窗口头续订，断线有界重订（S05/S06）。
  try {
    await followUntilTerminal(conversationId, { from: 0, expectedRunId: head.runId, signal: controller.signal })
  } catch (error) {
    reportFailure(error, '接续正在执行的任务失败')
  } finally {
    finishTurn()
  }
}

export async function sendMessage(text, reuseRequestId) {
  const trimmed = text.trim()
  if (trimmed === '' || state.streaming) return
  const fresh = state.conversationId === null
  if (fresh) state.conversationId = newConversationId()
  // 同一会话的新回合追加在原线程后面；只有第一次发送（或欢迎页还在）才换新视图（方案 I01）。
  if (fresh || el.thread.querySelector('.welcome') !== null) {
    state.viewToken += 1
    clear(el.thread)
    threadInner()
  }
  // 无论换不换视图，提交就回到跟随：用户发出的话和这一轮的回复要出现在眼前，
  // 不能沿用上次读完历史留下的暂停状态（浏览器复验发现的缺口）。
  resetFollowing()
  // 回合级状态每轮都换新：链路条不能带着上一轮的进度开跑，runId 也要清——
  // 新请求未收到回执就断流时，不能还顶着上一轮的身份去跟随（B 轮会接错 A 轮）。
  state.bubbles.clear()
  state.asks.clear()
  state.lastSeq = 0
  state.lastRunTaskId = ''
  state.lastRunId = ''
  resetRail()
  setRail('parse', 'active')
  setBusy(true)
  state.abort = new AbortController()
  // 提交幂等身份（S07）：同一次提交的重试复用，新的提交换新 ID——服务端按它认出
  // 「同一句话」，重试不会把活再派一遍。
  const requestId = reuseRequestId ?? newConversationId()
  // 这一轮带的附件。**空数组也照发**：老客户端不带这个字段，服务端按"没有附件"处理，
  // 与加这个功能之前逐字一致。
  const attachmentIds = attachmentsForSend()
  el.input.value = ''
  autosize()
  // 提交内容先就地呈现，配一行「正在发送」：受理与否是服务端事实，客户端不编（方案 S03）。
  const bubble = userMessage(trimmed, Date.now())
  // 附件随用户消息一起出现：它们和这句话是同一件事，分开放会让人以为文件还没交出去。
  const sentEntries = attachmentIds.length === 0 ? [] : takeSentAttachments(attachmentIds)
  if (sentEntries.length > 0) {
    const column = bubble.querySelector('.msg__col')
    const meta = column?.querySelector('.msg__meta')
    if (column !== null && meta !== null) column.insertBefore(attachmentChipsRow(sentEntries), meta)
    hideAttachUrl()
  }
  const note = append(make('p', 'msg__meta', '正在发送…'))
  state.pendingUser = { text: trimmed, bubble }
  let sawTerminal = false
  try {
    for await (const event of chat({ conversationId: state.conversationId, message: trimmed, requestId, attachmentIds, signal: state.abort.signal })) {
      if (event.type === 'summary') sawTerminal = true
      consumeTurnEvent(event, note)
    }
    state.pendingUser = null
    if (note.isConnected) note.remove()
    // 连接自然结束但终态没来（S06）：断连窗口里可能已收尾或仍在跑，跟到终态为止。
    if (!sawTerminal && state.abort.signal.aborted === false) {
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
  } catch (error) {
    if (note.isConnected) note.remove()
    if (state.pendingUser !== null) {
      // 还没受理就失败了：草稿回到输入框（用户后来打过字就不覆盖），并给出重试入口；
      // 重试复用同一个 requestId，不会把活再派一遍。附件也一并退回输入框上方——它们确实还没交出去。
      state.pendingUser = null
      if (el.input.value.trim() === '') { el.input.value = trimmed; autosize() }
      if (sentEntries.length > 0) {
        state.attachments = [...sentEntries, ...state.attachments]
        renderAttachments()
      }
      retryEntry(trimmed, error instanceof Error && error.message ? error.message : '没送出去', bubble, requestId)
    } else {
      // 已受理后连接断掉：这一轮还在服务端跑，重订事件流跟到终态，不自动重发。
      reportFailure(error, '发送失败')
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
    scheduleFollowScroll()
  } finally {
    finishTurn()
  }
}

/** 提交失败后的重试入口：撤掉失败的痕迹，原样重发同一句话（同一幂等身份）。 */
export function retryEntry(text, message, staleBubble, requestId) {
  const row = make('div', 'error-line error-line--retry')
  row.appendChild(make('span', null, `${message}。`))
  const button = make('button', 'btn btn--tiny', '重试')
  button.type = 'button'
  button.addEventListener('click', () => {
    staleBubble?.remove()
    row.remove()
    void sendMessage(text, requestId)
  })
  row.appendChild(button)
  append(row)
}

/**
 * 把一条操作决策交给服务端，并跟完这一轮（与 `runReply` 同一条消费路径）。
 *
 * 差别只在事件源：`act` 送的是一个结构化决策，服务端受理之后执行在后台跑，这条连接只把事件
 * 推回来。**不受理任何凭据**：卡片上只有呈现数据，执行方从自己的记录里取确认凭据。
 */
export async function runAct(input) {
  setBusy(true)
  state.abort = new AbortController()
  state.lastSeq = 0
  state.lastRunId = ''
  resetFollowing()
  let accepted = false
  let sawTerminal = false
  try {
    for await (const event of act({ ...input, signal: state.abort.signal })) {
      if (event.type === 'summary') sawTerminal = true
      traceEvent('receive', event)
      accepted = true
      consumeTurnEvent(event)
    }
    if (!sawTerminal && accepted && state.abort.signal.aborted === false && state.conversationId !== null) {
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
  } finally {
    finishTurn()
  }
}

export async function runReply(input, hooks = {}) {
  setBusy(true)
  state.abort = new AbortController()
  // 与 sendMessage 同一套回合重置：runId 不清会让新一轮回话顶着上一轮的身份；
  // 回话也回到跟随，用户要看到成员接下来的答复。
  state.lastSeq = 0
  state.lastRunId = ''
  resetFollowing()
  let accepted = false
  let sawTerminal = false
  try {
    for await (const event of reply({ ...input, signal: state.abort.signal })) {
      if (event.type === 'summary') sawTerminal = true
      traceEvent('receive', event)
      if (!accepted) {
        accepted = true
        // 受理确认：请示卡到这一步才收起，之前失败都还能改（方案 I03）。
        hooks.onAccepted?.()
      }
      consumeTurnEvent(event)
    }
    // 与提交同一条恢复路径（S06）：没看到终态就跟到终态。
    if (!sawTerminal && accepted && state.abort.signal.aborted === false && state.conversationId !== null) {
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
  } catch (error) {
    reportFailure(error, '回复没送出去')
    if (!accepted) hooks.onRejected?.(error)
    else if (state.conversationId !== null && state.abort.signal.aborted === false) {
      await followUntilTerminal(state.conversationId, { from: state.lastSeq, expectedRunId: state.lastRunId, signal: state.abort.signal })
    }
  } finally {
    finishTurn()
  }
}


/* ── 恢复一致性（B 批 S05/S06/S09/S12）────────────────────────────────── */

/**
 * 消费一条本轮事件：更新游标与任务标识，正文/汇总按现有分发渲染。
 * 三条流（提交、回话、只读接续）共用，保证断线重订时游标口径只有一份。
 */
export function consumeTurnEvent(event, note) {
  traceEvent('receive', event)
  if (event.type === 'run') {
    // 新一轮开始：seq 空间按轮重置，游标跟着归零；runId 是断线重订的「预期对象」，
    // 必须在消费回执时记下——没有它，重订无法证明跟随的还是原受理的那一轮。
    state.lastSeq = 0
    state.lastRunId = event.runId
    if (event.taskId) state.lastRunTaskId = event.taskId
  }
  if (event.seq !== undefined) state.lastSeq = event.seq
  if (event.type === 'subtask' && event.taskId) state.lastRunTaskId = event.taskId
  if (event.type === 'plan' && event.taskId) state.lastRunTaskId = event.taskId
  if (note !== null && note !== undefined) {
    // 受理确认只推进占位；正文、计划或异常到达才撤（方案 S03）。run/reset 是流元事件，
    // 不代表「已经有内容」——B 批曾让 run 误撤占位，退回了 A 批修过的行为。
    if (event.type === 'conversation') {
      note.textContent = '正在理解目标…'
      announce('已受理，正在安排')
    }
    else if (event.type !== 'user' && event.type !== 'run' && event.type !== 'reset') note.remove()
  }
  handleEvent(event)
  if (streamTraceEnabled) requestAnimationFrame(() => traceEvent('draw', event))
}

/**
 * 按服务端快照校准终态（S06/S09）：断连期间这轮可能已经收尾，权威结论在任务记录里。
 * 快照只在没消费到 summary 时补一张终态卡，不重放整条线程（那会重复已显示的内容）。
 * 读取挂调用方的截止信号：整个恢复过程共用一个硬期限。
 */
export async function calibrateFromSnapshot(conversationId, stop) {
  try {
    if (state.lastRunTaskId === '') return
    const record = await api.task(state.lastRunTaskId, stop)
    if (record.conversationId !== conversationId) return
    if (!['completed', 'failed', 'cancelled', 'partial'].includes(record.state)) return
    applySummaryRail(record.state)
    append(summaryCard({ state: record.state, text: record.summary, error: record.error }))
    scheduleFollowScroll()
  } catch { /* 快照拿不到就保持现状：已有内容不因校准失败而清空。 */ }
}

/**
 * 按快照**重建**一轮还在跑的任务（S05 reset 校准）。
 *
 * 之前这里只处理终态：运行中的快照直接返回，随后却把游标推进到窗口头——尚未恢复的
 * 成员状态、正文和引用全被跳过。现在运行中同样重建：线程按快照重画，等待中的成员
 * 重新拿到回复入口，游标以重建时点之后的窗口头为准（快照读取到重订之间存在极小的
 * 事件窗口，由随后的事件逐步覆盖，不假装无缝）。读取同样挂截止信号。
 */
export async function rebuildFromSnapshot(conversationId, stop) {
  try {
    if (state.lastRunTaskId === '') return null
    const record = await api.task(state.lastRunTaskId, stop)
    if (record.conversationId !== conversationId) return null
    state.viewToken += 1
    clear(el.thread)
    threadInner()
    state.bubbles.clear()
    state.asks.clear()
    resetRail()
    renderTaskRecord(record, { liveResume: true })
    resetFollowing()
    scrollToBottom()
    return record
  } catch {
    append(make('p', 'error-line', '按快照重建失败；已收到的内容保留，终态以右栏为准。'))
    return null
  }
}

/**
 * 只读跟随一轮事件直到终态（S05/S06）：断线重订、reset 后按快照重建再从窗口头续订、
 * 无终态结束时按运行状态选择重订或按快照补终态卡。全部复用现有 /events 与 /task 接口。
 *
 * 不混轮次：跟随对象由 `expectedRunId` **预先指定**（本轮 run 头的消费回执或恢复探测）。
 * 没有回执时不跟随——探测到的「当前最新一轮」无法证明属于原提交，归属未知就如实
 * 说明，不把别人的轮次接进本次视图。重放的旧 seq 直接丢弃；快照读取失败不推进游标，
 * 保留原位按预算重试。
 * 硬期限：订阅、探测、快照读取与退避共用同一个截止信号（AbortSignal.any 组合调用方
 * 取消与剩余期限），悬挂中的任何一步到期即中止，退避可被截止提前唤醒；预算（2s 起、
 * 封顶 4s、最多 4 次、总长 120s）耗尽后如实放弃，不无限重试。
 */
export async function followUntilTerminal(conversationId, { from, expectedRunId, signal }) {
  let after = from
  if (expectedRunId === undefined || expectedRunId === '') {
    // 归属未知（例如提交流断在 run 头之前）：明确说明并按快照尽量收尾，
    // 不用「当前最新一轮」冒充原受理。
    append(make('p', 'msg__meta', '这次提交的受理回执没有收到，无法确认还在跑的那一轮是否属于它；结果请以右栏任务记录为准。'))
    return
  }
  const followedRunId = expectedRunId
  const deadline = Date.now() + 120000
  let reconnects = 0
  const giveUp = () => { append(make('p', 'error-line', '事件流已断开；已收到的内容保留，终态以右栏为准。')) }
  // 可中断退避：截止或取消提前唤醒；进入时信号已取消则立即退出，不空等计时器。
  // timer 先声明再赋值：done 可能被同步调度器立即调用，不能踩到初始化之前。
  const backoff = stop => new Promise(resolve => {
    if (stop.aborted) { resolve(); return }
    let timer
    const done = () => { clearTimeout(timer); stop.removeEventListener('abort', done); resolve() }
    timer = setTimeout(done, Math.min(1000 * 2 ** reconnects, 4000))
    stop.addEventListener('abort', done, { once: true })
  })
  for (;;) {
    let sawTerminal = false
    let sawReset = false
    // 截止信号：每轮按剩余期限重建，取消与到期都能中断订阅、探测与快照读取。
    const remaining = deadline - Date.now()
    if (remaining <= 0) { giveUp(); return }
    const timeout = AbortSignal.timeout(remaining)
    const stop = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      for await (const event of events({ conversationId, after, signal: stop })) {
        if (event.type === 'run') {
          // 轮次边界：与预期不符（服务端已换轮）立即按快照收尾，不消费新轮任何事件。
          if (event.runId !== followedRunId) {
            await calibrateFromSnapshot(conversationId, stop)
            return
          }
          state.lastSeq = 0
          if (event.taskId) state.lastRunTaskId = event.taskId
          continue
        }
        if (event.type === 'reset') {
          // 滚出窗口的事件补不回来：按快照重建（运行中同样重建），再从窗口头续订。
          sawReset = true
          continue
        }
        // 不混轮次：别的轮次的重放事件不应用；同一轮内重放的旧序号直接丢弃。
        if (event.runId !== undefined && event.runId !== followedRunId) continue
        if (event.seq !== undefined) {
          if (after > 0 && event.seq <= after) continue
          after = event.seq
        }
        if (event.type === 'summary') sawTerminal = true
        consumeTurnEvent(event)
      }
      if (sawTerminal) return
      const head = await eventsHead(conversationId, stop)
      if (head === null || head.state !== 'running') {
        // 连接自然结束但没看到终态：终态多半在断连窗口里发生，按快照补结论（S06）。
        await calibrateFromSnapshot(conversationId, stop)
        return
      }
      if (head.runId !== followedRunId) {
        // 跟随的那一轮已被新的一轮接替：按快照收尾，不把新轮内容混进本次视图。
        await rebuildFromSnapshot(conversationId, stop)
        return
      }
      if (sawReset) {
        // 重建要用快照：任务标识从探测头部取——reset 流本身不带 run 头（浏览器实测发现），
        // 刷新接续时 lastRunTaskId 还是空，不补这一步重建会空转。
        if (head.taskId) state.lastRunTaskId = head.taskId
        const rebuilt = await rebuildFromSnapshot(conversationId, stop)
        // 快照读取失败不推进游标：保留原位，本轮按预算退避后重试重建（重订还会得到
        // reset，重建再次尝试）；只有重建成功才对齐到探测头部的窗口位置。重建成功后
        // 从 head.seq 续订——探测与重建之间产生的事件 seq 必然更大，续订会带上，
        // 不丢也不重复重放（head.seq 之前的事件不重放）。
        if (rebuilt !== null) after = head.seq
      }
    } catch (error) {
      if (signal?.aborted) return
      if (error?.name === 'AbortError') {
        if (timeout.aborted) { giveUp(); return }
        continue
      }
    }
    // 自然 EOF 后仍在跑（或断线）：同一份退避预算，不因「流正常结束」就零等待重连。
    reconnects += 1
    if (reconnects >= 4 || Date.now() > deadline) {
      giveUp()
      return
    }
    await backoff(stop)
    if (stop.aborted && !signal?.aborted) { giveUp(); return }
  }
}

export async function finishTurn() {
  setBusy(false)
  state.abort = null
  await refreshPanels()
  void refreshChatList()
  // 异步结束不抢焦点（方案 I05）：只在用户仍停留在会话区域时回到输入框；
  // 正在设置页、开着抽屉或选着字，都保持他现在的位置。
  const active = document.activeElement
  // 链路条节点已从页面移除（UI 重设计）：el.rail 为 null，contains 前必须判空。
  const inConversationArea = active === null || active === document.body
    || el.composer.contains(active) || el.thread.contains(active) || (el.rail !== null && el.rail.contains(active))
  const selection = document.getSelection()
  const selecting = selection !== null && !selection.isCollapsed
  if (!state.settingsOpen && document.body.dataset.drawer !== 'open' && document.body.dataset.sidebar !== 'open'
    && !selecting && inConversationArea) el.input.focus()
}


