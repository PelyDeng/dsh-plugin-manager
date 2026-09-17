import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { BlogStore, ownerKey } from '../src/store.mjs'
import { ChatStore } from '../src/chat-store.ts'
import { createBlogParticipant } from '../src/participant.ts'
import { chatConversationTarget } from '../web/chat.js'
import { renderMarkdown } from '../web/markdown.js'

const actor = Object.freeze({ namespace: 'user', userId: 'writer', sessionId: 'login-a' })

async function fixture(t) {
  const store = new BlogStore(':memory:'); await store.init(); const index = new ChatStore(':memory:')
  t.after(() => store.close())
  const f = { store, index, denied: false, auto: true, runs: 0, stops: 0, creates: 0, listeners: new Set(), messages: new Map(), active: new Map(), operations: [] }
  f.access = { assert(current) { assert.equal(current.namespace, 'user'); if (f.denied) throw new Error('登录或授权已失效') } }
  f.emit = id => { for (const listener of [...f.listeners]) if (listener.id === id) listener.send({ type: 'changed' }) }
  f.complete = (id, text = '本轮可显示的博客回答', status = 'succeeded') => {
    const turn = f.active.get(id)
    assert.ok(turn)
    f.messages.get(id).push({ id: 'answer-' + turn.id, role: 'assistant', text, reasoning: 'PRIVATE_REASONING' })
    index.updateRequest(turn.id, { status }); f.active.delete(id); f.emit(id)
  }
  f.chat = {
    index,
    create(current, id) { f.access.assert(current); f.creates++; return index.create(ownerKey(current), id) },
    async send(current, args) {
      f.access.assert(current)
      if (f.sendGate) await f.sendGate
      const owner = ownerKey(current)
      const { request, fresh } = index.start(owner, args.conversationId, args.requestId, { text: args.text.trim(), research: args.research, attachments: args.attachments })
      if (fresh) {
        f.runs++; f.active.set(args.conversationId, request)
        const messages = f.messages.get(args.conversationId) ?? []
        messages.push({ id: 'user-' + request.id, role: 'user', requestId: request.id, text: args.text })
        f.messages.set(args.conversationId, messages)
        index.updateRequest(request.id, { status: 'running' })
        if (f.auto) queueMicrotask(() => f.complete(args.conversationId))
      }
      return { id: request.id, conversationId: args.conversationId }
    },
    subscribe(current, id, send, end) {
      f.access.assert(current); index.get(ownerKey(current), id)
      const listener = { id, send(value) {
        try { f.access.assert(current); index.get(ownerKey(current), id); send(value) }
        catch { f.listeners.delete(listener); end() }
      } }
      f.listeners.add(listener)
      return () => f.listeners.delete(listener)
    },
    async history(current, id) {
      f.access.assert(current); index.get(ownerKey(current), id)
      // 收尾投影（`createBlogProjector`）读的是**业务库**的 `app.operations(owner)`，并按
      // `operation.chat.conversationId` 筛出本会话 —— 真实现（`application.mjs` 的操作卡片）
      // 本来就带这个字段。这里记下当前会话 id，供下面的 `app.operations` 替身补上。
      f.lastHistoryId = id
      f.historyEntered?.()
      if (f.historyGate) await f.historyGate
      return { messages: f.messages.get(id) ?? [], requests: index.requests(ownerKey(current), id),
        operations: f.operations, results: index.results(ownerKey(current), id), live: { reasoning: 'PRIVATE_LIVE_REASONING' } }
    },
    async stop(current, id) {
      f.access.assert(current); index.get(ownerKey(current), id)
      const turn = f.active.get(id)
      if (turn) { f.stops++; index.updateRequest(turn.id, { status: 'interrupted' }); f.active.delete(id); f.emit(id) }
      return { stopped: true }
    },
    async settleAccepted(current, id, requestId) {
      const turn = f.active.get(id)
      if (turn?.owner === ownerKey(current) && turn.id === requestId) {
        f.stops++; index.updateRequest(turn.id, { status: 'interrupted' }); f.active.delete(id); f.emit(id)
      }
    },
  }
  f.provider = (routePrefix = '/blog') => createBlogParticipant({
    access: f.access, chat: f.chat, index, storage: store, routePrefix,
    /**
     * 业务应用的最小替身：收尾投影只用到 `operations(owner)`。
     *
     * ⚠️ 真实现的记录**带 `chat.conversationId`**（`application.mjs` 的操作卡片就是这样，生产侧
     * `chat.mjs` 也按它筛会话）⇒ 夹具在这里补上；漏了它会以"本该 external_pending 却报
     * completed"的形式红，而那是**夹具失真**，不是实现错。
     */
    app: { operations: async () => f.operations.map(operation => ({ ...operation, chat: operation.chat ?? { conversationId: f.lastHistoryId } })) },
  })
  return f
}

