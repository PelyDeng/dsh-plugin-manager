/**
 * 回合域（评审 #10 拆分）：发送/补充/回话/决策/停止/接续六条路径与公共消费层。
 * 错误呈现四通道对照表见本文件头部注释。
 */
/**
 * 回合驱动的应用层：把 turn-engine（纯控制流）与 turn store（状态面）绑定起来。
 *
 * ── 错误呈现四通道对照表（评审 #17，新错误先查这张表再选通道）──────────
 * │ 通道            │ 视觉可见 │ 何时用                                     │ 例
 * │ 流内 error 行   │ 是(持久) │ 回合内业务失败/连接中断，属于对话叙事        │ sendMessage catch
 * │ 卡内 note       │ 是(随卡) │ 只属于这张卡的局部失败（决策/回话没送出）    │ ActionDeck.runDecision
 * │ 顶栏 topStatus  │ 是(全局) │ 全局数据源故障（左右栏读不到/未登录）        │ refreshPanelsData
 * │ announce        │ 否(读屏) │ 补充无障碍播报，或视觉无害的状态变化         │ 已补充给当前任务
 * 原则：能就地（卡内）不全局（顶栏）；announce 永不作为视觉用户的唯一告知。
 *
 * 订阅幂等（StrictMode，方案 §3.3 批 0 决策的落地）：resumeLiveTurn 由 bootstrap effect
 * 调用，effect 双调用时第二次被 streaming 守卫与 viewToken 复核挡住；订阅本身挂 abort
 * controller，store.switchConversation 的原子动作负责完整 cleanup，after=lastSeq 保证
 * 重订不重复消费。
 */
import { api, eventsHead, ApiError, chat, reply, act, supplement } from '../lib/api.ts'
import type { TaskRecord } from '../lib/api.ts'
export { act }
import { followUntilTerminal, productionLinks, type TurnEngineHost } from '../lib/turn-engine.ts'
import { newConversationId, rememberConversation } from '../lib/turn-event.ts'
import { errorTextOf } from '../lib/error-text.ts'
import type { TurnEvent } from '../lib/turn-event.ts'
import { useTurnStore, type ThreadEntry } from '../stores/turn.ts'
import { useSessionStore, TOP_IDLE, TOP_STOPPING } from '../stores/session.ts'
import { useComposerStore } from '../stores/composer.ts'
import { announce } from '../lib/announce.ts'
import { useAttachmentsStore } from '../stores/attachments.ts'
import { takeSentAttachments } from './attachments.ts'
import { attachmentsForSend, clearAttachments, loadAttachments } from './attachments.ts'

let hostEntrySeq = 0

export function reportFailure(error: unknown, fallback: string): void {
  if ((error as Error)?.name === 'AbortError') {
    useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text: '连接已中断，这一轮是否结束以右栏状态为准。' })
    return
  }
  useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text: errorTextOf(error, fallback) })
}

/** 回合收尾：忙碌态落回 + 右栏低频数据刷新（I05 焦点归还随 composer 批 3/4a 落地）。 */
export async function finishTurn(): Promise<void> {
  useTurnStore.setState({ streaming: false, abort: null })
  useSessionStore.getState().setTopStatus(TOP_IDLE)
  await refreshPanelsData()
  void refreshChatList()
}

// 左右栏运维域已拆至 flows/panels.ts（评审 #10）；此处 re-export 保持组件 import 路径稳定。
import { refreshPanelsData, refreshChatList } from '../flows/panels.ts'
export { refreshPanelsData, refreshChatList, gotoChatPage, renameConversation, removePickedFailures, removeConversationsWithFeedback, deletePickedConversations, openNewChat } from '../flows/panels.ts'
/* ── 基础发送链路（批 3：直发+停止+失败重试，无 @提及/附件）──────────────── */

/** 重试入口渲染（error-line + 重试按钮），由 Thread 按 entry 渲染。 */
export interface RetryEntry {
  key: string
  text: string
  requestText: string
  requestId: string
}

