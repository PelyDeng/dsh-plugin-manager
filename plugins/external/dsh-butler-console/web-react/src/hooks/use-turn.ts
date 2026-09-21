/**
 * 回合驱动的应用层：把 turn-engine（纯控制流）与 turn store（状态面）绑定起来。
 *
 * 订阅幂等（StrictMode，方案 §3.3 批 0 决策的落地）：resumeLiveTurn 由 bootstrap effect
 * 调用，effect 双调用时第二次被 streaming 守卫与 viewToken 复核挡住；订阅本身挂 abort
 * controller，store.switchConversation 的原子动作负责完整 cleanup，after=lastSeq 保证
 * 重订不重复消费。
 */
import { api, eventsHead } from '../lib/api.ts'
import { followUntilTerminal, productionLinks, type TurnEngineHost } from '../lib/turn-engine.ts'
import { newConversationId, recallConversation, rememberConversation } from '../lib/turn-event.ts'
import { mergeHistoryEntries } from '../lib/history-merge.ts'
import type { HistoryEntry } from '../lib/history-merge.ts'
import { useTurnStore, type ThreadEntry } from '../stores/turn.ts'
import { useSessionStore } from '../stores/session.ts'

let hostEntrySeq = 0

/** 把 turn store 装配成引擎的宿主（渲染副作用全部走 store 动作）。 */
function createHost(): TurnEngineHost {
  let terminalSeen = false
  return {
    apply: event => {
      if (event.type === 'summary') terminalSeen = true
      useTurnStore.getState().applyTurnEvent(event)
    },
    note: text => useTurnStore.getState().appendEntry({ key: `note-h${++hostEntrySeq}`, kind: 'note', text }),
    errorLine: text => useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text }),
    runTaskId: () => useTurnStore.getState().lastRunTaskId,
    setRunTaskId: taskId => { useTurnStore.setState({ lastRunTaskId: taskId }) },
    sawTerminal: () => terminalSeen,
    markTerminal: () => { terminalSeen = true },
    calibrate: record => {
      // 快照校准：只在没消费到 summary 时补一张终态卡（引擎已保证 terminal 语义）。
      if (terminalSeen) return
      useTurnStore.getState().appendEntry({
        key: `summary-h${++hostEntrySeq}`, kind: 'summary',
        state: record.state, text: record.summary ?? '',
      })
    },
    rebuild: record => {
      // 按快照重建（S05）：清空视图原子动作 + 重画任务记录 + 接续回跟随态。
      useTurnStore.getState().beginRebuild()
      useTurnStore.getState().renderTaskRecord(record, { liveResume: true })
      useTurnStore.setState({ streaming: true })
    },
  }
}

/**
 * 刷新或重新打开页面时，接上正在跑的那一轮（语义对齐 send.js resumeLiveTurn）。
 *
 * 关掉页面不再等于取消任务，所以「活还在干，页面得能看」是这套语义的另一半。
 * 幂等：streaming 中直接返回；探测有网络往返，回包后复核视图代次（I09）。
 */
export async function resumeLiveTurn(): Promise<void> {
  const conversationId = recallConversation()
  if (conversationId === null || conversationId === '' || useTurnStore.getState().streaming) return

  const tokenAtProbe = useTurnStore.getState().viewToken
  let head
  try {
    head = await eventsHead(conversationId)
  } catch (error) {
    if (tokenAtProbe !== useTurnStore.getState().viewToken) return
    // 接续检查失败不能静默吞掉（S04）：用户会以为一切正常，其实连不上。
    useTurnStore.getState().appendEntry({
      key: `error-h${++hostEntrySeq}`, kind: 'error',
      text: `接续检查失败：${error instanceof Error ? error.message : '网络异常'}；刷新页面可重试`,
    })
    return
  }
  if (head === null || head.state !== 'running') return
  if (tokenAtProbe !== useTurnStore.getState().viewToken || useTurnStore.getState().streaming) return

  const controller = new AbortController()
  // 接管视图：作废之前还在路上的历史读取回包，它们的结论属于旧视图。
  useTurnStore.setState({
    viewToken: useTurnStore.getState().viewToken + 1,
    conversationId,
    abort: controller,
    entries: [],
    bubbleKeys: new Map(),
    butlerSpeechKey: null,
    streaming: true,
    following: true,
    lastSeq: 0,
    lastRunId: head.runId,
    lastRunTaskId: head.taskId ?? '',
  })
  const host = createHost()
  try {
    // 只读订阅接续：reset 时按快照校准并从窗口头续订，断线有界重订（S05/S06）。
    await followUntilTerminal(conversationId, { from: 0, expectedRunId: head.runId, signal: controller.signal }, productionLinks, host)
  } catch (error) {
    reportFailure(error, '接续正在执行的任务失败')
  } finally {
    void finishTurn()
  }
}

