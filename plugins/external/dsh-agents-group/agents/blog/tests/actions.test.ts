/**
 * 就地确认（通用操作架构在博客这一侧的两半：**画得出来** + **办得了**）。
 *
 * 这一批用例只钉三件在协议里承诺过、错了会很难看的事：
 *
 * 1. **凭据不出业务**：投影出来的操作卡里**没有** `nonce`（模型与协调方都拿不到它）；
 * 2. **归属自己核**：不属于本次派活会话的操作，确认时拒掉；
 * 3. **幂等**：已经办过的操作不重复执行（用户会双击、网络会重试）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplyAction } from '../src/actions.ts'
import { pendingActionsOf } from '../src/definition.ts'

const actor = { namespace: 'user', userId: 'writer', sessionId: 'login' } as never
const ownerOf = (value: { namespace: string; userId: string }) => `${value.namespace}:${value.userId}`

/** 一份最小的业务门面替身：只实现投影与确认用到的门面（`operation` 支持办结前后两次读回不同值）。 */
function ports(operation: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return portsSeq(operation, operation, overrides)
}

/** 办结前/办结后两次 `operation` 读回不同记录：perform 之后的重取才是材料的事实来源。 */
function portsSeq(before: Record<string, unknown>, after: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const calls: { performed: unknown[]; remaining: number } = { performed: [], remaining: 0 }
  let performed = false
  const applied = createApplyAction({
    operation: async () => (performed ? after : before) as never,
    perform: async input => { calls.performed.push(input); performed = true },
    remaining: async () => { calls.remaining += 1; return [] },
    ownerOf,
    materialPath: conversationId => `/agents/blog?conversationId=${conversationId}`,
    ...overrides,
  })
  return { applied, calls }
}

test('投影出来的操作卡没有任何凭据：nonce 不出业务库', async () => {
  const app = {
    operations: async () => [{
      id: 'op-1',
      title: '发布《测试1》',
      mode: 'publish',
      status: 'prepared',
      expiresAt: 1_800_000_000_000,
      nonce: 'super-secret-nonce',
      sessionId: 'login',
      chat: { conversationId: 'blog-chat-1' },
    }],
    preview: () => ({ id: 'op-1', mode: 'publish', title: '发布《测试1》', after: { title: '测试1', text: '正文' }, expiresAt: 1_800_000_000_000, source: 'draft' }),
  }
  const actions = await pendingActionsOf(app as never, 'user:writer', 'blog-chat-1')
  assert.equal(actions.length, 1)
  const action = actions[0]!
  assert.equal(action.id, 'op-1')
  assert.equal(action.kind, 'blog.publish')
  assert.equal(action.state, 'prepared')
  assert.equal(action.title, '发布《测试1》')
  assert.equal(action.fields?.find(field => field.label === '发布来源')?.value, 'AI 候选稿'.replace('AI 候选稿', '当前草稿正文'))
  // 详情是受控 Markdown（台账用同一个渲染器画），字段是结构化键值。
  assert.match(action.detail ?? '', /将要发布的内容/)
  // ⚠️ 这一条是安全性质：整份呈现数据里不许出现凭据。
  assert.equal(JSON.stringify(actions).includes('nonce'), false)
  assert.equal(JSON.stringify(actions).includes('super-secret-nonce'), false)
  // 另一个会话的操作不进这张卡。
  assert.deepEqual(await pendingActionsOf(app as never, 'user:writer', 'blog-chat-other'), [])
})

test('投影在没有预览能力时退化但照样画得出来（标题 + 一句话，缺详情不影响做决定）', async () => {
  const app = {
    operations: async () => [{ id: 'op-9', title: '删除文章', mode: 'delete', status: 'prepared', chat: { conversationId: 'blog-chat-1' } }],
  }
  const actions = await pendingActionsOf(app as never, 'user:writer', 'blog-chat-1')
  assert.equal(actions.length, 1)
  assert.equal(actions[0]!.detail, undefined)
  assert.equal(actions[0]!.confirmLabel, '删除')
  assert.match(actions[0]!.summary, /永久删除/)
})

