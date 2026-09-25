/**
 * 活动轮次 store：POST /chat 单向事件流的投影面。
 *
 * 十类事件的分域映射（批 1a 建模对照表，行为基准=旧 app.js handleEvent）：
 * | SSE 事件            | store 状态域                                          |
 * |--------------------|------------------------------------------------------|
 * | conversation       | 不入本 store（会话确立 → session/board + 标题轮询 + 模型）|
 * | delta              | text（累加；服务端现实只在收尾发一次全量，累加建模兼容多段） |
 * | thinking_snapshot  | thinking/thinkingDone（250ms 节流投影，done 强制直投）    |
 * | tool_start         | tools[]（chip calling）+ cards loading 占位              |
 * | tool_end           | tools[]（done/error）+ error 卡置败                      |
 * | fences             | fences + hasStructured/hasResult                         |
 * | track              | tracks + hasStructured/hasResult（顶掉同 callId 卡片）    |
 * | cameras            | cameras（批 1b 地图弹窗消费，批 1a 只入数据面）            |
 * | media              | media + hasStructured/hasResult（顶掉同 callId 卡片）     |
 * | cards              | cards + chip phase（empty 单列）                         |
 * | done               | finishReason/terminalMessage/meta（completed 才有 meta）  |
 * | error              | terminalMessage（error 语气）                            |
 *
 * 契约事实：这条流**无断线续订**（close→abort，服务端没有重订端点），abort 即终态——
 * 不建 butler 式 followUntilTerminal/lastSeq 语义（方案 §4.3「管线比 blog 简单一档」）。
 *
 * thinking 250ms 节流：真实服务端已按 250ms 限频发送（web.ts scheduleThinking），
 * 旧客户端直投；这里在 store 投影层重做同款节流作为防御（密集快照合并投影，
 * 终态 done 强制直投不吞尾帧），行为与旧实现一致且有单测兜底。
 */
import { create } from 'zustand'
import type { BoardAssistantMessage, BoardTrack, ToolPhase } from '../lib/restore.ts'
import { finishReasonMessage } from '../lib/format.ts'
import type { CardsPayload, ChatEvent, FencePayload, MediaItem, TrackDeviceGroup, TurnMeta } from '../lib/types.ts'

export const THINKING_INTERVAL_MS = 250

export interface ToolChip {
  callId: string
  name: string
  /** chip 展示态：calling=调用中，done=已完成，empty=无记录，error=调用失败。 */
  phase: ToolPhase
  /** 进度统计口径（旧 astObj.states：track/media 事件也置 data）。 */
  resultState: 'loading' | 'data' | 'empty' | 'error'
  callAt: number
  durMs?: number
}

export type TerminalTone = '' | 'error' | 'warning'

export interface TurnState {
  active: boolean
  text: string
  hasStructured: boolean
  hasResult: boolean
  thinking: string
  thinkingDone: boolean
  tools: ToolChip[]
  cards: Record<string, CardsPayload>
  tracks: Record<string, BoardTrack>
  fences: Record<string, FencePayload>
  media: Record<string, MediaItem[]>
  cameras: Record<string, TrackDeviceGroup[]>
  finishReason: string | undefined
  terminalMessage: string
  terminalTone: TerminalTone
  meta: TurnMeta | undefined

  begin: () => void
  reset: () => void
  /** 十类事件分发（不含 conversation：那属于会话域，controller 处理）。 */
  applyEvent: (event: ChatEvent) => void
  /** 用户停止/连接中断：按 aborted 收尾（旧 applyFinishReason('aborted')）。 */
  markAborted: () => void
  /** 请求失败（非流内 error 的路径同样走这里）。 */
  markError: (message: string) => void
  /** 固化成 board 消息（done/停止/出错后的归档）。cameras 按 callId 合入轨迹。 */
  archive: () => BoardAssistantMessage
}