/** 历史条目 → 消息流条目（渲染模型转换；任务卡批 3 升级为完整调度卡回放）。 */
export function historyEntryToThreadEntry(entry: HistoryEntry): ThreadEntry {
  if (entry.kind === 'task' && entry.task !== undefined) {
    return { key: `task-${entry.task.id}`, kind: 'task', task: entry.task }
  }
  if (entry.kind === 'butler') {
    return { key: entry.id, kind: 'butler', text: entry.text, thinking: '', streaming: false, time: Number(entry.time) || undefined }
  }
  return { key: entry.id, kind: 'user', text: entry.text, time: Number(entry.time) || undefined }
}

/** 历史翻页游标（首屏 + 「加载更早」，批 1 先落首屏与游标记账）。 */
export interface HistoryCursor {
  transcriptBefore: string | null
  taskOffset: number | null
  loaded: boolean
  error: string | null
}

let historyCursor: HistoryCursor = { transcriptBefore: null, taskOffset: null, loaded: false, error: null }
export const historyCursorOf = (): HistoryCursor => historyCursor

/**
 * 打开一个历史会话（语义对齐 history.js openConversation 的守卫与 I09 核对）。
 *
 * 执行中禁止切换（旧语义）；切换本身是 store 的原子动作；两路回包都核对视图代次，
 * 旧回包不写进新会话。对话正文读不到时如实说明，不拿任务摘要冒充完整对话。
 */
export async function openConversation(id: string): Promise<void> {
  const turn = useTurnStore.getState()
  if (turn.streaming) return
  turn.switchConversation(id)
  rememberConversation(id)
  const token = useTurnStore.getState().viewToken

  historyCursor = { transcriptBefore: null, taskOffset: null, loaded: false, error: null }
  const placeholderKey = `note-h${++hostEntrySeq}`
  useTurnStore.getState().appendEntry({ key: placeholderKey, kind: 'note', text: '正在读取记录…' })

  let transcript: Awaited<ReturnType<typeof api.transcript>> | null = null
  let taskPage: Awaited<ReturnType<typeof api.history>> | null = null
  let transcriptError: unknown = null
  let taskError: unknown = null
  ;[transcript, taskPage] = await Promise.all([
    api.transcript({ conversationId: id, tail: true }).catch(error => { transcriptError = error; return null }),
    api.history({ conversationId: id, offset: 0 }).catch(error => { taskError = error; return null }),
  ])
  if (token !== useTurnStore.getState().viewToken) return

  const entries: ThreadEntry[] = []
  const removePlaceholder = useTurnStore.getState().entries.some(entry => entry.key === placeholderKey)
  if (removePlaceholder) useTurnStore.getState().removeEntry(placeholderKey)

  if (transcriptError !== null) {
    entries.push({
      key: `error-h${++hostEntrySeq}`, kind: 'error',
      text: `对话正文读不到：${transcriptError instanceof Error && transcriptError.message !== '' ? transcriptError.message : '网络异常'}；下面只有任务摘要。`,
    })
  }
  if (taskError !== null) {
    entries.push({
      key: `error-h${++hostEntrySeq}`, kind: 'error',
      text: `任务记录读不到：${taskError instanceof Error && taskError.message !== '' ? taskError.message : '网络异常'}`,
    })
  }
  const merged = mergeHistoryEntries(transcript?.items ?? null, taskPage?.items ?? null)
  if (merged.length === 0 && transcriptError === null && taskError === null) {
    // 空会话：欢迎板由 Thread 按 entries 为空渲染，这里无需占位。
    historyCursor = { transcriptBefore: null, taskOffset: null, loaded: true, error: null }
    return
  }
  for (const item of merged) entries.push(historyEntryToThreadEntry(item))
  const store = useTurnStore.getState()
  for (const entry of entries) store.appendEntry(entry)
  historyCursor = {
    transcriptBefore: transcript?.prevBefore ?? null,
    taskOffset: taskPage?.nextOffset ?? null,
    loaded: true,
    error: null,
  }
}

/** 发送失败的用户可见呈现（旧 dom.js reportFailure 语义：中断≠任务停了）。 */
export function reportFailure(error: unknown, fallback: string): void {
  if ((error as Error)?.name === 'AbortError') {
    useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text: '连接已中断，这一轮是否结束以右栏状态为准。' })
    return
  }
  useTurnStore.getState().appendEntry({ key: `error-h${++hostEntrySeq}`, kind: 'error', text: error instanceof Error && error.message !== '' ? error.message : fallback })
}

/** 回合收尾：忙碌态落回 + 右栏低频数据刷新（I05 焦点归还随 composer 批 3/4a 落地）。 */
export async function finishTurn(): Promise<void> {
  useTurnStore.setState({ streaming: false, abort: null })
  await refreshPanelsData()
}

/** 右栏数据装配（批 1 基础渲染；交互与轮询细化批 2）。 */
export async function refreshPanelsData(): Promise<void> {
  try {
    const { items } = await api.members()
    useSessionStore.getState().setMembers(items)
  } catch { /* 成员读不到保持现状：右栏下次轮询会再试。 */ }
}

export async function loadIdentity(): Promise<void> {
  try {
    const { label } = await api.identity()
    useSessionStore.getState().setIdentity(label)
  } catch {
    useSessionStore.getState().setIdentity('')
  }
}

export { newConversationId }