export async function sendMessage(text: string, reuseRequestId?: string): Promise<void> {
  const trimmed = text.trim()
  const before = useTurnStore.getState()
  if (trimmed === '' || before.streaming) return
  const fresh = before.conversationId === null
  if (fresh) {
    useTurnStore.setState({ conversationId: newConversationId() })
    rememberConversation(useTurnStore.getState().conversationId ?? '')
  }
  // 同一会话的新回合追加在原线程后；第一次发送（或欢迎页）才换新视图（I01）。
  const state = useTurnStore.getState()
  if (fresh || state.entries.length === 0) {
    // switchConversation 会重置会话 id——这里只重置视图面（beginRebuild 语义+保 id）。
    useTurnStore.setState({
      viewToken: state.viewToken + 1,
      entries: [],
      butlerSpeechKey: null,
      lastSeq: 0,
      lastRunId: '',
      lastRunTaskId: '',
      lastChatText: '',
      following: true,
    })
  }
  // 无论换不换视图，提交就回到跟随；回合级状态每轮换新（runId 不清会接错轮，B 轮教训）。
  useTurnStore.setState({
    streaming: true,
    abort: new AbortController(),
    lastSeq: 0,
    lastRunId: '',
    lastRunTaskId: '',
    following: true,
    pendingUser: { text: trimmed },
  })
  // 提交幂等身份（S07）：重试复用，新提交换新 ID。
  const requestId = reuseRequestId ?? newConversationId()
  const abortSignal = useTurnStore.getState().abort?.signal
  // 这一轮带的附件。**空数组也照发**：老客户端不带这个字段，服务端按「没有附件」处理。
  const attachmentIds = attachmentsForSend()
  // 受理与否是服务端事实：先就地呈现这句话与「正在发送…」（S03），正文不本地编。
  const userKey = `user-send-${requestId}`
  const noteKey = `note-send-${requestId}`
  // 附件随用户消息一起出现：发完就从输入框挪到消息里，不留重复的一份。
  const sentEntries = attachmentIds.length === 0 ? [] : takeSentAttachments(attachmentIds)
  useTurnStore.getState().appendEntry({
    key: userKey, kind: 'user', text: trimmed, time: Date.now(),
    ...(sentEntries.length > 0 ? { attachments: sentEntries } : {}),
  })
  useTurnStore.getState().appendEntry({ key: noteKey, kind: 'note', text: '正在发送…' })
  if (sentEntries.length > 0) {
    useAttachmentsStore.getState().setUrlInputVisible(false)
  }
  try {
    // 附件随消息送出（S-attach）：空数组也照发，后端按「没有附件」处理（老客户端兼容形态）。
    const host = await createTurnEngineHost()
    const { sawTerminal } = await consumeTurnStream(
      chat({ conversationId: useTurnStore.getState().conversationId ?? '', message: trimmed, requestId, attachmentIds, signal: abortSignal }),
      host,
      {
        // 占位 note 的撤除口径与旧 consumeTurnEvent 一致：受理（conversation）推进文案，
        // 正文/计划/异常到达才撤；run/reset/user 是流元事件不撤。
        onEvent: event => {
          if (event.type === 'conversation') {
            useTurnStore.setState(st => ({ entries: st.entries.map(entry => entry.key === noteKey ? { ...entry, text: '正在理解目标…' } : entry) }))
            announce('已受理，正在安排')
          } else if (event.type !== 'user' && event.type !== 'run' && event.type !== 'reset') {
            useTurnStore.getState().removeEntry(noteKey)
          }
        },
      },
    )
    useTurnStore.setState({ pendingUser: null })
    useTurnStore.getState().removeEntry(noteKey)
    // 连接自然结束但终态没来（S06）：断连窗口里可能已收尾或仍在跑，跟到终态为止。
    await settleOrFollow(host, { sawTerminal, accepted: true })
  } catch (error) {
    useTurnStore.getState().removeEntry(noteKey)
    const pending = useTurnStore.getState().pendingUser
    if (pending !== null) {
      // 还没受理就失败：草稿回输入框（用户后来打过字就不覆盖——restore 语义），附件退回
      // 输入框上方；重试入口复用同一幂等身份，不会把活再派一遍。
      useTurnStore.setState({ pendingUser: null })
      useComposerStore.getState().requestFill(trimmed, 'restore')
      if (sentEntries.length > 0) {
        useAttachmentsStore.getState().add(sentEntries.map(entry => ({
          key: entry.key, name: entry.name, size: entry.size,
          phase: 'ready' as const, message: '', item: null,
        })))
      }
      useTurnStore.getState().appendEntry({
        key: `error-${requestId}`, kind: 'error',
        text: errorTextOf(error, '没送出去'),
        retryFor: { requestText: trimmed, requestId },
      })
    } else {
      // 已受理后连接断掉：这一轮还在服务端跑，重订事件流跟到终态，不自动重发。
      reportFailure(error, '发送失败')
      await settleOrFollow(await createTurnEngineHost(), { sawTerminal: false, accepted: true })
    }
  } finally {
    void finishTurn()
  }
}

