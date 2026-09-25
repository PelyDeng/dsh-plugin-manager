/**
 * 会话控制流（旧 app.js send/restore/openConversation/startFresh/initHistory 的
 * 解耦重写，方案 §4.3「解耦重写而非搬运」）。
 *
 * 守卫的单一实现：所有在途回包（业务 JSON、SSE 事件、restore）统一用 `stale()`
 * 核对三件事——identityEpoch（登录态变化）、viewToken（会话视图切换）、
 * controller.signal（主动停止/切会话中断）。任一不满足即丢弃且不再写任何 store。
 *
 * 单向流语义如实建模：POST /chat 无重订端点，abort/连接断开即终态（没有
 * followUntilTerminal/续订对齐——那是 butler 的协议，closedoff 契约里不存在）。
 */
import { ApiError, api, businessFetch, checkIdentity, readJson } from './lib/api.ts'
import { routePath } from './lib/config.ts'
import { projectRestoredHistory } from './lib/restore.ts'
import { useBoardStore } from './stores/board.ts'
import { useComposerStore } from './stores/composer.ts'
import { usePickerStore } from './stores/picker.ts'
import { isLinkedConversationId, linkedConversationId, setTitlePollTick, useSessionStore } from './stores/session.ts'
import { useTurnStore } from './stores/turn.ts'
import type { ChatEvent, ModelSelection } from './lib/types.ts'

/** 在途请求句柄：同一时刻至多一条活动流、一个在途复原（旧码同形态）。 */
let activeChat: AbortController | null = null
let activeRestore: AbortController | null = null
/** 会话列表请求代次（旧 sidebar version 守卫）。 */
let listTicket = 0

function isStale(epoch: number, view: number, signal: AbortSignal | null): boolean {
  const session = useSessionStore.getState()
  return session.identityEpoch !== epoch || session.viewToken !== view || (signal?.aborted === true)
}

// ── 会话列表（侧栏与标题轮询共用）────────────────────────────────────────

export async function refreshConversations(append = false): Promise<void> {
  const session = useSessionStore.getState()
  const ticket = ++listTicket
  const offset = append ? session.conversationsOffset ?? 0 : 0
  const query = session.conversationsQuery
  try {
    const page = await api.conversations(offset, query)
    if (ticket !== listTicket) return
    session.acceptConversationPage(page.items, page.nextOffset ?? null, append)
    if (useSessionStore.getState().shouldStopTitlePoll(page.items)) useSessionStore.getState().stopTitlePoll()
  } catch (error) {
    if (ticket !== listTicket) return
    // 身份变化导致的失败不作为列表错误展示（clearPrivateView 已接管界面）。
    if (useSessionStore.getState().identityReady) {
      useSessionStore.getState().setConversationsError(error instanceof Error ? error.message : String(error))
    }
  }
}

// ── 复原（restore）────────────────────────────────────────────────────────

async function restore(): Promise<void> {
  const session = useSessionStore.getState()
  const board = useBoardStore.getState()
  void usePickerStore.getState().refresh(session.conversationId)
  if (session.conversationId === '') {
    board.reset()
    return
  }
  const controller = new AbortController()
  activeRestore = controller
  const epoch = session.identityEpoch
  const view = session.viewToken
  board.setRestoring()
  try {
    const data = await api.history(session.conversationId, controller.signal)
    if (controller.signal.aborted || isStale(epoch, view, controller.signal)) return
    useBoardStore.getState().setMessages(projectRestoredHistory(data))
  } catch (error) {
    if (controller.signal.aborted || isStale(epoch, view, controller.signal)) return
    const message = error instanceof Error ? error.message : String(error)
    useSessionStore.getState().setStatus('off', message)
    useBoardStore.getState().setRestoreError(message)
  } finally {
    if (activeRestore === controller) activeRestore = null
  }
}

// ── 会话导航 ─────────────────────────────────────────────────────────────

/** 打开一个历史会话：回答进行中禁止（旧码 running 守卫）。 */
export async function openConversation(id: string): Promise<boolean> {
  const session = useSessionStore.getState()
  if (useTurnStore.getState().active || !session.identityReady) return false
  switchConversation(id)
  await restore()
  return true
}

/** 开新对话（清空当前视图）。 */
export async function startFreshConversation(): Promise<boolean> {
  const session = useSessionStore.getState()
  if (useTurnStore.getState().active || !session.identityReady) return false
  switchConversation('')
  void usePickerStore.getState().refresh('')
  await Promise.resolve()
  return true
}

/** 切换会话的原子动作：bump 代次 + 停轮询 + 清面板 + 重置游标（不发起请求）。 */
function switchConversation(id: string): void {
  const session = useSessionStore.getState()
  session.beginViewChange()
  activeRestore?.abort()
  activeRestore = null
  session.setConversationId(id)
  useBoardStore.getState().reset()
  useTurnStore.getState().reset()
}