function input(overrides = {}) {
  return { actor, missionId: 'mission-a', requestId: 'request-a', message: '分析允许共享的资料', signal: new AbortController().signal, onProgress() {}, ...overrides }
}

test('reuses a durable mission conversation and original request idempotency without replaying another turn', async t => {
  const f = await fixture(t), progress = [], provider = f.provider()
  const first = await provider.run(input({ onProgress: value => progress.push(value) }))
  assert.equal(first.status, 'completed'); assert.equal(first.text, '本轮可显示的博客回答')
  assert.ok(progress.every(value => value.conversationId === first.conversationId))
  await provider.run(input({ requestId: 'request-b', conversationId: first.conversationId, message: '再说明来源' }))
  const replay = await f.provider().run(input({ conversationId: first.conversationId }))
  assert.equal(replay.text, first.text); assert.equal(f.runs, 2); assert.equal(f.creates, 1)
  assert.equal(f.listeners.size, 0)
  await assert.rejects(provider.run(input({ message: '改变同一请求内容' })), /不能更改/)
  assert.equal(f.runs, 2)
})

test('successful retries return only committed answers for completed and external_pending results', async t => {
  for (const expected of ['completed', 'external_pending']) await t.test(expected, async t => {
    const f = await fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const id = [...f.active.keys()][0]
    f.messages.get(id).push({ id: 'attempt-1', role: 'assistant', text: '废弃尝试内容', interrupted: true, reasoning: 'PRIVATE_ATTEMPT_REASONING' })
    if (expected === 'external_pending') f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE' }]
    f.complete(id, '已提交的最终回答')
    const result = await running
    assert.equal(result.status, expected)
    assert.ok(result.text.startsWith('已提交的最终回答'))
    assert.doesNotMatch(JSON.stringify(result), /废弃尝试内容|PRIVATE_|reasoning|nonce/)
    if (expected === 'completed') {
      assert.equal(result.text, '已提交的最终回答')
      // 没有外部待办时不能凭空给一份声明 —— 那会让上游把这一轮当成「还没办完」。
      assert.equal(result.externalPending, undefined)
    } else {
      assert.match(result.text, /没有执行发布/)
      // 判定来源是结构化声明，不是正文措辞：上游只认这个字段。
      assert.equal(typeof result.externalPending?.reason, 'string')
      assert.ok(result.externalPending.reason.length > 0)
    }
  })
})

test('failed and cancelled results retain interrupted text with an unfinished notice despite pending confirmation', async t => {
  for (const expected of ['failed', 'cancelled']) await t.test(expected, async t => {
    const f = await fixture(t), controller = new AbortController(); f.auto = false
    const running = f.provider().run(input({ signal: controller.signal }))
    await tick()
    const id = [...f.active.keys()][0]
    f.messages.get(id).push({ id: 'attempt-1', role: 'assistant', text: '尚未完成的回答片段', interrupted: true, reasoning: 'PRIVATE_ATTEMPT_REASONING' })
    f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE' }]
    const owner = ownerKey(actor), turn = f.active.get(id), draft = await f.store.create(owner)
    await f.store.propose(owner, draft.id, draft.revision, { title: '本轮留存候选', text: '尚需复核的候选正文' }, [])
    f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
    if (expected === 'cancelled') controller.abort()
    else f.complete(id, '', 'interrupted')
    const result = await running
    assert.equal(result.status, expected)
    assert.match(result.text, /尚未完成的回答片段/)
    assert.match(result.text, expected === 'failed' ? /博客本轮未完成/ : /本轮已停止/)
    assert.match(result.text, /没有执行发布/)
    assert.match(result.text, /本轮留存候选/)
    assert.match(result.text, /尚需复核的候选正文/)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|reasoning|nonce/)
  })
})