/** 喊停（I04/I08）：停止对象绑定当前会话；先发请求、继续观察终态，不本地断流冒充已停。 */
export async function stopTurn(): Promise<void> {
  const conversationId = useTurnStore.getState().conversationId
  if (conversationId === null) return
  useSessionStore.getState().setTopStatus(TOP_STOPPING)
  try {
    // taskId 防误伤（评审 #10-中10）：只中止确实属于当前任务的那一轮。
    const outcome = await api.stop(conversationId, { taskId: useTurnStore.getState().lastRunTaskId, signal: AbortSignal.timeout(10000) })
    if (outcome.accepted) {
      // 等待中的任务被喊停时服务端给 reason（如「已把等待中的任务喊停，材料保留」）。
      if (typeof outcome.reason === 'string' && outcome.reason !== '') {
        useSessionStore.getState().setTopStatus(TOP_IDLE)
        useTurnStore.getState().appendEntry({ key: `note-stop-${Date.now()}`, kind: 'note', text: outcome.reason })
      }
      // 其余情况：终态由随后的 summary 事件落定，这里不再多说。
      return
    }
    useSessionStore.getState().setTopStatus(TOP_IDLE)
    useTurnStore.getState().appendEntry({ key: `note-stop-${Date.now()}`, kind: 'note', text: `没有停止：${outcome.reason || '这一轮已经不在执行'}` })
  } catch {
    useSessionStore.getState().setTopStatus({ kind: 'error', text: '停止请求失败', source: 'stop' })
    useTurnStore.getState().appendEntry({ key: `error-stop-${Date.now()}`, kind: 'error', text: '停止请求没送到，可以再试一次；取消不能回滚已经发生的操作。' })
    announce('停止请求没送到，可以再试一次')
  }
}

/**
 * 等待当前跟随收尾（streaming 复位）。确认卡出现（subtask 终态）先于回合收尾
 * （summary + run finished + finishTurn）——用户看到卡立即点击会撞进这个窗口，
 * 静默丢弃点击等于按钮坏了；等待复位后再发起，超时抛错让卡面提示。
 */
async function waitForTurnIdle(timeoutMs = 15000): Promise<void> {
  if (!useTurnStore.getState().streaming) return
  // 事件化等待（评审 #20）：订阅 streaming 复位即返回，不轮询空转。
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('上一轮还没收尾，稍等一下再点'))
    }, timeoutMs)
    const unsubscribe = useTurnStore.subscribe(state => {
      if (!state.streaming) {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  })
}

