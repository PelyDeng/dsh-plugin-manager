/**
 * restore 复原投影（纯函数，批 1a 等价单测对象之一）。
 *
 * 旧页面把 /history 的每条助手条目重放进 DOM（app.js restore 段）；React 版改为
 * 投影成消息数组一次性上屏。五类复原要素（tool chips / tracks / fences / media /
 * cards）全部入数据面；轨迹与媒体的可视化在批 1b 接 Cesium 飞地，批 1a 由占位容器
 * 与 chips/引用块呈现。
 */
import type { CardsPayload, FencePayload, HistoryAssistant, HistoryResponse, MediaItem, TrackDeviceGroup, TrackPoint, TurnMeta } from './types.ts'

/** 工具行的页面态：calling 仅存在于活动流；复原数据里只有已完成/无记录/失败。 */
export type ToolPhase = 'calling' | 'done' | 'empty' | 'error'

export interface BoardTool {
  callId: string
  name: string
  phase: ToolPhase
  /** 进度统计口径（旧 ast.states：track/media 事件也置 data；复原数据里无 loading）。 */
  resultState: 'loading' | 'data' | 'empty' | 'error'
  /** 调用时间（复原时来自服务端记录，缺失退化为当前时间——旧码同口径）。 */
  callAt: number
  durMs?: number
}

export interface BoardTrack {
  points: TrackPoint[]
  vehicleNo?: string
  /** 轨迹附近设备组（restore 里 groups/cameras 两个来源字段，旧码都收）。 */
  groups?: TrackDeviceGroup[]
}

export interface BoardAssistantMessage {
  kind: 'assistant'
  text: string
  /** 有任一结构化结果（轨迹/围栏/媒体/非错误卡片）时，正文剥离重复表格。 */
  hasStructured: boolean
  thinking: string
  thinkingDone: boolean
  tools: BoardTool[]
  cards: Record<string, CardsPayload>
  tracks: Record<string, BoardTrack>
  fences: Record<string, FencePayload>
  media: Record<string, MediaItem[]>
  finishReason?: string
  /** 终态提示（旧 turnStatus：流内 error 的具体文案无法从 finishReason 派生，需显式保留）。 */
  terminalMessage?: string
  terminalTone?: '' | 'error' | 'warning'
  /** finishReason === 'completed' 时服务端才下发这批元信息。 */
  meta?: TurnMeta
  /** 当前评分（null=明确无评分；undefined=字段缺省形态）。 */
  rating?: 'positive' | 'negative' | null
  /** 反馈服务暂时不可用时，赞/踩按钮禁用并提示（旧 feedbackUnavailable 口径）。 */
  feedbackUnavailable?: boolean
}

export interface BoardUserMessage {
  kind: 'user'
  text: string
}

export type BoardMessage = BoardUserMessage | BoardAssistantMessage

function projectTrack(raw: { points: TrackPoint[]; vehicleNo?: string; groups?: TrackDeviceGroup[]; cameras?: TrackDeviceGroup[] } | undefined): BoardTrack | undefined {
  if (raw === undefined || !Array.isArray(raw.points) || raw.points.length === 0) return undefined
  return {
    points: raw.points,
    ...(raw.vehicleNo === undefined ? {} : { vehicleNo: raw.vehicleNo }),
    ...(raw.groups !== undefined ? { groups: raw.groups } : raw.cameras !== undefined ? { groups: raw.cameras } : {}),
  }
}

/** /history 响应 → 消息数组（restore 的全部业务规则都收在这一个纯函数里）。 */
export function projectRestoredHistory(response: HistoryResponse): BoardMessage[] {
  const feedbackByMessage = new Map<string, 'positive' | 'negative'>()
  for (const item of response.feedback ?? []) feedbackByMessage.set(item.messageId, item.rating)
  const feedbackUnavailable = response.feedbackUnavailable === true

  const messages: BoardMessage[] = []
  for (const entry of response.history ?? []) {
    if (entry.role === 'user') {
      messages.push({ kind: 'user', text: entry.text })
      continue
    }
    const rating = entry.messageId === undefined ? null : feedbackByMessage.get(entry.messageId) ?? null
    messages.push(projectRestoredAssistant(entry, { rating, feedbackUnavailable }))
  }
  return messages
}