test('rejects arbitrary user conversations, cross-mission references and other owners before sending', async t => {
  const f = await fixture(t), provider = f.provider()
  const unrelated = f.chat.create(actor, 'ordinary-conversation')
  await assert.rejects(provider.run(input({ conversationId: unrelated.id })), /不属于当前协作任务/)
  assert.equal(f.runs, 0)
  const first = await provider.run(input())
  await assert.rejects(provider.run(input({ missionId: 'mission-b', conversationId: first.conversationId })), /不属于当前协作任务/)
  await assert.rejects(provider.run(input({ actor: { ...actor, userId: 'other-user' }, conversationId: first.conversationId })), /不属于当前协作任务/)
  assert.equal(f.runs, 1)
})

test('pre-aborted requests create no conversation and install no subscription', async t => {
  const f = await fixture(t), controller = new AbortController(), progress = []; controller.abort()
  await assert.rejects(f.provider().run(input({ signal: controller.signal, onProgress: value => progress.push(value) })), { name: 'AbortError' })
  assert.equal(f.creates, 0); assert.equal(f.runs, 0); assert.equal(f.listeners.size, 0)
  assert.deepEqual(progress, [])
})

test('emits one bound native conversation link before sending and preserves its final artifact', async t => {
  const f = await fixture(t), progress = []; f.auto = false
  const running = f.provider('/native-blog/').run(input({ onProgress: value => {
    f.index.get(ownerKey(actor), value.conversationId)
    progress.push({ value, runs: f.runs })
  } }))
  await tick()
  const id = [...f.active.keys()][0]
  f.complete(id)
  const result = await running
  const artifact = { kind: 'conversation', title: '查看博客原对话', path: '/native-blog?conversationId=' + encodeURIComponent(id) }
  assert.deepEqual(progress[0], { value: { kind: 'status', text: '博客会话已连接', conversationId: id, conversationArtifact: artifact }, runs: 0 })
  assert.equal(progress.filter(entry => entry.value.conversationArtifact).length, 1)
  assert.ok(progress.length > 1)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.artifacts, [artifact])
})

test('过程按思考上报：完整覆盖，换段整段追加且不重复', async t => {
  const f = await fixture(t); f.auto = false
  const progress = []
  const running = f.provider().run(input({ onProgress: value => progress.push(value) }))
  await tick()
  const id = [...f.active.keys()][0]
  // 通道只在分片到达时发事件，累积值就是本步到目前的完整正文（见 chat.mjs 的 agent/assistant-stream 订阅）。
  const live = value => { for (const listener of [...f.listeners]) if (listener.id === id) listener.send({ type: 'live', live: value }) }
  live({ text: '先看资料。', reasoning: 'PRIVATE_LIVE_REASONING' })
  live({ text: '先看资料。再核对来源。', reasoning: 'PRIVATE_LIVE_REASONING' })
  // 下一步重新累积：它不以已发布内容开头，整段追加；过程里不该丢掉这一段的开头。
  live({ text: '结论是甲稿更完整。', reasoning: 'PRIVATE_LIVE_REASONING' })
  live({ text: '结论是甲稿更完整。建议先改标题。', reasoning: 'PRIVATE_LIVE_REASONING' })
  f.complete(id, '结论是甲稿更完整。建议先改标题。')
  const result = await running
  const shots = progress.filter(value => value.kind === 'thinking').map(value => value.thinking)
  assert.equal(result.status, 'completed')
  // 思考是**完整覆盖**语义：每条都是到目前为止的全量，页面直接替换整行。
  assert.deepEqual(shots, [
    '先看资料。',
    '先看资料。再核对来源。',
    '先看资料。再核对来源。结论是甲稿更完整。',
    '先看资料。再核对来源。结论是甲稿更完整。建议先改标题。',
  ])
  // 过程不再按正文发：一旦当正文，气泡里就全是「让我先看看…」，真正的答案被埋在最后。
  assert.equal(progress.filter(value => value.kind === 'delta').length, 0)
  assert.ok(progress.filter(value => value.kind === 'thinking').every(value => value.conversationId === undefined))
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_LIVE_REASONING/)
})

