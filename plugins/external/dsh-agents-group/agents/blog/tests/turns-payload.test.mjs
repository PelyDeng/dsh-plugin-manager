import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeJsonObject,
  decodeTurnPayload,
  decodeTurnResultPayload,
  encodeTurnPayload,
  encodeTurnResultPayload,
} from '../src/turns-payload.ts'

// ---------------------------------------------------------------------------
// `dsh_turns.payload` / `dsh_turn_results.payload` 的业务 schema
//
// 这些用例锁两件事：
//
// 1. **状态取值域冲突**（索引库切 PG 时最容易被静默搞坏的一处）：运行时的 `dsh_turns.status`
//    是 `claimed`/`finished`，blog 的业务状态是 `queued`/`running`/… ⇒ 业务状态只能住
//    `payload.status`。用例显式构造"运行时的状态被误写进 payload.status"这一形态，钉住
//    "收窄成 queued **并保留 rawStatus**"（不是静默吞掉，也不是崩掉）。
// 2. **JSONB 与 TEXT 两种读回形态同结果**：新库是 JSONB（驱动返回对象），旧库是 TEXT
//    （`JSON.parse` 的字符串）。解码必须同时接受——只认字符串会让新库下**全部读不出来**。
// ---------------------------------------------------------------------------

test('decodeJsonObject 接受对象 / JSON 文本 / 空值，拒绝数组与非法值', () => {
  // 新库 JSONB 的读回形态（已经是对象）
  assert.deepEqual(decodeJsonObject({ a: 1 }), { a: 1 })
  // 旧库 TEXT 的形态 / 我们自己写进去的字符串
  assert.deepEqual(decodeJsonObject('{"a":1}'), { a: 1 })
  // 空值三态 ⇒ "没落过值"
  assert.equal(decodeJsonObject(''), undefined)
  assert.equal(decodeJsonObject(null), undefined)
  assert.equal(decodeJsonObject(undefined), undefined)
  // 读不出来（**不降级成空对象**：那会让"没落过值"与"值坏了"混为一谈）
  assert.equal(decodeJsonObject([1, 2]), undefined)
  assert.equal(decodeJsonObject('{oops'), undefined)
  assert.equal(decodeJsonObject('"just a string"'), undefined)
  assert.equal(decodeJsonObject(42), undefined)
})

test('业务状态住在 payload.status，而不是 dsh_turns.status', () => {
  const payload = encodeTurnPayload({
    status: 'running',
    input: { text: '写一篇' },
    operationId: 'op-1',
    draftId: 'd-1',
    sources: [],
    attachments: [],
    userSeq: null,
  })
  // ⚠️ 这里断言的是"业务状态在 payload 里"这一事实本身：
  // 它**不会**出现在任何机制列上（机制列由运行时写 claimed/finished）。
  assert.equal(payload.status, 'running')
  const back = decodeTurnPayload(payload)
  assert.equal(back?.status, 'running')
  assert.equal(back?.operationId, 'op-1')
  assert.equal(back?.draftId, 'd-1')
})

test('⚠️ 运行时的 claimed/finished 被误写进 payload.status 时：收窄成 queued 并保留 rawStatus', () => {
  // 这条是"业务状态与运行时状态不串"的直接判据：
  // 上游若把 `dsh_turns.status` 的值写进业务状态位，我们不能静默当成一个合法业务状态，
  // 也不能崩 —— 收窄 + 留痕，让排查者看得见上游写错了什么。
  for (const wrong of ['claimed', 'finished']) {
    const decoded = decodeTurnPayload({ status: wrong, input: {}, operationId: 'op', draftId: null, sources: [], attachments: [], userSeq: null })
    assert.equal(decoded?.status, 'queued', `${wrong} 不是业务状态，应收窄成 queued`)
    assert.equal(decoded?.rawStatus, wrong, `${wrong} 要留在 rawStatus 里，不能静默吞掉`)
  }
  // 顺带：缺省 / 拼错同样收窄（不猜），且都留痕
  assert.equal(decodeTurnPayload({ input: {} })?.status, 'queued')
  assert.equal(decodeTurnPayload({ input: {} })?.rawStatus, undefined)
  assert.equal(decodeTurnPayload({ status: 'RUNNING', input: {} })?.rawStatus, 'RUNNING')
})

test('JSONB 形态（对象）与 TEXT 形态（字符串）解出同一结果', () => {
  const payload = {
    status: 'interrupted',
    input: { text: '写一篇', attachments: ['a'] },
    operationId: 'op-2',
    draftId: null,
    sources: [{ url: 'u' }],
    attachments: [{ requestId: 'r-1', id: 'a-1' }],
    userSeq: 3,
    message: '服务已重启；已保存的对话可以继续',
  }
  const fromObject = decodeTurnPayload(payload)
  const fromText = decodeTurnPayload(JSON.stringify(payload))
  assert.deepEqual(fromObject, fromText)
  assert.equal(fromObject?.message, '服务已重启；已保存的对话可以继续')
  assert.deepEqual(fromObject?.attachments, [{ requestId: 'r-1', id: 'a-1' }])
})

test('未知字段原样保留（updateRequest 的 patch 形状是开放的）', () => {
  const decoded = decodeTurnPayload({ status: 'queued', input: {}, operationId: 'op', draftId: null, sources: [], attachments: [], userSeq: null, openingAt: 123, openingUntil: 456 })
  assert.equal(decoded?.openingAt, 123)
  assert.equal(decoded?.openingUntil, 456)
  // ⚠️ 测试文件是 `.mjs`：Node **不对 `.mjs` 做类型剥离**，所以这里**不能**用 TS 语法
  // （`decoded!` 这种非空断言在 `.mjs` 里是语法错误 —— 实测 `SyntaxError: missing ) after argument list`）。
  // 带类型的源文件用 `.ts` 直接 import 是可以的（见文件头），但测试文件本身要保持纯 JS。
  assert.ok(decoded)
  const encoded = encodeTurnPayload(decoded)
  assert.equal(encoded.openingAt, 123)
})

test('必填字段缺失时的取向：形状自洽 + 不抛', () => {
  const decoded = decodeTurnPayload({})
  assert.equal(decoded?.status, 'queued')
  assert.deepEqual(decoded?.input, {})
  assert.equal(decoded?.operationId, '')
  assert.equal(decoded?.draftId, null)
  assert.deepEqual(decoded?.sources, [])
  assert.deepEqual(decoded?.attachments, [])
  assert.equal(decoded?.userSeq, null)
  // 完全读不出来 ⇒ undefined（不是空对象）
  assert.equal(decodeTurnPayload('{oops'), undefined)
})

test('结果侧：kind 是必需项，缺了就是读不出来；往返保形', () => {
  const value = { kind: 'candidate', draftId: 'd-9', revision: 3, title: '候选稿', proposal: { id: 'p-1' }, createdAt: 1726 }
  const back = decodeTurnResultPayload(encodeTurnResultPayload(value))
  assert.deepEqual(back, value)
  // JSONB 形态（对象）同样可解
  assert.deepEqual(decodeTurnResultPayload(value), value)
  // 没有 kind ⇒ 读不出来（不猜成某种结果）
  assert.equal(decodeTurnResultPayload({ draftId: 'd-9' }), undefined)
  assert.equal(decodeTurnResultPayload(''), undefined)
})
