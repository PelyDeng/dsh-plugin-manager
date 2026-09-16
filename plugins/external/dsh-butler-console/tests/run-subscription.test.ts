/**
 * 执行与观察分离的回归测试。
 *
 * 这三条性质之前都不成立，而且坏起来是静默的：页面关掉，任务被悄悄取消；后台还在跑的
 * 那一轮把增量推进一个再也没人读的队列；第二个入口想看同一轮，只能各自重跑一遍。
 * 所以这里逐条钉住：
 *
 * 1. 观察者断线不改变执行 —— 关掉页面不等于取消。
 * 2. 多个观察者能同时看同一轮，且任务只执行一次。
 * 3. 游标能续传，续不上时明确说「重取快照」，不假装补齐。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole, type ButlerEvent } from '../src/butler.ts'
import type { Config } from '../src/config.ts'
import { canResume, ConversationLog } from '../src/event-log.ts'
import type { ButlerStorage } from '../src/storage/types.ts'

const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab'
const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'alice-login' }

/** 只提供目录这一条通道：`runTurn` 组装提示词时会读成员名单。 */
function context(): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'ecosystem/catalog') accept({ protocol: 1, plugin: {
          id: 'closedoff', packageName: 'dsh-closedoff', version: '1.0.0', displayName: '封闭化',
          description: '', entryPath: '/agents/closedoff', permissions: [], tools: [], category: 'agents',
        } })
      },
    },
  } as unknown as Context
}

/** 让已经就绪的微任务与宏任务跑一轮。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** 等到条件成立，或超时后如实失败 —— 不用固定次数的 settle 去赌时序。检查可以是异步的。 */
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return
    await settle()
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * 一个可控的大总管会话。
 *
 * `followup` 不自己结束回合：测试要在「一轮正跑着」的时刻插入观察、断线与取消，
 * 所以由用例显式调用 `endTurn()`。这是本文件最关键的工装 —— 之前没有它，
 * 「执行中途断线」这个场景在单测里根本摆不出来。
 */