test('只带推理的分片把正文基准归零，下一步的叙述整段保留', async t => {
  const f = await fixture(t); f.auto = false
  const progress = []
  const running = f.provider().run(input({ onProgress: value => progress.push(value) }))
  await tick()
  const id = [...f.active.keys()][0]
  const live = value => { for (const listener of [...f.listeners]) if (listener.id === id) listener.send({ type: 'live', live: value }) }
  live({ text: '今天共有 ', reasoning: '' })
  // 下一条只带推理：正文是空的，说明这一步的正文还没开始，基准跟着归零。
  live({ text: '', reasoning: '换一步再看。' })
  live({ text: '今天共有 12 辆车入园。', reasoning: '换一步再看。' })
  f.complete(id, '今天共有 12 辆车入园。')
  await running
  const shots = progress.filter(value => value.kind === 'thinking').map(value => value.thinking)
  // 归零后这一步整段进快照；没有归零的话它会被当成「只多了后半段」，展开时开头就缺了。
  assert.deepEqual(shots, ['今天共有 ', '今天共有 今天共有 12 辆车入园。'])
})

test('交回的正文只取该回合最后一条，过程叙述不拼进材料', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input({ onProgress: () => {} }))
  await tick()
  const id = [...f.active.keys()][0]
  const turn = f.active.get(id)
  // 真机上一轮的形态：每一步的正文后面都跟着一次工具调用（「让我先看看…」），
  // 只有最后一条是答案。实测 7 条消息里 6 条是过程叙述，1 条 3890 字才是答案。
  f.messages.set(id, [
    { id: 'user-1', role: 'user', requestId: turn.id, text: 'DSH 插件接入要准备哪些声明文件？' },
    { id: 'step-1', role: 'assistant', text: '让我先探索代码仓库中的插件相关代码和文档。' },
    { id: 'tool-1', role: 'tool', name: 'blog_search_posts' },
    { id: 'step-2', role: 'assistant', text: '找到了相关文章！让我读取这篇关于 DSH 插件开发框架的文章：' },
    { id: 'tool-2', role: 'tool', name: 'blog_read_post' },
    { id: 'answer', role: 'assistant', text: '## 声明文件清单\n\n- `package.json`\n- `plugin.json`', tail: true },
  ])
  f.index.updateRequest(turn.id, { status: 'succeeded' }); f.active.delete(id); f.emit(id)
  const result = await running
  assert.equal(result.status, 'completed')
  assert.equal(result.text, '## 声明文件清单\n\n- `package.json`\n- `plugin.json`')
  assert.doesNotMatch(result.text, /让我先探索|让我读取/)
})

test('没有 tail（本轮没跑完）时保留全部已生成内容，不丢东西', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input({ onProgress: () => {} }))
  await tick()
  const id = [...f.active.keys()][0]
  const turn = f.active.get(id)
  f.messages.set(id, [
    { id: 'user-1', role: 'user', requestId: turn.id, text: '写一篇园区安全博客' },
    { id: 'step-1', role: 'assistant', text: '先看资料。' },
    { id: 'step-2', role: 'assistant', text: '还没写完的回答片段' },
  ])
  f.index.updateRequest(turn.id, { status: 'interrupted' }); f.active.delete(id); f.emit(id)
  const result = await running
  assert.equal(result.status, 'failed')
  assert.match(result.text, /先看资料。/)
  assert.match(result.text, /还没写完的回答片段/)
})

test('cancel or revoke before initial progress emits no conversation link or request', async t => {
  for (const action of ['cancel', 'revoke']) {
    const f = await fixture(t), controller = new AbortController(), progress = []
    const subscribe = f.chat.subscribe
    f.chat.subscribe = (...args) => {
      const unsubscribe = subscribe(...args)
      if (action === 'cancel') controller.abort()
      else f.denied = true
      return unsubscribe
    }
    await assert.rejects(f.provider().run(input({ signal: controller.signal, onProgress: value => progress.push(value) })),
      action === 'cancel' ? { name: 'AbortError' } : /登录或授权已失效/)
    assert.deepEqual(progress, [])
    assert.equal(f.runs, 0); assert.equal(f.listeners.size, 0)
  }
})