// ── 发送与停止 ───────────────────────────────────────────────────────────

export async function sendMessage(rawText: string): Promise<void> {
  const session = useSessionStore.getState()
  const turn = useTurnStore.getState()
  if (turn.active || !session.identityReady) return
  const text = rawText.trim()
  if (text === '') return

  let modelPayload: { modelSelection?: ModelSelection } = {}
  try {
    modelPayload = usePickerStore.getState().payload()
  } catch (error) {
    session.setStatus('off', error instanceof Error ? error.message : String(error))
    return
  }

  const epoch = session.identityEpoch
  const view = session.viewToken
  const freshConversation = session.conversationId === ''
  const conversationId = session.conversationId

  useComposerStore.getState().setDraft('')
  useBoardStore.getState().appendMessage({ kind: 'user', text })
  turn.begin()
  usePickerStore.getState().setBusy(true)
  useSessionStore.getState().setListBlocked(true)
  useSessionStore.getState().setStatus('thinking', '智能体回答中…')

  const controller = new AbortController()
  activeChat = controller
  const context: StreamContext = { epoch, view, controller, freshConversation, admitted: false }

  try {
    const response = await api.chat({ conversationId, message: text, ...modelPayload }, controller.signal)
    if (epoch !== useSessionStore.getState().identityEpoch) throw new Error('登录状态已变化')
    if (!response.ok) throw await responseError(response)
    if ((response.headers.get('content-type') ?? '').includes('json')) {
      const payload = await readJson<{ error?: string }>(response)
      throw new Error(payload?.error ?? '未知错误')
    }
    await consumeStream(response, context)
  } catch (error) {
    // 身份/视图已变化：面板归属已易主或被清空，这里不再写任何状态。
    if (epoch !== useSessionStore.getState().identityEpoch) return
    if (useSessionStore.getState().viewToken !== view && !controller.signal.aborted) return
    const turnState = useTurnStore.getState()
    if (controller.signal.aborted) {
      turnState.markAborted()
    } else {
      const message = error instanceof Error ? error.message : String(error)
      turnState.markError(message)
      // 未受理（没收到 conversation 事件）时把原话回填输入框，不必重打。
      if (!context.admitted && useComposerStore.getState().draft === '') {
        useComposerStore.getState().setDraft(text)
      }
    }
  }
  // 收尾：正常读完与出错归档共用；身份/视图已变化时不归档（面板已易主）。
  // 停止（abort）要归档：旧码停止后已生成内容留屏并附 aborted 提示。
  if (epoch !== useSessionStore.getState().identityEpoch) return
  if (useSessionStore.getState().viewToken !== view) return
  // stub/真实 fetch 对 abort 的表现不同（read 挂起 or reject），正常返回路径
  // 也要补一次 aborted 判定，保证停止语义不依赖传输实现。
  if (controller.signal.aborted) useTurnStore.getState().markAborted()
  finishRunning(epoch, controller)
}

/** 用户停止：中断读取 + 通知服务端取消（旧码 sendBtn running 分支）。 */
export function stopSend(): void {
  const turn = useTurnStore.getState()
  if (!turn.active) return
  const session = useSessionStore.getState()
  activeChat?.abort()
  if (session.conversationId !== '') {
    void api.stop(session.conversationId).catch(() => {})
  }
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload = await response.clone().json() as { error?: unknown }
    if (typeof payload?.error === 'string' && payload.error !== '') return new ApiError(response.status, payload.error)
  } catch { /* 非 JSON 错误体。 */ }
  return new ApiError(response.status, `请求失败 HTTP ${response.status}`)
}

interface StreamContext {
  epoch: number
  view: number
  controller: AbortController
  freshConversation: boolean
  /** 会话事件落地后置 true（每次发送独立，不共享模块状态）。 */
  admitted: boolean
}