export const useTurnStore = create<TurnState>((set, get) => ({
  active: false,
  text: '',
  hasStructured: false,
  hasResult: false,
  thinking: '',
  thinkingDone: false,
  tools: [],
  cards: {},
  tracks: {},
  fences: {},
  media: {},
  cameras: {},
  finishReason: undefined,
  terminalMessage: '',
  terminalTone: '',
  meta: undefined,

  begin: () => {
    get().reset()
    set({ active: true })
  },

  reset: () => {
    clearThinkingTimer()
    thinkingPending = null
    lastThinkingAt = 0
    set({
      active: false,
      text: '',
      hasStructured: false,
      hasResult: false,
      thinking: '',
      thinkingDone: false,
      tools: [],
      cards: {},
      tracks: {},
      fences: {},
      media: {},
      cameras: {},
      finishReason: undefined,
      terminalMessage: '',
      terminalTone: '',
      meta: undefined,
    })
  },

  applyEvent: event => {
    switch (event.type) {
      case 'delta':
        set(state => ({ text: state.text + event.text }))
        break
      case 'thinking_snapshot':
        scheduleThinking(set, get, event.text, event.done)
        break
      case 'tool_start': {
        const chip: ToolChip = {
          callId: event.callId,
          name: event.name,
          phase: 'calling',
          resultState: 'loading',
          callAt: Date.now(),
        }
        set(state => {
          const cards = { ...state.cards }
          if (event.presentation !== undefined && event.name !== 'closedoff_device_page') {
            cards[event.callId] = {
              tool: event.presentation.tool ?? event.name,
              group: event.presentation.group ?? 'other',
              variant: event.presentation.variant ?? 'records',
              sourceLabel: event.presentation.sourceLabel ?? '业务查询',
              state: 'loading',
              count: 0,
              shown: 0,
              note: '',
              cards: [],
              ...event.presentation,
            }
          }
          return { tools: [...state.tools, chip], cards }
        })
        break
      }
      case 'tool_end': {
        const failed = event.status === 'error'
        set(state => {
          const tools = state.tools.map(tool => tool.callId === event.callId
            ? {
              ...tool,
              phase: failed ? 'error' as const : 'done' as const,
              resultState: failed ? 'error' as const : 'data' as const,
              durMs: Date.now() - tool.callAt,
            }
            : tool)
          const cards = { ...state.cards }
          const existing = cards[event.callId]
          if (failed && existing !== undefined) cards[event.callId] = { ...existing, state: 'error' }
          // 旧 cards.js：tool_end(done) 即把查询行推进「已完成」，且无 cards 结果的查询
          // （如 closedoff_vehicle_location）**不进结果区**——React 版 tool_start 就建
          // loading 占位，不删的话会永远停在「正在查询…」（0.10.x 生产回归根因）。
          if (!failed && existing !== undefined && existing.state === 'loading') delete cards[event.callId]
          return { tools, cards }
        })
        break
      }
      case 'fences':
        set(state => ({
          fences: { ...state.fences, [event.callId]: event.payload },
          hasStructured: true,
          hasResult: true,
        }))
        break
      case 'track':
        // 轨迹顶掉同 callId 的卡片块（旧码移除 sources + drop 缓存）。
        set(state => {
          const cards = { ...state.cards }
          delete cards[event.callId]
          const tools = state.tools.map(tool => tool.callId === event.callId
            ? { ...tool, resultState: 'data' as const }
            : tool)
          return {
            tracks: {
              ...state.tracks,
              [event.callId]: {
                points: event.points,
                ...(event.vehicleNo === undefined ? {} : { vehicleNo: event.vehicleNo }),
              },
            },
            cards,
            tools,
            hasStructured: true,
            hasResult: true,
          }
        })
        break
      case 'cameras':
        set(state => ({ cameras: { ...state.cameras, [event.callId]: event.cameras } }))
        break
      case 'media':
        set(state => {
          const cards = { ...state.cards }
          delete cards[event.callId]
          const tools = state.tools.map(tool => tool.callId === event.callId
            ? { ...tool, resultState: 'data' as const }
            : tool)
          return {
            media: { ...state.media, [event.callId]: event.items },
            cards,
            tools,
            hasStructured: true,
            hasResult: true,
          }
        })
        break
      case 'cards':
        set(state => {
          const tools = state.tools.map(tool => tool.callId === event.callId
            ? {
              ...tool,
              phase: event.payload.state === 'empty' ? 'empty' as const : 'done' as const,
              resultState: event.payload.state === 'loading'
                ? 'loading' as const
                : event.payload.state === 'data' ? 'data' as const
                : event.payload.state === 'empty' ? 'empty' as const : 'error' as const,
            }
            : tool)
          return {
            cards: { ...state.cards, [event.callId]: event.payload },
            tools,
          }
        })
        break
      case 'done':
        set(state => {
          const tools = state.tools.map(tool => tool.phase === 'calling'
            ? { ...tool, phase: 'done' as const, resultState: tool.resultState === 'loading' ? 'data' as const : tool.resultState }
            : tool)
          const finishReason = event.reason
          // 旧 applyFinishReason：error 已提示时不再覆盖。
          const terminal = state.terminalTone === 'error' && state.terminalMessage !== ''
            ? { terminalMessage: state.terminalMessage, terminalTone: state.terminalTone }
            : terminalOf(finishReason, state.hasResult, state)
          return {
            tools,
            finishReason,
            ...(event.meta === undefined ? {} : { meta: event.meta }),
            ...terminal,
          }
        })
        break
      case 'error':
        set({ terminalMessage: `请求失败：${event.message || '发生错误'}`, terminalTone: 'error' })
        break
      // conversation 事件不属于 turn 域：controller 在会话域处理。
      case 'conversation':
        break
    }
  },

  markAborted: () => {
    const state = get()
    const message = finishReasonMessage('aborted', state.hasResult)
    if (message === '') return
    set({ terminalMessage: message, terminalTone: 'warning' })
  },

  markError: message => {
    set({ terminalMessage: `请求失败：${message || '发生错误'}`, terminalTone: 'error' })
  },

  archive: () => {
    const state = get()
    // 流式期 cameras 事件按 callId 关联轨迹（复原形状里就是 track.groups）。
    const tracks = Object.fromEntries(Object.entries(state.tracks).map(([callId, track]) => {
      const cameras = state.cameras[callId]
      return [callId, cameras === undefined ? track : { ...track, groups: cameras }]
    }))
    return {
      kind: 'assistant' as const,
      text: state.text,
      hasStructured: state.hasStructured,
      thinking: state.thinking,
      thinkingDone: state.thinkingDone,
      tools: state.tools.map(tool => ({
        callId: tool.callId,
        name: tool.name,
        phase: tool.phase,
        resultState: tool.resultState,
        callAt: tool.callAt,
        ...(tool.durMs === undefined ? {} : { durMs: tool.durMs }),
      })),
      cards: { ...state.cards },
      tracks,
      fences: { ...state.fences },
      media: { ...state.media },
      ...(state.finishReason === undefined ? {} : { finishReason: state.finishReason }),
      ...(state.terminalMessage === '' ? {} : { terminalMessage: state.terminalMessage, terminalTone: state.terminalTone }),
      ...(state.meta === undefined ? {} : { meta: state.meta }),
    }
  },
}))

