/**
 * 把多个并发执行流的事件汇成一条按到达顺序交错的队列。
 *
 * 用在并行派发（{@link ButlerConsole.drainQueue} 取一批互不依赖、不同成员的步骤同时派出）：
 * 每条执行流是一个 async generator，事件到达顺序天然交错——不能"步调对齐"地逐回合聚合
 * （那会让快执行方的事件被慢执行方拖住），也不能丢（SSE 观众要逐条看到）。
 *
 * 语义：`push` 无界缓存（消费者只有 drain 一个，且 drain 不停消费）；`drain` 逐条产出，
 * 在全部流 `close()` 之后结束；任一流失败时先产出已缓冲事件再抛出，不静默吞。
 */
export class MergedEvents<T> {
  private readonly buffered: T[] = []
  private readonly waiters: (() => void)[] = []
  private openCount = 0
  private failure: unknown
  private failed = false
  private finished = false

  /** 一条参与汇流的执行流开始（计数 +1）。 */
  open(): void {
    this.openCount += 1
  }

  /** 一条流结束（计数 -1）；归零后 drain 收尾。 */
  close(): void {
    this.openCount = Math.max(0, this.openCount - 1)
    if (this.openCount === 0) {
      this.finished = true
      this.wake()
    }
  }

  /** 缓冲一条事件并唤醒等待中的 drain。 */
  push(event: T): void {
    this.buffered.push(event)
    this.wake()
  }

  /** 一条流失败：唤醒 drain 抛出（缓冲的事件仍会先产出）。保留**第一个**失败——
   *  多流并发失败时后到的错误只作日志参考，排障要的是首因。 */
  fail(error: unknown): void {
    this.failed = true
    this.failure ??= error
    this.wake()
  }

  private wake(): void {
    for (const resume of this.waiters.splice(0)) resume()
  }

  private wait(): Promise<void> {
    return new Promise<void>(resolve => { this.waiters.push(resolve) })
  }

  /** 逐条产出已到达的事件；全部流结束（或失败）后返回/抛出。 */
  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.buffered.length > 0) yield this.buffered.shift() as T
      if (this.failed) throw this.failure
      if (this.finished) return
      await this.wait()
    }
  }
}
