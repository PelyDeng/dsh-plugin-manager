/**
 * MergedEvents 的基本语义（并行派发的事件汇流器件）。
 *
 * drainQueue 把一批互不依赖、不同成员的步骤并发派出，各执行流的事件经这个类汇成一条
 * 按到达顺序交错的队列。它是独立可测的纯 TS，这里直接锁三条命根子：
 *
 * 1. 交错且不被慢流拖住：快流的事件在慢流还开着时就必须能被消费（SSE 观众要逐条看到）；
 * 2. 失败先吐缓冲：任一流失败时，已到达的事件先产出再抛出那个错误，不静默吞；
 * 3. 全部 close 才结束：还有流开着时 drain 挂起；归零后先清空缓冲再返回。
 *
 * drain 的检查顺序（buffered → failed → finished）是实现语义的一部分：把失败检查挪到
 * 缓冲前面就会吞掉已到达的事件——这些用例就是防那一类的"顺手重构"。
 */
import { describe, expect, it } from 'vitest'
import { MergedEvents } from '../src/merged-events.ts'

/** 自旋等条件成立：消费是异步的，事件到达要等微任务跑完。 */
async function until(check: () => boolean, label = '条件成立'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`等待超时：${label}`)
}

/** 到点仍挂起返回 'pending'：用来断言「drain 既没产出也没结束」。 */
async function pendingUnless<T>(promise: Promise<T>, ms = 20): Promise<'pending' | 'resolved'> {
  return Promise.race([
    promise.then(() => 'resolved' as const),
    new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms)),
  ])
}

describe('MergedEvents：多条执行流汇成一条队列', () => {
  it('事件按到达顺序交错产出，慢流没结束时快流的事件就已经能被消费', async () => {
    const merged = new MergedEvents<string>()
    merged.open() // 流 A（慢，一直开着）
    merged.open() // 流 B
    const received: string[] = []
    const pump = (async () => {
      for await (const item of merged.drain()) received.push(item)
    })()
    merged.push('a1')
    merged.push('b1')
    merged.push('a2')
    // 两条流都还开着（谁都没 close）：三件事已经全部到齐——不能被慢流"步调对齐"拖住。
    await until(() => received.length === 3, '快流事件在慢流未结束时被消费')
    expect(received).toEqual(['a1', 'b1', 'a2'])
    merged.close()
    merged.close()
    await pump
    expect(received).toEqual(['a1', 'b1', 'a2'])
  })

  it('任一流失败：已缓冲的事件先产出，然后才抛出第一个失败', async () => {
    const merged = new MergedEvents<string>()
    merged.open()
    merged.open()
    merged.push('a1')
    merged.push('b1')
    const first = new Error('流 A 炸了')
    merged.fail(first)
    merged.fail(new Error('流 B 也炸了'))
    merged.close()
    merged.close()
    const received: string[] = []
    const consume = (async () => {
      for await (const item of merged.drain()) received.push(item)
    })()
    await expect(consume).rejects.toBe(first)
    expect(received).toEqual(['a1', 'b1'])
  })

  it('还有流开着时 drain 挂起；最后一条 close 后先吐剩余缓冲再结束', async () => {
    const merged = new MergedEvents<string>()
    merged.open()
    merged.open()
    const iter = merged.drain()
    const first = iter.next()
    merged.push('a1')
    await expect(first).resolves.toEqual({ value: 'a1', done: false })
    merged.close() // 只关了一条，另一条还开着
    const second = iter.next()
    expect(await pendingUnless(second), '还有流开着，drain 不能结束').toBe('pending')
    merged.push('b1')
    await expect(second).resolves.toEqual({ value: 'b1', done: false })
    merged.close()
    await expect(iter.next()).resolves.toEqual({ value: undefined, done: true })
  })

  it('全部流 close 之后，已缓冲的事件照常产出：close 不清空缓冲', async () => {
    const merged = new MergedEvents<string>()
    merged.open()
    merged.push('x1')
    merged.push('x2')
    merged.close()
    const received: string[] = []
    for await (const item of merged.drain()) received.push(item)
    expect(received).toEqual(['x1', 'x2'])
  })
})