test('cancel or revoke in the initial link callback cannot start a blog turn', async t => {
  for (const action of ['cancel', 'revoke']) {
    const f = await fixture(t), controller = new AbortController(), progress = []
    await assert.rejects(f.provider().run(input({ signal: controller.signal, onProgress(value) {
      progress.push(value)
      if (action === 'cancel') controller.abort()
      else f.denied = true
    } })), action === 'cancel' ? { name: 'AbortError' } : /登录或授权已失效/)
    assert.equal(progress.length, 1)
    assert.equal(progress[0].conversationArtifact.kind, 'conversation')
    assert.equal(f.runs, 0); assert.equal(f.stops, 0); assert.equal(f.listeners.size, 0)
  }
})

test('aborting during send preparation stops the accepted turn and cleans its subscription', async t => {
  const f = await fixture(t), controller = new AbortController(); f.auto = false
  let release; f.sendGate = new Promise(resolve => { release = resolve })
  const running = f.provider().run(input({ signal: controller.signal }))
  await tick(); controller.abort(); release()
  const result = await running
  assert.equal(result.status, 'cancelled'); assert.equal(f.stops, 1); assert.equal(f.active.size, 0); assert.equal(f.listeners.size, 0)
})

test('aborting from a running progress callback does not lose its completion notification', async t => {
  const f = await fixture(t), controller = new AbortController(); f.auto = false
  const result = await f.provider().run(input({ signal: controller.signal, onProgress(value) {
    if (value.text === '博客正在整理资料与回答') controller.abort()
  } }))
  assert.equal(result.status, 'cancelled'); assert.equal(f.stops, 1); assert.equal(f.listeners.size, 0)
})

test('cancellation waits for an asynchronously settled job after stop has already returned', async t => {
  const f = await fixture(t), controller = new AbortController(); f.auto = false
  f.chat.stop = async (current, id) => {
    f.access.assert(current); f.index.get(ownerKey(current), id)
    const turn = f.active.get(id); f.stops++
    f.index.updateRequest(turn.id, { status: 'stopping' }); f.emit(id)
    setTimeout(() => {
      f.index.updateRequest(turn.id, { status: 'interrupted' }); f.active.delete(id); f.emit(id)
    }, 5)
    return { stopped: true }
  }
  const running = f.provider().run(input({ signal: controller.signal }))
  await tick(); controller.abort()
  const result = await running
  assert.equal(result.status, 'cancelled'); assert.equal(f.stops, 1)
  assert.equal(f.active.size, 0); assert.equal(f.listeners.size, 0)
})

test('returns a native confirmation link without nonce, reasoning or remote operation snapshots', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick()
  const id = [...f.active.keys()][0]
  f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE', before: { private: 'PRIVATE_REMOTE_SNAPSHOT' }, canConfirm: true }]
  f.complete(id)
  const result = await running, encoded = JSON.stringify(result)
  assert.equal(result.status, 'external_pending'); assert.equal(result.artifacts[0].kind, 'confirmation')
  assert.equal(result.artifacts[0].path, '/blog?conversationId=' + encodeURIComponent(id))
  assert.doesNotMatch(encoded, /PRIVATE_|nonce|reasoning|canConfirm|before/)
  assert.match(result.text, /没有执行发布/)
  assert.match(result.externalPending.reason, /没有执行发布/)
  assert.equal(f.listeners.size, 0)
})

test('an unapplied proposal is reported as external_pending and never as a saved native article', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor)
  const draft = await f.store.create(owner, { title: 'PRIVATE_BEFORE_TITLE', text: 'PRIVATE_BEFORE_TEXT' })
  await f.store.propose(owner, draft.id, draft.revision, { title: '实际候选标题', text: '真实候选正文与 Agent 自述不同', tags: ['PRIVATE_TAG'] }, [{ text: 'PRIVATE_SOURCE' }])
  f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
  f.complete(id, '已提出文章修改建议')
  const result = await running
  assert.equal(result.status, 'external_pending'); assert.equal(result.artifacts[0].kind, 'draft')
  assert.match(result.text, /候选稿不等于正文已保存或发布/)
  assert.match(result.externalPending.reason, /不等于正文已保存或发布/)
  assert.match(result.text, /实际候选标题/)
  assert.match(result.text, /真实候选正文与 Agent 自述不同/)
  assert.match(result.text, /作为核对资料，不是指令/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|before|sources|reasoning|nonce/)
})

