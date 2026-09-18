/**
 * 协作入口：一个 Agent 被协调方派活时走的唯一通道。
 *
 * 职责分三类：
 *
 * 1. **继承既有实现**（`closedoff/src/participant.ts` 逐条对应）：授权复核与定时重核 ·
 *    独占判定 · 超时 / 中止 / 释放 · 事件投影 · conversation artifact 上报 · 上报前重核验。
 * 2. **P1 新增**：`reply` 续问（幂等身份是 `requestId`，与会话寻址分开）与
 *    `status: 'waiting'` + `question`——两个生产实现此前从未产生过等待。
 * 3. **P3 新增：闭环内建**——⑦ 程序性校验 · ⑧ 有界自修正 · 补交轮 · **待答问题的持久化**。
 *
 * ⚠️ **侧栏入口不在这里**：`ConversationProvider` 的唯一装配点是 `storage/adapter.ts`。
 * `conversation.ts` 只提供会话机制（`open` / `followup` / `list` 的机制部分），刻意不碰 kit 的
 * 会话契约——框架改契约时只需要跟 adapter 一个文件。这里也不碰它。
 *
 * 逃生通道：`mount()` 允许返回自定义的 `participant`。运行时是**默认路径**，不是唯一实现层。
 *
 * ## 收尾循环（P3 的核心）
 *
 * 一轮跑完（`turn/end`）之后不是直接交付，而是进一个**有界循环**：
 *
 * ```
 * turn/end
 *   → 投影（交活工具优先，projectResult 兜底）
 *   → 没调交活工具？→ 注入一条补交提示，再跑一轮（只补一次）
 *   → ⑦ 程序性校验 + judge
 *   → 不达标且自修正次数没用完？→ 注入一条重做提示，再跑一轮
 *   → 交付（并把待答问题落库、如实回报 selfCheck）
 * ```
 *
 * **整个循环共用一个 `turnTimeoutMs` 预算**：超时定时器只在 `cleanup()` 里清，补交轮与
 * 自修正轮都不另开预算。超时发生时把 `'timeout'` 交给收尾循环，由 `settleOnce` **无条件**
 * 决定去路；循环还没起来时（首轮进行中或尚未开始）直接整条失败——那两种情形下都**不可能**
 * 已有算好的结论，也没有循环能接住那个标记。
 *
 * **但超时不等于整条失败**：超时落在**补交轮**（运行时自己的补救动作）上、而首轮已经产出可用
 * 结论时，用那一份兜底交付（见 `handoffFallback`）——补交没跑完不该毁掉一次已经成功的交付。
 * 首轮本身超时、或自修正轮超时，仍然整条失败：那两种情况下都没有"已经成功的交付"。
 */