/** 操作卡决策入口（ActionDeck 用）：走 /action，requestId 幂等；跟随到终态。 */
export async function runActionDecision(input: {
  taskId: string
  subtaskId: string
  actionId: string
  decision: 'confirm' | 'cancel'
  /** 决策补充说明（评审 B4：如「换成 5 月再发」），后端 /action 原生支持。 */
  note?: string | undefined
  requestId?: string | undefined
}, hooks: { onAccepted?: () => void; onRejected?: (error: unknown) => void } = {}): Promise<void> {
  await waitForTurnIdle()
  useTurnStore.setState({ streaming: true, abort: new AbortController(), lastSeq: 0, lastRunId: '', following: true })
  const host = await createTurnEngineHost()
  try {
    let accepted = false
    for await (const event of act({ ...input, requestId: input.requestId ?? newConversationId(), signal: useTurnStore.getState().abort?.signal })) {
      // 决策流的第一个事件即受理回执：deck 卡就地摘下（乐观更新），不等执行期结束。
      if (!accepted) {
        accepted = true
        hooks.onAccepted?.()
      }
      useTurnStore.getState().applyTurnEvent(event)
    }
    const st = useTurnStore.getState()
    if (st.abort?.signal.aborted !== true && st.conversationId !== null) {
      await followUntilTerminal(st.conversationId, { from: st.lastSeq, expectedRunId: st.lastRunId, signal: st.abort?.signal }, productionLinks, host)
    }
  } catch (error) {
    reportFailure(error, '操作没送出去')
    // 卡面也要知道失败：否则 note 停在「正在办理…」、按钮锁死，用户以为点了没反应。
    hooks.onRejected?.(error)
  } finally {
    void finishTurn()
  }
}

/**
 * 给进行中的一轮补充目标/材料（/supplement，后端幂等）。受理即回调；事件进 store，
 * 跟随到终态——补充后的界面变化由服务端事件驱动，与回话同一管线。
 */
export async function runSupplement(input: { taskId: string; text: string; expectVersion?: number; requestId?: string | null }, hooks: {
  onAccepted?: () => void
  onRejected?: (error: unknown) => void
} = {}): Promise<void> {
  await waitForTurnIdle()
  useTurnStore.setState({ streaming: true, abort: new AbortController(), lastSeq: 0, lastRunId: '', following: true })
  const host = await createTurnEngineHost()
  try {
    // 受理判定：流内第一条事件即回执（deck 卡就地摘下），后续状态变化交给服务端事件。
    const { sawTerminal } = await consumeTurnStream(
      supplement({ taskId: input.taskId, text: input.text, expectVersion: input.expectVersion, requestId: input.requestId ?? newConversationId(), signal: useTurnStore.getState().abort?.signal }),
      host,
      { onFirstEvent: hooks.onAccepted },
    )
    await settleOrFollow(host, { sawTerminal, accepted: true })
  } catch (error) {
    reportFailure(error, '补充没送出去')
    hooks.onRejected?.(error)
  } finally {
    void finishTurn()
  }
}

/** 回应等待中的成员（runReply 语义：受理确认才收卡，失败卡内恢复，输入不丢）。 */
export async function runReply(input: { taskId: string; subtaskId: string; text: string; decideByAgent: boolean; requestId?: string | null }, hooks: {
  onAccepted?: () => void
  onRejected?: (error: unknown) => void
}): Promise<void> {
  await waitForTurnIdle()
  useTurnStore.setState({
    streaming: true,
    abort: new AbortController(),
    lastSeq: 0,
    lastRunId: '',
    following: true,
  })
  const host = await createTurnEngineHost()
  let sawTerminal = false
  let accepted = false
  try {
    const requestId = input.requestId ?? newConversationId()
    // 受理判定：流内第一条事件；requireAccepted——未受理的失败不重订（回复没进系统）。
    const consumed = await consumeTurnStream(
      reply({ taskId: input.taskId, subtaskId: input.subtaskId, text: input.text, decideByAgent: input.decideByAgent, requestId, signal: useTurnStore.getState().abort?.signal }),
      host,
      { onFirstEvent: hooks.onAccepted },
    )
    sawTerminal = consumed.sawTerminal
    accepted = consumed.accepted
    await settleOrFollow(host, { sawTerminal, accepted: true }, { requireAccepted: true })
  } catch (error) {
    reportFailure(error, '回复没送出去')
    if (!accepted) {
      hooks.onRejected?.(error)
    } else {
      // 已受理后断连：这一轮还在服务端跑，重订事件流跟到终态，不自动重发（S06）。
      await settleOrFollow(host, { sawTerminal: false, accepted: true })
    }
  } finally {
    void finishTurn()
  }
}

