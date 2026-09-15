/**
 * 会话级事件日志：把「一轮执行」和「一条 HTTP 连接」拆开。
 *
 * 之前的实现里，事件的唯一出口是发起那一轮的响应流。连接一断，事件就没了去处，
 * 而后台还在跑的执行只能把增量推进一个再也没人读的队列 —— 关掉页面既看不到结果，
 * 又掐不断已经派出去的活。
 *
 * 这里改成：执行只负责往日志里写，谁想看就各自拿着游标读。谁断线都只影响自己。
 *
 * 只保留**最近一轮**：新一轮开始时清空。这样内存有界，而「刷新后接上正在跑的那一轮」
 * 需要的恰好就是最近这一轮的全部事件。
 *
 * 这个类不认识牛马大总管的事件类型，`T` 由调用方决定；这样它可以被单独测试，
 * 也不会和 `butler.ts` 形成循环依赖。
 */

/** 一轮的执行状态。`running` 之外都是终态。 */
export type RunState = 'running' | 'finished' | 'cancelled' | 'failed'

/** 日志里的一条事件。 */
export interface LoggedEvent<T> {
  /** 会话内单调递增，从 1 开始。客户端拿它做续传游标。 */
  readonly seq: number
  /** 这条事件属于哪一轮。 */
  readonly runId: string
  readonly event: T
}

/** 一轮的头部信息。客户端据此判断该重放还是该重取快照。 */
export interface RunHead {
  readonly runId: string
  readonly state: RunState
  readonly startedAt: number
  readonly finishedAt: number | null
  /** 这一轮对应的任务 id；计划产生之前是空字符串。 */
  readonly taskId: string
  /** 日志里最后一条事件的 seq；没有事件时是 0。 */
  readonly seq: number
  /**
   * 窗口内第一条事件的 seq。
   *
   * 客户端游标早于 `windowStart - 1` 时，中间的事件已经被挤掉，只能重取快照，
   * 不能假装补齐。
   */
  readonly windowStart: number
}

interface RunMeta {
  runId: string
  state: RunState
  readonly startedAt: number
  finishedAt: number | null
  taskId: string
}

/**
 * 客户端带着游标回来时，日志还接不接得上。
 *
 * `after` 是它已经读到的最后一条，所以它接下来要的是 `after + 1`。窗口里最早的一条是
 * `windowStart`，只要 `windowStart <= after + 1` 中间就没有缺口。
 *
 * 注意游标 0（「一条都还没读」）同样要接受这个检查：窗口已经滚动过时，从头也拿不全
 * 一整轮，这时只能如实要求重取快照，而不是交回半轮事件让调用方以为这就是全部。
 */
export function canResume(head: RunHead, after: number): boolean {
  return after + 1 >= head.windowStart
}

export class ConversationLog<T> {
  private items: LoggedEvent<T>[] = []
  private nextSeq = 1
  private run: RunMeta | null = null
  /** 正在等待新事件的订阅者。唤醒时一次性清空，订阅者各自重新取数。 */
  private readonly wakeups = new Set<() => void>()

  /** `limit` 是日志最多保留的事件条数，超出时丢最旧的。 */
  constructor(private readonly limit: number) {}

  /** 开始新的一轮：清空上一轮，重新从 seq 1 计数。 */
  begin(runId: string): RunHead {
    this.items = []
    this.nextSeq = 1
    this.run = { runId, state: 'running', startedAt: Date.now(), finishedAt: null, taskId: '' }
    this.wake()
    const head = this.head()
    if (head === null) throw new Error('刚开始的日志取不到头部')
    return head
  }

  /** 追加一条事件，返回带游标的记录。还没有开始一轮时抛错。 */
  push(event: T): LoggedEvent<T> {
    if (this.run === null) throw new Error('还没有开始一轮，事件无处安放')
    const logged: LoggedEvent<T> = { seq: this.nextSeq, runId: this.run.runId, event }
    this.nextSeq += 1
    this.items.push(logged)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
    this.wake()
    return logged
  }

  /** 计划产生后补上任务 id，供精确取消与客户端理解状态。 */
  setTaskId(taskId: string): void {
    if (this.run !== null) this.run.taskId = taskId
  }

  /** 一轮结束。重复调用只有第一次生效。 */
  finish(state: Exclude<RunState, 'running'>): void {
    if (this.run === null || this.run.state !== 'running') return
    this.run.state = state
    this.run.finishedAt = Date.now()
    this.wake()
  }

  head(): RunHead | null {
    if (this.run === null) return null
    return {
      runId: this.run.runId,
      state: this.run.state,
      startedAt: this.run.startedAt,
      finishedAt: this.run.finishedAt,
      taskId: this.run.taskId,
      seq: this.nextSeq - 1,
      windowStart: this.items[0]?.seq ?? this.nextSeq,
    }
  }

  /**
   * 按游标读指定一轮的事件：先补齐已有的，再跟着新事件走，直到那一轮结束。
   *
   * `runId` 由调用方在订阅前同步取好，而不是在这里现读。否则「取头部」和「开始跟随」
   * 之间若换了轮次，订阅者会连到另一轮上，两轮的事件就混在一起了。
   *
   * `signal` 是订阅者的退出信号。它不是为了取消执行（执行根本不看它），而是为了让
   * **等待本身**可以被叫醒：没有它的话，客户端断开后这条流要一直等到下一个事件到达
   * 才会发现自己该结束了 —— 一个安静下来的任务能让一个已经没人看的响应挂很久。
   */
  async *follow(runId: string, after: number, signal?: AbortSignal): AsyncGenerator<LoggedEvent<T>> {
    let cursor = after
    try {
      while (true) {
        if (signal?.aborted === true) return
        if (this.run === null || this.run.runId !== runId) return
        for (const item of this.items) {
          if (item.seq <= cursor) continue
          cursor = item.seq
          yield item
        }
        if (this.run === null || this.run.runId !== runId || this.run.state !== 'running') return
        await this.waitForChange(signal)
      }
    } finally {
      // 等待中的 `done` 会自己从集合里摘掉；这里只兜住「yield 期间被叫停」的情况。
    }
  }

  /**
   * 等到有新事件、这一轮结束、或者订阅者退出。
   *
   * 三种情形共用一个出口：无论谁先到，等待者都会醒来重新看一眼状态。醒来时顺手把自己
   * 从集合里摘掉，所以提前退出不会在日志里留下一个永远等不到的唤醒点。
   */
  private waitForChange(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.resolve()
    return new Promise<void>(resolve => {
      const done = () => {
        this.wakeups.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      this.wakeups.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** 唤醒所有等待者。它们醒来后各自重新取一遍自己的游标之后的事件。 */
  private wake(): void {
    for (const done of [...this.wakeups]) done()
  }
}