/** 单条助手条目投影（活动流 done 归档时也复用同一形状）。 */
export function projectRestoredAssistant(
  entry: HistoryAssistant,
  feedback: { rating?: 'positive' | 'negative' | null; feedbackUnavailable?: boolean } = {},
): BoardAssistantMessage {
  const tools: BoardTool[] = []
  const cards: Record<string, CardsPayload> = {}
  const tracks: Record<string, BoardTrack> = {}
  const fences: Record<string, FencePayload> = {}
  const media: Record<string, MediaItem[]> = {}
  let hasStructured = false

  for (const t of entry.tools ?? []) {
    const failed = t.status === 'error'
    tools.push({
      callId: t.callId,
      name: t.name,
      phase: failed ? 'error' : 'done',
      resultState: failed ? 'error' : 'data',
      callAt: t.time ?? Date.now(),
      ...(t.durMs === undefined ? {} : { durMs: t.durMs }),
    })
    // 失败且带展示描述的查询复原 error 卡（旧码口径：轨迹设备组工具不出卡）。
    if (failed && t.presentation !== undefined && t.name !== 'closedoff_device_page') {
      cards[t.callId] = {
        tool: t.presentation.tool ?? t.name,
        group: t.presentation.group ?? 'other',
        variant: t.presentation.variant ?? 'records',
        sourceLabel: t.presentation.sourceLabel ?? '业务查询',
        state: 'error',
        count: 0,
        shown: 0,
        note: '',
        cards: [],
        ...t.presentation,
      }
    }
  }
  for (const [callId, payload] of Object.entries(entry.cards ?? {})) {
    if (payload === undefined) continue
    cards[callId] = payload
    if (payload.state === 'data' || payload.state === 'empty') hasStructured = true
    const tool = tools.find(item => item.callId === callId)
    if (tool !== undefined && (payload.state === 'empty' || payload.state === 'data')) {
      tool.phase = payload.state === 'empty' ? 'empty' : 'done'
      tool.resultState = payload.state === 'empty' ? 'empty' : 'data'
    }
  }
  for (const [callId, raw] of Object.entries(entry.tracks ?? {})) {
    const track = projectTrack(raw)
    if (track === undefined) continue
    tracks[callId] = track
    hasStructured = true
  }
  for (const [callId, payload] of Object.entries(entry.fences ?? {})) {
    fences[callId] = payload
    hasStructured = true
  }
  for (const [callId, items] of Object.entries(entry.media ?? {})) {
    if (!Array.isArray(items) || items.length === 0) continue
    media[callId] = items
    hasStructured = true
  }

  const completed = entry.finishReason === 'completed'
  const meta: TurnMeta | undefined = completed
    ? {
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
      ...(entry.branchSeq === undefined ? {} : { branchSeq: entry.branchSeq }),
      ...(entry.completedAt === undefined ? {} : { completedAt: entry.completedAt }),
      ...(entry.runMs === undefined ? {} : { runMs: entry.runMs }),
      ...(entry.ttftMs === undefined ? {} : { ttftMs: entry.ttftMs }),
      ...(entry.usage === undefined ? {} : { usage: entry.usage }),
    }
    : undefined

  return {
    kind: 'assistant',
    text: entry.text ?? '',
    hasStructured,
    thinking: entry.thinking ?? '',
    thinkingDone: Boolean(entry.thinkingDone),
    tools,
    cards,
    tracks,
    fences,
    media,
    ...(entry.finishReason === undefined ? {} : { finishReason: entry.finishReason }),
    ...(meta === undefined ? {} : { meta }),
    ...(feedback.rating === undefined ? {} : { rating: feedback.rating }),
    ...(feedback.feedbackUnavailable === true ? { feedbackUnavailable: true } : {}),
  }
}
