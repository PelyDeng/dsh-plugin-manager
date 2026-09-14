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
    const el = { thread: {}, jumpLatest: { hidden: false } }
    const historyState = { conversationId: null, transcriptBefore: null, taskOffset: null, loading: false }
    const api = {
      // A 的对话正文回包故意晚到：这正是乱序场景。
      transcript: async ({ conversationId }: { conversationId: string }) => {
        if (conversationId === 'conv-a') await new Promise(resolve => { setTimeout(resolve, 30) })
        return { items: [{ seq: 1, role: 'butler', text: `t-${conversationId}`, time: 1 }], prevBefore: null }
      },
      history: async () => ({ items: [], nextOffset: null }),
    }
    const noop = () => {}
    // mergeHistoryEntries 与 timeOf 用真实源码：合并排序本身就是被测行为的一部分。
    const openConversation = Function(
      'state', 'el', 'api', 'historyState', 'make', 'append', 'clear', 'threadInner', 'resetRail',
      'resetFollowing', 'renderWelcome', 'renderHistorySlice', 'rememberConversation', 'refreshChatList',
      'updateLoadEarlier', 'scrollToBottom', 'TRANSCRIPT_PAGE_SIZE',
      `${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\n${pick('openConversation')} return openConversation`,
    )(state, el, api, historyState,
      () => ({ remove() {} }), (node: unknown) => node, noop, () => ({ prepend: noop }), noop,
      noop, noop,
      (entries: { text?: string }[]) => { rendered.push(entries.map(entry => entry.text ?? '').join('|')) },
      noop, noop, noop, noop, 50) as
      (id: string) => Promise<void>

    const first = openConversation('conv-a')
    const second = openConversation('conv-b')
    await Promise.all([first, second])

    expect(rendered).toEqual(['t-conv-b'])
  })

  it('历史合并按时间排序，任务摘要标注为 task 不冒充对话（S13/C 批）', () => {
    const merge = Function(`${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\nreturn mergeHistoryEntries`)() as
      (transcript: unknown[], tasks: unknown[]) => { at: number; kind: string; interrupted?: boolean }[]
    const entries = merge(
      [
        { seq: 9, role: 'butler', text: '第二回合答复', time: 9000, interrupted: true },
        { seq: 3, role: 'user', text: '第一句', time: 3000 },
      ],
      [{ id: 'task-1', updatedAt: '1970-01-01T00:00:06Z', createdAt: '1970-01-01T00:00:05Z' }],
    )
    expect(entries.map(entry => entry.kind)).toEqual(['user', 'task', 'butler'])
    expect(entries.map(entry => entry.at)).toEqual([3000, 6000, 9000])
    expect(entries[2]!.interrupted).toBe(true)
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

  it('重派重置预览、终态后不再追加、成功按权威正文校准并落成受控 Markdown（S08/S09/C 批）', () => {
    expect(source).toMatch(/view\.terminal = false/u)
    expect(source).toMatch(/view\.terminal === true\) break/u)
    expect(source).toMatch(/const finalText = event\.detail \?\? view\.body/u)
    expect(source).toMatch(/settleMarkdown\(view\.text, finalText\)/u)
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

describe('C 批「内容可读与历史阅读」守卫', () => {
  it('输入预编辑（I02）：执行中只锁发送，不再禁用输入框', () => {
    const setBusyBody = pick('setBusy')
    expect(setBusyBody).not.toContain('el.input.disabled')
    expect(setBusyBody).toContain('el.send.disabled')
    expect(setBusyBody).toContain('下一句可以先写好')
    // 发送守卫仍在：执行中提交直接返回，不误发。
    expect(source).toMatch(/if \(trimmed === '' \|\| state\.streaming\) return/u)
  })

  it('按帧合并（I12）：增量走 scheduleFrame，事件分发尾部不再逐事件滚动', () => {
    const deltaCase = source.slice(source.indexOf("case 'subtask_delta'"), source.indexOf("case 'subtask_thinking'"))
    expect(deltaCase).toContain('scheduleFrame')
    expect(source).toMatch(/function butlerDelta[\s\S]*?scheduleFrame/u)
    expect(source).toMatch(/default:\n      break\n  \}\n  scheduleFollowScroll\(\)/u)
  })

  it('滚动跟随（I11）：上滚/选字暂停跟随，「回到最新」恢复；插入与落定钉住视口', () => {
    expect(source).toContain('function stabilizeViewport')
    expect(source).toMatch(/distance > 160\) state\.following = false/u)
    expect(source).toContain("el.jumpLatest.addEventListener('click'")
    expect(source).toContain('selectionchange')
    const earlier = pick('loadEarlier')
    expect(earlier).toContain('planHistoryInsertion(historyState.entries')
    expect(earlier).toContain('stabilizeViewport(()')
  })

  it('历史阅读（I10/S13）：会话视图用 transcript 尾读，任务只给标注的摘要卡', () => {
    const openBody = pick('openConversation')
    expect(openBody).toContain('api.transcript({ conversationId: id, tail: true')
    expect(openBody).toContain('对话正文读不到')
    expect(source).toContain("make('span', 'task-card__badge', '任务摘要')")
    // 任务摘要卡点开的是完整记录，不再把任务重建成逐条对话。
    expect(openBody).not.toContain('renderTaskRecord')
  })

  it('受控 Markdown（方案 5.4）：管家、成员、汇总落定走 renderMarkdownInto', () => {
    expect(source).toContain("import { renderMarkdownInto } from './markdown.js'")
    expect(source).toMatch(/function settleMarkdown/u)
    expect(source).toMatch(/renderMarkdownInto\(body, event\.text \|\| event\.error\)/u)
    // 模型正文不回退到 innerHTML：唯一的 innerHTML 是固定 SVG 常量。
    const htmlAssignments = source.match(/innerHTML = [^=]/gu) ?? []
    expect(htmlAssignments).toHaveLength(1)
  })

  it('翻页按稳定标识去重并定位插入，全局保持时间序（复核 1）', () => {
    const merge = Function(`${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\nreturn mergeHistoryEntries`)() as
      (transcript: unknown[], tasks: unknown[]) => { id: string; at: number }[]
    const planInsertion = Function(`${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\n${pick('planHistoryInsertion')}\nreturn planHistoryInsertion`)() as
      (existing: { id: string; at: number }[], fresh: { id: string; at: number }[]) =>
        { merged: { id: string; at: number }[]; insertions: { entry: { id: string; at: number }; beforeId: string | null }[] }
    // 已显示：seq 1000 的对话。新页正文 seq 800/900，另有任务 100——任务页与正文页的
    // 时间范围交叉，只排新页再整体前插会得到 [800,100,900,1000]（复核例）。
    const existing = merge([{ seq: 1000, role: 'butler', text: '最新', time: 1000 }], [])
    const fresh = merge(
      [{ seq: 800, role: 'user', text: 'a', time: 800 }, { seq: 900, role: 'user', text: 'b', time: 900 }],
      [{ id: 'task-old', updatedAt: 100, createdAt: 100 }],
    )
    const { merged, insertions } = planInsertion(existing, fresh)
    expect(merged.map(entry => entry.at)).toEqual([100, 800, 900, 1000])
    // 降序插入：先插 900（落在 1000 之前），再 800（落在 900 之前），再 100（落在 800 之前）。
    expect(insertions.map(item => [item.entry.at, item.beforeId])).toEqual([[900, 't:1000'], [800, 't:900'], [100, 't:800']])
    // 重复到达的条目按稳定标识去重，不重复插入。
    const again = planInsertion(merged, fresh)
    expect(again.insertions).toEqual([])
    expect(again.merged.map(entry => entry.at)).toEqual([100, 800, 900, 1000])
  })

  it('上方内容增高按可见锚点补偿；被改的就是可见节点时不滚动（复核 2 几何替身）', () => {
    // 几何替身：视口 scrollTop=500、高 400。head 顶部分界；above 完全在视口上方
    // （20..420）；seen 是用户正在看的（620..820）。
    const tops = { head: 0, above: 20, seen: 620 }
    const heights = { head: 20, above: 400, seen: 200 }
    const thread = {
      scrollTop: 500,
      clientHeight: 400,
      getBoundingClientRect: () => ({ top: 0 }),
    }
    const el = { thread, jumpLatest: { hidden: false } }
    const node = (name: keyof typeof tops) => ({
      classList: { contains: (value: string) => value === 'history-head' && name === 'head' },
      getBoundingClientRect: () => ({ top: tops[name] - thread.scrollTop, height: heights[name] }),
    })
    const inner = { children: [node('head'), node('above'), node('seen')] }
    const state = { following: false, selecting: false }
    const stabilize = Function('el', 'state', 'threadInner', 'nextFrame', 'noteStabilize',
      `${pick('stabilizeViewport')} return stabilizeViewport`)(el, state, () => inner, () => {}, () => {}) as
      (mutate: () => void) => void
    // 上方节点向下增高 400px：它自身的 top 不变，但把用户看的内容整体推下去——
    // 锚在被改节点上会漏掉这 400px，锚在可见内容上必须补偿。
    stabilize(() => { heights.above += 400; tops.seen += 400 })
    expect(thread.scrollTop).toBe(900)
    // 被改的就是可见节点自身（向下长高）：锚点 top 不变，不该滚动。
    stabilize(() => { heights.seen += 100 })
    expect(thread.scrollTop).toBe(900)
  })

  it('加载更早记录：游标推进、全局序列就位，旧回包不推进也不渲染（I09/I10）', async () => {
    const rendered: { text?: string; task?: { id: string } }[] = []
    type HistoryFixture = {
      conversationId: string | null
      transcriptBefore: number | null
      taskOffset: number | null
      loading: boolean
      entries: { id: string; at: number; kind?: string; node?: { id: string; isConnected: boolean } }[]
    }
    type FixtureApi = {
      transcript: () => Promise<{ items: unknown[]; prevBefore: number | null }>
      history: () => Promise<{ items: unknown[]; nextOffset: number | null }>
    }
    const state = { viewToken: 0 }
    const historyState: HistoryFixture = { conversationId: 'conv-1', transcriptBefore: 8, taskOffset: 30, loading: false, entries: [] }
    const api: FixtureApi = {
      transcript: async () => ({ items: [{ seq: 3, role: 'user', text: '旧对话', time: 3 }], prevBefore: null }),
      history: async () => ({ items: [{ id: 'older-task', updatedAt: 5 }], nextOffset: null }),
    }
    const noop = () => {}
    // 跟踪式容器：断言实际插入后的节点顺序，而不只验证计划（复核 1 的要求）。
    const makeInner = () => {
      const children: { id: string }[] = []
      return {
        children,
        querySelector: () => null,
        appendChild(node: { id: string }) { children.push(node); return node },
        insertBefore(node: { id: string }, ref: { id: string }) {
          // 与 DOM 同语义：insertBefore 是搬移，先移出原位置再插入。
          const existing = children.indexOf(node)
          if (existing !== -1) children.splice(existing, 1)
          const index = children.indexOf(ref)
          children.splice(index === -1 ? children.length : index, 0, node)
          return node
        },
      }
    }
    const inner = makeInner()
    const build = (ownState: { viewToken: number }, ownHistory: HistoryFixture, ownApi: FixtureApi, sink: (entry: unknown) => void, ownInner = inner) => Function(
      'state', 'historyState', 'api', 'updateLoadEarlier', 'threadInner', 'stabilizeViewport',
      'createHistoryNode', 'planHistoryInsertion', 'TRANSCRIPT_PAGE_SIZE',
      `${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\n${pick('planHistoryInsertion')}\n${pick('loadEarlier')} return loadEarlier`,
    )(ownState, ownHistory, ownApi, noop, () => ownInner, (mutate: () => void) => { mutate() },
      (entry: { id: string }) => {
        sink(entry)
        const node = { id: entry.id, isConnected: true }
        // 与真实 createHistoryNode 同语义：创建即追加到线程，插入逻辑只负责搬移。
        ownInner.appendChild(node)
        return node
      },
      Function(`${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\n${pick('planHistoryInsertion')}\nreturn planHistoryInsertion`)(), 50) as
      () => Promise<void>

    await build(state, historyState, api, entry => { rendered.push(entry as { text?: string; task?: { id: string } }) })()
    // 创建按时间降序（先建晚的，才能各自参照后继落位）；DOM 顺序由 insertBefore 决定。
    expect(rendered.map(entry => entry.text ?? entry.task?.id)).toEqual(['older-task', '旧对话'])
    // 实际插入后的节点顺序就是全局时间序（复核 1：不只验证计划）。
    expect(inner.children.map(node => node.id)).toEqual(['t:3', 'task:older-task'])
    // 全局序列按时间就位，两个游标都到底。
    expect(historyState.entries.map(entry => entry.at)).toEqual([3, 5])
    expect(historyState.transcriptBefore).toBeNull()
    expect(historyState.taskOffset).toBeNull()
    expect(historyState.loading).toBe(false)

    // 复核 1 的复现场景：已在页面上 1 条（old），新页 4 条（seq 7..10）时间都更晚。
    // 节点索引同步修复前，最早的 7 找不到刚插入的后继，会落到末尾（old,8,9,10,7）。
    const reproState = { viewToken: 3 }
    const repro = { conversationId: 'conv-r', transcriptBefore: 100, taskOffset: null, loading: false, entries: [{ id: 't:old', at: 50, kind: 'butler', node: { id: 't:old', isConnected: true } }] }
    const reproInner = makeInner()
    reproInner.appendChild({ id: 't:old' })
    const reproApi: FixtureApi = {
      transcript: async () => ({ items: [7, 8, 9, 10].map(seq => ({ seq, role: 'user' as const, text: `第${seq}句`, time: seq * 10 })), prevBefore: null }),
      history: async () => ({ items: [], nextOffset: null }),
    }
    await build(reproState, repro, reproApi, () => {}, reproInner)()
    expect(reproInner.children.map(node => node.id)).toEqual(['t:old', 't:7', 't:8', 't:9', 't:10'])

    // 旧回包到达时视图已切走：不渲染、不推进游标。
    const staleState = { viewToken: 7 }
    const stale = { conversationId: 'conv-2', transcriptBefore: 99, taskOffset: 60, loading: false, entries: [] as HistoryFixture['entries'] }
    const staleApi = {
      transcript: async () => { staleState.viewToken = 8; return { items: [{ seq: 1, role: 'user', text: '过期', time: 1 }], prevBefore: 1 } },
      history: async () => ({ items: [], nextOffset: 50 }),
    }
    const staleRender: unknown[] = []
    await build(staleState, stale, staleApi, entry => { staleRender.push(entry) })()
    expect(staleRender).toHaveLength(0)
    expect(stale.transcriptBefore).toBe(99)
    expect(stale.taskOffset).toBe(60)
  })

  it('同刻条目按数值序号排序，任务排同刻对话之后；初次加载与分页共用规则（复核 2）', () => {
    const merge = Function(`${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\nreturn mergeHistoryEntries`)() as
      (transcript: unknown[], tasks: unknown[]) => { id: string; at: number }[]
    const planInsertion = Function(`${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\n${pick('planHistoryInsertion')}\nreturn planHistoryInsertion`)() as
      (existing: { id: string; at: number }[], fresh: { id: string; at: number }[]) => { merged: { id: string }[] }
    // 同一时刻的对话按 seq 数值排：t:2 在 t:10 前（字符串比较会倒置）。
    const sameTime = merge(
      [{ seq: 10, role: 'butler', text: '十', time: 5 }, { seq: 2, role: 'user', text: '二', time: 5 }, { seq: 1, role: 'user', text: '一', time: 5 }],
      [],
    )
    expect(sameTime.map(entry => entry.id)).toEqual(['t:1', 't:2', 't:10'])
    // 任务锚定收尾时刻，同刻排在对话之后。
    const withTask = merge([{ seq: 4, role: 'user', text: 'x', time: 9 }], [{ id: 'same-at', updatedAt: 9, createdAt: 9 }])
    expect(withTask.map(entry => entry.id)).toEqual(['t:4', 'task:same-at'])
    // 分页合并走同一套比较规则。
    const paged = planInsertion(
      [{ id: 't:1', at: 5 }],
      merge([{ seq: 10, role: 'user', text: '十', time: 5 }, { seq: 2, role: 'user', text: '二', time: 5 }], []),
    )
    expect(paged.merged.map(entry => entry.id)).toEqual(['t:1', 't:2', 't:10'])
  })

  it('旧分页请求的结束不解除新请求的加载锁（复核 3）', async () => {
    const state = { viewToken: 1 }
    const historyState = { conversationId: 'conv-a', transcriptBefore: 50, taskOffset: null, loading: false, entries: [] }
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const api = {
      transcript: async () => {
        await gate
        // A 的回包到达前，用户已切到 B：B 重置了共享状态并自己发起加载（loading=true）。
        historyState.conversationId = 'conv-b'
        historyState.loading = true
        state.viewToken = 2
        return { items: [], prevBefore: null }
      },
      history: async () => ({ items: [], nextOffset: null }),
    }
    const noop = () => {}
    const inner = { querySelector: () => null, insertBefore: noop, appendChild: noop }
    const loadA = Function(
      'state', 'historyState', 'api', 'updateLoadEarlier', 'threadInner', 'stabilizeViewport',
      'createHistoryNode', 'planHistoryInsertion', 'TRANSCRIPT_PAGE_SIZE',
      `${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\n${pick('planHistoryInsertion')}\n${pick('loadEarlier')} return loadEarlier`,
    )(state, historyState, api, noop, () => inner, (mutate: () => void) => { mutate() },
      () => ({ isConnected: true }),
      Function(`${pick('timeOf')}\n${pick('compareHistoryEntries')}\n${pick('mergeHistoryEntries')}\n${pick('planHistoryInsertion')}\nreturn planHistoryInsertion`)(), 50) as
      () => Promise<void>
    const pending = loadA()
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(historyState.loading).toBe(true)
    release!()
    await pending
    // A 的结束不碰 B 的加载状态，也不写 B 的游标与序列。
    expect(historyState.loading).toBe(true)
    expect(historyState.conversationId).toBe('conv-b')
    expect(historyState.transcriptBefore).toBe(50)
    expect(historyState.entries).toEqual([])
  })
})
