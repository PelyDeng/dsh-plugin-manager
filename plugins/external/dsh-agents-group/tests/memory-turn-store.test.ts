/**
 * `MemoryTurnStore` 的行为契约（无 DSN，任何环境都真跑）。
 *
 * ## 为什么这个替身需要自己的契约测试
 *
 * 它**不是**测试夹具，而是运行时提供的实现（`packages/runtime/src/storage/memory.ts`）：blog 的
 * 24 个测试文件原本跑在 SQLite `:memory:` 上，索引库切 PG 之后它们唯一的后端就是它。**替身撒谎，
 * 上层用例就集体假绿**——所以这里逐条钉住它与 PG 实现（`PgTurns`）相同的语义，并**刻意钉住它没有
 * 的那些**（无持久化、无并发、无跨进程；见文件头那张表）。
 *
 * ⚠️ 与真 PG 的对照在 `storage-contract.test.ts`（要 `DSH_RUNTIME_TEST_PG_DSN`，缺 DSN 时**整文件
 * skip**）。**两边是两份断言，不是同一份套件跑两遍** —— 谁改了语义，两边会各红一次，这正是要的。
 */
import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it } from 'vitest'
import { MemoryTurnStore } from '../packages/runtime/src/storage/memory.ts'
import type { OwnerKey } from '../packages/runtime/src/storage/ports.ts'

const AGENT = 'minimal'
const owner: OwnerKey = { namespace: 'user', userId: 'alice' }
const otherOwner: OwnerKey = { namespace: 'user', userId: 'bob' }

const store = (): MemoryTurnStore => new MemoryTurnStore(AGENT)

