/**
 * 回合跟随引擎的单测（批 1 DoD：SSE 断线重订逻辑——重试预算/runId 核对/续订对齐）。
 *
 * turn-engine 是解耦重写的纯控制流：订阅/探测/快照与渲染副作用全部注入，这里用
 * 假事件流逐条核对语义（对齐 web/modules/send.js followUntilTerminal 的 S05/S06/S09）。
 * 退避计时用假时钟推进；120s 硬期限由 AbortSignal.timeout 走真实时钟，测试内不会触达，
 * 预算耗尽以重订计数（4 次）为准。
 */
import { describe, expect, it, vi } from 'vitest'
import { followUntilTerminal, type TurnEngineHost, type TurnEngineLinks } from '../web-react/src/lib/turn-engine.ts'
import type { TurnEvent } from '../web-react/src/lib/turn-event.ts'
import type { RunHead, TaskRecord } from '../web-react/src/lib/api.ts'

const CONV = 'conv-1'
const RUN = 'run-A'

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1', conversationId: CONV, goal: 'g', note: null,
    state: 'completed', createdAt: 0, updatedAt: 0, summary: '结论', error: null, subtasks: [],
    ...overrides,
  }
}

/** 记录行为的空宿主：断言各副作用回调的调用与顺序。 */
function fakeHost() {
  const applied: TurnEvent[] = []
  const notes: string[] = []
  const errors: string[] = []
  const host: TurnEngineHost = {
    apply: event => { applied.push(event) },
    note: text => { notes.push(text) },
    errorLine: text => { errors.push(text) },
    runTaskId: () => 'task-1',
    setRunTaskId: () => {},
    sawTerminal: () => applied.some(event => event.type === 'summary'),
    markTerminal: () => {},
    calibrate: vi.fn(),
    rebuild: vi.fn(),
  }
  const sawApplied = () => applied
  return { host, sawApplied, notes, errors }
}

/** 依次产出若干段流的假订阅：每次调用 links.subscribe 消耗一段；段耗尽后抛错兜底。 */
function scriptedLinks(script: Array<TurnEvent[]>, heads: RunHead[] = [], snapshots: TaskRecord[] = []) {
  let subscribeCalls = 0
  const afterLog: number[] = []
  const links: TurnEngineLinks = {
    subscribe: (_conversationId, after) => {
      afterLog.push(after)
      const chunk = script[subscribeCalls]
      subscribeCalls += 1
      if (chunk === undefined) throw new Error('测试脚本流已耗尽')
      return (async function* () {
        for (const event of chunk) yield event
      })()
    },
    probeHead: () => Promise.resolve(heads[Math.min(subscribeCalls, heads.length) - 1] ?? null),
    taskSnapshot: () => Promise.resolve(snapshots[0] ?? record()),
  }
  return { links, afterLog, subscribeCount: () => subscribeCalls }
}

