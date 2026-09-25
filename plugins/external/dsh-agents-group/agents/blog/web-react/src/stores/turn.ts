/**
 * live 段 store：订阅-快照模型的实时输出投影与快照合并的 live 保护。
 *
 * 三守卫迁移（方案 §4.3，对照旧 web/chat.js）：
 * - 旧 liveClock（chat.js:33 计数、:95 live 帧 ++、:106 重拉合并判据）拆成两个面：
 *   `liveClock` 保留「重拉期间是否前进过」的序语义；新增 `liveAt`（最后帧时钟），
 *   给保护一个显式的新鲜度时限（LIVE_FRESH_MS）——超过时限的 live 不再覆盖快照
 *   刷新的结果（旧码在 live 停更但 busy 仍真时会让本地 live 无限滞留，这里是任务
 *   要求的增强，正常流式下行为与旧码一致）。
 * - live 帧整段替换（旧 renderLive 的 data.live 直写），不做增量合并。
 */
import { create } from 'zustand'
import type { ChatHistoryResult, LiveOutput } from '../lib/types.ts'

/**
 * live 段新鲜度时限：流式期间 live 帧密集到达（每个 delta 一帧），停更超过该时限
 * 即视为过期——过期后快照刷新的结果生效（不被本地 live 覆盖）。
 */
export const LIVE_FRESH_MS = 5000

export interface TurnState {
  /** 当前 live 段（null=无流式输出；旧 state.history.live 的投影位）。 */
  live: LiveOutput | null
  /** 最后 live 帧到达时钟（Date.now()；新鲜度判定用）。 */
  liveAt: number
  /** live 帧计数（旧 liveClock）：重拉发起时快照一份，回包时比较是否前进过。 */
  liveClock: number

  /** live 帧：整段替换 + 计数推进（旧 chat.js:95）。 */
  applyLive: (live: LiveOutput) => void
  /**
   * live 投影位与快照对齐（refresh 落地时调用）：旧码 live 寄存于 state.history，
   * 重拉落地即整体覆盖——这里给独立的 live store 补上同一语义，完成后快照
   * live=null 即收口流式区（服务端真相优先）。视为新鲜帧（同步 liveAt）。
   */
  setLive: (live: LiveOutput | null) => void
  resetLive: () => void
  /**
   * 快照合并的 live 段保护（旧 chat.js:106 的解耦重写）：
   * 回包 busy 且本地 live 新鲜（重拉期间有新帧，或最后帧未超时限）→ 用本地 live
   * 覆盖回包（它是在回包抓取之前开始序列化的，比回包新）；否则原样返回。
   */
  mergeLive: (data: ChatHistoryResult, liveClockAtStart: number, now?: number) => ChatHistoryResult
}

export const useTurnStore = create<TurnState>((set, get) => ({
  live: null,
  liveAt: 0,
  liveClock: 0,

  applyLive: live => {
    set(state => ({ live: { ...live }, liveAt: Date.now(), liveClock: state.liveClock + 1 }))
  },

  setLive: live => {
    set({ live: live === null ? null : { ...live }, liveAt: live === null ? 0 : Date.now() })
  },

  resetLive: () => set({ live: null, liveAt: 0 }),

  mergeLive: (data, liveClockAtStart, now = Date.now()) => {
    if (!data.busy) return data
    const turn = get()
    if (turn.live === null) return data
    const advanced = turn.liveClock !== liveClockAtStart
    const fresh = now - turn.liveAt < LIVE_FRESH_MS
    if (!advanced && !fresh) return data
    return { ...data, live: turn.live }
  },
}))