describe('MemoryTurnStore（内存轮次端口）', () => {
  it('claim 落建行载荷，且只在**首次**建行时生效（幂等命中不覆盖原来那一层）', async () => {
    const turns = store()
    expect(await turns.claim(owner, 'c1', 'req-1', 'hash', { status: 'running', attempt: 1 })).toBe('claimed')
    const turnId = (await turns.turnId(owner, 'req-1'))!
    expect((await turns.turnById(owner, turnId))!.payload).toEqual({ status: 'running', attempt: 1 })
    // 重放：回的是**原来那一行**，这次传的载荷不许盖掉它（否则一次重放就能把业务状态改回去）。
    expect(await turns.claim(owner, 'c1', 'req-1', 'hash', { status: 'done' })).toBe('duplicate')
    expect((await turns.turnById(owner, turnId))!.payload).toEqual({ status: 'running', attempt: 1 })
    // 省略载荷与 `{}` 同义：端口那一侧一律是对象，调用方不必分两种缺省。
    expect(await turns.claim(owner, 'c1', 'req-2', 'hash')).toBe('claimed')
    expect((await turns.turnById(owner, (await turns.turnId(owner, 'req-2'))!))!.payload).toEqual({})
  })

  it('claim：空 requestId 明确拒绝（不伪造幂等身份），换正文报 409', async () => {
    const turns = store()
    await expect(turns.claim(owner, 'c1', '', 'hash')).rejects.toThrow(/缺少幂等身份/u)
    expect(await turns.claim(owner, 'c1', 'req-1', 'hash-a')).toBe('claimed')
    // 同一次受理换了正文必须报冲突而不是重跑 —— 重跑会让带副作用的活干两遍。
    await expect(turns.claim(owner, 'c1', 'req-1', 'hash-b')).rejects.toBeInstanceOf(AccessError)
  })

  it('turnById 按行 id 读整行：字段逐一对上，未知行 / 空行 id / 别人的行都是 undefined', async () => {
    const turns = store()
    await turns.claim(owner, 'c1', 'req-row', 'hash-row', { status: 'running' })
    const turnId = (await turns.turnId(owner, 'req-row'))!
    const row = (await turns.turnById(owner, turnId))!
    // `id` 与 `requestId` 是**两个**东西（DDL 第 150 行的"同名不同义"）：回填成幂等键，结果层就
    // 拿幂等键去查 `turn_id`，**一条都查不到**。
    expect(row.id).toBe(turnId)
    expect(row.id).not.toBe('req-row')
    expect(row).toMatchObject({
      conversationId: 'c1', requestId: 'req-row', inputHash: 'hash-row', status: 'claimed',
    })
    expect(typeof row.createdAt).toBe('number')
    // 同一个行 id、不同的人：答出内容就是越权读别人的业务载荷。
    expect(await turns.turnById(otherOwner, turnId)).toBeUndefined()
    expect(await turns.turnById(owner, 'turn-does-not-exist')).toBeUndefined()
    expect(await turns.turnById(owner, '')).toBeUndefined()
    // 结算之后同一行读回来是 `finished`（运行期状态在 `status` 上，业务状态不在那里）。
    await turns.finish(owner, 'req-row')
    expect((await turns.turnById(owner, turnId))!.status).toBe('finished')
  })

  it('turnStatus 三态：无行 ⇒ undefined，认领未结算 ⇒ claimed，结算后 ⇒ finished；空 requestId ⇒ undefined', async () => {
    const turns = store()
    expect(await turns.turnStatus(owner, 'req-t')).toBeUndefined()
    await turns.claim(owner, 'c1', 'req-t', 'hash')
    expect(await turns.turnStatus(owner, 'req-t')).toBe('claimed')
    await turns.finish(owner, 'req-t')
    expect(await turns.turnStatus(owner, 'req-t')).toBe('finished')
    expect(await turns.turnStatus(owner, '')).toBeUndefined()
    // 别人的轮次不泄露状态（答出来会让别人的重试被判成"已结算"而静默丢活）。
    expect(await turns.turnStatus(otherOwner, 'req-t')).toBeUndefined()
  })

  it('★ turnsOf 读会话的全部轮次：含 `request_id = \'\'` 的等待行，按 created_at 升序，跨会话/跨 owner 不串', async () => {
    const turns = store()
    expect(await turns.turnsOf(owner, 'c1')).toEqual([])
    await turns.claim(owner, 'c1', 'req-1', 'h1', { status: 'first' })
    await turns.claim(owner, 'c1', 'req-2', 'h2', { status: 'second' })
    await turns.claim(owner, 'c2', 'req-other', 'h3')
    await turns.setPendingQuestion(owner, 'c1', '采用哪一版？')
    // `createdAt` 可能同毫秒（内存实现就是同一毫秒），所以按 `requestId` 的断言只钉"集合",
    // 顺序断言单独用 `createdAt` 的非递减来钉（与真实现的"同毫秒退化成按 id 排"同一条口径）。
    const rows = await turns.turnsOf(owner, 'c1')
    expect(rows.map(row => row.requestId).sort()).toEqual(['', 'req-1', 'req-2'])
    expect(rows.map(row => row.createdAt)).toEqual([...rows.map(row => row.createdAt)].sort((a, b) => a - b))
    // 等待行**必须**在列表里，且带得出"在等什么"：在这里滤掉 `request_id = ''`，会让"这个会话卡在
    // 等用户回话"那条线**静默消失**（重启后协调侧直接报 `waiting_expired`）。
    const waiting = rows.filter(row => row.requestId === '')
    expect(waiting.map(row => row.payload.question)).toEqual(['采用哪一版？'])
    expect(waiting.map(row => row.status)).toEqual(['waiting'])
    expect((await turns.turnsOf(owner, 'c2')).map(row => row.requestId)).toEqual(['req-other'])
    expect(await turns.turnsOf(otherOwner, 'c1')).toEqual([])
  })

  it('★ patchTurnPayload 是浅合并：没提到的键留着，返回合并结果而不是补丁；未知行抛 404', async () => {
    const turns = store()
    await turns.claim(owner, 'c1', 'req-p', 'hash', { status: 'running', keep: 'x', nested: { a: 1 } })
    const turnId = (await turns.turnId(owner, 'req-p'))!
    const merged = await turns.patchTurnPayload(owner, turnId, { status: 'done' })
    // 返回 `{status:'done'}`（补丁本身）也是"看起来成功"的——但 `keep` / `nested` 会消失。
    expect(merged).toEqual({ status: 'done', keep: 'x', nested: { a: 1 } })
    expect((await turns.turnById(owner, turnId))!.payload).toEqual(merged)
    // **浅**合并（与 `jsonb ||` 同义）：`nested` 整层被替换，不是递归合并。
    expect(await turns.patchTurnPayload(owner, turnId, { nested: { b: 2 } }))
      .toEqual({ status: 'done', keep: 'x', nested: { b: 2 } })
    // 空补丁是恒等，不是清空。
    expect(await turns.patchTurnPayload(owner, turnId, {}))
      .toEqual({ status: 'done', keep: 'x', nested: { b: 2 } })
    // 静默成功（或返回 undefined）会让调用方以为写进去了；别人的行同样一个字都不动。
    await expect(turns.patchTurnPayload(owner, 'turn-missing', { status: 'done' })).rejects.toBeInstanceOf(AccessError)
    await expect(turns.patchTurnPayload(otherOwner, turnId, { stolen: true })).rejects.toBeInstanceOf(AccessError)
    expect((await turns.turnById(owner, turnId))!.payload).toEqual({ status: 'done', keep: 'x', nested: { b: 2 } })
  })

  it('结果层按轮次存取、按 seq 升序；空行 id ⇒ 空数组，别人的轮次读不到', async () => {
    const turns = store()
    await turns.claim(owner, 'c1', 'req-a', 'h')
    await turns.claim(owner, 'c1', 'req-b', 'h')
    const turnA = (await turns.turnId(owner, 'req-a'))!
    const turnB = (await turns.turnId(owner, 'req-b'))!
    expect(turnA).not.toBe(turnB)
    expect(await turns.turnResults(owner, turnA)).toEqual([])
    await turns.appendTurnResult(owner, { conversationId: 'c1', turnId: turnA, operationId: 'op-1', payload: { kind: 'candidate' } })
    await turns.appendTurnResult(owner, { conversationId: 'c1', turnId: turnA, operationId: 'op-1', payload: { kind: 'operation' } })
    // **同一次操作两条结果是允许的**（身份是各自的 id，不是 `(turn_id, operation_id)`）。
    const rows = await turns.turnResults(owner, turnA)
    expect(rows.map(row => row.payload.kind)).toEqual(['candidate', 'operation'])
    expect(rows.map(row => row.operationId)).toEqual(['op-1', 'op-1'])
    expect(rows[1]!.seq).toBeGreaterThan(rows[0]!.seq)
    // 结果**串轮次**（把上一轮的材料当本轮交回）是这一层的经典错，按轮次隔离能抓住它。
    expect(await turns.turnResults(owner, turnB)).toEqual([])
    expect(await turns.turnResults(otherOwner, turnA)).toEqual([])
    expect(await turns.turnResults(owner, '')).toEqual([])
  })

  it('待答问题：一个会话同时只有一个（后写的胜出）；undefined 把问题清掉，等待行本身留着', async () => {
    const turns = store()
    await turns.setPendingQuestion(owner, 'c1', '第一问？')
    expect(await turns.pendingQuestion(owner, 'c1')).toBe('第一问？')
    await turns.setPendingQuestion(owner, 'c1', '第二问？')
    // 等待可以发生多次，但**只有最后那次是"此刻在等的"**。这里刻意不靠时间戳：内存实现里两次等待
    // 必然同毫秒，靠 `createdAt` 排就是掷骰子——载体唯一是**写入前先清掉原有 `question` 键**换来的。
    expect(await turns.pendingQuestion(owner, 'c1')).toBe('第二问？')
    expect(turns.rawTurns.filter(row => typeof row.payload.question === 'string')).toHaveLength(1)
    // 别的会话 / 别人的会话读不到。
    expect(await turns.pendingQuestion(owner, 'c2')).toBeUndefined()
    expect(await turns.pendingQuestion(otherOwner, 'c1')).toBeUndefined()
    await turns.setPendingQuestion(owner, 'c1', undefined)
    expect(await turns.pendingQuestion(owner, 'c1')).toBeUndefined()
    // 清掉的是**键**：等待行本身还在（它也是 `turnsOf` 里那条"本轮在等什么"的痕迹）。
    expect((await turns.turnsOf(owner, 'c1')).some(row => row.requestId === '')).toBe(true)
  })

  it('一个实例就是一个 Agent：别人的 owner 全部读不到（与真实现的 SQL 条件同一口径）', async () => {
    const turns = store()
    await turns.claim(otherOwner, 'c1', 'req-o', 'h')
    expect(await turns.turnId(otherOwner, 'req-o')).toBeDefined()
    // 同一个实例里，"别的 owner"不是不存在，而是**被 owner 条件挡住**——两种错法（越权读到 /
    // 该读到的读不到）都会在这里红。
    expect(await turns.turnId(owner, 'req-o')).toBeUndefined()
    expect(await turns.turnsOf(owner, 'c1')).toEqual([])
    expect(await turns.turnStatus(owner, 'req-o')).toBeUndefined()
  })
})