function fixture() {
  const store = {
    touchConversation: vi.fn(),
    assertOwner: vi.fn(),
    task: vi.fn(() => undefined),
    setSubtaskState: vi.fn(),
  } as unknown as ButlerStorage
  const access = { mode: 'authenticated', ready() {}, resolve: () => undefined, assert() {} } as unknown as Access
  const config = {
    subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000, maxConversationEvents: 50,
  } as Config
  const console_ = new ButlerConsole(context(), config, access, store, '')

  const agent = {
    session: { id: conversationId },
    followup: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
  vi.spyOn(console_, 'open').mockResolvedValue({
    id: conversationId, handle: { agent }, active: false, lastUsedAt: Date.now(),
  } as never)

  /** 结束当前这一轮（理解阶段）：`runTurn` 等的是这个 `turn/end`。 */
  const endTurn = () => {
    console_.observe({ id: conversationId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
  }
  return { console_, agent, endTurn, store }
}

/** 收下一条观察流，`stopAfter` 条之后主动断开（模拟关页面或断网）。 */
async function collect(
  events: AsyncGenerator<{ seq: number; event: ButlerEvent }>,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<{ seq: number; event: ButlerEvent }[]> {
  const seen: { seq: number; event: ButlerEvent }[] = []
  for await (const logged of events) {
    seen.push(logged)
    if (seen.length >= stopAfter) break
  }
  return seen
}

describe('一轮的事件日志', () => {
  it('游标连续且从 1 开始，新的一轮重新计数', () => {
    const log = new ConversationLog<string>(10)
    log.begin('run-1')
    expect(log.push('a').seq).toBe(1)
    expect(log.push('b').seq).toBe(2)
    log.finish('finished')

    log.begin('run-2')
    expect(log.push('c').seq).toBe(1)
    expect(log.head()).toMatchObject({ runId: 'run-2', seq: 1, windowStart: 1 })
  })

  it('超出窗口时丢最旧的，并把窗口起点如实前移', () => {
    const log = new ConversationLog<number>(3)
    log.begin('run-1')
    for (let index = 1; index <= 5; index += 1) log.push(index)

    const head = log.head()
    expect(head).toMatchObject({ seq: 5, windowStart: 3 })
    // 游标 2 之后要的是 3、4、5，都还在窗口里，接得上。
    expect(canResume(head!, 2)).toBe(true)
    // 游标 1 之后要的是 2 起，而 2 已经被挤掉：接不上，只能重取快照。
    expect(canResume(head!, 1)).toBe(false)
    // 从头读也一样拿不全这一轮，不能交回半轮却当作全部。
    expect(canResume(head!, 0)).toBe(false)
  })

  it('窗口还没滚动时，任何游标都接得上', () => {
    const log = new ConversationLog<number>(3)
    log.begin('run-1')
    log.push(1)
    const head = log.head()!
    expect(canResume(head, 0)).toBe(true)
    expect(canResume(head, 1)).toBe(true)
  })

  it('先补齐已有事件，再跟着新事件走', async () => {
    const log = new ConversationLog<string>(10)
    log.begin('run-1')
    log.push('a')

    const seen: string[] = []
    const reader = (async () => { for await (const item of log.follow('run-1', 0)) seen.push(item.event) })()
    await settle()
    expect(seen).toEqual(['a'])

    log.push('b')
    await settle()
    expect(seen).toEqual(['a', 'b'])

    log.finish('finished')
    await reader
    expect(seen).toEqual(['a', 'b'])
  })

  it('一个观察者退出不影响另一个，也不影响后面的写入', async () => {
    const log = new ConversationLog<string>(10)
    log.begin('run-1')
    log.push('a')

    const first = (async () => { for await (const item of log.follow('run-1', 0)) { if (item.event === 'a') break } })()
    const second: string[] = []
    const secondReader = (async () => { for await (const item of log.follow('run-1', 0)) second.push(item.event) })()

    await first
    await settle()
    log.push('b')
    await settle()
    log.finish('finished')
    await secondReader

    // 先退出的那个没有把日志带走：后加入的照样收到全部事件。
    expect(second).toEqual(['a', 'b'])
  })

  it('换到新的一轮时，跟随旧轮的订阅直接结束', async () => {
    const log = new ConversationLog<string>(10)
    log.begin('run-1')
    log.push('a')

    const seen: string[] = []
    const reader = (async () => { for await (const item of log.follow('run-1', 0)) seen.push(item.event) })()
    await settle()
    log.begin('run-2')
    await reader
    expect(seen).toEqual(['a'])
  })
})

describe('提交之后，观察者是否在场与任务无关', () => {
  it('观察者读到第一条就断开，这一轮仍然跑完并留下终态', async () => {
    const f = fixture()
    const started = await f.console_.start(conversationId, '看看今天园区的情况', actor)
    const watch = await f.console_.watch(conversationId, actor, started.from)
    expect(watch).toBeDefined()

    // 页面在这里关掉：只读到「用户发了话」就断开。
    const seen = await collect(watch!.events, 1)
    expect(seen.map(item => item.event.type)).toEqual(['user'])

    // 执行还在后台等着这一轮结束 —— 断线没有把它取消掉。
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
    expect((await f.console_.watch(conversationId, actor, 0))!.head.state).toBe('running')

    f.endTurn()
    await until(async () => (await f.console_.watch(conversationId, actor, 0))!.head.state !== 'running', '这一轮结束')

    const after = await f.console_.watch(conversationId, actor, 0)
    expect(after!.head.state).toBe('finished')
    // 断线之后产生的事件一条都没丢，重新订阅就能补齐。
    const replayed = await collect((await f.console_.watch(conversationId, actor, 0))!.events)
    expect(replayed.map(item => item.event.type)).toEqual(['user', 'chat'])
    expect(replayed.map(item => item.seq)).toEqual([1, 2])
  })

  it('两个入口同时观察同一轮，两边内容一致，任务只执行一次', async () => {
    const f = fixture()
    const started = await f.console_.start(conversationId, '看看今天园区的情况', actor)
    const left = collect((await f.console_.watch(conversationId, actor, started.from))!.events)
    const right = collect((await f.console_.watch(conversationId, actor, started.from))!.events)

    await settle()
    f.endTurn()
    const [leftSeen, rightSeen] = await Promise.all([left, right])

    expect(leftSeen.map(item => item.event.type)).toEqual(['user', 'chat'])
    expect(rightSeen).toEqual(leftSeen)
    // 第二个入口是「看」，不是「再派一次」。
    expect(f.agent.followup).toHaveBeenCalledTimes(1)
  })

  it('迟到加入的观察者用游标续传，只补自己没读过的部分', async () => {
    const f = fixture()
    const started = await f.console_.start(conversationId, '看看今天园区的情况', actor)
    await settle()
    f.endTurn()
    await until(async () => (await f.console_.watch(conversationId, actor, 0))!.head.state !== 'running', '这一轮结束')

    const tail = await collect((await f.console_.watch(conversationId, actor, 1))!.events)
    expect(tail.map(item => item.seq)).toEqual([2])
    expect(tail[0]!.event.type).toBe('chat')
  })

  it('没有跑过的会话取不到可观察的一轮', async () => {
    const f = fixture()
    expect(await f.console_.watch(conversationId, actor, 0)).toBeUndefined()
  })
})

describe('停止只作用在该停的那一轮上', () => {
  it('按会话停止会中止当前这一轮，并如实记成取消', async () => {
    const f = fixture()
    await f.console_.start(conversationId, '看看今天园区的情况', actor)

    expect(await f.console_.cancel(conversationId, actor)).toEqual({ accepted: true, reason: '' })
    await until(async () => (await f.console_.watch(conversationId, actor, 0))!.head.state !== 'running', '这一轮被取消')

    const head = (await f.console_.watch(conversationId, actor, 0))!.head
    expect(head.state).toBe('cancelled')
    const seen = await collect((await f.console_.watch(conversationId, actor, 0))!.events)
    expect(seen.at(-1)!.event).toMatchObject({ type: 'summary', state: 'cancelled' })
  })

  it('没有正在跑的一轮时停止是幂等的，不报错', async () => {
    const f = fixture()
    const outcome = await f.console_.cancel(conversationId, actor)
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).not.toBe('')
  })

  it('带 taskId 的取消只认正在跑的那个任务，对不上时不误伤当前这一轮', async () => {
    const f = fixture()
    const taskId = 'butler-task-1'
    f.store.task = vi.fn((_actor: Actor, id: string) => (id === taskId
      ? { id: taskId, conversationId, subtasks: [] }
      : undefined)) as unknown as ButlerStorage['task']

    await f.console_.start(conversationId, '看看今天园区的情况', actor)
    // 这一轮才走到理解阶段，日志里还没有 taskId：旧任务的取消不该把它掐掉。
    const outcome = await f.console_.cancel(conversationId, actor, taskId)
    expect(outcome.accepted).toBe(false)
    expect((await f.console_.watch(conversationId, actor, 0))!.head.state).toBe('running')
  })

  it('别的会话的任务 id 借不来取消权限', async () => {
    const f = fixture()
    const taskId = 'butler-task-1'
    f.store.task = vi.fn((_actor: Actor, id: string) => (id === taskId
      ? { id: taskId, conversationId: 'butler-web-11111111-2222-4333-8444-555555555555', subtasks: [] }
      : undefined)) as unknown as ButlerStorage['task']

    await expect(f.console_.cancel(conversationId, actor, taskId)).rejects.toThrowError(/任务不存在或无权访问/)
  })
})
