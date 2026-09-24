/**
 * 单测公共设施：在**被测模块加载前**装好 CLOSEDOFF_CONFIG（config.ts 在模块
 * 加载期读取，import 提升会晚于顶层赋值，所以被测模块一律动态 import）、
 * 注入内存 storage、提供 store 重置与 SSE Response 构造。
 */
import { vi } from 'vitest'
import type { StorageLike } from '../stores/session.ts'

export const TEST_PREFIX = '/closedoff-qa'

export function installBrowserGlobals(): void {
  ;(globalThis as Record<string, unknown>).CLOSEDOFF_CONFIG = {
    routePrefix: TEST_PREFIX,
    map: { terrainUrl: '', tilesetUrl: '', tilesetHeight: 0, trackDeviceRadiusMeters: 50 },
  }
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
  board: typeof import('../stores/board.ts')
  turn: typeof import('../stores/turn.ts')
  picker: typeof import('../stores/picker.ts')
  composer: typeof import('../stores/composer.ts')
}

/** 动态加载 store 模块（保证 config 已就位）。 */
export async function loadStores(): Promise<StoreModules> {
  const [session, board, turn, picker, composer] = await Promise.all([
    import('../stores/session.ts'),
    import('../stores/board.ts'),
    import('../stores/turn.ts'),
    import('../stores/picker.ts'),
    import('../stores/composer.ts'),
  ])
  return { session, board, turn, picker, composer }
}

/** 全部 store 恢复初值（测试隔离）。 */
export async function resetStores(): Promise<StoreModules> {
  const modules = await loadStores()
  modules.session.useSessionStore.setState({
    identityEpoch: 0,
    viewToken: 0,
    identityReady: true,
    identityKey: 'tester',
    identityLabel: '测试用户',
    identityMode: 'standalone',
    storageKey: 'dsh_closedoff_conversationId:tester',
    status: { kind: 'ok', text: '智能体就绪' },
    conversationId: '',
    conversations: [],
    conversationsOffset: null,
    conversationsQuery: '',
    conversationsError: null,
    listBlocked: false,
  })
  modules.board.useBoardStore.setState({ messages: [], restorePhase: 'idle', restoreError: null })
  modules.turn.useTurnStore.getState().reset()
  modules.picker.usePickerStore.setState({
    catalog: null,
    ready: true,
    busy: false,
    errorText: '',
    selected: null,
    dirty: false,
    epoch: 0,
    contextId: '',
  })
  modules.composer.useComposerStore.setState({ draft: '' })
  modules.session.setStorageAdapter(memoryStorage())
  return modules
}

/** 构造一个一次性 SSE 响应：每个事件一个 chunk，读毕自动关闭。 */
export function sseResponse(events: readonly unknown[], headers: HeadersInit = { 'content-type': 'text/event-stream' }): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers })
}

/**
 * 可手动推进的 SSE 流：测试在任意时刻写入事件/关闭，模拟「流式中途」。
 */
export interface ManualStream {
  response: Response
  push: (...events: readonly unknown[]) => void
  close: () => void
}

export function manualSseResponse(): ManualStream {
  const encoder = new TextEncoder()
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { sink = controller },
  })
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (...events) => {
      if (sink === null) throw new Error('流已关闭')
      for (const event of events) sink.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    },
    close: () => {
      sink?.close()
      sink = null
    },
  }
}

/** stub fetch：/identity 恒 200，/chat 由调用方给定响应；记录调用路径。 */
export function stubFetch(chatResponse: Response | ((call: number) => Response)): { calls: string[] } {
  const calls: string[] = []
  let chatCalls = 0
  const resolve = (): Response => {
    chatCalls += 1
    return typeof chatResponse === 'function' ? chatResponse(chatCalls) : chatResponse
  }
  const fetchMock = (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/identity')) {
      return Promise.resolve(new Response(JSON.stringify({ mode: 'standalone', key: 'tester', label: '测试用户' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    }
    return Promise.resolve(resolve())
  }
  vi.stubGlobal('fetch', vi.fn(fetchMock as typeof fetch))
  return { calls }
}
