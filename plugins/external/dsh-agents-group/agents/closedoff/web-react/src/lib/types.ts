/**
 * SSE 事件与业务数据形状（批 1a 数据层的唯一类型源）。
 *
 * 事件族对照 src/web.ts 的 /chat 发送面（十类，单向流、无重订）：
 * conversation / delta / thinking_snapshot / tool_start / tool_end /
 * fences / track / cameras / media / cards / done / error。
 * 契约事实（批 1a 核实）：正文 delta 服务端只在回合收尾发**一次全量**（脱敏后），
 * 客户端仍按累加建模（旧 app.js 的 `+=` 语义），多段 delta 兼容。
 */
import type { ResultGroup } from './labels.ts'

/** 模型选择（官方 ConversationModel 投影）。 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 模型目录（/models：目录 + 默认 + 该会话当前选中 + 部分失败说明）。 */
export interface ModelCatalog {
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
  failures: Array<{ id: string; name: string }>
  default?: ModelSelection | null
  selected?: ModelSelection | null
}

/** 结果卡片的展示描述（服务端 presentationDescriptor 的投影）。 */
export interface CardsPayload {
  tool: string
  group: ResultGroup | string
  variant: 'summary' | 'records' | string
  sourceLabel: string
  state: 'loading' | 'data' | 'empty' | 'error' | string
  count: number
  shown: number
  note: string
  cards: Array<{
    title: string
    titleKey?: string
    fields: Array<{ k: string; v: string; tone: string }>
  }>
}

/** 轨迹点（批 1b Cesium 消费；批 1a 只入数据面）。 */
export interface TrackPoint {
  lon: number
  lat: number
  time?: number
  [key: string]: unknown
}

/** 设备组（摄像头/抓拍；批 1b 弹窗消费）。 */
export interface TrackDeviceGroup {
  name?: string
  devices?: Array<Record<string, unknown>>
  [key: string]: unknown
}

/** 电子围栏 payload（批 1b 渲染；批 1a 入数据面）。 */
export type FencePayload = unknown

/** 车辆抓拍媒体项。 */
export interface MediaItem {
  startTime?: string
  timeLength?: string
  deviceId?: string | number
  mediaUrl?: string
  [key: string]: unknown
}

/** /chat SSE 的十类事件。 */
export type ChatEvent =
  | { type: 'conversation'; conversationId: string; model?: ModelSelection | null }
  | { type: 'delta'; text: string }
  | { type: 'thinking_snapshot'; text: string; done: boolean }
  | { type: 'tool_start'; callId: string; name: string; presentation?: Partial<CardsPayload> }
  | { type: 'tool_end'; callId: string; status: 'done' | 'error' | string }
  | { type: 'fences'; callId: string; payload: FencePayload }
  | { type: 'track'; callId: string; points: TrackPoint[]; vehicleNo?: string }
  | { type: 'cameras'; callId: string; cameras: TrackDeviceGroup[] }
  | { type: 'media'; callId: string; items: MediaItem[] }
  | { type: 'cards'; callId: string; payload: CardsPayload }
  | {
    type: 'done'
    reason: string
    /** 仅 reason === 'completed' 时携带（服务端口径）。 */
    meta?: TurnMeta
  }
  | { type: 'error'; message: string }

/** 回合元信息（done.meta / 历史助手条目共用）。 */
export interface TurnMeta {
  messageId?: string
  branchSeq?: number
  completedAt?: number
  runMs?: number
  ttftMs?: number
  usage?: TurnUsage
}

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

// ── /history 响应形状（restore 数据面）───────────────────────────────────

/** 历史里的工具行（status: run|ok|error；页面只区分 error 与「已完成」）。 */
export interface HistoryTool {
  callId: string
  name: string
  api?: string
  status: string
  time?: number
  durMs?: number
  presentation?: Partial<CardsPayload>
}

/** 历史助手条目（projectHistory 的输出投影）。 */
export interface HistoryAssistant {
  role: 'assistant'
  text: string
  thinking: string
  thinkingDone: boolean
  tools: HistoryTool[]
  tracks: Record<string, { points: TrackPoint[]; vehicleNo?: string; groups?: TrackDeviceGroup[]; cameras?: TrackDeviceGroup[] }>
  fences: Record<string, FencePayload>
  media: Record<string, MediaItem[]>
  cards: Record<string, CardsPayload>
  time: number
  done: boolean
  finishReason?: string
  messageId?: string
  branchSeq?: number
  completedAt?: number
  runMs?: number
  ttftMs?: number
  usage?: TurnUsage
}

export interface HistoryUser {
  role: 'user'
  text: string
  time?: number
}

export type HistoryEntry = HistoryAssistant | HistoryUser

export interface HistoryResponse {
  history: HistoryEntry[]
  feedback?: Array<{ messageId: string; rating: 'positive' | 'negative' }>
  feedbackUnavailable?: boolean
}

// ── /conversations 响应形状（会话列表）──────────────────────────────────

export interface ConversationItem {
  id: string
  title: string
  updatedAt: number
  /** ready/busy 可打开；pending/failed/legacy 是打不开的死行（页面侧再滤一次）。 */
  state?: string
  pinned?: boolean
  titleSource?: string
}

export interface ConversationPage {
  items: ConversationItem[]
  nextOffset: number | null
}
