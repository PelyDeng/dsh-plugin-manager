/**
 * 牛马大总管执行入口桥接的测试。
 *
 * 桥接的作用是把子包的参与者（`AgentParticipant`）翻译成牛马大总管的执行入口
 * （`ButlerAgentExecutor`）。这里锁住三件事：
 *
 * 1. **身份原样传递**。牛马大总管给完整 `Actor`，桥接必须把它原样交给参与者去鉴权 —— 参与者
 *    每次运行前都会重新鉴权，所以这一层绝不能丢字段或自己造身份。
 * 2. **状态一一对应**，不归并。`cancelled` 与 `failed` 对用户是两件不同的事。
 * 3. **不编造进度**。参与者报什么就搬什么，缺的字段不能凭空补。
 */

import { describe, expect, it, vi } from 'vitest'
import type { AgentParticipant } from '@dsh-agents-group/common'
import { executorFor, BUTLER_EXECUTORS_EVENT } from '../src/butler-bridge.ts'
import type { AgentManifest } from '../src/agents/registry.ts'

const manifest: AgentManifest = {
  id: 'closedoff',
  displayName: '封闭化管理智能助手',
  directory: 'closedoff',
  category: '封闭化园区',
  description: '园区业务查询、车辆轨迹',
}

const actor = { namespace: 'user', userId: 'alice', sessionId: 'login-a' } as const

/** 一个记录收到的请求、返回指定结论的参与者替身。 */
function stubParticipant(result: Partial<Awaited<ReturnType<AgentParticipant['run']>>> = {}, onRun?: (request: unknown) => void): AgentParticipant {
  return {
    protocol: 1,
    id: 'closedoff',
    displayName: '封闭化管理智能助手',
    description: '替身',
    assertAccess: vi.fn(),
    run: vi.fn(async (request: never) => {
      onRun?.(request)
      return { status: 'completed', conversationId: 'conv-1', text: '查到了', ...result }
    }),
  } as unknown as AgentParticipant
}

const request = (overrides: Record<string, unknown> = {}) => ({
  taskId: 'task-1',
  subtaskId: 'sub-1',
  goal: '查一下今天有多少危化车进园',
  brief: '整体目标：统计园区情况。\n你负责：查危化车进园数量。',
  taskGoal: '统计园区情况',
  owner: 'user:alice',
  actor,
  signal: new AbortController().signal,
  ...overrides,
})

describe('执行入口的身份传递', () => {
  it('把完整 Actor 原样交给参与者，而不是从 owner 重建', async () => {
    // owner 丢掉了 sessionId，靠它重建身份会得到不完整的 Actor，那正是越权的来源。
    let seen: { actor?: unknown } = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as { actor?: unknown } }))
    await executor.dispatch(request())
    expect(seen.actor).toEqual(actor)
  })

  it('身份里的 sessionId 必须保留', async () => {
    let seen: { actor?: { sessionId?: string } } = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as typeof seen }))
    await executor.dispatch(request())
    // 只比对 userId 会漏掉「重建身份丢了 sessionId」这个缺陷。
    expect(seen.actor?.sessionId).toBe('login-a')
  })

  it('reply 路径同样传完整身份', async () => {
    let seen: { actor?: unknown } = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as { actor?: unknown } }))
    await executor.reply?.({
      taskId: 'task-1', subtaskId: 'sub-1', text: '用上周的数据',
      decideByAgent: false, owner: 'user:alice', actor, signal: new AbortController().signal,
    })
    expect(seen.actor).toEqual(actor)
  })
})

describe('执行入口的字段翻译', () => {
  it('标识、简报与取消信号都对上', async () => {
    let seen: Record<string, unknown> = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    const controller = new AbortController()
    await executor.dispatch(request({ signal: controller.signal }))
    expect(seen.missionId).toBe('task-1')
    expect(seen.requestId).toBe('sub-1')
    // message 用完整简报而不是光秃秃的 goal：它含整体目标与产出要求。
    expect(String(seen.message)).toContain('你负责')
    expect(seen.signal).toBe(controller.signal)
  })

  it('简报为空时回落到目标', async () => {
    let seen: Record<string, unknown> = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    await executor.dispatch(request({ brief: '   ' }))
    expect(seen.message).toBe('查一下今天有多少危化车进园')
  })

  it('状态一一对应，不归并失败与取消', async () => {
    const cases = [
      ['completed', 'succeeded'],
      ['waiting', 'waiting_user'],
      ['cancelled', 'cancelled'],
      ['failed', 'failed'],
    ] as const
    for (const [participantStatus, butlerStatus] of cases) {
      const executor = executorFor(manifest, stubParticipant({ status: participantStatus }))
      const result = await executor.dispatch(request())
      expect(result.status, `${participantStatus} 应映射为 ${butlerStatus}`).toBe(butlerStatus)
    }
  })

  it('未知状态按失败处理，不当成成功', async () => {
    // 把未知状态当成功会把一次没跑完的活报成成果，那比报失败严重得多。
    const executor = executorFor(manifest, stubParticipant({ status: 'something-new' as never }))
    expect((await executor.dispatch(request())).status).toBe('failed')
  })

  it('结论与会话 id 原样带回', async () => {
    const executor = executorFor(manifest, stubParticipant({ text: '今天 12 辆', conversationId: 'conv-9' }))
    const result = await executor.dispatch(request())
    expect(result.summary).toBe('今天 12 辆')
    expect(result.conversationId).toBe('conv-9')
  })

  it('不编造 question：参与者没给问题就不写', async () => {
    const executor = executorFor(manifest, stubParticipant())
    expect((await executor.dispatch(request())).question).toBeUndefined()
  })
})

