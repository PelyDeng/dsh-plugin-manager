/**
 * 推理文本的中文译文整理（旧 web/thinking-translation.js 的解耦重写）。
 *
 * 旧实现是「一个 translations 实例 + IntersectionObserver 懒加载 + 并发 2 + 按
 * [conversationId, sourceId, text] 缓存」的 DOM 巡检模型；React 化后数据面收敛到
 * translation store（zustand），视图侧（ThinkingBlock）只声明自己关心的推理文本——
 * 语义逐条对齐：
 * - needsChineseTranslation：与旧码/服务端同一保守判定（代码块/行内代码/链接除外，
 *   拉丁字母 ≥16 且单词 ≥4 且超过汉字两倍才整理），不做整段机翻。
 * - 只整理「已保存的思考」：live 推理流（sourceId 缺失）或尚未结束（done=false）时
 *   显示「正在生成思考，稍后整理中文译文…」占位，不发起请求（旧 watch 的分支）。
 * - 请求体 {conversationId, sourceId}，响应是 ReadingCopy（status: native|translated）。
 * - 失败可重试：state=failed 时给「重试译文」，重试即回 idle 重新排队。
 * - 会话切换 reset：在途请求 abort、队列与缓存清空（旧 reset 的 epoch++ 语义）。
 */
import { create } from 'zustand'
import { errorTextOf } from '@dsh-agents-group/web-common'
import { basePath } from './config.ts'

export interface ReadingCopy {
  status: 'native' | 'translated'
  text: string
  partial: boolean
  provider?: string | undefined
  model?: string | undefined
  usage?: Record<string, number> | null | undefined
  elapsedMs?: number | undefined
  createdAt?: number | undefined
}

export type TranslationState = 'idle' | 'queued' | 'loading' | 'done' | 'failed'

export interface TranslationEntry {
  conversationId: string
  sourceId: string
  text: string
  state: TranslationState
  result: ReadingCopy | null
  error: string
}

/** 与旧码/服务端同一保守判定：代码与链接保留原拼写，只整理散文形态的推理。 */
export function needsChineseTranslation(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g, '')
  const latin = (prose.match(/[A-Za-z]/g) ?? []).length
  const words = (prose.match(/[A-Za-z]+/g) ?? []).length
  const han = (prose.match(/\p{Script=Han}/gu) ?? []).length
  return latin >= 16 && words >= 4 && latin > han * 2
}

/** 同一译文请求的并发上限（旧 pump 的 active.size<2）。 */
export const TRANSLATION_CONCURRENCY = 2

interface TranslationStore {
  /** 缓存表：key = JSON.stringify([conversationId, sourceId, text])。 */
  entries: Record<string, TranslationEntry>
  /** 观察请求：ThinkingBlock 挂载/更新时上报（旧 watch）。done 且无 sourceId 不入队。 */
  watch: (input: { text: string; conversationId: string; sourceId?: string | undefined; done: boolean }) => void
  /** 失败重试（旧 retry 按钮的 entry.state='idle' + enqueue）。 */
  retry: (key: string) => void
  /** 会话切换清场：abort 在途、清队列与缓存（旧 reset）。 */
  reset: () => void
}

// 模块级在途句柄（旧 active/queue/epoch 的等价物）。
const active = new Set<string>()
const queue: string[] = []
const controllers = new Map<string, AbortController>()
let queueRunning = false

export const useTranslationStore = create<TranslationStore>((set, get) => ({
  entries: {},

  watch: ({ text, conversationId, sourceId, done }) => {
    if (!needsChineseTranslation(text)) return
    const key = JSON.stringify([conversationId, sourceId, text])
    const existing = get().entries[key]
    if (existing !== undefined) {
      // 已有缓存条目：仅推进「正文已生成」的可整理时机（旧 watch 的 done 判据）。
      if (done && sourceId !== undefined && existing.state === 'idle' && !active.has(key) && !queue.includes(key)) {
        set(state => ({ entries: { ...state.entries, [key]: { ...state.entries[key]!, state: 'queued' } } }))
        queue.push(key)
        pump(set, get)
      }
      return
    }
    if (sourceId === undefined || !done) {
      // live 推理流或未结束：只登记占位（旧 watch 无 conversationId/sourceId 分支）。
      set(state => ({ entries: { ...state.entries, [key]: { conversationId, sourceId: sourceId ?? '', text, state: 'idle', result: null, error: '' } } }))
      return
    }
    set(state => ({ entries: { ...state.entries, [key]: { conversationId, sourceId, text, state: 'queued', result: null, error: '' } } }))
    queue.push(key)
    pump(set, get)
  },

  retry: key => {
    const entry = get().entries[key]
    if (entry === undefined || entry.state !== 'failed') return
    set(state => ({ entries: { ...state.entries, [key]: { ...state.entries[key]!, state: 'queued', error: '' } } }))
    queue.push(key)
    pump(set, get)
  },

  reset: () => {
    for (const controller of controllers.values()) controller.abort()
    controllers.clear()
    active.clear()
    queue.length = 0
    set({ entries: {} })
  },
}))

/** 队列泵（旧 pump：并发上限内逐个取队首发起请求）。 */
function pump(set: (fn: (state: TranslationStore) => Partial<TranslationStore>) => void, get: () => TranslationStore): void {
  if (queueRunning) return
  queueRunning = true
  try {
    while (active.size < TRANSLATION_CONCURRENCY && queue.length > 0) {
      const key = queue.shift()!
      const entry = get().entries[key]
      if (entry === undefined || entry.state !== 'queued') continue
      active.add(key)
      set(state => ({ entries: { ...state.entries, [key]: { ...state.entries[key]!, state: 'loading' } } }))
      void load(key, entry.conversationId, entry.sourceId, set, get)
    }
  } finally {
    queueRunning = false
  }
}

async function load(key: string, conversationId: string, sourceId: string, set: (fn: (state: TranslationStore) => Partial<TranslationStore>) => void, get: () => TranslationStore): Promise<void> {
  const controller = new AbortController()
  controllers.set(key, controller)
  try {
    const response = await fetch(basePath('/reasoning-translation'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ conversationId, sourceId }),
    })
    const data = (await response.json()) as ReadingCopy & { error?: string }
    if (!response.ok) throw new Error(data.error ?? '中文译文生成失败，请重试')
    set(state => {
      const current = state.entries[key]
      if (current === undefined) return {}
      return { entries: { ...state.entries, [key]: { ...current, state: 'done', result: data } } }
    })
  } catch (error) {
    set(state => {
      const current = state.entries[key]
      if (current === undefined) return {}
      const aborted = error instanceof DOMException && error.name === 'AbortError'
      return aborted ? {} : { entries: { ...state.entries, [key]: { ...current, state: 'failed', error: errorTextOf(error) } } }
    })
  } finally {
    controllers.delete(key)
    active.delete(key)
    queueRunning = false
    pump(set, get)
  }
}

/** 视图读取一个观察键（ThinkingBlock 用；watch 之后的稳定读取入口）。 */
export function translationKeyOf(conversationId: string, sourceId: string | undefined, text: string): string {
  return JSON.stringify([conversationId, sourceId, text])
}