async function consumeStream(response: Response, context: StreamContext): Promise<void> {
  if (response.body === null) throw new Error('服务端没有返回事件流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const step = await reader.read()
      if (isStale(context.epoch, context.view, context.controller.signal)) {
        await reader.cancel().catch(() => {})
        return
      }
      if (step.done) break
      buffer += decoder.decode(step.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue
          let event: ChatEvent
          try {
            event = JSON.parse(line.slice(6)) as ChatEvent
          } catch {
            continue // 单个坏事件不中断整轮（旧码同口径）。
          }
          handleChatEvent(event, context)
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    if (context.controller.signal.aborted) await reader.cancel().catch(() => {})
    reader.releaseLock?.()
  }
}

function handleChatEvent(event: ChatEvent, context: StreamContext): void {
  // 事件级守卫（旧 handleEvent 首行）：身份/视图/中止任一变化即丢弃。
  if (isStale(context.epoch, context.view, context.controller.signal)) return
  if (event.type === 'conversation') {
    context.admitted = true
    usePickerStore.getState().accept(event.model)
    useSessionStore.getState().setConversationId(event.conversationId)
    if (context.freshConversation) useSessionStore.getState().startTitlePoll(event.conversationId)
    void refreshConversations()
    return
  }
  useTurnStore.getState().applyEvent(event)
}

function finishRunning(epoch: number, controller: AbortController): void {
  if (epoch !== useSessionStore.getState().identityEpoch) return
  if (activeChat === controller) activeChat = null
  const turn = useTurnStore.getState()
  if (turn.active) {
    // 归档：活动轮次固化成 board 消息，turn 复位（同批更新，视觉连续）。
    const message = turn.archive()
    useBoardStore.getState().appendMessage(message)
    useTurnStore.getState().reset()
  }
  usePickerStore.getState().setBusy(false)
  useSessionStore.getState().setListBlocked(false)
  useSessionStore.getState().setStatus('ok', '智能体就绪')
  void refreshConversations()
}

// ── 启动与身份 ───────────────────────────────────────────────────────────

export async function logout(): Promise<void> {
  const session = useSessionStore.getState()
  try {
    const sessionResponse = await fetch('/auth/api/session', { cache: 'no-store' })
    const sessionData = await readJson<{ csrf?: string }>(sessionResponse)
    await fetch('/auth/api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dsh-csrf': sessionData.csrf ?? '' },
      body: '{}',
    })
    globalThis.localStorage?.setItem('dsh_auth_changed', String(Date.now()))
    session.clearPrivateView()
    window.location.replace('/auth')
  } catch (error) {
    session.setStatus('off', error instanceof Error ? error.message : String(error))
  }
}

/** 页面启动：身份核验 → 恢复上次会话 → 列表 → 复原（旧码 init 序列等价）。 */
export async function bootstrap(): Promise<void> {
  const epochAtStart = useSessionStore.getState().identityEpoch
  try {
    // 身份核验并落地（旧码 identityKey/storageKey/identityReady 的赋值段）。
    const identity = await checkIdentity()
    if (useSessionStore.getState().identityEpoch !== epochAtStart) return
    const state = useSessionStore.getState()
    state.adoptIdentity(identity)
    // 旧键（无身份后缀）清理：历史版本的持久化位置。
    globalThis.localStorage?.removeItem('dsh_closedoff_conversationId')
    const stored = state.storageKey === '' ? null : globalThis.localStorage?.getItem(state.storageKey) ?? null
    const linked = linkedConversationId()
    const conversationId = isLinkedConversationId(linked) ? linked : stored ?? ''
    state.setConversationId(conversationId)
    // authenticated 模式：顶栏显示名用 Auth 会话的 username 覆盖（旧码
    // checkIdentity.then 里的 /auth/api/session 段；失败静默保持 /identity 的 label，
    // 登录态在途变化时不得回写，按发起时的 identityEpoch 核对）。
    if (identity.mode === 'authenticated') {
      const epochAtFetch = useSessionStore.getState().identityEpoch
      void fetch('/auth/api/session', { cache: 'no-store' })
        .then(response => readJson<{ user?: { username?: unknown } }>(response))
        .then(session => {
          const username = session.user?.username
          if (typeof username !== 'string' || username === '') return
          if (useSessionStore.getState().identityEpoch !== epochAtFetch) return
          useSessionStore.setState({ identityLabel: username })
        })
        .catch(() => {})
    }
    await refreshConversations()
    useSessionStore.getState().setStatus('ok', '智能体就绪')
    await restore()
  } catch (error) {
    if (useSessionStore.getState().identityEpoch !== epochAtStart) return
    useSessionStore.getState().setStatus('off', error instanceof Error ? error.message : String(error))
  }
}

// 装配：标题轮询的一拍动作（避免 session store 反向依赖 api 层）。
setTitlePollTick(() => refreshConversations())

// 装配：身份失效（clearPrivateView bump epoch）时连带清面板——旧码
// clearPrivateView 里的 resetViewState + inner.innerHTML=''（单一副作用点，
// 守卫逻辑不复制）。
let lastIdentityEpoch = useSessionStore.getState().identityEpoch
useSessionStore.subscribe(state => {
  if (state.identityEpoch !== lastIdentityEpoch) {
    lastIdentityEpoch = state.identityEpoch
    useBoardStore.getState().reset()
    useTurnStore.getState().reset()
  }
})

export { businessFetch, routePath }