import type { Context } from '@deepseek-ai/cordis'
import { AccessError, type Access, type Actor, type AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
import {
  PARTICIPANT_PROTOCOL,
  type AgentParticipant,
  type ParticipantAction,
  type ParticipantActionRequest,
  type ParticipantProgress,
  type ParticipantRequest,
  type ParticipantResult,
  type ParticipantStatus,
} from './contract.ts'
import { historyOf, textOf, type AgentRuntime, type Conversation, type ConversationLifecycle, type TurnIdentity } from './conversation.ts'
import type { AgentDefinition, ProjectedResult, ResultContext } from './definition.ts'
import {
  createHandoffLedger,
  HANDOFF_RETRY_PROMPT,
  REPORT_RESULT_TOOL,
  reworkPrompt,
  type HandoffLedger,
  type TurnAttempt,
} from './handoff.ts'
import { createVisibleStream, createVisibleThinking, onAssistantDelta, type AssistantDelta } from './projection.ts'
import { runSelfCheck, toSelfCheck } from './selfcheck.ts'
import type { AgentStoragePort, OwnerKey, TurnResultRecord } from './storage/ports.ts'

export interface CreateParticipantInput {
  readonly definition: AgentDefinition
  /**
   * 运行时能力：**只收 participant 真正会读的那两样**（`ctx` 与 `lifecycle`）。
   *
   * ## 为什么只收两样，而不是整份 `AgentRuntime`
   *
   * 这里曾经写的是 `Omit<AgentRuntime, 'lifecycle'> & { lifecycle: () => ConversationLifecycle }`：
   * 形状上要求"取值器"，字段上却把整份 runtime 都摆出来。于是装配侧很自然地把**整个 runtime
   * 对象**传了进来（`runtime.lifecycle` 是**实例**不是取值器），再用一个
   * `as unknown as Parameters<typeof createParticipant>[0]['runtime']` 把类型检查关掉——
   * 结果是第一次真实回合就 `TypeError: runtime.lifecycle is not a function`（2026-09-18 生产实测）。
   *
   * 只在接口里留下真正被读的字段，那条错路就不存在了：没有 `lifecycle` 实例可以顺手传进来，
   * 形状不对是**编译错误**。`participant.ts` 读 `runtime` 的地方只有两处——构造期的 `ctx`，
   * 以及回合运行时的 `lifecycle()`。
   */
  readonly runtime: {
    readonly ctx: Context
    /**
     * 会话生命周期的**惰性取值器**，不是实例。
     *
     * 原因是装配顺序：交活工具按会话注册，它的接线点（`runtime.ts` 的 `registerScopedTools`）
     * 要拿 participant 的 `handoffFor`，而那个接线点又必须**在 lifecycle 造出来之前**交给
     * lifecycle 的 host ⇒ 装配顺序只能是"先 participant、后 lifecycle"。
     *
     * 取成函数之后，真正的读取推迟到**回合运行时**——那时装配早已完成。
     */
    readonly lifecycle: () => ConversationLifecycle
  }
  /** 可注入的存储门面；不注入时业务钩子拿到 `undefined`，工具与投影要自己处理这种情况。 */
  readonly storage?: AgentStoragePort
  readonly access: Access
  readonly config: {
    readonly turnTimeoutMs: number
    readonly authRecheckMs: number
    readonly routePrefix: string
    /**
     * 进程内幂等缓存的上界（条），缺省 256。
     *
     * 与 `RuntimeConfig` 的同名字段对应；这里只取装配真正用到的那几个，所以是独立的内联类型
     * 而不是 `RuntimeConfig` 本身 —— 加字段时**两处都要改**（这一条已经漏过一次）。
     */
    readonly settledCacheMax?: number
  }
}

/**
 * 运行时协作入口：契约之外多给交活账本。
 *
 * 多出来的属性不影响 `AgentParticipant` 契约——它是结构类型，桥接只看契约里的那几个字段。
 */
export interface RuntimeParticipant extends AgentParticipant {
  /**
   * 交活账本：装配侧注册交活工具时用它（`reportResultTool(participant.handoff)`）。
   *
   * ⚠️ 账本是**按会话**的（同一个 participant 可能同时服务多个会话，`sinks` 就是按会话的），
   * 而工具注册发生在每个 agent 创建时。所以注册路径应该用 {@link handoffFor} 拿那一个会话的
   * 账本；`handoff` 只是"最近一次用到的那个"的便捷入口，**单会话场景够用**。
   */
  readonly handoff: HandoffLedger
  /** 取某个会话的账本（没有就建一个）。 */
  handoffFor(conversationId: string): HandoffLedger
  /** 已受理过的请求身份数（诊断用；幂等缓存的大小）。 */
  readonly settledRequests: number
  /**
   * 停止这个入口：在飞轮次按 503 收尾，之后的 `run` / `reply` / `assertAccess` 一律拒绝。
   *
   * 与插件卸载走的是**同一条**清理路径（`ctx.effect` 的释放器就是它），所以先释放谁都不会漏；
   * 幂等，重复调用不抛。装配工厂（`createAgentRuntime`）的 `dispose()` 调它。
   */
  dispose(): Promise<void>
}

/** 收尾循环里一次"再跑一轮"的结论。 */
type SettleOutcome =
  | { readonly kind: 'deliver'; readonly result: ParticipantResult }
  | { readonly kind: 'retry'; readonly attempt: TurnAttempt; readonly prompt: string }

/**
 * 造一个协作入口。
 *
 * `run` 与 `reply` 共用同一条状态机，差别只有两处：**续问必须带原会话引用**（沿它续接而不是
 * 新建），以及**续问的幂等身份是 `requestId`**（`AgentReplyRequest.requestId` 必填，缺失即
 * 拒绝——回落成子任务 id 会让同一子任务的多次回话撞同一个键）。
 */
export function createParticipant(input: CreateParticipantInput): RuntimeParticipant {
  const { definition, runtime, access, config } = input
  const { ctx } = runtime
  /**
   * 会话生命周期的**惰性取值**（见 `CreateParticipantInput.runtime` 的说明）。
   *
   * 在这里**按需**解引用，而不是构造期解一次：装配顺序是"先 participant、后 lifecycle"，
   * 构造期拿到的会是占位值。每处用点都读一次 `runtime`，代价是一次属性读取。
   */
  const lifecycleOf = () => runtime.lifecycle()
  const storage = input.storage
  /**
   * 幂等缓存的上界（条）。缓存只为"进程内重试"服务，**持久化由 `dsh_turns` 承担**，所以给它一个
   * 有界窗口：不清理的话每轮都会永久留下一条完整结果，长期运行的进程会单调增长。
   */
  const settledCacheMax = config.settledCacheMax ?? 256
  let disposed = false
  const pending = new Set<() => Promise<void>>()
  /**
   * 停止这个入口：置停止标志，并让**在飞轮次**按 503 收尾（`assertAccess` 随后一律拒绝）。
   *
   * 有两条路径调它，**必须是同一个实现**：插件卸载（`ctx.effect` 的释放器）与装配工厂的
   * `dispose()`（`RuntimeParticipant.dispose`）——两条路径各写一份的话，"插件卸载时不收尾"
   * 或"工厂释放时不收尾"这种偏差只会在某一条上出现。
   *
   * **幂等**：`disposed` 只是重复置位，而 `pending` 里的 `close` 在第一次收尾时就各自调了
   * `cleanup()` 把自己摘掉，所以第二次进来是一个空集合。
   */
  const stop = async (): Promise<void> => {
    disposed = true
    await Promise.allSettled([...pending].map(close => close()))
  }
  ctx.effect(() => stop)
  /** 正在协作的业务会话 → 这一轮的增量出口。同一会话不会有两轮同时跑。 */
  const sinks = new Map<string, (delta: AssistantDelta) => void>()
  /**
   * 幂等缓存：请求身份 → 上一次的结论。
   *
   * 它是**补交轮与自修正轮的安全前提**：两者都会再注入一条 user message，如果同一个
   * `requestId` 重试时又跑一遍，就等于对同一个请求产生第二轮副作用（先例见
   * `tests/fixtures/chain-member.ts:117-122`：先查同 ID 异文、再回缓存）。
   */
  /**
   * ⚠️ **键必须含 owner**（理由见 `runTurn` 里 `settledCacheKey` 的说明）：这是**进程级**缓存，
   * 一个插件实例服务所有用户；只按 `settledKey` 分桶会变成**跨用户读取**。
   */
  const settledTurns = new Map<string, { readonly message: string; readonly result: ParticipantResult }>()
  /** 按会话分的交活账本。 */
  const ledgers = new Map<string, HandoffLedger>()
  /** 门槛缺失只警告一次：那是装配错误，不该按会话刷屏。 */
  let warnedHandoffMissing = false
  /** 中断轮次的告警也只发一次：同一进程里反复刷同一个崩溃信号没有意义。 */
  let warnedResumedTurn = false
  /** 自检结论形状非法的告警同样只发一次：那是上游的 bug，按会话刷屏只会淹掉别的信号。 */
  let warnedDamagedSelfCheck = false
  let lastLedger = createHandoffLedger()
  const ledgerOf = (conversationId: string): HandoffLedger => {
    const existing = ledgers.get(conversationId)
    if (existing !== undefined) return existing
    const created = createHandoffLedger()
    ledgers.set(conversationId, created)
    lastLedger = created
    return created
  }
  onAssistantDelta(ctx, (sessionId, delta) => { sinks.get(sessionId)?.(delta) })

  const assertAccess = (actor: Actor) => {
    if (disposed) throw new AccessError(503, `${definition.displayName}正在停止`)
    access.assert(actor)
  }
  const ownerOf = (actor: Actor): OwnerKey => ({ namespace: actor.namespace, userId: actor.userId })

  /** 结果投影：业务钩子优先，缺省用兜底投影（**"没调交活工具"不等于失败**）。 */
  const project = async (requestContext: ResultContext): Promise<ProjectedResult> => {
    // ⚠️ 缺省投影**必须自己**走一遍 `definition.redact`（见 `fallbackProjection`）：漏掉它，
    // 业务没声明 `projectResult` 时交回的 `result.text` 就是模型正文的**原文** —— 敏感值直接
    // 交给协调方，是安全口径的退步（旧实现 `closedoff/src/participant.ts` 是无条件脱敏的）。
    //
    // 反过来，业务投影那条路径**不能**在运行时再补一次脱敏：`redact` 的契约是"无状态文本变换"
    // （`definition.ts:185`），**没有承诺幂等**，而业务投影本来就按自己的口径脱敏
    // （closedoff 的投影就是 `redactVisibleText(finalText)`）。两条路径各自只脱敏一次。
    if (definition.projectResult === undefined) return fallbackProjection(requestContext, definition.redact)
    const projected = await definition.projectResult(requestContext)
    // 等待的唯一来源是 needsReply：业务给了问题但没声明要等时，不能自行把状态改成等待。
    if (projected.status === 'completed' && definition.needsReply?.(requestContext) === true) {
      return { ...projected, status: 'waiting', question: projected.question ?? fallbackQuestion(projected) }
    }
    return projected
  }

  function runTurn(request: ParticipantRequest, mode: 'run' | 'reply'): Promise<ParticipantResult> {
    // `run` 与 `reply` 分开算：子任务 id 与回话身份是两套命名空间。`settledKey` 留在 executor
    // **外面** —— 收尾循环写幂等缓存时还要用它。
    const settledKey = `${mode}:${request.requestId}`
    /**
     * ⚠️ **缓存的键必须含 owner。** `settledKey` 只在"同一个人重试"这一语义下唯一，
     * 而 `settledTurns` 是**进程级**的（一个插件实例服务所有用户）。若只按 `settledKey` 分桶，
     * 另一个 owner 只要拿到同一个 `requestId` 且正文**逐字相同**，就会拿到第一个 owner 的结论
     * （会话 id + 投影正文 + artifacts）——**那是跨用户读取**。
     * 存储层本来就按 `(agent_id, owner, request_id)` 分桶（内存见 `storage/memory.ts:104`，
     * PG 见 `storage/postgres.ts` 的部分唯一索引），这里补齐同一口径。
     */
    const settledOwner = ownerOf(request.actor)
    const settledCacheKey = `${settledOwner.namespace}\u0000${settledOwner.userId}\u0000${settledKey}`
    return new Promise<ParticipantResult>((resolve, reject) => {
      void (async () => {
        // ⚠️ 这一整段校验与幂等判断必须在 Promise **内部**。写在 `new Promise` 之前的话，它们会
        // **同步抛出**：调用方写 `.catch()` 接不住（拿到的是同步异常而不是 rejected Promise），
        // 而 `run`/`reply` 对外是异步方法 —— 契约要求失败也走 Promise。
        let message = ''
        try {
          request.signal.throwIfAborted()
          assertAccess(request.actor)
          message = request.message.trim()
          if (!message) throw new AccessError(400, '协作消息不能为空')
          if (mode === 'reply' && (request.conversationId === undefined || request.conversationId === '')) {
            // 没有原会话引用就无法"续接"：新建一个会话会让用户的话落进一条他不认识的对话里。
            throw new AccessError(400, '续问缺少原会话引用（conversationId）')
          }
          // —— 幂等：同 `requestId` 的重试直接回上一次的结论，**不重跑一轮** ——
          const cached = settledTurns.get(settledCacheKey)
          if (cached !== undefined) {
            if (cached.message !== message) {
              // 同一个身份换了内容 = 调用方把幂等身份生成错了。按契约拒绝，不静默当同一次：
              // 那会让"重试"变成"用旧结论回答新问题"。
              throw new AccessError(409, '同一请求身份不能用在不同内容上')
            }
            resolve(cached.result)
            return
          }
        } catch (error) { reject(error); return }
        let conversation: Conversation | undefined
        try {
          // 第四参数是这次派活的**任务身份**：声明了 `conversationAddressing: 'derived'` 的 Agent
          // 用它寻址会话（同一 mission 只有一条）并交叉核验 `request.conversationId`；其他 Agent
          // 上它一律被忽略（`missionKeyOf` 返回 `undefined`），行为与不传时逐字一致。
          conversation = await lifecycleOf().open(
            request.conversationId === undefined || request.conversationId === '' ? undefined : request.conversationId,
            mode === 'run',
            request.actor,
            request.missionId,
          )
        } catch (error) { reject(error); return }
        if (conversation === undefined) { reject(new AccessError(404, '会话不存在或无权访问')); return }
        const opened = conversation
        try {
          request.signal.throwIfAborted()
          assertAccess(request.actor)
          lifecycleOf().assertConversation(opened.id, request.actor)
          if (opened.active) throw new AccessError(409, '智能体正在回答上一条问题')
        } catch (error) { reject(error); return }

        let admitted = false
        let started = false
        let finished = false
        let ending = false
        let cancelled = false
        let failed = false
        let finalText = ''
        let failure: unknown
        let continuation: Promise<void> | undefined
        let unsubscribe = () => {}
        let releaseTurn = () => {}
        /**
         * 这一轮的**身份**，供后续轮次复用（补交轮 / 自修正轮）。
         *
         * ⚠️ 必须存在这一层，不能只交给生命周期的回合凭据：注入下一轮之前会先 `releaseTurn()`
         * （否则 `followup` 会以"正在回答上一条问题"拒绝），凭据一放，身份就没了 ⇒ 下一轮的
         * `onTurnStart` 收到 `turnId === undefined`。2026-09-18 生产实测：blog 的钩子当场抛
         * `BlogError: 协作入口驱动的一轮缺少行 id`，整轮失败（模型一个工具都没跑），而
         * huiyu / closedoff 因为没有这个钩子看起来一切正常。
         */
        let turnIdentity: TurnIdentity | undefined
        let sink: ((delta: AssistantDelta) => void) | undefined
        let timeout: ReturnType<typeof setTimeout> | undefined
        let recheck: ReturnType<typeof setInterval> | undefined
        /** 收尾循环是否已经启动/正在跑（超时与关闭要用它决定中断方式）。 */
        let settling = false
        /** 自修正已经用掉的次数（⑧ 的上界）。 */
        let selfRetries = 0
        /** 补交只补一次：用标志而不是计数，避免和自修正的计数混在一起。 */
        let retriedHandoff = false
        /**
         * 补交轮开始前先存下的"不再重试会交付什么"。
         *
         * 补交轮是**运行时自己的补救动作**（模型这一轮没调交活工具，运行时再问它一次）。它超时
         * 不该毁掉一次已经成功的交付：那份结果在补交之前就算好了。超时时用它兜底交付。
         * 自修正轮开始前会清掉它——那时这份结论**已经被判定不达标**，不能再拿去交。
         */
        let handoffFallback: ParticipantResult | undefined
        /** 本轮的交活账本（按会话取；补交轮与自修正轮共用同一个）。 */
        const ledger = ledgerOf(opened.id)
        // 门槛 `ledger.available` 只有装配侧注册过 `report_result` 时才为真（`handoff.ts:88-89`）。
        // 装配侧漏调 `install()` 时它**没有任何信号**：⑦ 会把"没调用工具"记成 `unverified`，而看到
        // `unverified` 的人会以为是"模型没交活"，真因却是"运行时没接线"。第一次拿到账本就警告一次。
        if (!ledger.available && !warnedHandoffMissing) {
          warnedHandoffMissing = true
          console.warn(
            `[agents-group/runtime] ${definition.id} 没有可用的 ${REPORT_RESULT_TOOL} 账本：`
            + '补交轮不会发生，⑦ 会把"没交活"记为 unverified。若这不是有意为之，'
            + '检查装配侧注册工具后是否漏调了 handoff.install()。',
          )
        }
        /**
         * `turn/end` 的交接队列。
         *
         * 补交轮与自修正轮都要"等下一轮的 `turn/end`"，所以不能像单轮那样在事件处理器里直接
         * 收尾——事件到达时先入队，再由收尾循环按顺序取。
         */
        const turnEnds: string[] = []
        let turnEndWaiter: ((reason: string) => void) | undefined
        const pushTurnEnd = (reason: string): void => {
          const waiter = turnEndWaiter
          if (waiter !== undefined) { turnEndWaiter = undefined; waiter(reason); return }
          turnEnds.push(reason)
        }
        const waitTurnEnd = (): Promise<string> => {
          const ready = turnEnds.shift()
          if (ready !== undefined) return Promise.resolve(ready)
          return new Promise(resolveTurnEnd => { turnEndWaiter = resolveTurnEnd })
        }

        // 正文与思考各走一条通道：正文是面向用户的回答，思考是业务那套脱敏投影。
        // 两条通道的变换都由业务提供（纯函数），时序与节流在这里。
        const visible = createVisibleStream(text => { report({ kind: 'delta', delta: text }) }, definition.redact)
        const thinking = createVisibleThinking(
          text => { report({ kind: 'thinking', thinking: text }) },
          definition.projectReasoning,
          definition.liveMode ?? 'delta',
        )

        const cleanup = () => {
          finished = true
          thinking.clear()
          if (sink !== undefined && sinks.get(opened.id) === sink) sinks.delete(opened.id)
          unsubscribe()
          clearTimeout(timeout)
          clearInterval(recheck)
          request.signal.removeEventListener('abort', cancel)
          pending.delete(close)
          releaseTurn()
          // ⚠️ `releaseTurn()` 只对**首轮**有效：第 2 轮起它已被重置成空函数，而那一轮的
          // `active` 是 `followup` 自己置上的——只有 `finish()` 会放掉它。少了这一句，凡是
          // 走过第 2 轮的交付（补交轮 / 自修正轮 / 超时兜底）都会把会话永久留在"运行中"：
          // 同会话的 `run` 与 `reply` 此后一律 409「正在回答上一条问题」，而 `reserveSlot`
          // 只驱逐 `!active` 的会话 ⇒ 它同时永久占住一个 `maxActiveConversations` 槽位。
          // **实测**：单轮交付后 `isBusy=false`，走两轮的交付 `isBusy=true` 且同会话下一轮 409。
          //
          // `outcome` 只喂给业务的 `onTurnFinish`：**只有协作入口知道**这一轮是正常结束、被取消
          // 还是失败（页面入口与其它 `finish` 调用方只做"放掉占用"，没有失败的语义）。三个标志
          // 里 `failed` 优先——一次 `fail` 之后再被取消，结论仍然是"失败"。
          lifecycleOf().finish(opened.id, failed ? 'failed' : cancelled ? 'cancelled' : 'completed')
        }
        const fail = (error: unknown) => {
          if (finished || failed) return
          failed = true; failure = error
          if (admitted) lifecycleOf().abort(opened.id)
          // **一律在这里给出结论**，不再分 `settling` / `started` 两种情形：
          //  · `settling` 时收尾循环可能挂在 `waitTurnEnd()` 上——那一轮的 `turn/end` 可能永远不来；
          //  · 首轮已经开跑（`started && !settling`）时循环还没起来，而宿主**不保证**在 `abort`
          //    之后补一个 `turn/end`：不补就是永久挂起（实测 900ms 仍 pending），补了则会把它
          //    交付成"用户取消"，与文件头"首轮超时整条失败"的契约相反。
          // 两种情形下都只有这里能收尾——原实现只在 `settling` 或 `!started` 时收尾，于是
          // "首轮进行中失败"既不交付也不失败，**静默挂起**。
          cleanup(); reject(error)
        }
        const cancel = () => {
          if (finished) return
          cancelled = true
          if (admitted) lifecycleOf().abort(opened.id)
          if (!started) { cleanup(); reject(request.signal.reason) }
        }
        const close = async () => {
          if (finished) return
          cancelled = true
          if (admitted) lifecycleOf().abort(opened.id)
          try { if (started) { await continuation; await opened.handle.agent.whenIdle() } } catch { /* 关闭时统一报告插件已停止。 */ }
          if (!finished) { cleanup(); reject(new AccessError(503, '插件已停止')) }
        }
        pending.add(close)
        const assert = () => { assertAccess(request.actor); lifecycleOf().assertConversation(opened.id, request.actor) }
        /** 实时上报：每条都在当前授权与归属下重新核验，失败按回合失败处理。 */
        const report = (value: ParticipantProgress) => {
          assert()
          request.onProgress(value)
        }
        const progress = (text: string) => {
          report({ kind: 'status', text, conversationId: opened.id })
        }
        sink = delta => {
          if (finished || ending || cancelled || failed || !admitted || !started) return
          const chunk = delta.chunk
          try {
            if (chunk.type === 'text-delta') visible.push(chunk.text)
            else if (chunk.type === 'reasoning-delta') thinking.push(delta.step, chunk.text)
          } catch (error) { fail(error) }
        }

        /** 等会话真正空闲（`finish` 的异步收尾把 `active` 放掉）；有界，不会挂住。 */
        const waitUntilIdle = async (): Promise<void> => {
          for (let step = 0; step < 50; step += 1) {
            await opened.handle.agent.whenIdle()
            // 直接看这个会话对象自己的占用标志：`lifecycle.isBusy(id)` 还包含"正在打开"与
            // "正在分支"，那两个在补交轮里不该出现，用它会掩盖真正的异常。
            if (!opened.active) return
            await new Promise(resolveTick => setTimeout(resolveTick, 0))
          }
          // 等不到就**明确报错**，而不是带着 `active = true` 去 `followup`——那样拿到的是一条
          // "智能体正在回答上一条问题"的 409，它会把人引向"并发冲突"，而真因是这里没收尾。
          throw new Error('会话没有回到空闲，无法续发下一轮')
        }

        /**
         * 待答问题的持久化（`waiting` 的载体）。**两条交付路径共用这一处**：正常交付与超时兜底。
         *
         * ⚠️ 这一处接线曾经缺失：接口（`TurnStorePort`）与实现（`storage/postgres.ts`）都有、
         * 两侧的测试各自绿，但运行时**从不调用它**。后果是重启之后子任务**永远停在
         * `waiting_user`**——不报错、静默不动，而协调侧的 `prepareReply` 只会报
         * `waiting_expired`（"重启后仍能恢复在等什么"是协调侧的硬要求）。
         * 非 `waiting` 的那一轮必须**清空**：否则上一轮的问题会被下一轮读回来。
         *
         * **抽成函数而不是留在调用处**：超时兜底那条路径曾经整段跳过它，于是"首轮投影是
         * `waiting`、补交轮又超时"会交回一个带 `question` 的结果，而 PG 里什么都没有——
         * 协调方进了 `waiting_user`，重启后却读不到"在等什么"。
         */
        const persistPendingQuestion = async (
          value: { readonly status: ParticipantStatus; readonly question?: string | undefined },
        ): Promise<void> => {
          if (storage === undefined) return
          await storage.db.turns.setPendingQuestion(
            ownerOf(request.actor), opened.id, value.status === 'waiting' ? value.question : undefined,
          )
        }

        /**
         * 跑完一轮的收尾判定：投影 → ⑦ → ⑧ → 交付或再来一轮。
         *
         * ⚠️ **"没调交活工具"不等于失败**：先补交一次；补交后仍未调，就按投影的兜底交付，
         * 并把 `report-called` 如实标成"未核验"。这是 §4.3 的明确要求——blog 现在的完成
         * 判定本来就来自客观投影，改成"没调工具就判失败"是语义降级。
         */
        const settleOnce = async (reason: string): Promise<SettleOutcome> => {
          // 超时：**无条件**在这里定去路，不看兜底在不在。
          //  · 有兜底（补交轮已经开始、首轮结论已经算好）⇒ 用那一份兜底交付；
          //  · 没有兜底 ⇒ 如实整条失败（抛出去由 `settleLoop` 收成 reject）。
          // ⚠️ 不能写成"没有兜底就继续走下面的普通分支"：`'timeout'` 既不是 `'aborted'` 也不是
          // `'completed'`，`status` 会被算成 `failed` —— 于是交付一份正文是"未能完成本回合"的
          // 结果，**首轮已经跑完的结论一个字都不出现**，还把自修正轮又跑起来；而那个一次性定时器
          // 已经烧掉了，自修正额度未尽时就**既不交付也不失败**（红队实测：预算 300ms 却跑了
          // 1240ms；把额度调大后 2.6s 仍 pending）。
          if (reason === 'timeout') {
            const fallback = handoffFallback
            handoffFallback = undefined
            if (fallback === undefined) throw new Error('协作超时')
            // 待答问题与正常交付**同源落库**，否则"重启后仍能恢复在等什么"在兜底路径上不成立。
            await persistPendingQuestion(fallback)
            return { kind: 'deliver', result: fallback }
          }
          const aborted = cancelled || reason === 'aborted'
          const status: ParticipantStatus = aborted
            ? 'cancelled'
            : reason === 'completed' && finalText.trim() ? 'completed' : 'failed'
          const history = historyOf(lifecycleOf().events(opened), opened.id)
          if (status === 'completed') { thinking.finish(); visible.finish() }
          const fallbackText = status === 'completed' ? (definition.redact?.(finalText) ?? finalText)
            : status === 'cancelled' ? '协作已取消。' : `${definition.displayName}未能完成本回合，请查看原会话。`
          /**
           * 读**本轮**的结果记录（`dsh_turn_results`）。
           *
           * 惰性（业务不读就不查库）+ **记忆化**（同一轮里读两次不该查两次）。按 `settledKey`
           * 查行 id——那是与 `claim` **同一个**幂等身份（含 `run:`/`reply:` 前缀），所以查到的
           * 就是这一轮的 turn 行。
           */
          let resultsCache: Promise<readonly TurnResultRecord[]> | undefined
          const loadResults = (): Promise<readonly TurnResultRecord[]> => {
            resultsCache ??= (async () => {
              if (storage === undefined) return []
              const owner = ownerOf(request.actor)
              const turnId = await storage.db.turns.turnId(owner, settledKey)
              if (turnId === undefined) return []
              return storage.db.turns.turnResults(owner, turnId)
            })()
            return resultsCache
          }
          const context: ResultContext = {
            history,
            // 每请求的 actor：投影要"按 owner 读业务库"时必须用它派生 owner 键（见 `ResultContext`）。
            actor: request.actor,
            request: {
              message,
              ...(request.acceptance === undefined ? {} : { acceptance: request.acceptance }),
              ...(request.reworkOf === undefined ? {} : { reworkOf: request.reworkOf }),
            },
            storage,
            loadResults,
          }
          const taken = ledger.take()
          /**
           * 结论有**两个来源**，各自管哪些字段是有分工的。
           *
           * - **模型交回的**（`report_result`）：正文、状态、问题。它知道这一轮干了什么，
           *   但它**复述不出结构化事实**——用户在生产上看到的就是这个后果：模型说
           *   "发布确认卡片已生成"，而卡片上一个按钮都没有，因为 `actions` 是空的。
           * - **业务投影**（`definition.projectResult`）：`actions` / `artifacts` /
           *   `externalPending`。**只有业务**知道有哪些待确认操作、材料放在哪、
           *   还等谁做什么（博客那张确认卡片的 id/字段/有效期全在业务库里）。
           *
           * 所以模型交活时**也要跑一次投影**，把结构化字段按业务的来；模型只保留它对正文与
           * 状态的判断。合并规则见 {@link mergeBusinessFacts}。投影抛错**不牵连交付**：
           * 那一轮正文已经拿到了，降级成"没有结构化字段"并留下告警。
           */
          const businessFacts = taken.result !== undefined && status === 'completed'
            ? await project(context).catch((error: unknown) => {
              console.warn(`[agents-group/runtime] ${definition.id} 的 projectResult 在模型交活后抛错（本轮仍按模型交回的内容交付）：`, error)
              return undefined
            })
            : undefined
          // **交活工具的结果优先，投影兜底**：模型没交活时才整份走投影。
          const projected: ProjectedResult = taken.result === undefined
            ? (status === 'completed' ? await project(context) : { status, text: fallbackText })
            : mergeBusinessFacts(taken.result, businessFacts)

          /**
           * 把"这一轮的投影 + ⑦ 的汇总结论"组装成要交回协调方的结果。
           *
           * 它有两个调用点：正常交付，以及补交轮超时的兜底交付（`handoffFallback`）。必须是
           * 同一份组装逻辑，否则兜底交付会悄悄少字段。
           */
          const resultOf = (selfCheck: AgentSelfCheck): ParticipantResult => ({
            status: projected.status,
            conversationId: opened.id,
            text: projected.text === '' ? fallbackText : projected.text,
            ...(projected.question === undefined ? {} : { question: projected.question }),
            ...(projected.artifacts === undefined ? { artifacts: [conversationArtifact(opened.id)] } : { artifacts: projected.artifacts }),
            ...(projected.externalPending === undefined ? {} : { externalPending: projected.externalPending }),
            // 待确认的操作：与 artifacts 一起上交给协调方，让它就地渲染确认卡（不再逼用户跳页面）。
            ...(projected.actions === undefined || projected.actions.length === 0 ? {} : { actions: projected.actions }),
            // 回报给协调方的是**运行时跑完 ⑦ 与 ⑧ 之后的汇总**，不是业务自报的那一份。
            selfCheck,
          })

          // —— ⑦ 程序性校验 ——
          // ⚠️ 它排在**补交轮判断之前**：补交轮要顺手把"不再重试会交付什么"存成兜底，而那份
          // 结果必须带着 ⑦ 的结论。`runSelfCheck` 是纯函数——不读时钟、不碰存储、不花模型调用。
          const outcome = runSelfCheck({
            result: projected,
            acceptance: request.acceptance,
            selfCheck: projected.selfCheck,
            reported: taken.called,
          })

          // 自检结论**形状非法**（`status` 拼错、缺字段、不是对象、是 `null`）是**上游的 bug**，
          // 与"这个执行方没有自检能力"是两件事：⑦ 之外再发一次告警（只发一次，不按会话刷屏），
          // 否则一个写错的枚举值只会留下一条 `absent`，谁也看不出上游写错了。
          if (outcome.selfCheck === 'damaged' && !warnedDamagedSelfCheck) {
            warnedDamagedSelfCheck = true
            console.warn(
              `[agents-group/runtime] ${definition.id} 回报的自检结论形状非法（status 拼错、缺字段、`
              + '不是对象或为 null）：已如实按"未核验"处理，不猜成通过。请检查执行方回报 selfCheck 的地方。',
            )
          }

          // —— 补交轮：这一轮正常跑完、但模型**能**交活却没交 ——
          // 只补一次；取消与失败没有可补的结论，不补；**没接线（工具没注册）也不补** ——
          // 那时模型手里没有那个工具，补交只会让它把同一件事再答一遍，白花一轮预算。
          if (!taken.called && status === 'completed' && !retriedHandoff && ledger.available) {
            retriedHandoff = true
            // 补交轮超时时的兜底：这一份结论已经算好了，不该因为运行时自己的补救动作没跑完而
            // 被丢掉（P3 红队攻击 3）。⑦ 的 `report-called` 本就是 `unverified`（这一轮确实
            // 没调交活工具），如实带上，不冒充通过。
            handoffFallback = resultOf(toSelfCheck(outcome))
            return { kind: 'retry', attempt: 'report_retry', prompt: HANDOFF_RETRY_PROMPT }
          }

          // —— ⑧ 有界自修正 ——
          const judged = definition.judge === undefined
            ? undefined
            : await definition.judge({ result: projected, acceptance: request.acceptance })
          const needsRework = outcome.failed || judged?.ok === false
          const maxSelfRetries = Math.min(Math.max(definition.maxSelfRetries ?? 1, 0), 3)
          if (needsRework && !aborted && selfRetries < maxSelfRetries) {
            // 首轮结论到这一步**已经被判定不达标**，不能再当作超时兜底交出去——那会把一次不达标
            // 的交付伪装成"运行时没来得及补救"。自修正轮超时就整条失败，如实说没跑完。
            handoffFallback = undefined
            const why = judged?.reason?.trim()
            const finding = outcome.findings.find(item => item.verdict === 'failed')?.detail
            return { kind: 'retry', attempt: 'self_retry', prompt: reworkPrompt(why !== undefined && why !== '' ? why : (finding ?? '')) }
          }

          // —— 重试用完仍有不达标 → 如实标 `failed` ——
          // 不能只报 ⑦ 的结论：⑦ 里可能全是"未核验"（业务没自检、这一步没有口径），而
          // `judge` 的不达标是**业务判定**，它不该因为 ⑦ 没拦住就消失——那样协调方会以为
          // 这一步只是"没顾上核验"，而实际上它已经被判定为不合格。
          const selfCheck = needsRework
            ? {
              status: 'failed' as const,
              detail: [
                judged?.ok === false ? (judged.reason?.trim() ?? '业务判定不达标') : '',
                outcome.findings.filter(item => item.verdict === 'failed').map(item => item.detail).join('；'),
              ].filter(text => text !== '').join('；'),
            }
            : toSelfCheck(outcome)

          // —— 待答问题的持久化（`waiting` 的载体）——
          // 落库口径与"为什么抽成函数"写在 `persistPendingQuestion` 上，这里只把这一轮的投影交给它。
          await persistPendingQuestion(projected)

          return { kind: 'deliver', result: resultOf(selfCheck) }
        }

        /**
         * 收尾循环：一轮结束后决定"交付"还是"再来一轮"。
         *
         * 循环的每一步都受同一个超时预算约束（见文件头），并且**有界**：
         * 补交最多一次（`retriedHandoff`），自修正最多 `maxSelfRetries` 次。
         */
        const settleLoop = async (): Promise<void> => {
          try {
            // 首轮：等注入的 followup 真正结束、再等 driver 空闲，才能安全地再注入。
            await continuation
            await opened.handle.agent.whenIdle()
            for (;;) {
              if (finished) return
              const reason = await waitTurnEnd()
              if (finished) return
              assert()
              const outcome = await settleOnce(reason)
              if (outcome.kind === 'deliver') {
                cleanup()
                settledTurns.set(settledCacheKey, { message, result: outcome.result })
                // 先进先出淘汰：`Map` 的迭代顺序就是插入顺序，第一个键即最旧的一条。
                // 淘汰掉的只是"进程内回放"能力，重启后的幂等仍由 `dsh_turns` 保证。
                while (settledTurns.size > settledCacheMax) {
                  const oldest = settledTurns.keys().next().value
                  if (oldest === undefined) break
                  settledTurns.delete(oldest)
                }
                // ⚠️ `finish` 必须在 `resolve` **之前**：反过来的话调用方一拿到结果就可能退出
                // 进程，状态停在 `claimed`，下次重试会被判成"中断可重跑"——而它其实已经交付过
                // ⇒ 又是重复副作用。`claim` 与 `finish` 必须成对落地：`dsh_turns` 里的 `claimed`
                // 行没有任何清理或翻转机制（`failStalePending` 翻的是会话围栏，不是它）。
                if (storage !== undefined) {
                  await storage.db.turns.finish(ownerOf(request.actor), settledKey)
                }
                resolve(outcome.result)
                return
              }
              if (outcome.attempt === 'self_retry') selfRetries += 1
              // 释放本轮占用，否则 `followup` 会以"正在回答上一条问题"拒绝注入。
              //
              // ⚠️ 两件事都要做，缺一不可：`releaseTurn()` 只对**首轮**有效（它持有的凭据在
              // 第一次调用后就作废了，`retainTurn` 不会再被调用）；而第 2 轮起 `active` 是
              // `followup` 自己置上的，只有 `finish()` 会把它放掉。少了 `finish()`，"补交一次"
              // 能过、**"补交两次以上"就会 409**——本轮的多轮自修正用例正是这么抓到的。
              releaseTurn()
              releaseTurn = () => {}
              // ⚠️ `notify: false`：这一轮**还没有结束**，这里只是为了能注入下一轮而释放占用。
              // 缺省通知会让业务每注入一轮就收到一次假的"回合结束"，而它会据此解除绑定、写终态
              // ——把一个仍在跑的回合记成已结束。
              lifecycleOf().finish(opened.id, 'completed', { notify: false })
              await waitUntilIdle()
              if (finished) return
              // 新一轮：重置这一轮的观测状态（交活账本、正文、回合标记）。
              ledger.reset()
              ending = false
              started = false
              finalText = ''
              try {
                // ⚠️ 身份必须显式带上：补交轮/自修正轮与首轮**属于同一轮**（同一个 `requestId`、
                // 同一行 id），而上面刚 `releaseTurn()` 放掉了携带来历的回合凭据。
                await lifecycleOf().followup(opened, outcome.prompt, request.actor, turnIdentity)
                await opened.handle.agent.whenIdle()
              } catch (error) { cleanup(); reject(error); return }
            }
          } catch (error) { cleanup(); reject(error) }
        }

        // 不加显式注解：`session/event` 的载荷类型由官方包的事件增强提供，覆盖注解会把
        // `session` 变成隐式 any，也让 `event.type` 的收窄失效。
        unsubscribe = ctx.on('session/event', (session, event) => {
          if (String(session.id) !== opened.id || finished || ending || !admitted) return
          if (event.type === 'turn/start') started = true
          if (!started) return
          if (event.type === 'turn/end') {
            // `turn/end` 先于 driver 退出。事件只入队，收尾（含补交轮与自修正轮）全部在
            // `settleLoop` 里做——那里才能安全地 await 并再注入一条 user message。
            ending = true
            pushTurnEnd(event.data.reason.kind)
            if (!settling) { settling = true; void settleLoop() }
            return
          }
          if (failed || cancelled) return
          try {
            assert()
            if (event.type === 'assistant/message') {
              finalText = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
            } else if (event.type === 'assistant/attempt') {
              // 失败、重试或取消的尝试：它的推理不能留在思考快照里。
              thinking.discard(event.data.step)
            } else if (event.type === 'tool/result') {
              // 工具结果里的业务主键不能出现在思考正文里——**这是安全钩子，不是展示细节**。
              const opaque = definition.opaqueFromToolResult
              if (opaque !== undefined) {
                const block = event.data.message.content[0]
                if (block !== undefined) thinking.hide(opaque(textOf(block.content), event.data.meta))
              }
              progress('查询步骤已返回。')
            } else if (event.type === 'tool/call') {
              progress(definition.stageText?.(event) ?? '正在执行。')
            }
          } catch (error) { fail(error) }
        }, { global: true })
        request.signal.addEventListener('abort', cancel, { once: true })
        recheck = setInterval(() => { try { assert() } catch (error) { fail(error) } }, config.authRecheckMs)
        recheck.unref()
        // 整个收尾循环共用这一个预算：补交轮与自修正轮都不另开定时器。
        timeout = setTimeout(() => {
          if (settling) {
            // 收尾循环已经在跑 ⇒ 把 `'timeout'` 交给它，由 `settleOnce` **无条件**定去路
            // （有兜底就兜底交付，没有就整条失败）。**不在这里看"此刻有没有兜底"**：
            // 循环可能正挂在 `await project` / `await judge` 这类业务钩子上，标记只能先压在
            // 队列里、等下一轮才被取到；而下一轮也许已被判定为要自修正（兜底同时被清掉），
            // 标记就会以"普通 reason"的身份参与状态判定，交出一份**首轮正文一个字都没有**的
            // "这一轮失败"（红队实测 1240ms / 预算 300ms），自修正额度未尽时还会因为一次性
            // 定时器已烧掉而**既不交付也不失败**（实测 2.6s 仍 pending）。
            //
            // 先入队再 `abort`：补交轮可能正在跑，不打断它就还会继续产生副作用；而 `'timeout'`
            // 必须排在它的 `turn/end` 之前——否则循环拿到的是 `'aborted'`，那份结论又会被当成
            // "用户取消"。
            pushTurnEnd('timeout')
            if (admitted) lifecycleOf().abort(opened.id)
            return
          }
          // 循环还没起来（首轮进行中或尚未开始）：此刻**不可能**已有算好的结论可兜底，也没有
          // 循环能接住标记 ⇒ 直接在这里整条失败，而不是把标记放进队列等一个可能永不推进的循环。
          fail(new Error('协作超时'))
        }, config.turnTimeoutMs)
        timeout.unref()
        void (async () => { try {
          request.signal.throwIfAborted()
          assert()
          request.onProgress({
            kind: 'status', text: '已接单。', conversationId: opened.id,
            conversationArtifact: conversationArtifact(opened.id),
          })
          request.signal.throwIfAborted()
          assert()
          if (opened.active) throw new AccessError(409, '智能体正在回答上一条问题')
          // —— 轮次幂等（落 `dsh_turns`）：同一个 `requestId` 在**重启之后**也只跑一轮 ——
          // ⚠️ 这一处接线曾经缺失，与上面 `setPendingQuestion` 是同一家族的另一处：接口
          // （`TurnStorePort.claim`）与实现（`PgTurns.claim`）都在、两侧测试各自绿，但运行时
          // **从不调用它**。后果是进程重启后**整轮重放**、重复产生外部副作用，而且**静默**。
          //
          // 位置被两头钉死，不能挪：
          //  · 不能放早 —— `dsh_turns.conversation_id` 是 NOT NULL + 外键，会话要到
          //    `lifecycle.open()` 才存在（放早直接 23503）；也不能放到上面那条 `opened.active`
          //    校验之前，否则一个已被判 409/401/404、从未执行的轮次会被登记成"已结算"。
          //  · 不能放晚 —— `retainTurn`/`followup` 一执行，消息已注入、模型已开跑，外部副作用
          //    已经发生，此时再 claim 只能丢结果，白烧一次调用。
          //
          // `settledKey`（含 `run:`/`reply:` 前缀）整体当作 `requestId`：这样 DB 里就是两个不同
          // 身份，与现有"`run` 与 `reply` 分开算"逐字一致；传裸 `requestId` 会让两者互相冲突。
          /**
           * 这一轮的**行 id**：`claim` **不返回它**（那个返回值被存储契约测试固化），要用
           * `turns.turnId(owner, settledKey)` **回查一次**。查到的值随回合钩子下传
           * （`TurnHookContext.turnId`），业务按它把自己的记账绑到**这一轮**上、并把结构化产出
           * 写进 `dsh_turn_results`（`turn_id` 要的正是行 id，不是幂等键）。
           *
           * ⚠️ **只在这里查一次**：`onTurnStart` 与 `turnContext` 在同一轮里都会跑，各查一次就是
           * 白烧往返。运行时把它存进回合凭据，三个钩子共用同一份（见 `retainTurn` 的 `identity`）。
           * ⚠️ 查不到就**如实给 `undefined`**（未注入存储、或这一行还没落地），不编一个：
           * 编出来的行 id 会让业务的写入落到别人/不存在的轮次上，而数据库**没有**指向 `dsh_turns`
           * 的外键（`dsh_turn_results` 只挂了 `conversation_id`），写错**不会报错**、只会查不出来。
           */
          let turnId: string | undefined
          if (storage !== undefined) {
            const owner = ownerOf(request.actor)
            const verdict = await storage.db.turns.claim(owner, opened.id, settledKey, message)
            turnId = await storage.db.turns.turnId(owner, settledKey)
            if (verdict === 'duplicate') {
              const status = await storage.db.turns.turnStatus(owner, settledKey)
              if (status === 'finished') {
                // 已经交付过 ⇒ 重跑会重复外部副作用，必须显式拒绝，不能静默再来一遍。
                throw new AccessError(409, '这一轮已经结算过（同一个请求标识）')
              }
              // `claimed` ⇒ 上一轮认领后崩在半路，那是**中断**而不是"已结算"，允许重跑。
              // `claim` 自己分辨不出这两者 —— 这就是它必须与 `turnStatus` 成对使用的原因。
              if (!warnedResumedTurn) {
                warnedResumedTurn = true
                console.warn(
                  `[agents-group/runtime] ${definition.id} 遇到中断的轮次（${settledKey}）：`
                  + '上一轮认领后没有结算完，本轮会重跑，外部副作用可能因此发生两次。',
                )
              }
            }
          }
          /**
           * 把这一轮的**身份**交给生命周期：它随三个回合钩子（`onTurnStart` / `turnContext` /
           * `onTurnFinish`）原样下传，业务据此把"按回合的业务绑定"与"结构化产出的落点"绑到**这一轮**上。
           * ⚠️ 缺省字段用**条件展开**而不是写 `undefined`（`exactOptionalPropertyTypes`，且业务按
           * "属性在不在"判断有没有身份）。
           */
          turnIdentity = {
            requestId: settledKey,
            ...(turnId === undefined ? {} : { turnId }),
          }
          releaseTurn = lifecycleOf().retainTurn(opened, request.actor, turnIdentity)
          admitted = true
          sinks.set(opened.id, sink!)
          continuation = lifecycleOf().followup(opened, message, request.actor)
          await continuation
        } catch (error) {
          if (finished) return
          if (admitted) {
            // ⚠️ 用 `abortHeldTurn(opened)` 而不是 `abort(opened.id)`：失败到达时这个会话上的
            // **当前**回合可能已经不是这一轮的了（这一轮的回合被页面入口的 `cancel` 摘掉、或已被
            // 后续轮次取代），而 `abort(id)` 取消的正是"此刻的当前回合" —— 那会取消到别人的回合
            // 上，或对同一个 driver 补一次无人需要的取消。守卫用这一轮的回合凭据判定，见
            // `ConversationLifecycle.abortHeldTurn`。
            lifecycleOf().abortHeldTurn(opened)
            try { if (started) await opened.handle.agent.whenIdle() } catch { /* 保留原始接续错误。 */ }
          }
          if (!finished) { cleanup(); reject(error) }
        } })()
      })()
    })
  }

  /** 会话材料定位：告诉用户在哪能看到这场对话。 */
  const conversationArtifact = (conversationId: string) => ({
    kind: 'conversation' as const,
    title: '查看会话',
    path: `${config.routePrefix}?conversationId=${encodeURIComponent(conversationId)}`,
  })

  /**
   * 列出待确认的操作（刷新后补画）。
   *
   * **只走业务实现**：运行时不自己推断"哪个操作还没办"——那属于业务状态（博客的操作记录在
   * 它自己的库里）。没实现就如实返回空数组，协调方只显示它已经收到的那一份，不编造。
   */
  const listActions = async (owner: string, actor: Actor): Promise<readonly ParticipantAction[]> => {
    assertAccessAllowed(actor)
    if (definition.listActions === undefined) return []
    return await definition.listActions({ actor, owner, storage })
  }

  /**
   * 执行用户对一条操作的决策。
   *
   * 三件事按顺序做，缺一不可：
   * 1. **权限与停止状态**：与 `run`/`reply` 同一个 `assertAccess`（插件被停用、权限被撤之后
   *    一律拒绝）；
   * 2. **交给业务**：`definition.applyAction` 自己核验归属并执行（凭据在它自己的记录里，
   *    **不经协调方、也不经模型**）；
   * 3. **结果照原样上交**：返回的是一个完整的 {@link ParticipantResult}，因此执行完之后
   *    新的待办（或没有待办）会自动回到协调方，不需要另一条通路。
   */
  const applyAction = async (request: ParticipantActionRequest): Promise<ParticipantResult> => {
    assertAccessAllowed(request.actor)
    request.signal.throwIfAborted()
    if (definition.applyAction === undefined) {
      throw new AccessError(409, `${definition.displayName} 没有实现就地确认，请到它的页面里办理`)
    }
    if (disposed) throw new AccessError(503, '这个协作入口正在停止')
    const result = await definition.applyAction({
      actionId: request.actionId,
      decision: request.decision,
      ...(request.note === undefined ? {} : { note: request.note }),
      taskId: request.taskId,
      subtaskId: request.subtaskId,
      actor: request.actor,
      ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
      storage,
      signal: request.signal,
    })
    // 业务返回的是"投影形状"（与 `projectResult` 同形），这里补上会话引用后按同一口径上交。
    const fallbackText = result.text === '' ? '操作已处理。' : result.text
    return {
      status: result.status,
      conversationId: request.conversationId ?? '',
      text: fallbackText,
      ...(result.question === undefined ? {} : { question: result.question }),
      ...(result.artifacts === undefined ? {} : { artifacts: result.artifacts }),
      ...(result.externalPending === undefined ? {} : { externalPending: result.externalPending }),
      ...(result.actions === undefined || result.actions.length === 0 ? {} : { actions: result.actions }),
      // 就地确认不是模型跑的一轮：自检结论按"这一轮没有可核验产出"如实标，不冒充通过。
      selfCheck: { status: 'unverifiable', detail: '这是用户对已准备操作的确认，不是一次模型回合。' },
    }
  }

  /** 与 `run`/`reply` 同一道权限与停止检查（抽出来避免三处各写一份）。 */
  const assertAccessAllowed = (actor: Actor): void => {
    assertAccess(actor)
    if (disposed) throw new AccessError(503, '这个协作入口正在停止')
  }

  return {
    protocol: PARTICIPANT_PROTOCOL,
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    assertAccess,
    run: request => runTurn(request, 'run'),
    reply: request => runTurn(request, 'reply'),
    listActions,
    applyAction,
    get handoff() { return lastLedger },
    handoffFor: conversationId => ledgerOf(conversationId),
    get settledRequests() { return settledTurns.size },
    dispose: stop,
  }
}

/**
 * 缺省的结果投影：按回合结局判定，正文取最终消息。
 *
 * 正文**一律过一遍 `definition.redact`**（未声明时原样返回）：这条路径与业务投影是并列的
 * 两条交付来源，脱敏不能只做在业务那一侧。`redact` 只在这里调一次——调用方（`project`）
 * 对业务投影的返回值不做任何改写，所以交付正文恰好脱敏一次。
 *
 * 结局判定看的是**脱敏前**的正文：脱敏把整段正文清空（全敏感）时，那一轮仍然是"模型答了"，
 * 不该被记成 `failed`。
 */
function fallbackProjection(context: ResultContext, redact?: (text: string) => string): ProjectedResult {
  const text = context.history.finalText.trim()
  if (text === '') return { status: 'failed', text: '没有拿到可交付的结果。' }
  return { status: 'completed', text: redact === undefined ? text : redact(text) }
}

/**
 * 把**业务的结构化事实**合并进模型交回的结论。
 *
 * ## 为什么必须合并，而不是"模型交活了就不看投影"
 *
 * 交活工具是模型**口头**交回的一份摘要；而 `actions` / `artifacts` / `externalPending`
 * 是**结构化事实**，只有业务知道。让模型转述它们等于让信息不在手的一方替在手的一方回答——
 * 生产上就是这么丢的：模型说"发布确认卡片已生成"，而卡片上一个按钮都没有（`actions` 空），
 * 用户守着一条永远点不了的发布确认。
 *
 * ## 合并规则
 *
 * | 字段 | 谁说了算 | 为什么 |
 * | --- | --- | --- |
 * | `text` / `question` | 模型 | 它知道这一轮实际做了什么，投影的正文常是兜底拼的 |
 * | `actions` / `artifacts` / `externalPending` | 业务投影 | 结构化事实，模型复述不可靠 |
 * | `status` | 模型，**但被业务事实校正** | 有待确认操作/材料时不能报 `completed` |
 *
 * ⚠️ 最后一条是"诚实归类"：模型看不见 `actions`，它说"完成"只是因为它把正文写完了；
 * 而业务手里还压着一条没办的发布确认。这种时候报完成会让用户以为事情结束了。
 *
 * @param model 模型交回的结论（`report_result`）
 * @param facts 业务投影的结论；投影没跑或抛错时为 undefined（降级：保持模型那一份）
 * @returns 合并后的结论
 */
function mergeBusinessFacts(model: ProjectedResult, facts: ProjectedResult | undefined): ProjectedResult {
  if (facts === undefined) return model
  const actions = facts.actions === undefined || facts.actions.length === 0 ? undefined : facts.actions
  const artifacts = facts.artifacts === undefined || facts.artifacts.length === 0 ? undefined : facts.artifacts
  const merged: ProjectedResult = {
    ...model,
    ...(actions === undefined ? {} : { actions }),
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(facts.externalPending === undefined ? {} : { externalPending: facts.externalPending }),
  }
  // 有待确认操作或外部待办时，"完成"是错的：事情还有一步在用户手里。
  if (merged.status === 'completed' && (actions !== undefined || facts.externalPending !== undefined)) {
    return { ...merged, status: 'external_pending' }
  }
  return merged
}

/** `needsReply` 声明要等、但投影没给问题时，用一句兜底问题，避免用户面对一个没有问题的"等待"。 */
function fallbackQuestion(projected: ProjectedResult): string {
  return projected.text.trim() === '' ? '需要你补充一句话才能继续。' : projected.text.slice(0, 200)
}