/** 引擎宿主（发送/回话/接续共用；apply 走 store，markTerminal 由 apply 顺带维护）。 */
/**
 * 回合流公共消费层（评审 #9：五条路径——sendMessage/runSupplement/runReply/
 * runActionDecision/resumeLiveTurn——各自的「for await + 逐条 apply + sawTerminal
 * 计数 + 受理回调」骨架收拢为一份实现）。
 *
 * - onFirstEvent：流内第一条事件到达时触发一次。runReply/runActionDecision/
 *   runSupplement 以它作「受理回执」（deck 卡就地摘下）；sendMessage 不用（它的
 *   受理信号是 conversation 事件，走 onEvent 专属钩改占位文案）。
 * - onEvent：每条事件 apply 之后触发。sendMessage 用它撤占位 note；多数路径不传。
 */
interface ConsumeHooks {
  onFirstEvent?: (() => void) | undefined
  onEvent?: ((event: TurnEvent) => void) | undefined
}

async function consumeTurnStream(
  stream: AsyncGenerator<TurnEvent>,
  host: TurnEngineHost,
  hooks: ConsumeHooks = {},
): Promise<{ sawTerminal: boolean; accepted: boolean }> {
  let sawTerminal = false
  let accepted = false
  let first = true
  for await (const event of stream) {
    if (event.type === 'summary') sawTerminal = true
    if (first) {
      first = false
      accepted = true
      hooks.onFirstEvent?.()
    }
    host.apply(event)
    hooks.onEvent?.(event)
  }
  return { sawTerminal, accepted }
}

/**
 * 收尾统一（评审 #9）：流自然结束后没看到终态、连接没被取消、受理已发生、会话可寻址
 * ——四个条件满足才跟着事件流到终态。此前五处四种写法，终态守卫已漂移出三种。
 * requireAccepted：runReply 语义（未受理的失败不重订）；sendMessage 不要求（它的
 * 受理与否看 conversation 事件，断连窗口里已受理的轮次照样要跟）。
 */
async function settleOrFollow(
  host: TurnEngineHost,
  consume: { sawTerminal: boolean; accepted: boolean },
  options: { requireAccepted: boolean } = { requireAccepted: false },
): Promise<void> {
  const st = useTurnStore.getState()
  if (consume.sawTerminal) return
  if (options.requireAccepted && !consume.accepted) return
  if (st.abort?.signal.aborted === true) return
  if (st.conversationId === null) return
  await followUntilTerminal(st.conversationId, { from: st.lastSeq, expectedRunId: st.lastRunId, signal: st.abort?.signal }, productionLinks, host)
}

export async function createTurnEngineHost(): Promise<TurnEngineHost> {
  let terminalSeen = false
  return {
    apply: event => {
      if (event.type === 'summary') terminalSeen = true
      useTurnStore.getState().applyTurnEvent(event)
    },
    note: text => useTurnStore.getState().appendEntry({ key: `note-h${++hostEntrySeq}`, kind: 'note', text }),
    errorLine: text => useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text }),
    runTaskId: () => useTurnStore.getState().lastRunTaskId,
    sawTerminal: () => terminalSeen,
    markTerminal: () => { terminalSeen = true },
    calibrate: record => {
      if (terminalSeen) return
      useTurnStore.getState().appendEntry({
        key: `summary-h${++hostEntrySeq}`, kind: 'summary',
        state: record.state, text: record.summary ?? '',
      })
    },
    rebuild: record => {
      useTurnStore.getState().beginRebuild()
      useTurnStore.getState().renderTaskRecord(record, { liveResume: true })
      useTurnStore.setState({ streaming: true })
    },
  }
}
