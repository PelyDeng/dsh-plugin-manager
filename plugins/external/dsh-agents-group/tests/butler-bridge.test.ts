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
// 契约来自**运行时**（与 src/butler-bridge.ts 同一份）：common 里那份旧拷贝没有本批新增的
// 待确认操作字段，用它做夹具会让「桥接透传了什么」这件事在类型上就测不到。
import type { AgentParticipant } from '../packages/runtime/src/contract.ts'
import { executorFor, BUTLER_EXECUTORS_EVENT } from '../src/butler-bridge.ts'
import type { AgentManifest } from '../src/agents/registry.ts'

const manifest: AgentManifest = {
  id: 'closedoff',
  displayName: '封闭化管理助手',
  directory: 'closedoff',
  category: '封闭化园区',
  description: '园区业务查询、车辆轨迹',
}

const actor = { namespace: 'user', userId: 'alice', sessionId: 'login-a' } as const

/**
 * 一个记录收到的请求、返回指定结论的参与者替身。
 *
 * `id` 可覆盖：判据④的载体要把三种老执行方（`closedoff` / `blog` / `chain-member`）都跑一遍，
 * 而桥接会核验参与者身份与清单一致——id 对不上会被直接拒包装。
 */
function stubParticipant(
  result: Partial<Awaited<ReturnType<AgentParticipant['run']>>> = {},
  onRun?: (request: unknown) => void,
  id = 'closedoff',
): AgentParticipant {
  return {
    protocol: 1,
    id,
    displayName: '封闭化管理助手',
    description: '替身',
    assertAccess: vi.fn(),
    run: vi.fn(async (request: never) => {
      onRun?.(request)
      return { status: 'completed', conversationId: 'conv-1', text: '查到了', ...result }
    }),
    // 默认带续问入口：G01 之后 reply 是显式能力，桥接按它暴露；
    // 验证「没有 reply」的用例用 stubParticipantWithoutReply。
    reply: vi.fn(async (request: never) => {
      onRun?.(request)
      return { status: 'completed', conversationId: 'conv-1', text: '续上了', ...result }
    }),
  } as unknown as AgentParticipant
}

/** 不实现续问的参与者：桥接不应替它暴露 reply。 */
function stubParticipantWithoutReply(): AgentParticipant {
  const stub = { ...stubParticipant() } as { reply?: unknown }
  delete stub.reply
  return stub as unknown as AgentParticipant
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

  it('reply 路径同样传完整身份，且续问身份与会话分开（G01）', async () => {
    let seen: Record<string, unknown> = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    await executor.reply?.({
      taskId: 'task-1', subtaskId: 'sub-1', requestId: 'reply-run-9', text: '用上周的数据',
      conversationId: 'member-conv-7',
      decideByAgent: false, owner: 'user:alice', actor, signal: new AbortController().signal,
    })
    expect(seen.actor).toEqual(actor)
    // requestId 是这一次回话的幂等身份，不再复用子任务 ID；原会话沿它续接。
    expect(seen.requestId).toBe('reply-run-9')
    expect(seen.requestId).not.toBe(seen.missionId)
    expect(seen.conversationId).toBe('member-conv-7')
  })

  it('旧调用方缺 requestId 时明确拒绝，不回落子任务 ID（G01 防撞键）', async () => {
    let seen: Record<string, unknown> | undefined
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    await expect(executor.reply?.({
      taskId: 'task-1', subtaskId: 'sub-1', requestId: '', text: '缺身份的回话',
      decideByAgent: false, owner: 'user:alice', actor, signal: new AbortController().signal,
    } as unknown as Parameters<NonNullable<typeof executor.reply>>[0])).rejects.toThrow(/幂等身份/)
    // 回落会让同一子任务多次回话撞键：这里必须保证参与者根本没被调用。
    expect(seen).toBeUndefined()
  })

  it('纯空白的 requestId（空格、制表符）同样拒绝，参与者未被调用', async () => {
    let seen: Record<string, unknown> | undefined
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    for (const blank of ['   ', '\t', ' \t ']) {
      await expect(executor.reply?.({
        taskId: 'task-1', subtaskId: 'sub-1', requestId: blank, text: '空白身份的回话',
        decideByAgent: false, owner: 'user:alice', actor, signal: new AbortController().signal,
      })).rejects.toThrow(/幂等身份/)
    }
    expect(seen).toBeUndefined()
  })

  it('参与者没实现 reply 就不暴露续问入口', () => {
    const executor = executorFor(manifest, stubParticipantWithoutReply())
    expect(executor.reply).toBeUndefined()
  })

  it('协议版本或身份不一致的参与者直接拒绝包装（G03）', () => {
    const wrongProtocol = { ...stubParticipant(), protocol: 2 } as unknown as AgentParticipant
    expect(() => executorFor(manifest, wrongProtocol)).toThrow(/协议版本不兼容/)
    const wrongId = { ...stubParticipant(), id: 'someone-else' } as unknown as AgentParticipant
    expect(() => executorFor(manifest, wrongId)).toThrow(/身份与清单不一致/)
  })

  it('进度里的早期会话引用原样透传（G02）', async () => {
    let seen: Record<string, unknown> | undefined
    const participant = {
      protocol: 1, id: 'closedoff', displayName: '替身', description: '替身',
      assertAccess() {},
      async run(request: { onProgress?: (update: unknown) => void }) {
        request.onProgress?.({
          kind: 'status', text: '开工', conversationId: 'member-conv-7',
          conversationArtifact: { kind: 'conversation', title: '查看原会话', path: '/agents/blog?conversationId=member-conv-7' },
        })
        return { status: 'completed', conversationId: 'member-conv-7', text: '办好了' }
      },
    } as unknown as AgentParticipant
    const executor = executorFor(manifest, participant)
    await executor.dispatch({ ...request(), onProgress: update => { seen = update as unknown as Record<string, unknown> } })
    expect(seen?.conversationId).toBe('member-conv-7')
    expect(seen?.conversationArtifact).toEqual({
      kind: 'conversation', title: '查看原会话', path: '/agents/blog?conversationId=member-conv-7',
    })
  })
})