describe('执行入口的进度转换', () => {
  const capture = async (progress: unknown) => {
    const received: unknown[] = []
    const participant = stubParticipant({}, () => {})
    // 让参与者在 run 期间上报一次进度。
    ;(participant as { run: unknown }).run = vi.fn(async (req: { onProgress: (u: unknown) => void }) => {
      req.onProgress(progress)
      return { status: 'completed', conversationId: 'c', text: 'x' }
    })
    const executor = executorFor(manifest, participant)
    await executor.dispatch(request({ onProgress: (update: unknown) => received.push(update) }))
    return received
  }

  it('搬真实存在的字段，并把状态正文改名成对方读的 stage', async () => {
    const received = await capture({ kind: 'status', text: '正在查询', tool: 'closedoff_vehicle_track', phase: 'tool' })
    // 牛马大总管读的是 `stage`：正文留在 `text` 里等于没报，对方还会拿 undefined 去压平空白。
    expect(received[0]).toMatchObject({ stage: '正在查询', tool: 'closedoff_vehicle_track', phase: 'tool' })
    expect(received[0]).not.toHaveProperty('text')
  })

  it('缺的字段不凭空补，也不留 undefined 键', async () => {
    const received = await capture({ kind: 'status', text: '正在查询' })
    // 补一个没发生过的 phase 会让页面点亮一个假的协作环节。
    expect(received[0]).not.toHaveProperty('phase')
    expect(received[0]).not.toHaveProperty('tool')
    expect(received[0]).not.toHaveProperty('delta')
  })

  it('正文增量原样搬过去，页面才有东西可追加', async () => {
    const received = await capture({ kind: 'delta', delta: '今天共有 ', conversationId: 'conv-1' })
    expect(received[0]).toMatchObject({ delta: '今天共有 ' })
    // 增量不带状态正文：把它当状态写下来会把同一段回答记成很多条。
    expect(received[0]).toMatchObject({ stage: '' })
  })

  it('思考快照原样搬过去，仍然是覆盖语义而不是增量', async () => {
    const received = await capture({ kind: 'thinking', thinking: '先看今天的通行记录。\n正在生成…' })
    expect(received[0]).toMatchObject({ thinking: '先看今天的通行记录。\n正在生成…' })
    expect(received[0]).not.toHaveProperty('delta')
  })

  it('没有状态正文时 stage 是空串，不写 undefined', async () => {
    const received = await capture({ kind: 'status' })
    // 空状态行由对方显示成「干活中」；这里不替它编一个没发生过的阶段。
    expect(received[0]).toMatchObject({ stage: '' })
    expect(JSON.stringify(received[0])).not.toContain('undefined')
  })

  it('没有 onProgress 时不上报，也不崩', async () => {
    const participant = stubParticipant({}, () => {})
    ;(participant as { run: unknown }).run = vi.fn(async (req: { onProgress: (u: unknown) => void }) => {
      req.onProgress({ kind: 'status' })
      return { status: 'completed', conversationId: 'c', text: 'x' }
    })
    const executor = executorFor(manifest, participant)
    await expect(executor.dispatch(request({ onProgress: undefined }))).resolves.toMatchObject({ status: 'succeeded' })
  })
})

describe('执行入口的身份声明', () => {
  it('agentId 与清单一致', () => {
    expect(executorFor(manifest, stubParticipant()).agentId).toBe('closedoff')
  })

  it('能力摘要取清单里的分类与自述', () => {
    const executor = executorFor(manifest, stubParticipant())
    expect(executor.capabilities).toContain('封闭化园区')
    expect(executor.capabilities).toContain('园区业务查询、车辆轨迹')
  })

  it('分类或自述为空时不塞空字符串', () => {
    const executor = executorFor({ ...manifest, category: '  ', description: '' }, stubParticipant())
    expect(executor.capabilities).toEqual([])
  })

  it('事件名与牛马大总管插件约定一致', () => {
    // 两边各自声明这个事件，名字对不上就会静默不连通。
    expect(BUTLER_EXECUTORS_EVENT).toBe('butler/executors')
  })
})
