/**
 * 回合跟随引擎（方案 §3.3 SSE 管线解耦重写，语义源自 web/modules/send.js followUntilTerminal，
 * 是**解耦重写而非搬运**）：断线重订、reset 后按快照重建再从窗口头续订、无终态结束时按
 * 运行状态选择重订或按快照补终态卡。
 *
 * 与旧实现的本质差别：这里是**纯控制流**——订阅、探测、快照读取全部经 `links` 注入，
 * 渲染副作用（痕迹行/错误行/事件应用/快照校准/重建）经 `host` 注入，本文件不碰 store
 * 与 DOM。断线重订的单测直接喂假事件流即可（DoD：重试预算/runId 核对/续订对齐单测绿）。
 *
 * 语义逐条对齐旧实现（S05/S06/S09）：
 * - 不混轮次：跟随对象由 `expectedRunId` **预先指定**（本轮 run 头的消费回执或恢复探测）。
 *   没有回执时不跟随——探测到的「当前最新一轮」无法证明属于原提交。
 * - 重放的旧 seq 直接丢弃；轮次不符的重放事件不应用；服务端换轮立即按快照收尾。
 * - reset 滚出窗口的事件补不回来：按快照重建（运行中同样重建），重建成功才对齐到
 *   探测头部的窗口位置（head.seq）续订；快照读取失败不推进游标，保留原位按预算重试。
 * - 预算：退避 2s 起、封顶 4s、最多 4 次重订，总硬期限 120s；到期如实放弃不无限重试。
 * - 硬期限：订阅、探测、快照读取与退避共用同一个截止信号，取消与到期都能中断每一步。
 */

import { api, events, eventsHead } from './api.ts'
import type { RunHead, TaskRecord } from './api.ts'
import type { TurnEvent } from './turn-event.ts'

export interface TurnEngineLinks {
  subscribe(conversationId: string, after: number, signal: AbortSignal): AsyncIterable<TurnEvent>
  probeHead(conversationId: string, signal: AbortSignal): Promise<RunHead | null>
  taskSnapshot(taskId: string, signal: AbortSignal): Promise<TaskRecord>
}

/** 生产环境的接缝：直接走 api.ts。单测注入假实现。 */
export const productionLinks: TurnEngineLinks = {
  subscribe: (conversationId, after, signal) => events({ conversationId, after, signal }) as AsyncIterable<TurnEvent>,
  probeHead: (conversationId, signal) => eventsHead(conversationId, signal),
  taskSnapshot: (taskId, signal) => api.task(taskId, signal),
}

export interface TurnEngineHost {
  /** 应用一条事件：游标推进 + 渲染分发（host 侧保证轮内旧 seq 已被引擎丢弃）。 */
  apply(event: TurnEvent): void
  /** 界面痕迹行（msg__meta 语义）。 */
  note(text: string): void
  /** 界面错误行。 */
  errorLine(text: string): void
  /** 这一轮已受理的任务 id（快照校准/重建的依据；空串表示还没有）。引擎只读不写（评审 #24：
   *  重建对象的任务 id 经 rebuildFromSnapshot 入参传入，不再回写宿主）。 */
  runTaskId(): string
  /** 消费到 summary 即终态（含历史重建内出现的 summary）。 */
  sawTerminal(): boolean
  /** 标记终态已见（host 在 apply 里做，这里供引擎复核）。 */
  markTerminal(): void
  /** 按快照补一张终态卡（不改游标；读取失败保持现状）。 */
  calibrate(record: TaskRecord): void
  /** 按快照重建整轮视图（清空+重画），成功返回 true。 */
  rebuild(record: TaskRecord): void
}

export interface FollowOptions {
  from: number
  expectedRunId: string
  signal?: AbortSignal | undefined
  /** 覆盖默认重试预算（评审 #24）：单测注入短预算验证到期/耗尽；生产调用不传。 */
  budget?: Partial<RetryBudget> | undefined
}

/**
 * 重试预算（评审 #24 可注入）：FollowOptions.budget 覆盖默认值——单测注入短预算
 * 验证到期/耗尽语义，生产调用不传走 RETRY_BUDGET。
 */
export interface RetryBudget {
  /** 退避基数（毫秒），指数增长。 */
  base: number
  /** 单次退避封顶（毫秒）。 */
  cap: number
  /** 最多重订次数。 */
  maxReconnects: number
  /** 总硬期限（毫秒）。 */
  deadline: number
}

const RETRY_BUDGET: RetryBudget = { base: 1000, cap: 4000, maxReconnects: 4, deadline: 120_000 }

