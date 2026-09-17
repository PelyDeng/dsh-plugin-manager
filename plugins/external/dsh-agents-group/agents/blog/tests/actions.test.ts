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

/** 一份最小的业务门面替身：只实现投影与确认用到的四个面。 */
function ports(operation: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const calls: { performed: unknown[]; remaining: number } = { performed: [], remaining: 0 }
  const applied = createApplyAction({
    operation: async () => operation as never,
    perform: async input => { calls.performed.push(input) },
    remaining: async () => { calls.remaining += 1; return [] },
    ownerOf,
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