describe('执行入口的字段翻译', () => {
  it('标识、简报与取消信号都对上', async () => {
    let seen: Record<string, unknown> = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    const controller = new AbortController()
    await executor.dispatch(request({ signal: controller.signal }))
    expect(seen.missionId).toBe('task-1')
    // 幂等身份是 `<taskId>:<subtaskId>`，**不是**光秃秃的子任务 id：子任务 id 只在任务内唯一
    // （s1/s2…），直接拿来当 requestId 会让两个任务的第一个子任务撞同一个键 ⇒ 运行时 409
    // 「同一请求身份不能用在不同内容上」（生产实测 2026-09-17）。
    expect(seen.requestId).toBe('task-1:sub-1')
    // message 用完整简报而不是光秃秃的 goal：它含整体目标与产出要求。
    expect(String(seen.message)).toContain('你负责')
    expect(seen.signal).toBe(controller.signal)
  })

  it('跨任务不再撞幂等身份：同一 subtaskId 在两个任务里必须给出不同 requestId', async () => {
    const ids: string[] = []
    const executor = executorFor(manifest, stubParticipant({}, value => { ids.push(String((value as { requestId?: unknown }).requestId)) }))
    await executor.dispatch(request({ taskId: 'task-A', subtaskId: 's1' }))
    await executor.dispatch(request({ taskId: 'task-B', subtaskId: 's1' }))
    expect(ids).toEqual(['task-A:s1', 'task-B:s1'])
    expect(new Set(ids).size).toBe(2)
    // 同一个任务里的同一子任务**重派**仍是同一个键（幂等语义不能被这次修复破坏）。
    ids.length = 0
    await executor.dispatch(request({ taskId: 'task-A', subtaskId: 's1' }))
    expect(ids).toEqual(['task-A:s1'])
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

  it('两种「没跑完」各自对应，不合并', async () => {
    // 等着用户补一句话，和材料已交回、剩下的事在别处办，是两件不同的事：
    // 前者必须等回话，后者可以结束这一轮。合并之后上游只能靠猜。
    const asking = executorFor(manifest, stubParticipant({ status: 'waiting', question: '用上周还是本周的数据？' }))
    const asked = await asking.dispatch(request())
    expect(asked.status).toBe('waiting_user')
    expect(asked.question).toBe('用上周还是本周的数据？')

    const external = executorFor(manifest, stubParticipant({
      status: 'external_pending',
      externalPending: { reason: '候选稿已交回，须在原页面采用', next: '采用之后可以再派一轮' },
    }))
    const pending = await external.dispatch(request())
    expect(pending.status).toBe('external_pending')
    expect(pending.externalPending).toEqual({ reason: '候选稿已交回，须在原页面采用', next: '采用之后可以再派一轮' })
  })

  it('旧版本参与者只说 waiting 时，仍然按等着回话处理', async () => {
    // 旧的子包没有 external_pending 这个值，也没有声明字段。它说 waiting 就是等着回话，
    // 不能因为结果里带着材料就自行升级成「外部待办」。
    const executor = executorFor(manifest, stubParticipant({
      status: 'waiting',
      artifacts: [{ kind: 'draft', title: '查看候选稿', path: '/blog?conversationId=c' }],
    }))
    const result = await executor.dispatch(request())
    expect(result.status).toBe('waiting_user')
    expect(result.externalPending).toBeUndefined()
  })

  it('材料引用原样带过去，不归并种类', async () => {
    const artifacts = [
      { kind: 'confirmation', title: '在博客核对并确认', path: '/blog?conversationId=c' },
      { kind: 'report', title: '查看本周报表', path: '/blog/report?id=7' },
    ] as const
    const executor = executorFor(manifest, stubParticipant({ status: 'external_pending', artifacts: [...artifacts], externalPending: { reason: '等确认' } }))
    const result = await executor.dispatch(request())
    expect(result.artifacts).toEqual([...artifacts])
  })

  it('材料的核验字段（url/state/fields）逐项透传，缺省不产生空键', async () => {
    // 「办了，但没递东西给我核」的桥接半边：发布结果的可访问链接与状态必须一路带到
    // 协调方，否则台账只能证明「有材料」，证明不了「口径要的那种东西交回来了」。
    const artifacts = [
      { kind: 'article', title: '《测试1》已发布', path: '/blog?conversationId=c', state: 'published', url: 'https://blog.example/p/1.html', fields: [{ label: '发布状态', value: '已发布' }] },
      // 老形状（只有位置）：不带新字段的成员照旧工作，桥接不补空串、不补空表。
      { kind: 'conversation', title: '查看原对话', path: '/blog?conversationId=c' },
      // 只有 state 没有 url：状态是事实，链接缺失照实缺着。
      { kind: 'draft', title: '《测试2》草稿', path: '/blog?conversationId=c', state: 'draft' },
    ]
    const executor = executorFor(manifest, stubParticipant({ status: 'completed', artifacts }))
    const result = await executor.dispatch(request())
    expect(result.artifacts).toEqual(artifacts)
    // 缺省字段不得出现 `undefined` 键（exactOptionalPropertyTypes 的运行期对照）。
    expect(Object.keys(result.artifacts![1]!).sort()).toEqual(['kind', 'path', 'title'])
  })

  it('待确认操作原样带过去：协调方据此就地渲染，不认 kind 也画得出来', async () => {
    // 形状就是 kit 的 `AgentAction`：桥接层**不改名、不裁剪**——一旦这里少一个字段，
    // 页面上的按钮或字段表就会缺一块，而类型检查全绿（跨包的类型来自同一份定义）。
    const actions = [{
      id: 'op-1',
      kind: 'blog.publish',
      title: '发布《测试1》',
      summary: '确认后会把这篇内容公开发布到博客。',
      detail: '将要发布的内容',
      fields: [{ label: '标题', value: '测试1' }],
      confirmLabel: '确认',
      state: 'prepared' as const,
      expiresAt: 1_800_000_000_000,
    }]
    const executor = executorFor(manifest, stubParticipant({ status: 'external_pending', externalPending: { reason: '等确认' }, actions }))
    const result = await executor.dispatch(request())
    expect(result.actions).toEqual(actions)
    // 没有待办时不带这个字段（`[]` 与缺省对页面是同一件事，但契约上保持"没有就不发"）。
    const none = executorFor(manifest, stubParticipant({ status: 'completed' }))
    expect((await none.dispatch(request())).actions).toBeUndefined()
  })

  it('就地确认只在参与者实现时暴露；决策原样转交、结果原样带回', async () => {
    const decisions: unknown[] = []
    const bare = executorFor(manifest, stubParticipant({ status: 'completed' }))
    expect(bare.applyAction).toBeUndefined()
    expect(bare.listActions).toBeUndefined()

    // 参与者实现 `applyAction` 才暴露（与 reply 同一个口径：显式能力，不推断）。
    const participant = {
      ...stubParticipant({ status: 'completed' }),
      applyAction: async (input: never) => {
        decisions.push(input)
        return {
          status: 'completed',
          conversationId: 'blog-chat-1',
          text: '已经按你确认的办了。《测试1》已发布。',
          // 批 2：办结材料随就地确认结果上交（链接 + 状态 + 自检结论），桥接原样带回。
          artifacts: [{ kind: 'article', title: '《测试1》已发布', path: '/blog?conversationId=blog-chat-1', state: 'published', url: 'https://blog.example/p/1.html', fields: [{ label: '发布状态', value: '已发布' }] }],
          selfCheck: { status: 'passed', detail: '材料取自业务库操作记录' },
        }
      },
    } as unknown as AgentParticipant
    const executor = executorFor(manifest, participant)
    const result = await executor.applyAction!({
      actionId: 'op-1',
      decision: 'confirm',
      taskId: 'task-1',
      subtaskId: 's1',
      actor: { namespace: 'user', userId: 'writer', sessionId: 'login' } as never,
      conversationId: 'blog-chat-1',
      signal: new AbortController().signal,
    })
    expect(result.status).toBe('succeeded')
    expect(result.summary).toBe('已经按你确认的办了。《测试1》已发布。')
    expect(result.artifacts?.[0]).toMatchObject({ kind: 'article', state: 'published', url: 'https://blog.example/p/1.html' })
    expect(result.selfCheck).toEqual({ status: 'passed', detail: '材料取自业务库操作记录' })
    // 转交的是同一个身份链路：执行方按 `actor` 自己核归属，桥接层不替它判断。
    expect(decisions).toEqual([{
      actionId: 'op-1',
      decision: 'confirm',
      taskId: 'task-1',
      subtaskId: 's1',
      actor: { namespace: 'user', userId: 'writer', sessionId: 'login' },
      conversationId: 'blog-chat-1',
      signal: expect.anything(),
    }])
  })

  it('参与者没给声明时，桥接不替它编一份', async () => {
    const executor = executorFor(manifest, stubParticipant({ status: 'external_pending' }))
    // 一路透传到上游，由上游按「声明缺失」处理；这一层只做翻译，不补字段。
    expect((await executor.dispatch(request())).externalPending).toBeUndefined()
  })

  it('reply 路径同样透传材料与声明', async () => {
    const executor = executorFor(manifest, stubParticipant({
      status: 'external_pending',
      artifacts: [{ kind: 'draft', title: '查看候选稿', path: '/blog?conversationId=c' }],
      externalPending: { reason: '还在等采用' },
    }))
    const result = await executor.reply?.({
      taskId: 'task-1', subtaskId: 'sub-1', requestId: 'reply-run-2', text: '再改一版', decideByAgent: false,
      owner: 'user:alice', actor, signal: new AbortController().signal,
    })
    expect(result?.status).toBe('external_pending')
    expect(result?.externalPending?.reason).toBe('还在等采用')
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

/**
 * 验收口径与自检的透传（P0）。
 *
 * 断言一律落在**参与者侧的回调**里，而不是 `executor.dispatch` 的入参上：桥接内部是逐字段
 * 重建 `run` 的入参，漏传一个可选字段既不报错也不影响其它字段——只看协调方那一跳的 spy
 * 根本看不见。仓库自己的先例也是这么断言的（本文件上面的身份传递用例）。
 */
describe('验收口径与自检的透传', () => {
  it('派单把 acceptance 与 reworkOf 原样交给参与者', async () => {
    let seen: Record<string, unknown> = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    await executor.dispatch(request({ acceptance: '一份 800 字以上的候选稿，含标题与正文', reworkOf: 's3' }))
    expect(seen.acceptance).toBe('一份 800 字以上的候选稿，含标题与正文')
    expect(seen.reworkOf).toBe('s3')
  })

  it('没有声明口径时不传该字段，而不是传空串', async () => {
    let seen: Record<string, unknown> = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    await executor.dispatch(request())
    // 空串到参与者那边会被读成「有口径，但内容是空的」，与「没有声明口径」不是同一件事：
    // 前者会让按参与者能力豁免的那条校验失效。
    expect('acceptance' in seen).toBe(false)
    expect('reworkOf' in seen).toBe(false)
  })

  it('续问沿用同一份口径（口径不变，变的是用户又补了一句话）', async () => {
    let seen: Record<string, unknown> = {}
    const executor = executorFor(manifest, stubParticipant({}, value => { seen = value as Record<string, unknown> }))
    await executor.reply?.({
      taskId: 'task-1', subtaskId: 'sub-1', requestId: 'reply-run-1', text: '用上周的数据',
      acceptance: '一份 800 字以上的候选稿', conversationId: 'member-conv-7',
      decideByAgent: false, owner: 'user:alice', actor, signal: new AbortController().signal,
    })
    expect(seen.acceptance).toBe('一份 800 字以上的候选稿')
  })

  it('selfCheck 原样回传，缺声明时不补一个 passed', async () => {
    const reported = executorFor(manifest, stubParticipant({ selfCheck: { status: 'failed', detail: '少了发布链接' } }))
    await expect(reported.dispatch(request())).resolves.toMatchObject({
      selfCheck: { status: 'failed', detail: '少了发布链接' },
    })
    // 补一个 passed 会把一次没人核验过的交付显示成已核验；协调方按「未核验」如实标记才对。
    const silent = executorFor(manifest, stubParticipant())
    const result = await silent.dispatch(request())
    expect('selfCheck' in result).toBe(false)
  })

  it('unverifiable 如实透传，不被折成通过或失败', async () => {
    // 它的语义是「这一轮没有可核验的产出」，是「没顾上过目」而不是「活没干好」——
    // 折成任何一边都会让不带产出物的正常步骤被算成不达标。
    const executor = executorFor(manifest, stubParticipant({ selfCheck: { status: 'unverifiable' } }))
    await expect(executor.dispatch(request())).resolves.toMatchObject({ selfCheck: { status: 'unverifiable' } })
  })
})

/**
 * 老执行方集合（P0 判据④的载体）。
 *
 * 判据原文要求"定义老执行方集合 = `closedoff` + `blog` + `chain-member` 替身"，但早先全仓
 * 只有 kit 里一句注释，没有可执行的东西。这里把它落成断言。
 *
 * **三种老执行方都不声明 `selfCheck`**，桥接必须如实回传"没有自检结论"，而**绝不能**替它们
 * 补一个 `passed`——那会把一次没人核验过的交付显示成已核验。判据要能区分四种情形：
 * `passed` / `unverifiable` / `failed` / **缺省（执行方没实现自检）**，缺省**不等价于通过**。
 *
 * `closedoff` 与 `blog` 是当前两个生产执行方（都还没读 `acceptance` / `selfCheck`，恒缺省）；
 * `chain-member`（`tests/fixtures/chain-member.ts`）是测试替身，代表"将来新写的、还没跟上
 * 契约的执行方"。
 */
describe('老执行方集合：缺省的自检不得被当成通过', () => {
  it.each(['closedoff', 'blog', 'chain-member'])('%s 不声明 selfCheck 时不补 passed', async (id) => {
    const executor = executorFor({ ...manifest, id }, stubParticipant({}, undefined, id))
    const result = await executor.dispatch(request())
    expect('selfCheck' in result).toBe(false)
  })

  it('缺省与 unverifiable 是两件事，都不能等同于 passed', async () => {
    const silent = executorFor(manifest, stubParticipant())
    expect('selfCheck' in await silent.dispatch(request())).toBe(false)
    const declared = executorFor(manifest, stubParticipant({ selfCheck: { status: 'unverifiable' } }))
    expect((await declared.dispatch(request())).selfCheck).toEqual({ status: 'unverifiable' })
  })
})