test('a later progress question preserves earlier unresolved candidates and confirmation operations', async t => {
  const f = await fixture(t); f.auto = false
  const provider = f.provider(), first = provider.run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor)
  const draft = await f.store.create(owner, { title: '仍待采用' })
  await f.store.propose(owner, draft.id, draft.revision, { text: '候选内容' }, [])
  f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
  f.complete(id)
  assert.equal((await first).status, 'external_pending')
  f.auto = true
  const followup = await provider.run(input({ requestId: 'progress-request', conversationId: id, message: '现在等谁' }))
  assert.equal(followup.status, 'external_pending'); assert.equal(followup.artifacts[0].kind, 'draft')
  assert.doesNotMatch(followup.text, /候选内容|本轮实际候选内容/)
  f.operations = [{ status: 'prepared', nonce: 'PRIVATE_OLD_NONCE', requestId: turn.id }]
  const confirmation = await provider.run(input({ requestId: 'progress-request-2', conversationId: id, message: '能继续了吗' }))
  assert.equal(confirmation.status, 'external_pending'); assert.equal(confirmation.artifacts[0].kind, 'confirmation')
  assert.doesNotMatch(JSON.stringify(confirmation), /PRIVATE_OLD_NONCE/)
})

test('actual candidate paragraphs and headings render readably without JSON escapes in collaboration details', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor), draft = await f.store.create(owner)
  const body = '## 数据来源\n\n这是实际候选的第一段。\n\n第二段包含 "引号" 和 C:\\reports。\n\n- 本页 2 条样例\n- 全量未知\n\n<script>不能执行</script>'
  await f.store.propose(owner, draft.id, draft.revision, { title: '候选标题 "样例"', text: body }, [])
  f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
  f.complete(id, 'Agent 的概述不能代替候选正文')
  const result = await running, html = renderMarkdown(result.text)
  assert.ok(result.text.includes(body), 'candidate body must remain complete and unmodified')
  assert.match(html, /<h3>候选 1 · 待采用<\/h3>/)
  assert.match(html, /<h2>数据来源<\/h2>/)
  assert.match(html, /<p>这是实际候选的第一段。<\/p>/)
  assert.match(html, /<li>本页 2 条样例<\/li>/)
  assert.match(html, /&lt;script&gt;不能执行&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script|\[\{&quot;title&quot;|\\n\\n##/)
  assert.equal(result.status, 'external_pending')
})

test('only the current unapplied candidate of the requested turn is forwarded', async t => {
  for (const action of ['replace', 'apply', 'discard']) await t.test(action, async t => {
    const f = await fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor), draft = await f.store.create(owner)
    const first = await f.store.propose(owner, draft.id, draft.revision, { text: '旧候选不应转交' }, [])
    f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
    if (action === 'replace') {
      await f.store.propose(owner, draft.id, draft.revision, { text: '同轮替换后的实际候选' }, [], first.id)
      f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
    } else if (action === 'apply') await f.store.applyProposal(owner, draft.id, draft.revision, first.id, ['text'])
    else await f.store.discardProposal(owner, draft.id, draft.revision, first.id)
    f.complete(id)
    const result = await running
    assert.doesNotMatch(result.text, /旧候选不应转交/)
    assert.equal(result.status, action === 'replace' ? 'external_pending' : 'completed')
    if (action === 'replace') assert.match(result.text, /同轮替换后的实际候选/)
    else assert.doesNotMatch(result.text, /本轮实际候选内容/)
  })
})