// ── thinking 节流（store 投影层）────────────────────────────────────────

let thinkingTimer: ReturnType<typeof setTimeout> | undefined
let thinkingPending: { text: string; done: boolean } | null = null
let lastThinkingAt = 0

function clearThinkingTimer(): void {
  if (thinkingTimer !== undefined) {
    clearTimeout(thinkingTimer)
    thinkingTimer = undefined
  }
}

function scheduleThinking(
  set: (partial: Partial<TurnState>) => void,
  get: () => TurnState,
  text: string,
  done: boolean,
): void {
  const project = (): void => {
    const pending = thinkingPending
    thinkingPending = null
    thinkingTimer = undefined
    lastThinkingAt = Date.now()
    set({
      thinking: pending?.text ?? text,
      thinkingDone: pending?.done ?? done,
    })
  }
  // 终态强制直投：不吞尾帧（服务端 turn 收尾会推一次 done 快照）。
  if (done) {
    clearThinkingTimer()
    thinkingPending = null
    lastThinkingAt = Date.now()
    set({ thinking: text, thinkingDone: true })
    return
  }
  const wait = Math.max(0, THINKING_INTERVAL_MS - (Date.now() - lastThinkingAt))
  if (wait === 0) {
    clearThinkingTimer()
    thinkingPending = null
    project()
    return
  }
  // 窗口内的快照只保留最新，到点投影一次。
  thinkingPending = { text, done }
  if (thinkingTimer === undefined) thinkingTimer = setTimeout(project, wait)
  else thinkingPending = { text, done }
}

function terminalOf(reason: string, hasResult: boolean, state: TurnState): { terminalMessage: string; terminalTone: TerminalTone } {
  const message = finishReasonMessage(reason, hasResult)
  if (message === '') return { terminalMessage: state.terminalMessage, terminalTone: state.terminalTone }
  return { terminalMessage: message, terminalTone: reason === 'error' ? 'error' : 'warning' }
}

// ── 工具进度摘要（旧 updateProgress 的派生纯函数，归档消息复用同一形状）────

export interface ProgressToolLike {
  phase: ToolPhase
  resultState: 'loading' | 'data' | 'empty' | 'error'
}

export function progressSummary(tools: readonly ProgressToolLike[], done: boolean): string {
  let failed = 0
  let running = 0
  let withData = 0
  let empty = 0
  for (const tool of tools) {
    if (tool.phase === 'error') failed++
    if (tool.phase === 'calling') running++
    if (tool.resultState === 'data') withData++
    else if (tool.resultState === 'empty') empty++
  }
  if (done) {
    return tools.length === 0
      ? '未调用业务查询'
      : `已完成 ${tools.length} 项查询：有数据 ${withData}、无记录 ${empty}、失败 ${failed}`
  }
  if (running > 0) return `正在查询 ${running} 个数据源`
  if (tools.length > 0) return '正在汇总结论'
  return ''
}
