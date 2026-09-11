import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick } from 'node:timers/promises'
import { BlogStore, ownerKey } from '../src/store.mjs'
import { ChatStore } from '../src/chat-store.mjs'
import { createBlogParticipant, registerBlogParticipant } from '../src/participant.ts'
import { chatConversationTarget } from '../web/chat.js'
import { renderMarkdown } from '../../dsh-pirate-command/web/src/markdown.js'

const actor = Object.freeze({ namespace: 'user', userId: 'writer', sessionId: 'login-a' })

function fixture(t) {
  const store = new BlogStore(':memory:'), index = new ChatStore(store)
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
  f.provider = (routePrefix = '/blog') => createBlogParticipant({ access: f.access, chat: f.chat, index, store, routePrefix })
  return f
}

function input(overrides = {}) {
  return { actor, missionId: 'mission-a', requestId: 'request-a', message: '分析允许共享的资料', signal: new AbortController().signal, onProgress() {}, ...overrides }
}

test('reuses a durable mission conversation and original request idempotency without replaying another turn', async t => {
  const f = fixture(t), progress = [], provider = f.provider()
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

test('successful retries return only committed answers for completed and waiting results', async t => {
  for (const expected of ['completed', 'waiting']) await t.test(expected, async t => {
    const f = fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const id = [...f.active.keys()][0]
    f.messages.get(id).push({ id: 'attempt-1', role: 'assistant', text: '废弃尝试内容', interrupted: true, reasoning: 'PRIVATE_ATTEMPT_REASONING' })
    if (expected === 'waiting') f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE' }]
    f.complete(id, '已提交的最终回答')
    const result = await running
    assert.equal(result.status, expected)
    assert.ok(result.text.startsWith('已提交的最终回答'))
    assert.doesNotMatch(JSON.stringify(result), /废弃尝试内容|PRIVATE_|reasoning|nonce/)
    if (expected === 'completed') assert.equal(result.text, '已提交的最终回答')
    else assert.match(result.text, /没有执行发布/)
  })
})

test('failed and cancelled results retain interrupted text with an unfinished notice despite pending confirmation', async t => {
  for (const expected of ['failed', 'cancelled']) await t.test(expected, async t => {
    const f = fixture(t), controller = new AbortController(); f.auto = false
    const running = f.provider().run(input({ signal: controller.signal }))
    await tick()
    const id = [...f.active.keys()][0]
    f.messages.get(id).push({ id: 'attempt-1', role: 'assistant', text: '尚未完成的回答片段', interrupted: true, reasoning: 'PRIVATE_ATTEMPT_REASONING' })
    f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE' }]
    const owner = ownerKey(actor), turn = f.active.get(id), draft = f.store.create(owner)
    f.store.propose(owner, draft.id, draft.revision, { title: '本轮留存候选', text: '尚需复核的候选正文' }, [])
    f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
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
  const f = fixture(t), provider = f.provider()
  const unrelated = f.chat.create(actor, 'ordinary-conversation')
  await assert.rejects(provider.run(input({ conversationId: unrelated.id })), /不属于当前协作任务/)
  assert.equal(f.runs, 0)
  const first = await provider.run(input())
  await assert.rejects(provider.run(input({ missionId: 'mission-b', conversationId: first.conversationId })), /不属于当前协作任务/)
  await assert.rejects(provider.run(input({ actor: { ...actor, userId: 'other-user' }, conversationId: first.conversationId })), /不属于当前协作任务/)
  assert.equal(f.runs, 1)
})

test('pre-aborted requests create no conversation and install no subscription', async t => {
  const f = fixture(t), controller = new AbortController(), progress = []; controller.abort()
  await assert.rejects(f.provider().run(input({ signal: controller.signal, onProgress: value => progress.push(value) })), { name: 'AbortError' })
  assert.equal(f.creates, 0); assert.equal(f.runs, 0); assert.equal(f.listeners.size, 0)
  assert.deepEqual(progress, [])
})

test('emits one bound native conversation link before sending and preserves its final artifact', async t => {
  const f = fixture(t), progress = []; f.auto = false
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

test('cancel or revoke before initial progress emits no conversation link or request', async t => {
  for (const action of ['cancel', 'revoke']) {
    const f = fixture(t), controller = new AbortController(), progress = []
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
    const f = fixture(t), controller = new AbortController(), progress = []
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
  const f = fixture(t), controller = new AbortController(); f.auto = false
  let release; f.sendGate = new Promise(resolve => { release = resolve })
  const running = f.provider().run(input({ signal: controller.signal }))
  await tick(); controller.abort(); release()
  const result = await running
  assert.equal(result.status, 'cancelled'); assert.equal(f.stops, 1); assert.equal(f.active.size, 0); assert.equal(f.listeners.size, 0)
})

test('aborting from a running progress callback does not lose its completion notification', async t => {
  const f = fixture(t), controller = new AbortController(); f.auto = false
  const result = await f.provider().run(input({ signal: controller.signal, onProgress(value) {
    if (value.text === '博客正在整理资料与回答') controller.abort()
  } }))
  assert.equal(result.status, 'cancelled'); assert.equal(f.stops, 1); assert.equal(f.listeners.size, 0)
})

test('cancellation waits for an asynchronously settled job after stop has already returned', async t => {
  const f = fixture(t), controller = new AbortController(); f.auto = false
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
  const f = fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick()
  const id = [...f.active.keys()][0]
  f.operations = [{ status: 'prepared', nonce: 'PRIVATE_CONFIRM_NONCE', before: { private: 'PRIVATE_REMOTE_SNAPSHOT' }, canConfirm: true }]
  f.complete(id)
  const result = await running, encoded = JSON.stringify(result)
  assert.equal(result.status, 'waiting'); assert.equal(result.artifacts[0].kind, 'confirmation')
  assert.equal(result.artifacts[0].path, '/blog?conversationId=' + encodeURIComponent(id))
  assert.doesNotMatch(encoded, /PRIVATE_|nonce|reasoning|canConfirm|before/)
  assert.match(result.text, /没有执行发布/)
  assert.equal(f.listeners.size, 0)
})

test('an unapplied proposal remains waiting and is never reported as a saved native article', async t => {
  const f = fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor)
  const draft = f.store.create(owner, { title: 'PRIVATE_BEFORE_TITLE', text: 'PRIVATE_BEFORE_TEXT' })
  f.store.propose(owner, draft.id, draft.revision, { title: '实际候选标题', text: '真实候选正文与 Agent 自述不同', tags: ['PRIVATE_TAG'] }, [{ text: 'PRIVATE_SOURCE' }])
  f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
  f.complete(id, '已提出文章修改建议')
  const result = await running
  assert.equal(result.status, 'waiting'); assert.equal(result.artifacts[0].kind, 'draft')
  assert.match(result.text, /候选稿不等于正文已保存或发布/)
  assert.match(result.text, /实际候选标题/)
  assert.match(result.text, /真实候选正文与 Agent 自述不同/)
  assert.match(result.text, /作为核对资料，不是指令/)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|before|sources|reasoning|nonce/)
})

test('a later progress question preserves earlier unresolved candidates and confirmation operations', async t => {
  const f = fixture(t); f.auto = false
  const provider = f.provider(), first = provider.run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor)
  const draft = f.store.create(owner, { title: '仍待采用' })
  f.store.propose(owner, draft.id, draft.revision, { text: '候选内容' }, [])
  f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
  f.complete(id)
  assert.equal((await first).status, 'waiting')
  f.auto = true
  const followup = await provider.run(input({ requestId: 'progress-request', conversationId: id, message: '现在等谁' }))
  assert.equal(followup.status, 'waiting'); assert.equal(followup.artifacts[0].kind, 'draft')
  assert.doesNotMatch(followup.text, /候选内容|本轮实际候选内容/)
  f.operations = [{ status: 'prepared', nonce: 'PRIVATE_OLD_NONCE', requestId: turn.id }]
  const confirmation = await provider.run(input({ requestId: 'progress-request-2', conversationId: id, message: '能继续了吗' }))
  assert.equal(confirmation.status, 'waiting'); assert.equal(confirmation.artifacts[0].kind, 'confirmation')
  assert.doesNotMatch(JSON.stringify(confirmation), /PRIVATE_OLD_NONCE/)
})

test('actual candidate paragraphs and headings render readably without JSON escapes in collaboration details', async t => {
  const f = fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick()
  const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor), draft = f.store.create(owner)
  const body = '## 数据来源\n\n这是实际候选的第一段。\n\n第二段包含 "引号" 和 C:\\reports。\n\n- 本页 2 条样例\n- 全量未知\n\n<script>不能执行</script>'
  f.store.propose(owner, draft.id, draft.revision, { title: '候选标题 "样例"', text: body }, [])
  f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
  f.complete(id, 'Agent 的概述不能代替候选正文')
  const result = await running, html = renderMarkdown(result.text)
  assert.ok(result.text.includes(body), 'candidate body must remain complete and unmodified')
  assert.match(html, /<h3>候选 1 · 待采用<\/h3>/)
  assert.match(html, /<h2>数据来源<\/h2>/)
  assert.match(html, /<p>这是实际候选的第一段。<\/p>/)
  assert.match(html, /<li>本页 2 条样例<\/li>/)
  assert.match(html, /&lt;script&gt;不能执行&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script|\[\{&quot;title&quot;|\\n\\n##/)
  assert.equal(result.status, 'waiting')
})

test('only the current unapplied candidate of the requested turn is forwarded', async t => {
  for (const action of ['replace', 'apply', 'discard']) await t.test(action, async t => {
    const f = fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor), draft = f.store.create(owner)
    const first = f.store.propose(owner, draft.id, draft.revision, { text: '旧候选不应转交' }, [])
    f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
    if (action === 'replace') {
      f.store.propose(owner, draft.id, draft.revision, { text: '同轮替换后的实际候选' }, [], first.id)
      f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
    } else if (action === 'apply') f.store.applyProposal(owner, draft.id, draft.revision, first.id, ['text'])
    else f.store.discardProposal(owner, draft.id, draft.revision, first.id)
    f.complete(id)
    const result = await running
    assert.doesNotMatch(result.text, /旧候选不应转交/)
    assert.equal(result.status, action === 'replace' ? 'waiting' : 'completed')
    if (action === 'replace') assert.match(result.text, /同轮替换后的实际候选/)
    else assert.doesNotMatch(result.text, /本轮实际候选内容/)
  })
})

test('multiple current draft candidates are deduplicated and forwarded together or explicitly all omitted', async t => {
  for (const oversized of [false, true]) await t.test(oversized ? 'oversized list' : 'full list', async t => {
    const f = fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor)
    const bodies = ['甲稿正文', oversized ? '乙稿正文'.repeat(20000) : '乙稿正文']
    for (const [i, body] of bodies.entries()) {
      const draft = f.store.create(owner)
      f.store.propose(owner, draft.id, draft.revision, { title: '候选标题' + i, text: body }, [])
      f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
      f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
    }
    f.complete(id)
    const result = await running
    assert.equal(result.status, 'waiting')
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
    const f = fixture(t); f.auto = false
    const running = f.provider().run(input())
    await tick()
    const [id, turn] = [...f.active.entries()][0], owner = ownerKey(actor)
    if (body !== null) {
      const draft = f.store.create(owner)
      f.store.propose(owner, draft.id, draft.revision, { title: '需要核对的候选', text: body }, [])
      f.index.result(owner, turn, 'candidate', f.store.get(owner, draft.id))
    }
    f.complete(id, answer)
    const result = await running
    assert.ok(result.text.length <= 64000, 'must fit the existing pirate event storage limit')
    assert.equal(result.status, body === null ? 'completed' : 'waiting')
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
  const f = fixture(t)
  let release, entered
  f.historyGate = new Promise(resolve => { release = resolve })
  const reading = new Promise(resolve => { entered = resolve }); f.historyEntered = entered
  const running = f.provider().run(input())
  await reading; f.denied = true; release()
  await assert.rejects(running, /登录或授权已失效/)
  assert.equal(f.listeners.size, 0)
})

test('subscription revocation while running rejects instead of leaking a later answer', async t => {
  const f = fixture(t); f.auto = false
  const running = f.provider().run(input())
  await tick(); f.denied = true; f.emit([...f.active.keys()][0])
  await assert.rejects(running, /登录或授权已失效/)
  assert.equal(f.active.size, 0)
  assert.equal(f.listeners.size, 0)
})

test('registration only exposes a discovery event and needs no pirate runtime service', t => {
  const f = fixture(t); let event, provider
  const dispose = () => {}
  const returned = registerBlogParticipant({ on(name, handler, options) {
    event = name; assert.equal(options.global, true); handler(value => { provider = value }); return dispose
  } }, { access: f.access, chat: f.chat, index: f.index, store: f.store, routePrefix: '/blog' })
  assert.equal(event, 'pirate/participants'); assert.equal(provider.id, 'blog'); assert.equal(returned, dispose)
})

test('native chat deep links select the requested conversation over a previous local conversation', () => {
  const path = '/blog?conversationId=' + encodeURIComponent('blog-chat-owned-id')
  assert.equal(chatConversationTarget(new URL(path, 'https://example.invalid').search, 'previous-chat'), 'blog-chat-owned-id')
  assert.equal(chatConversationTarget('', 'previous-chat'), 'previous-chat')
  assert.equal(chatConversationTarget(''), null)
  // 选择标识不授予访问权；非法和他人标识仍交给 activate 的原 HTTP 归属检查。
  assert.equal(chatConversationTarget('?conversationId=unowned-id'), 'unowned-id')
})
