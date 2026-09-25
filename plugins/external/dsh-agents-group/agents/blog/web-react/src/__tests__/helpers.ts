/**
 * 单测公共设施（closedoff 批 1a helpers 同形态）：
 * - 在**被测模块加载前**注入 `__BLOG_BASE__`（config.ts 模块加载期读取，动态
 *   import 时序约束同 closedoff）；
 * - 注入 FakeEventSource（Node 测试环境无 EventSource；connect/handleStreamMessage
 *   的传输面用它，消息分发断言走 emit）；
 * - store 重置、sessionStorage 内存适配、/api 信封 stub。
 */
import { vi } from 'vitest'
import type { StorageLike } from '../stores/conversation.ts'

export const TEST_PREFIX = '/blog'

/** connect/handleStreamMessage 的传输替身：实例可枚举，消息手动派发。 */
export class FakeEventSource {
  static instances: FakeEventSource[] = []
  static reset(): void {
    FakeEventSource.instances = []
  }
  url: string
  closed = false
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  close(): void {
    this.closed = true
  }
  /** 派发一条结构化消息（JSON 序列化后走 onmessage，与浏览器一致）。 */
  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
  /** 派发一条坏消息（解析失败路径）。 */
  emitRaw(raw: string): void {
    this.onmessage?.({ data: raw })
  }
  fail(): void {
    this.onerror?.()
  }
}

export function installBrowserGlobals(): void {
  ;(globalThis as Record<string, unknown>).__BLOG_BASE__ = TEST_PREFIX
  FakeEventSource.reset()
  ;(globalThis as Record<string, unknown>).EventSource = FakeEventSource
}

export function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
  }
}

export interface StoreModules {
  session: typeof import('../stores/session.ts')
  conversation: typeof import('../stores/conversation.ts')
  turn: typeof import('../stores/turn.ts')
  composer: typeof import('../stores/composer.ts')
}

/** 动态加载 store 模块（保证 config 注入已就位）。 */
export async function loadStores(): Promise<StoreModules> {
  const [session, conversation, turn, composer] = await Promise.all([
    import('../stores/session.ts'),
    import('../stores/conversation.ts'),
    import('../stores/turn.ts'),
    import('../stores/composer.ts'),
  ])
  return { session, conversation, turn, composer }
}

/** 全部 store 恢复初值（测试隔离；身份置为已就绪，等价 bootstrap 完成态）。 */
export async function resetStores(): Promise<StoreModules> {
  const modules = await loadStores()
  modules.session.useSessionStore.setState({
    viewToken: 0,
    identityReady: true,
    userId: 'tester',
    view: 'chat',
    notice: null,
  })
  modules.conversation.useConversationStore.setState({
    conversationId: '',
    history: null,
    conversations: [],
    conversationsOffset: null,
    conversationsQuery: '',
    conversationsError: null,
  })
  modules.conversation.setStorageAdapter(memoryStorage())
  modules.turn.useTurnStore.setState({ live: null, liveAt: 0, liveClock: 0 })
  modules.composer.useComposerStore.setState({
    draft: '',
    draftsByConversation: {},
    research: true,
    sending: false,
    stopping: false,
    uploading: false,
    connectionHint: '',
    files: [],
    imageCapability: null,
  })
  modules.composer.usePickerStore.setState({
    catalog: null,
    ready: true,
    busy: false,
    errorText: '',
    selected: null,
    dirty: false,
    epoch: 0,
    contextId: null,
  })
  return modules
}

/** /identity 的固定身份（stubApi 内建应答）。 */
const IDENTITY = {
  userId: 'tester',
  version: '0.0.0-test',
  backupAdmin: false,
  maxImageBytes: 1024,
  blogUrl: 'https://blog.example.invalid',
}

export interface ApiCall {
  action: string
  args: Record<string, unknown>
}

/**
 * stub fetch：/identity 恒 200；POST /api 按 action 分发到给定处理器。
 * 未实现的 action 直接抛错（测试缺桩要显式响，不静默给空）。
 */
export function stubApi(
  actions: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>,
): { calls: ApiCall[] } {
  const calls: ApiCall[] = []
  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url.includes('/identity')) {
      return new Response(JSON.stringify(IDENTITY), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ApiCall
    calls.push({ action: body.action, args: body.args })
    const handler = actions[body.action]
    if (handler === undefined) throw new Error(`stub 未实现 action：${body.action}`)
    const result = await handler(body.args)
    return new Response(JSON.stringify(result ?? {}), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  vi.stubGlobal('fetch', vi.fn(fetchMock as typeof fetch))
  return { calls }
}

/** 构造一份最小 chat-history 快照（按需覆盖）。 */
export function historyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation: { id: 'conv-1', title: '测试会话', updatedAt: Date.now(), ready: true, parent: null, pinned: false },
    messages: [],
    turns: [],
    busy: false,
    live: null,
    requests: [],
    results: [],
    operations: [],
    ...overrides,
  }
}

/** 微任务队列推进（让 await 链走完）。 */
export const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))