describe('followUntilTerminal', () => {
  it('正常路径：run 头匹配 → 消费到 summary 即返回，不重订', async () => {
    const { links, afterLog, subscribeCount } = scriptedLinks([[
      { type: 'run', runId: RUN, seq: 0 },
      { type: 'chat', text: '你好', seq: 1 },
      { type: 'summary', state: 'completed', text: '你好', seq: 2 },
    ]])
    const { host, sawApplied } = fakeHost()
    await followUntilTerminal(CONV, { from: 0, expectedRunId: RUN }, links, host)
    expect(subscribeCount()).toBe(1)
    expect(afterLog).toEqual([0])
    expect(sawApplied().map(event => event.type)).toEqual(['run', 'chat', 'summary'])
  })

  it('归属未知（expectedRunId 空）：只留说明，不订阅', async () => {
    const { links, subscribeCount } = scriptedLinks([[]])
    const { host, notes } = fakeHost()
    await followUntilTerminal(CONV, { from: 0, expectedRunId: '' }, links, host)
    expect(subscribeCount()).toBe(0)
    expect(notes[0]).toContain('受理回执没有收到')
  })

  it('不混轮次（S06）：跟随中收到别的 run 头，立即按快照收尾，不消费新轮事件', async () => {
    const { links, subscribeCount } = scriptedLinks(
      [[{ type: 'chat', text: '旧轮尾巴', seq: 1 }, { type: 'run', runId: 'run-B' }]],
      [],
      [record({ state: 'completed' })],
    )
    const { host, sawApplied } = fakeHost()
    await followUntilTerminal(CONV, { from: 0, expectedRunId: RUN }, links, host)
    expect(subscribeCount()).toBe(1)
    expect(host.calibrate).toHaveBeenCalledTimes(1)
    expect(sawApplied().some(event => event.runId === 'run-B')).toBe(false)
  })

  it('旧 seq 丢弃（after 之后不重复消费）：别的轮次重放事件不应用', async () => {
    const { links } = scriptedLinks([[
      { type: 'chat', runId: 'run-other', text: '别人的轮次', seq: 6 },
      { type: 'chat', runId: RUN, text: '新内容', seq: 7 },
      { type: 'chat', runId: RUN, text: '重放', seq: 7 },
      { type: 'summary', state: 'completed', text: '', seq: 8 },
    ]])
    const { host, sawApplied } = fakeHost()
    await followUntilTerminal(CONV, { from: 5, expectedRunId: RUN }, links, host)
    const seqs = sawApplied().map(event => event.seq)
    expect(seqs).toEqual([7, 8])
  })

  it('reset 重建后续订对齐：重建成功才把游标推进到探测头部的 seq', async () => {
    // 第一段流：reset 后空 EOF；探测：仍在跑（同 runId、taskId=t9、seq=42）。
    // 第二段流：summary 终态。断言第二次订阅拿到的 after=42（head.seq）。
    const { links, afterLog, subscribeCount } = scriptedLinks(
      [[{ type: 'reset' }], [{ type: 'summary', state: 'completed', text: '收尾', seq: 43 }]],
      [{ runId: RUN, state: 'running', taskId: 't9', seq: 42 }],
      [record()],
    )
    const { host } = fakeHost()
    await followUntilTerminal(CONV, { from: 3, expectedRunId: RUN }, links, host)
    expect(subscribeCount()).toBe(2)
    expect(host.rebuild).toHaveBeenCalledTimes(1)
    // 第一次订阅 from=3；重建成功后续订从 head.seq=42 起。
    expect(afterLog).toEqual([3, 42])
  })

  it('重建失败不推进游标：退避后按原 after 重订再试', async () => {
    vi.useFakeTimers()
    try {
      // 快照读取失败：taskSnapshot 抛错 → rebuild 不落 → 重订 after 仍是 3。
      const afters: number[] = []
      const links: TurnEngineLinks = {
        subscribe: (_conversationId, after) => {
          afters.push(after)
          const chunk = after === 3
            ? [{ type: 'reset' as const }]
            : [{ type: 'summary' as const, state: 'completed', text: '收尾', seq: 43 }]
          return (async function* () { for (const event of chunk) yield event })()
        },
        probeHead: () => Promise.resolve({ runId: RUN, state: 'running', taskId: 't9', seq: 42 }),
        taskSnapshot: () => Promise.reject(new Error('快照暂不可用')),
      }
      const { host } = fakeHost()
      const pending = followUntilTerminal(CONV, { from: 3, expectedRunId: RUN }, links, host)
      await vi.advanceTimersByTimeAsync(30_000)
      await pending
      expect(host.rebuild).not.toHaveBeenCalled()
      // 重建失败后重订没有对齐到 42，仍按原游标 3 重试。
      expect(afters.filter(value => value === 42)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('EOF 后仍在跑：按预算退避重订，第二次消费到终态', async () => {
    vi.useFakeTimers()
    try {
      const { links, subscribeCount } = scriptedLinks(
        [[], [{ type: 'summary', state: 'completed', text: '收尾', seq: 2 }]],
        [{ runId: RUN, state: 'running', taskId: 'task-1' }],
      )
      const { host, errors } = fakeHost()
      const pending = followUntilTerminal(CONV, { from: 0, expectedRunId: RUN }, links, host)
      // 退避 2s 起（封顶 4s）：假时钟推进，直到跟随结束。
      await vi.advanceTimersByTimeAsync(10_000)
      await pending
      expect(subscribeCount()).toBe(2)
      expect(errors).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('重试预算耗尽（4 次重订）：如实放弃，不无限重试', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const links: TurnEngineLinks = {
        subscribe: () => {
          calls += 1
          return (async function* () { /* 立即 EOF */ })()
        },
        probeHead: () => Promise.resolve({ runId: RUN, state: 'running', taskId: 'task-1' }),
        taskSnapshot: () => Promise.resolve(record()),
      }
      const { host, errors } = fakeHost()
      const pending = followUntilTerminal(CONV, { from: 0, expectedRunId: RUN }, links, host)
      await vi.advanceTimersByTimeAsync(60_000)
      await pending
      expect(calls).toBe(4)
      expect(errors[0]).toContain('事件流已断开')
    } finally {
      vi.useRealTimers()
    }
  })

  it('调用方取消：跟随立即返回（AbortError 不当失败）', async () => {
    const controller = new AbortController()
    const links: TurnEngineLinks = {
      subscribe: () => (async function* () {
        controller.abort()
        yield { type: 'chat', runId: RUN, text: 'x', seq: 1 }
      })(),
      probeHead: () => Promise.resolve(null),
      taskSnapshot: () => Promise.resolve(record()),
    }
    const { host, errors } = fakeHost()
    await followUntilTerminal(CONV, { from: 0, expectedRunId: RUN, signal: controller.signal }, links, host)
    // 订阅被取消打断：既不给「放弃」的错误行，也不继续重订（由 signal?.aborted 分支保证）。
    expect(errors).toEqual([])
  })
})