test('multiple current draft candidates are deduplicated and forwarded together or explicitly all omitted', async t => {
  for (const oversized of [false, true]) await t.test(oversized ? 'oversized list' : 'full list', async t => {
    const f = await fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor)
    const bodies = ['甲稿正文', oversized ? '乙稿正文'.repeat(20000) : '乙稿正文']
    for (const [i, body] of bodies.entries()) {
      const draft = await f.store.create(owner)
      await f.store.propose(owner, draft.id, draft.revision, { title: '候选标题' + i, text: body }, [])
      f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
      f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
    }
    f.complete(id)
    const result = await running
    assert.equal(result.status, 'external_pending')
    assert.ok(result.externalPending.reason.length > 0)
    assert.ok(result.text.length <= 64000)
    assert.equal(result.artifacts[0].path, '/blog?conversationId=' + encodeURIComponent(id))
    assert.match(result.text, /共 2 份/)
    if (oversized) {
      assert.match(result.text, new RegExp('候选正文共 ' + bodies.reduce((sum, body) => sum + body.length, 0) + ' 字符'))
      assert.match(result.text, /所有候选均未转交全文，不能宣称已完整复核任何一份候选/)
      assert.doesNotMatch(result.text, /甲稿正文|乙稿正文/)
    } else {
      for (const body of bodies) assert.equal(result.text.split(body).length - 1, 1)
      const html = renderMarkdown(result.text)
      assert.match(html, /<h3>候选 1 · 待采用<\/h3>/)
      assert.match(html, /<h3>候选 2 · 待采用<\/h3>/)
      assert.match(html, /候选 1 正文结束。/)
      assert.match(html, /候选 2 正文结束。/)
    }
  })
})

test('long responses preserve status and disclose omissions within the collaboration message limit', async t => {
  for (const [name, answer, body, fullCandidate, answerTruncated] of [
    ['long answer', '答'.repeat(70000), '短候选全文', true, true],
    ['candidate priority', '答'.repeat(5000), '始' + '文'.repeat(62998) + '终', true, true],
    ['long candidate', '公开回答', '候'.repeat(70000), false],
    ['literal backslashes fit without JSON expansion', '公开回答', '\\'.repeat(40000), true, false],
    ['no candidate', '答'.repeat(70000), null, false],
  ]) await t.test(name, async t => {
    const f = await fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor)
    if (body !== null) {
      const draft = await f.store.create(owner)
      await f.store.propose(owner, draft.id, draft.revision, { title: '需要核对的候选', text: body }, [])
      f.index.result(owner, turn, 'candidate', await f.store.get(owner, draft.id))
    }
    f.complete(id, answer)
    const result = await running
    assert.ok(result.text.length <= 64000, '转交正文不超过参与者自己的上限')
    assert.equal(result.status, body === null ? 'completed' : 'external_pending')
    assert.equal(result.artifacts[0].path, '/blog?conversationId=' + encodeURIComponent(id))
    if (fullCandidate) {
      assert.ok(result.text.includes(body), 'actual candidate must be forwarded in full')
      if (answerTruncated) assert.match(result.text, /公开回答原长 .* 字符.*已省略后文/)
      else assert.doesNotMatch(result.text, /公开回答原长|所有候选均未转交全文/)
    } else if (body !== null) {
      assert.match(result.text, new RegExp('候选正文共 ' + body.length + ' 字符'))
      assert.match(result.text, /未转交全文，不能宣称已完整复核/)
      assert.ok(!result.text.includes(body.slice(0, 20)), 'do not silently pass a candidate fragment')
    } else assert.match(result.text, /公开回答原长 70000 字符.*已省略后文/)
  })
})

test('revocation during result read fails closed and removes the subscription', async t => {
  const f = await fixture(t)
  let release, entered
  f.historyGate = new Promise(resolve => { release = resolve })
  const reading = new Promise(resolve => { entered = resolve }); f.historyEntered = entered
  const running = f.provider().run(input())
  await reading; f.denied = true; release()
  await assert.rejects(running, /登录或授权已失效/)
  assert.equal(f.listeners.size, 0)
})

test('subscription revocation while running rejects instead of leaking a later answer', async t => {
  const f = await fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick(); f.denied = true; f.emit([...f.active.keys()][0])
  await assert.rejects(running, /登录或授权已失效/)
  assert.equal(f.active.size, 0)
  assert.equal(f.listeners.size, 0)
})

test('native chat deep links select the requested conversation over a previous local conversation', () => {
  const path = '/blog?conversationId=' + encodeURIComponent('blog-chat-owned-id')
  assert.equal(chatConversationTarget(new URL(path, 'https://example.invalid').search, 'previous-chat'), 'blog-chat-owned-id')
  assert.equal(chatConversationTarget('', 'previous-chat'), 'previous-chat')
  assert.equal(chatConversationTarget(''), null)
  // 选择标识不授予访问权；非法和他人标识仍交给 activate 的原 HTTP 归属检查。
  assert.equal(chatConversationTarget('?conversationId=unowned-id'), 'unowned-id')
})
