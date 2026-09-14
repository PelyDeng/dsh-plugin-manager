/**
 * A 批「可信反馈与操作」的前端检查。
 *
 * 视图代次是真实的异步时序行为，用替身 api 跑一遍：先点 A 再点 B、A 响应更晚时，
 * 只允许渲染 B（方案 I09）。其余项（去罐头、eventsHead 调用、停止不再本地断流）
 * 做源码级守卫——静态匹配只能证明约束存在，浏览器交互验证见验收记录的未验证范围。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

function pick(name: string): string {
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
  if (body === undefined) throw new Error(`${name} 源码未找到`)
  return body
}

describe('视图切换的异步归属（I09）', () => {
  it('先点 A 再点 B、A 响应更晚时，只渲染 B 的记录', async () => {
    const rendered: string[] = []
    const state = { streaming: false, viewToken: 0, conversationId: null, bubbles: { clear() {} }, asks: { clear() {} } }
    const el = { thread: { scrollTop: 0, scrollHeight: 0 } }
    const recordOf = (id: string) => ({ id, conversationId: `conv-${id}` })
    const api = {
      // A 的历史回包故意晚到：这正是乱序场景。
      history: async ({ conversationId }: { conversationId: string }) => {
        if (conversationId === 'conv-a') await new Promise(resolve => { setTimeout(resolve, 30) })
        return { items: [{ id: `task-${conversationId}` }] }
      },
      task: async (id: string) => recordOf(id),
    }
    const noop = () => {}
    const openConversation = Function(
      'state', 'el', 'api', 'make', 'append', 'clear', 'threadInner', 'resetRail',
      'renderWelcome', 'renderTaskRecord', 'rememberConversation', 'refreshChatList',
      `${pick('openConversation')} return openConversation`,
    )(state, el, api, noop, noop, noop, noop, noop, noop, (record: { id: string }) => { rendered.push(record.id) }, noop, noop) as
      (id: string) => Promise<void>

    const first = openConversation('conv-a')
    const second = openConversation('conv-b')
    await Promise.all([first, second])

    expect(rendered).toEqual(['task-conv-b'])
  })
})

describe('A 批源码守卫', () => {
  it('计划事件不再编造任务数量与派发事实（S02）', () => {
    const planCase = source.slice(source.indexOf("case 'plan':"), source.indexOf("case 'subtask':"))
    expect(planCase).toContain('planNote(event)')
    expect(planCase).not.toContain('已经喊人')
    expect(planCase).not.toContain('拆成三份')
  })

  it('接续检查使用独立导出的 eventsHead，失败可见（S04）', () => {
    expect(source).not.toMatch(/api\.eventsHead/u)
    expect(source).toMatch(/await eventsHead\(/u)
    expect(source).toContain('接续检查失败')
  })

  it('停止不再先本地断流，停止对象绑定点击时的会话（I04）', () => {
    const stopListener = source.slice(source.indexOf("el.stop.addEventListener"), source.indexOf('el.at?.addEventListener'))
    expect(stopListener).not.toContain('state.abort?.abort()')
    expect(stopListener).toContain('const conversationId = state.conversationId')
    expect(stopListener).toContain('outcome.accepted')
    expect(stopListener).toContain('停止请求没送到')
  })

  it('右栏失败记录入口与历史入口共用执行中保护（I08）', () => {
    const openTask = pick('openTask')
    expect(openTask).toContain('if (state.streaming) return')
    expect(openTask).toContain('state.viewToken')
  })
})

describe('补缺轮守卫（代码核对发现的三处缺口）', () => {
  const serverSource = readFileSync(fileURLToPath(new URL('../src/butler.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
  const webSource = readFileSync(fileURLToPath(new URL('../src/web.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

  it('占位在受理后转为「正在理解目标」，内容或异常到达才撤掉；流元事件不撤（缺口 2/3a）', () => {
    expect(source).toContain("note.textContent = '正在理解目标…'")
    expect(source).toMatch(/event\.type === 'conversation'/u)
    // run/reset 是流元事件，不代表「已经有内容」——撤掉只发生在内容或异常分支。
    expect(source).toContain("event.type !== 'user' && event.type !== 'run' && event.type !== 'reset'")
  })

  it('接续探测回包后复核视图代次与执行状态（缺口 3）', () => {
    const resume = pick('resumeLiveTurn')
    expect(resume).toContain('tokenAtProbe')
    expect(resume).toMatch(/tokenAtProbe !== state\.viewToken \|\| state\.streaming/u)
  })

  it('互斥不允许回话接管活着的回合（缺口 1）', () => {
    const prepareReply = serverSource.slice(serverSource.indexOf('private prepareReply'), serverSource.indexOf('private async *replyBody'))
    expect(prepareReply).toContain('这一轮还在执行')
    // claimNow 不再有按 kind 的接管分支。
    const claim = serverSource.slice(serverSource.indexOf('private claimNow'), serverSource.indexOf('private releaseClaim'))
    expect(claim).not.toContain("holder.kind === 'turn'")
  })

  it('S01 区分应用入队与 HTTP 写出，且入队记录带 runId/seq/时间', () => {
    expect(serverSource).toContain("'butler-stream server-enqueue'")
    // 入队观测在 push 之后（拿得到本条 seq）。
    const enqueueAt = serverSource.indexOf("'butler-stream server-enqueue'")
    const pushAt = serverSource.lastIndexOf('log.push(event)', enqueueAt)
    expect(pushAt).toBeGreaterThan(-1)
    expect(enqueueAt).toBeGreaterThan(pushAt)
    expect(webSource).toContain("'butler-stream server-write'")
    expect(webSource).toMatch(/seq: logged\.seq/u)
  })

  it('取消态子任务不再触发 classList.add 空串（浏览器验证发现）', () => {
    expect(source).not.toMatch(/classList\.add\([^)]*\?\s*'bubble--fail'\s*:\s*''/u)
  })
})

describe('B 批恢复一致性守卫（S05–S09/S12）', () => {
  it('提交与回话带幂等身份，重试复用同一 ID（S07）', () => {
    expect(source).toMatch(/requestId = reuseRequestId \?\? newConversationId\(\)/u)
    expect(source).toMatch(/void sendMessage\(text, requestId\)/u)
    // 回话：同文重试复用，改了措辞换新 ID。
    expect(source).toMatch(/replyRequestId === null \|\| lastTriedText !== text/u)
  })

  it('reset 运行中快照重建视图；无终态结束走快照校准加续订（S05/S06）', () => {
    expect(source).toContain('async function followUntilTerminal')
    expect(source).toContain('async function rebuildFromSnapshot')
    expect(source).toContain('renderTaskRecord(record, { liveResume: true })')
    // 退避有界且截止可中断：订阅读取挂截止信号（不是只在循环之间检查），预算与总期限共用。
    expect(source).toMatch(/reconnects >= 4 \|\| Date\.now\(\) > deadline/u)
    expect(source).toMatch(/AbortSignal\.any\(\[signal, timeout\]\)/u)
    expect(source).toContain('后续跟不上了')
    // 跟随对象预先指定：不把首次订阅返回的 runId 当预期。
    expect(source).toContain('expectedRunId')
    // 快照失败不推进游标：只有重建成功才对齐窗口头。
    expect(source).toMatch(/if \(rebuilt !== null\) after = head\.seq/u)
  })

  it('重订按轮次校验并去重重放（不混轮次）', () => {
    expect(source).toContain('followedRunId')
    expect(source).toMatch(/event\.seq <= after\) continue/u)
  })

  it('重派重置预览、终态后不再追加、成功按权威正文校准（S08/S09）', () => {
    expect(source).toMatch(/view\.terminal = false/u)
    expect(source).toMatch(/view\.terminal === true\) break/u)
    expect(source).toMatch(/view\.text\.textContent = event\.detail \?\? view\.body/u)
    // 模型重试隔离：旧尝试帧丢弃 + chat_reset 重置预览。
    expect(source).toContain("case 'chat_reset'")
  })

  it('总结正文与气泡相同时汇总卡不再重复（S12）', () => {
    expect(source).toContain('state.lastChatText')
    expect(source).toMatch(/event\.text === state\.lastChatText/u)
  })
})

describe('恢复链路边界（复核轮代码核对发现的两个缺口）', () => {
  /**
   * 无网络替身（与人工复核同一方法）：抽取 followUntilTerminal 源码，注入可控
   * 事件流/探测/重建替身，验证换轮、快照失败、探测窗口三个边界的行为。
   */
  const start = source.indexOf('async function followUntilTerminal(')
  const end = source.indexOf('\nasync function finishTurn', start)
  const followBody = source.slice(start, end)

  async function play(batches: Iterable<unknown>[], head: unknown, from: number, expectedRunId: string | undefined, rebuildResult: unknown) {
    const consumed: unknown[] = []
    const afters: unknown[] = []
    let rebuilds = 0
    let calibrates = 0
    let gaveUp = false
    const state = { lastSeq: from, lastRunTaskId: 'old-task', lastRunId: expectedRunId ?? '' }
    const queue = [...batches]
    const events = async function* (options: { after: unknown }) {
      afters.push(options.after)
      const batch = queue.shift()
      if (batch === undefined) throw new Error('unexpected resubscribe')
      yield* batch
    }
    let timers = 0
    const run = new Function('events', 'eventsHead', 'state', 'consumeTurnEvent', 'calibrateFromSnapshot', 'rebuildFromSnapshot', 'append', 'make', 'setTimeout',
      `return (${followBody})`)(events, async () => head, state,
        (event: unknown) => { consumed.push(event) },
        async () => { calibrates += 1 },
        async () => { rebuilds += 1; return rebuildResult },
        () => { gaveUp = true }, () => ({}),
        (resolve: (v?: unknown) => void) => { timers += 1; if (timers > 20) throw new Error('backoff runaway'); resolve() })
    await run('conversation-1', { from, expectedRunId, signal: new AbortController().signal })
    return { afters, consumed, rebuilds, calibrates, gaveUp }
  }

  it('首次重订服务端已换轮：不消费新轮事件，按快照收尾', async () => {
    const out = await play(
      [[{ type: 'run', runId: 'new-run', taskId: 'new-task' }, { type: 'summary', runId: 'new-run', seq: 11 }]],
      null, 10, 'old-run', null)
    expect(out.consumed).toEqual([])
    expect(out.calibrates).toBe(1)
  })

  it('快照读取失败不推进游标：保留原位按预算重试，耗尽后如实放弃', async () => {
    const reset = [{ type: 'reset', runId: 'old-run', seq: 20 }]
    const out = await play([reset, reset, reset, reset],
      { runId: 'old-run', taskId: 'old-task', state: 'running', seq: 20 }, 0, 'old-run', null)
    expect(out.afters).toEqual([0, 0, 0, 0])
    expect(out.gaveUp).toBe(true)
  })

  it('快照成功后从探测头续订：窗口期事件不丢、已应用的不重放', async () => {
    const out = await play(
      [[{ type: 'reset', runId: 'old-run', seq: 20 }],
       [{ type: 'run', runId: 'old-run', taskId: 'old-task' }, { type: 'summary', runId: 'old-run', seq: 21 }]],
      { runId: 'old-run', taskId: 'old-task', state: 'running', seq: 20 }, 0, 'old-run', { id: 'rebuilt' })
    expect(out.afters).toEqual([0, 20])
    expect(out.consumed).toEqual([{ runId: 'old-run', type: 'summary', seq: 21 }])
    expect(out.rebuilds).toBe(1)
  })

  it('消费回执记录预期轮次；断线重订跟同一轮（完整路径）', async () => {
    // 串起真实的消费函数与跟随函数：POST 流里消费到 run-A 回执（consumeTurnEvent 记
    // lastRunId）→ 流断 → 用记录的 runId 调跟随 → 重订仍返回 run-A → 终态正常消费。
    const consumeStart = source.indexOf('function consumeTurnEvent(')
    const consumeEnd = source.indexOf('\n/**\n * 按服务端快照校准终态', consumeStart)
    const consumeBody = source.slice(consumeStart, consumeEnd)
    const consumed: unknown[] = []
    const state = { lastSeq: 0, lastRunId: '', lastRunTaskId: '' }
    const notes: (HTMLElement | null)[] = [null]
    const consumeTurnEvent = new Function('state', 'traceEvent', 'handleEvent', 'streamTraceEnabled', 'requestAnimationFrame',
      `return (${consumeBody})`)(state, () => {}, () => {}, false, () => {})
    consumeTurnEvent({ type: 'run', runId: 'run-A', taskId: 'task-1' }, null)
    // 回执已记录：断线后跟随用它作为预期对象。
    expect(state.lastRunId).toBe('run-A')
    const out = await play(
      [[{ type: 'run', runId: 'run-A', taskId: 'task-1' }, { type: 'subtask', runId: 'run-A', taskId: 'task-1', seq: 1, id: 's1', state: 'running' }, { type: 'summary', runId: 'run-A', taskId: 'task-1', seq: 2 }]],
      null, 0, state.lastRunId, null)
    expect(out.consumed.map((e: unknown) => (e as { type: string }).type)).toEqual(['subtask', 'summary'])
    void consumed
    void notes
  })

  it('没有回执时不跟随：归属未知如实说明，不采纳当前最新轮', async () => {
    const consumed: unknown[] = []
    const afters: unknown[] = []
    let gaveUp = false
    let noted = ''
    const state = { lastSeq: 0, lastRunTaskId: '', lastRunId: '' }
    const events = async function* () { throw new Error('不应发起订阅') }
    const run = new Function('events', 'eventsHead', 'state', 'consumeTurnEvent', 'calibrateFromSnapshot', 'rebuildFromSnapshot', 'append', 'make', 'setTimeout',
      `return (${followBody})`)(events, async () => { throw new Error('不应探测') }, state,
        (e: unknown) => { consumed.push(e) }, async () => {}, async () => null,
        (node: unknown) => { noted = String(node) }, (tag: string, cls: string, text: string) => text, (r: (v?: unknown) => void) => r())
    await run('conversation-1', { from: 0, expectedRunId: '', signal: new AbortController().signal })
    expect(afters).toEqual([])
    expect(consumed).toEqual([])
    expect(noted).toContain('受理回执没有收到')
  })

  it('新请求清空旧身份：A 轮完成后 B 无回执，不携带 A 的 runId（复核第四轮）', async () => {
    // 串联真实源码：sendMessage 与 runReply 的回合重置块 + 消费函数 + 跟随函数。
    // 复核场景：A 轮消费到 run-A 回执并完成 → 发起 B（重置块应清空 lastRunId）→
    // B 未收到任何回执即断流 → 用 state.lastRunId 跟随时应得到空（归属未知），而不是 run-A。
    const resetStart = source.indexOf('  // 回合级状态每轮都换新')
    const resetEnd = source.indexOf('resetRail()', resetStart) + 'resetRail()'.length
    const resetBlock = source.slice(resetStart, resetEnd)
    const consumeStart = source.indexOf('function consumeTurnEvent(')
    const consumeEnd = source.indexOf('\n/**\n * 按服务端快照校准终态', consumeStart)
    const consumeBody = source.slice(consumeStart, consumeEnd)
    const state = { lastSeq: 0, lastRunId: '', lastRunTaskId: '', bubbles: { clear() {} }, asks: { clear() {} } }
    const consumeTurnEvent = new Function('state', 'traceEvent', 'handleEvent', 'streamTraceEnabled', 'requestAnimationFrame',
      `return (${consumeBody})`)(state, () => {}, () => {}, false, () => {})
    // A 轮：消费 run-A 回执（lastRunId 记为 run-A）。
    consumeTurnEvent({ type: 'run', runId: 'run-A', taskId: 'task-1' }, null)
    expect(state.lastRunId).toBe('run-A')
    // B 轮发起：重置块清空身份（resetRail 是源码函数，测试里给空实现）。
    new Function('state', 'resetRail', `${resetBlock}`)(state, () => {})
    expect(state.lastRunId).toBe('')
    // B 未收到回执即断流：跟随收到空身份 → 归属未知（不订阅 run-A）。
    let subscribed = false
    let noted = ''
    const events = async function* () { subscribed = true }
    const run = new Function('events', 'eventsHead', 'state', 'consumeTurnEvent', 'calibrateFromSnapshot', 'rebuildFromSnapshot', 'append', 'make', 'setTimeout',
      `return (${followBody})`)(events, async () => { throw new Error('不应探测') }, state,
        () => {}, async () => {}, async () => null,
        (node: unknown) => { noted = String(node) }, (tag: string, cls: string, text: string) => text, (r: (v?: unknown) => void) => r())
    await run('conversation-1', { from: state.lastSeq, expectedRunId: state.lastRunId, signal: new AbortController().signal })
    expect(subscribed).toBe(false)
    expect(noted).toContain('受理回执没有收到')
  })
})