test('确认走执行方自己的凭据；撤回同理', async () => {
  const { applied, calls } = ports({ id: 'op-1', mode: 'publish', title: '发布', status: 'prepared', nonce: 'n-1', chat: { conversationId: 'blog-chat-1' } })
  const result = await applied({ actionId: 'op-1', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'completed')
  assert.equal(calls.performed.length, 1)
  // 凭据是**执行方自己**补上的：调用方从头到尾没有它。
  assert.deepEqual(calls.performed[0], { actor, conversationId: 'blog-chat-1', id: 'op-1', decision: 'confirm', nonce: 'n-1' })
})

test('幂等：已经办过的操作不重复执行，如实回报它现在的状态', async () => {
  const { applied, calls } = ports({ id: 'op-2', mode: 'publish', title: '发布', status: 'succeeded', nonce: 'n-2', chat: { conversationId: 'blog-chat-1' } })
  const result = await applied({ actionId: 'op-2', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(calls.performed.length, 0, '重复确认不得再执行一次')
  assert.equal(result.status, 'completed')
  assert.match(result.text, /已经办完/)
})

test('归属自己核：不属于本次派活会话的操作直接拒掉（403）', async () => {
  const { applied, calls } = ports({ id: 'op-3', mode: 'publish', title: '发布', status: 'prepared', nonce: 'n-3', chat: { conversationId: 'blog-chat-1' } })
  await assert.rejects(
    applied({ actionId: 'op-3', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-other' }),
    /不属于本次派活的会话/,
  )
  assert.equal(calls.performed.length, 0)
})

test('执行失败如实交回：卡片上要能看到原因，而不是一直停在"正在办"', async () => {
  const { applied } = ports(
    { id: 'op-4', mode: 'publish', title: '发布', status: 'prepared', nonce: 'n-4', chat: { conversationId: 'blog-chat-1' } },
    { perform: async () => { throw new Error('远端 502') } },
  )
  const result = await applied({ actionId: 'op-4', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'failed')
  assert.match(result.externalPending?.reason ?? '', /远端 502/)
})

test('撤回是终态结论：没有别的卡时投影 cancelled（不是 completed）', async () => {
  // K2 的根子：撤回被投影成 completed，协调方就把子任务记成 succeeded，裁决再把它读成
  // "没经过确认就收了"，转头派一轮重做。老板的"不要"必须是个结论。
  const { applied } = ports({ id: 'op-5', mode: 'delete', title: '删除', status: 'prepared', nonce: 'n-5', chat: { conversationId: 'blog-chat-1' } })
  const result = await applied({ actionId: 'op-5', decision: 'cancel', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'cancelled')
  assert.match(result.text, /已经撤回/)
})

test('撤回后同会话还有别的卡：投影 external_pending 并如实交回剩余清单', async () => {
  const left = [{ id: 'op-7', kind: 'blog.delete', title: '另一张卡', summary: '还在等确认', state: 'prepared' }]
  const { applied } = ports(
    { id: 'op-6', mode: 'delete', title: '删除', status: 'prepared', nonce: 'n-6', chat: { conversationId: 'blog-chat-1' } },
    { remaining: async () => left as never },
  )
  const result = await applied({ actionId: 'op-6', decision: 'cancel', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'external_pending')
  assert.deepEqual(result.actions?.map(item => item.id), ['op-7'])
})

test('发布一篇「已发布文章的未发布修改稿」：卡片明示「发布将消费当前保存稿」', async () => {
  // 2026-09-19 生产：用户确认发布后博客侧守卫拒绝（"请明确确认发布会消费现有博客保存稿"），
  // 而卡片根本没披露这件事——确认一个没被告知的后果不算确认。披露行与确认侧传入的
  // consumeSavedDraft（index.ts applyAction）是同一条契约的两半。
  const app = {
    operations: async () => [{ id: 'op-10', title: '发布', mode: 'publish', status: 'prepared', chat: { conversationId: 'blog-chat-1' } }],
    preview: () => ({ id: 'op-10', mode: 'publish', title: '发布', after: { title: '标题', text: '正文' }, expiresAt: 1_800_000_000_000, hasSavedDraft: true }),
  }
  const actions = await pendingActionsOf(app as never, 'user:writer', 'blog-chat-1')
  assert.match(actions[0]!.detail ?? '', /消费当前保存稿/)
})

// —— 批 2：办结材料（「办了，但没递东西给我核」的闭环）——
//
// 材料的事实来源是**业务库操作记录**（perform 之后重取的那份）：状态、链接都从它来，
// 不从措辞猜、不从调用方拿。没有可核对产出的操作（删除/管理）如实不给——不造假材料。

test('发布确认办结：交回已发布文章材料（链接 + 状态 + 字段表），自检对照操作记录', async () => {
  const { applied } = portsSeq(
    { id: 'op-20', mode: 'publish', title: '测试1', status: 'prepared', nonce: 'n-20', chat: { conversationId: 'blog-chat-1' } },
    { id: 'op-20', mode: 'publish', title: '测试1', status: 'succeeded', chat: { conversationId: 'blog-chat-1' }, result: { url: 'https://blog.example/p/1.html', version: 3 } },
  )
  const result = await applied({ actionId: 'op-20', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'completed')
  assert.match(result.text, /已经按你确认的办了/)
  assert.match(result.text, /《测试1》已发布/)
  assert.equal(result.artifacts?.length, 1)
  const material = result.artifacts![0]!
  assert.equal(material.kind, 'article')
  assert.equal(material.state, 'published')
  assert.equal(material.url, 'https://blog.example/p/1.html')
  assert.equal(material.fields?.find(field => field.label === '发布状态')?.value, '已发布')
  // 自检结论是"对照业务库操作记录"，不是模型自评；材料在才有它。
  assert.equal(result.selfCheck?.status, 'passed')
  // 材料里没有任何凭据（nonce 不随办结结果外泄）。
  assert.equal(JSON.stringify(result.artifacts).includes('n-20'), false)
})

test('发布办结但业务库没有链接：照给 state=published，不伪造 url，也不因此判失败', async () => {
  const { applied } = portsSeq(
    { id: 'op-21', mode: 'publish', title: '无链接', status: 'prepared', nonce: 'n-21', chat: { conversationId: 'blog-chat-1' } },
    { id: 'op-21', mode: 'publish', title: '无链接', status: 'succeeded', chat: { conversationId: 'blog-chat-1' }, result: {} },
  )
  const result = await applied({ actionId: 'op-21', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'completed')
  assert.equal(result.artifacts![0]!.state, 'published')
  assert.equal(result.artifacts![0]!.url, undefined)
  assert.equal(result.artifacts![0]!.fields?.some(field => field.label === '链接'), false)
})

test('保存草稿确认办结：交回 draft 材料，明示「不是已发布」', async () => {
  const { applied } = portsSeq(
    { id: 'op-22', mode: 'draft', title: '草稿文', status: 'prepared', nonce: 'n-22', chat: { conversationId: 'blog-chat-1' } },
    { id: 'op-22', mode: 'draft', title: '草稿文', status: 'succeeded', chat: { conversationId: 'blog-chat-1' } },
  )
  const result = await applied({ actionId: 'op-22', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'completed')
  const material = result.artifacts![0]!
  assert.equal(material.kind, 'draft')
  assert.equal(material.state, 'draft')
  assert.equal(material.url, undefined)
  assert.match(material.fields?.find(field => field.label === '状态')?.value ?? '', /不是已发布/)
})

test('删除类操作办结：没有可核对的公开产出就如实不给材料，也不表态自检', async () => {
  const { applied } = portsSeq(
    { id: 'op-23', mode: 'delete', title: '删文', status: 'prepared', nonce: 'n-23', chat: { conversationId: 'blog-chat-1' } },
    { id: 'op-23', mode: 'delete', title: '删文', status: 'succeeded', chat: { conversationId: 'blog-chat-1' } },
  )
  const result = await applied({ actionId: 'op-23', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'completed')
  assert.equal(result.artifacts, undefined, '没有材料是事实，编一份材料是谎')
  assert.equal(result.selfCheck, undefined)
})

test('办结后还有同会话别的卡：材料照交，状态停在 external_pending', async () => {
  const left = [{ id: 'op-25', kind: 'blog.delete', title: '另一张卡', summary: '还在等确认', state: 'prepared' }]
  const { applied } = portsSeq(
    { id: 'op-24', mode: 'publish', title: '测试2', status: 'prepared', nonce: 'n-24', chat: { conversationId: 'blog-chat-1' } },
    { id: 'op-24', mode: 'publish', title: '测试2', status: 'succeeded', chat: { conversationId: 'blog-chat-1' }, result: { url: 'https://blog.example/p/2.html' } },
    { remaining: async () => left as never },
  )
  const result = await applied({ actionId: 'op-24', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'external_pending')
  assert.equal(result.artifacts![0]!.url, 'https://blog.example/p/2.html')
})

test('重复确认（幂等重入）：不再执行，但材料从操作记录重取后同样交回', async () => {
  // 材料不稳定比没有材料更难核对：同一操作无论点几次，台账看到的产出区是同一行。
  const { applied, calls } = ports({ id: 'op-26', mode: 'publish', title: '测试3', status: 'succeeded', chat: { conversationId: 'blog-chat-1' }, result: { url: 'https://blog.example/p/3.html' } })
  const result = await applied({ actionId: 'op-26', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(calls.performed.length, 0)
  assert.equal(result.status, 'completed')
  assert.match(result.text, /已经办完/)
  assert.equal(result.artifacts![0]!.url, 'https://blog.example/p/3.html')
  assert.equal(result.artifacts![0]!.state, 'published')
})

test('执行失败：交回失败与原因，不产生任何办结材料', async () => {
  const { applied } = portsSeq(
    { id: 'op-27', mode: 'publish', title: '会失败的', status: 'prepared', nonce: 'n-27', chat: { conversationId: 'blog-chat-1' } },
    { id: 'op-27', mode: 'publish', title: '会失败的', status: 'uncertain', chat: { conversationId: 'blog-chat-1' } },
    { perform: async () => { throw new Error('远端 502') } },
  )
  const result = await applied({ actionId: 'op-27', decision: 'confirm', taskId: 't', subtaskId: 's1', actor, conversationId: 'blog-chat-1' })
  assert.equal(result.status, 'failed')
  assert.equal(result.artifacts, undefined)
})
