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
 * 自修正轮都不另开预算。超时发生时收尾循环被直接中断（见 `fail` 里的 `settling` 分支），
 * 不会挂在"等下一个 `turn/end`"上。
 *
 * **但超时不等于整条失败**：超时落在**补交轮**（运行时自己的补救动作）上、而首轮已经产出可用
 * 结论时，用那一份兜底交付（见 `handoffFallback`）——补交没跑完不该毁掉一次已经成功的交付。
 * 首轮本身超时、或自修正轮超时，仍然整条失败：那两种情况下都没有"已经成功的交付"。
 */
import { AccessError, type Access, type Actor, type AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
import {
  PARTICIPANT_PROTOCOL,
  type AgentParticipant,
  type ParticipantProgress,
  type ParticipantRequest,
  type ParticipantResult,
  type ParticipantStatus,
} from './contract.ts'
import { historyOf, textOf, type AgentRuntime, type Conversation } from './conversation.ts'
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
import type { AgentStoragePort, OwnerKey } from './storage/ports.ts'

export interface CreateParticipantInput {
  readonly definition: AgentDefinition
  readonly runtime: AgentRuntime
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
  const { ctx, lifecycle } = runtime
  const storage = input.storage
  /**
   * 幂等缓存的上界（条）。缓存只为"进程内重试"服务，**持久化由 `dsh_turns` 承担**，所以给它一个
   * 有界窗口：不清理的话每轮都会永久留下一条完整结果，长期运行的进程会单调增长。
   */
  const settledCacheMax = config.settledCacheMax ?? 256
  let disposed = false
  const pending = new Set<() => Promise<void>>()
  /** 正在协作的业务会话 → 这一轮的增量出口。同一会话不会有两轮同时跑。 */
  const sinks = new Map<string, (delta: AssistantDelta) => void>()
  /**
   * 幂等缓存：请求身份 → 上一次的结论。
   *
   * 它是**补交轮与自修正轮的安全前提**：两者都会再注入一条 user message，如果同一个
   * `requestId` 重试时又跑一遍，就等于对同一个请求产生第二轮副作用（先例见
   * `tests/fixtures/chain-member.ts:117-122`：先查同 ID 异文、再回缓存）。
   */
  const settledTurns = new Map<string, { readonly message: string; readonly result: ParticipantResult }>()
  /** 按会话分的交活账本。 */
  const ledgers = new Map<string, HandoffLedger>()
  /** 门槛缺失只警告一次：那是装配错误，不该按会话刷屏。 */
  let warnedHandoffMissing = false
  /** 中断轮次的告警也只发一次：同一进程里反复刷同一个崩溃信号没有意义。 */
  let warnedResumedTurn = false
  let lastLedger = createHandoffLedger()
  const ledgerOf = (conversationId: string): HandoffLedger => {
    const existing = ledgers.get(conversationId)
    if (existing !== undefined) return existing
    const created = createHandoffLedger()
    ledgers.set(conversationId, created)
    lastLedger = created
    return created
  }
  ctx.effect(() => async () => {
    disposed = true
    await Promise.allSettled([...pending].map(close => close()))
  })
  onAssistantDelta(ctx, (sessionId, delta) => { sinks.get(sessionId)?.(delta) })

  const assertAccess = (actor: Actor) => {
    if (disposed) throw new AccessError(503, `${definition.displayName}正在停止`)
    access.assert(actor)
  }
  const ownerOf = (actor: Actor): OwnerKey => ({ namespace: actor.namespace, userId: actor.userId })

  /** 结果投影：业务钩子优先，缺省用兜底投影（**"没调交活工具"不等于失败**）。 */
  const project = async (requestContext: ResultContext): Promise<ProjectedResult> => {
    if (definition.projectResult === undefined) return fallbackProjection(requestContext)
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
          const cached = settledTurns.get(settledKey)
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
          conversation = await lifecycle.open(
            request.conversationId === undefined || request.conversationId === '' ? undefined : request.conversationId,
            mode === 'run',
            request.actor,
          )
        } catch (error) { reject(error); return }
        if (conversation === undefined) { reject(new AccessError(404, '会话不存在或无权访问')); return }
        const opened = conversation
        try {
          request.signal.throwIfAborted()
          assertAccess(request.actor)
          lifecycle.assertConversation(opened.id, request.actor)
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
        }
        const fail = (error: unknown) => {
          if (finished || failed) return
          failed = true; failure = error
          if (admitted) lifecycle.abort(opened.id)
          if (settling) {
            // 收尾循环里出错（含**超时**、含补交轮本身失败）：必须在这里直接结束。
            // 否则循环会挂在 `waitTurnEnd()` 上——那一轮的 `turn/end` 可能永远不会来。
            cleanup(); reject(error); return
          }
          if (!started) { cleanup(); reject(error) }
        }
        const cancel = () => {
          if (finished) return
          cancelled = true
          if (admitted) lifecycle.abort(opened.id)
          if (!started) { cleanup(); reject(request.signal.reason) }
        }
        const close = async () => {
          if (finished) return
          cancelled = true
          if (admitted) lifecycle.abort(opened.id)
          try { if (started) { await continuation; await opened.handle.agent.whenIdle() } } catch { /* 关闭时统一报告插件已停止。 */ }
          if (!finished) { cleanup(); reject(new AccessError(503, '插件已停止')) }
        }
        pending.add(close)
        const assert = () => { assertAccess(request.actor); lifecycle.assertConversation(opened.id, request.actor) }
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
         * 跑完一轮的收尾判定：投影 → ⑦ → ⑧ → 交付或再来一轮。
         *
         * ⚠️ **"没调交活工具"不等于失败**：先补交一次；补交后仍未调，就按投影的兜底交付，
         * 并把 `report-called` 如实标成"未核验"。这是 §4.3 的明确要求——blog 现在的完成
         * 判定本来就来自客观投影，改成"没调工具就判失败"是语义降级。
         */
        const settleOnce = async (reason: string): Promise<SettleOutcome> => {
          // 补交轮超时：首轮结论已经算好，只是运行时自己的补救动作没跑完 ⇒ 用那一份兜底交付。
          // 这一段必须在 `status` 计算之前：`reason` 是我们自造的 `'timeout'`，按普通分支走会
          // 落进"这一轮失败"，把一份已经成功的交付说成没干完。
          if (reason === 'timeout' && handoffFallback !== undefined) {
            const fallback = handoffFallback
            handoffFallback = undefined
            return { kind: 'deliver', result: fallback }
          }
          const aborted = cancelled || reason === 'aborted'
          const status: ParticipantStatus = aborted
            ? 'cancelled'
            : reason === 'completed' && finalText.trim() ? 'completed' : 'failed'
          const history = historyOf(lifecycle.events(opened), opened.id)
          if (status === 'completed') { thinking.finish(); visible.finish() }
          const fallbackText = status === 'completed' ? (definition.redact?.(finalText) ?? finalText)
            : status === 'cancelled' ? '协作已取消。' : `${definition.displayName}未能完成本回合，请查看原会话。`
          const context: ResultContext = {
            history,
            request: {
              message,
              ...(request.acceptance === undefined ? {} : { acceptance: request.acceptance }),
              ...(request.reworkOf === undefined ? {} : { reworkOf: request.reworkOf }),
            },
            storage,
          }
          const taken = ledger.take()
          // **交活工具的结果优先，投影兜底**：模型显式说了交回什么就用它；没说才回去看会话。
          const projected: ProjectedResult = taken.result ?? (status === 'completed'
            ? await project(context)
            : { status, text: fallbackText })

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
          // ⚠️ 这一处接线曾经缺失：接口（`TurnStorePort`）与实现（`storage/postgres.ts`）都有、
          // 两侧的测试各自绿，但运行时**从不调用它**。后果是重启之后子任务**永远停在
          // `waiting_user`**——不报错、静默不动，而协调侧的 `prepareReply` 只会报
          // `waiting_expired`（"重启后仍能恢复在等什么"是协调侧的硬要求）。
          // 非 `waiting` 的那一轮必须**清空**：否则上一轮的问题会被下一轮读回来。
          if (storage !== undefined) {
            const question = projected.status === 'waiting' ? projected.question : undefined
            await storage.db.turns.setPendingQuestion(ownerOf(request.actor), opened.id, question)
          }

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
                settledTurns.set(settledKey, { message, result: outcome.result })
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
              lifecycle.finish(opened.id)
              await waitUntilIdle()
              if (finished) return
              // 新一轮：重置这一轮的观测状态（交活账本、正文、回合标记）。
              ledger.reset()
              ending = false
              started = false
              finalText = ''
              try {
                await lifecycle.followup(opened, outcome.prompt, request.actor)
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
          // 首轮已经产出可用结论、只是运行时自己的补交补救没跑完 ⇒ **不整条失败**：唤醒收尾
          // 循环，让它按兜底交付走完（见 `settleOnce` 的 `'timeout'` 分支）。先入队再 abort：
          // 补交轮可能正在跑，不打断它就还会继续产生副作用，但 `'timeout'` 必须排在它的
          // `turn/end` 前面——否则循环拿到的是 `'aborted'`，那份结论又会被当成"这一轮失败"。
          if (handoffFallback !== undefined) {
            pushTurnEnd('timeout')
            if (admitted) lifecycle.abort(opened.id)
            return
          }
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
          if (storage !== undefined) {
            const owner = ownerOf(request.actor)
            const verdict = await storage.db.turns.claim(owner, opened.id, settledKey, message)
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
          releaseTurn = lifecycle.retainTurn(opened, request.actor)
          admitted = true
          sinks.set(opened.id, sink!)
          continuation = lifecycle.followup(opened, message, request.actor)
          await continuation
        } catch (error) {
          if (finished) return
          if (admitted) {
            lifecycle.abort(opened.id)
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

  return {
    protocol: PARTICIPANT_PROTOCOL,
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    assertAccess,
    run: request => runTurn(request, 'run'),
    reply: request => runTurn(request, 'reply'),
    get handoff() { return lastLedger },
    handoffFor: conversationId => ledgerOf(conversationId),
    get settledRequests() { return settledTurns.size },
  }
}

/** 缺省的结果投影：按回合结局判定，正文取最终消息。 */
function fallbackProjection(context: ResultContext): ProjectedResult {
  const text = context.history.finalText.trim()
  return { status: text === '' ? 'failed' : 'completed', text: text === '' ? '没有拿到可交付的结果。' : text }
}

/** `needsReply` 声明要等、但投影没给问题时，用一句兜底问题，避免用户面对一个没有问题的"等待"。 */
function fallbackQuestion(projected: ProjectedResult): string {
  return projected.text.trim() === '' ? '需要你补充一句话才能继续。' : projected.text.slice(0, 200)
}