export async function followUntilTerminal(
  conversationId: string,
  { from, expectedRunId, signal, budget: budgetOverride }: FollowOptions,
  links: TurnEngineLinks = productionLinks,
  host: TurnEngineHost,
): Promise<void> {
  const budget: RetryBudget = { ...RETRY_BUDGET, ...budgetOverride }
  let after = from
  if (expectedRunId === '' || expectedRunId === undefined) {
    // 归属未知（例如提交流断在 run 头之前）：明确说明并按快照尽量收尾，
    // 不用「当前最新一轮」冒充原受理。
    host.note('这次提交的受理回执没有收到，无法确认还在跑的那一轮是否属于它；结果请以右栏任务记录为准。')
    return
  }
  const followedRunId = expectedRunId
  const deadline = Date.now() + budget.deadline
  let reconnects = 0
  const giveUp = () => { host.errorLine('事件流已断开；已收到的内容保留，终态以右栏为准。') }
  // 可中断退避：截止或取消提前唤醒；进入时信号已取消则立即退出，不空等计时器。
  // timer 先声明再赋值：done 可能被同步调度器立即调用，不能踩到初始化之前。
  const backoff = (stop: AbortSignal) => new Promise<void>(resolve => {
    if (stop.aborted) { resolve(); return }
    let timer: ReturnType<typeof setTimeout>
    const done = () => { clearTimeout(timer); stop.removeEventListener('abort', done); resolve() }
    timer = setTimeout(done, Math.min(budget.base * 2 ** reconnects, budget.cap))
    stop.addEventListener('abort', done, { once: true })
  })
  for (;;) {
    let sawReset = false
    // 截止信号：每轮按剩余期限重建，取消与到期都能中断订阅、探测与快照读取。
    const remaining = deadline - Date.now()
    if (remaining <= 0) { giveUp(); return }
    const timeout = AbortSignal.timeout(remaining)
    const stop = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    try {
      for await (const event of links.subscribe(conversationId, after, stop)) {
        if (event.type === 'run') {
          // 轮次边界：与预期不符（服务端已换轮）立即按快照收尾，不消费新轮任何事件。
          if (event.runId !== followedRunId) {
            await calibrateFromSnapshot(conversationId, stop, links, host)
            return
          }
          // 与预期一致的 run 头：游标归零、记录任务 id（store 的 apply 承担
          // consumeTurnEvent 语义），但 run 是流元事件，不产生渲染条目。
          host.apply(event)
          continue
        }
        if (event.type === 'reset') {
          sawReset = true
          continue
        }
        // 不混轮次：别的轮次的重放事件不应用；同一轮内重放的旧序号直接丢弃。
        if (event.runId !== undefined && event.runId !== followedRunId) continue
        if (event.seq !== undefined) {
          if (after > 0 && event.seq <= after) continue
          after = event.seq
        }
        if (event.type === 'summary') host.markTerminal()
        host.apply(event)
      }
      if (host.sawTerminal()) return
      const head = await links.probeHead(conversationId, stop)
      if (head === null || head.state !== 'running') {
        // 连接自然结束但没看到终态：终态多半在断连窗口里发生，按快照补结论（S06）。
        await calibrateFromSnapshot(conversationId, stop, links, host)
        return
      }
      if (head.runId !== followedRunId) {
        // 跟随的那一轮已被新的一轮接替：按快照收尾，不把新轮内容混进本次视图。
        await rebuildFromSnapshot(conversationId, stop, links, host)
        return
      }
      if (sawReset) {
        // 重建要用快照：任务标识从探测头部取——reset 流本身不带 run 头（浏览器实测发现），
        // 刷新接续时任务 id 还是空，不补这一步重建会空转。任务 id 作为 rebuild 的**输入
        // 参数**传入（评审 #24：引擎不回写宿主状态；宿主的游标由续订时重放的 run 头补齐）。
        const rebuilt = await rebuildFromSnapshot(conversationId, stop, links, host, head.taskId)
        // 快照读取失败不推进游标：保留原位，本轮按预算退避后重试重建（重订还会得到
        // reset，重建再次尝试）；只有重建成功才对齐到探测头部的窗口位置——探测与重建
        // 之间产生的事件 seq 必然更大，续订会带上，不丢也不重复重放。
        if (rebuilt && head.seq !== undefined) after = head.seq
      }
    } catch (error) {
      if (signal?.aborted === true) return
      if ((error as Error)?.name === 'AbortError') {
        if (timeout.aborted) { giveUp(); return }
        continue
      }
      // 真实网络错误：同一份退避预算，不因「流抛错」就零等待重连。
    }
    // 自然 EOF 后仍在跑（或断线）：同一份退避预算，不因「流正常结束」就零等待重连。
    reconnects += 1
    if (reconnects >= budget.maxReconnects || Date.now() > deadline) {
      giveUp()
      return
    }
    await backoff(stop)
    if (stop.aborted && signal?.aborted !== true) { giveUp(); return }
  }
}

/**
 * 按服务端快照校准终态（S06/S09）：断连期间这轮可能已经收尾，权威结论在任务记录里。
 * 快照只在没消费到 summary 时补一张终态卡，不重放整条线程。读取挂调用方的截止信号。
 */
export async function calibrateFromSnapshot(
  conversationId: string,
  stop: AbortSignal,
  links: TurnEngineLinks,
  host: TurnEngineHost,
): Promise<void> {
  try {
    const taskId = host.runTaskId()
    if (taskId === '') return
    const record = await links.taskSnapshot(taskId, stop)
    if (record.conversationId !== conversationId) return
    if (!['completed', 'failed', 'cancelled', 'partial'].includes(record.state)) return
    host.calibrate(record)
  } catch { /* 快照拿不到就保持现状：已有内容不因校准失败而清空。 */ }
}

/**
 * 按快照**重建**一轮还在跑的任务（S05 reset 校准）。返回是否成功。
 *
 * 运行中的快照同样重建：线程按快照重画，等待中的成员重新拿到回复入口，游标以重建时点
 * 之后的窗口头为准。快照读取失败不推进游标（由调用方决定重试），保留已有内容并如实说明。
 */
export async function rebuildFromSnapshot(
  conversationId: string,
  stop: AbortSignal,
  links: TurnEngineLinks,
  host: TurnEngineHost,
  /** 重建对象的任务 id（reset 后从探测头部带来）；缺省回落宿主已知的那一个。 */
  taskIdHint?: string | undefined,
): Promise<boolean> {
  const taskId = taskIdHint ?? host.runTaskId()
  if (taskId === '') return false
  try {
    const record = await links.taskSnapshot(taskId, stop)
    if (record.conversationId !== conversationId) return false
    host.rebuild(record)
    return true
  } catch {
    host.errorLine('按快照重建失败；已收到的内容保留，终态以右栏为准。')
    return false
  }
}
