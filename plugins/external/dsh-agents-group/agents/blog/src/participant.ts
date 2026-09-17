import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import type { AgentParticipant, ParticipantRequest, ParticipantResult } from '../../../packages/common/src/participant.ts'
import type { BlogChat } from './chat.ts'
import type { ChatStore } from './chat-store.ts'
import type { BlogPgStorage } from './storage/pg.mjs'
import { createBlogProjector } from './definition.ts'
import { publicResultText } from './result-text.ts'
import { digest, ownerKey } from './store.mjs'
import { invariant } from './settings.mjs'

const pending = new Set(['queued', 'running', 'stopping'])

/** 只适配博客自己的会话；确认凭据和内部推理不进入跨插件结果。 */
export function createBlogParticipant({ access, chat, index, storage, app, routePrefix }: {
  access: { assert(actor: Actor): void }
  chat: BlogChat
  index: ChatStore
  storage: BlogPgStorage
  /**
   * 业务应用（`BlogApplication`）：收尾投影要读这个会话留下的**操作卡片**。
   *
   * 与 `BlogDefinitionInput['app']` **同形**（那里也是最小结构类型）。两处各声明一次这个形状是
   * 有意的：`definition.ts` 是声明层、本文件是协作入口，它们各自只依赖自己用到的方法，不互相
   * 绑定实现类型。
   */
  app: { operations(owner: string): Promise<readonly { id: string; title: string; mode: string; status: string; result?: { url?: string | null } | null; chat?: { conversationId?: string } | null }[]> }
  routePrefix: string
}): AgentParticipant {
  invariant(/^\/(?!\/)[^?#\\]*$/.test(routePrefix), '博客入口路径无效', 503)
  /**
   * 收尾投影的**唯一实现**（`definition.ts` 的 `createBlogProjector`）。
   *
   * blog 现在有两条收尾路径：本协作入口，以及（切到运行时之后的）`AgentDefinition.projectResult`。
   * 让它们**共用同一份实现**，而不是各写一份等价逻辑 —— 两份的下场是"某条路径改了、另一条没改"，
   * 而用户看到的是**同一轮在大总管那里和在页面上结论不同**。
   */
  const projector = createBlogProjector({
    storage, app, routePrefix,
    /**
     * 候选判定里**跨轮**的那半（"这个会话还有没有未采用的候选稿"）：运行时的 `loadResults()`
     * 契约只读本轮，跨轮要业务**用自己的表**查 ⇒ 传索引库的会话产出读取。
     *
     * 与装配侧将传给 `createBlogDefinition` 的是**同一个** `ChatStore.results`，两条收尾路径
     * 因此不会各写一份"还有没有候选"的判断。
     */
    results: { list: async (owner, conversationId) => index.results(owner, conversationId) },
  })
  // ⚠️ 映射表（旧 `pirate_blog_conversations`）已**取消**：会话寻址改成"**派生 requestId +
  // 创建幂等**"。`create` 的幂等身份是 `(agent_id, owner, request_id)` 上的部分唯一索引 ⇒
  // 同一个 mission 再来一次返回**原来那一行**，会话 id 因此跨进程重启仍然稳定；
  // 而幂等键里**不需要** owner——索引本身就带 owner 两列，换个用户派同一个 missionId 各建各的会话。
  // 这样"会话与其协作任务的绑定"不再是一份需要迁移的持久数据，而是 requestId 的函数。

  return {
    protocol: 1, id: 'blog', displayName: '伊丽莎白 · 博客',
    description: '查询博客、整理资料并提出文章候选；采用候选和发布确认仍在博客原页面完成。',
    assertAccess(actor) { access.assert(actor) },
    async run(request: ParticipantRequest): Promise<ParticipantResult> {
      const { actor, missionId, requestId, signal } = request
      access.assert(actor)
      signal.throwIfAborted()
      invariant([missionId, requestId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 200), '协作任务标识无效')
      invariant(typeof request.message === 'string' && request.message.trim() && request.message.length <= 8000, '请输入协作要求（最多 8000 字符）')
      const owner = ownerKey(actor)
      // 派生的是 **requestId**（幂等身份），不是会话 id：会话 id 由 `create` 内部铸
      //（`blog-chat-<uuid>`），并由上面那条部分唯一索引保证"同一 mission 只得一行"。
      const conversation = await chat.create(actor, 'pirate-conversation-' + digest({ missionId }))
      const conversationId = conversation.id
      if (request.conversationId !== undefined) {
        invariant(conversationId === request.conversationId, '博客会话不属于当前协作任务', 403)
      }
      const assertBound = async () => {
        access.assert(actor)
        await index.get(owner, conversationId)
      }
      await assertBound()
      signal.throwIfAborted()
      const path = routePrefix.replace(/\/$/, '') + '?conversationId=' + encodeURIComponent(conversationId)
      let turnId: string | undefined, wake: (() => void) | undefined, closed = false, updates = 0
      let unsubscribe = () => {}, lastStatus = '', stopPromise: Promise<unknown> | undefined
      /**
       * 已经把多少实时内容交给协作入口。
       *
       * 博客的实时通道给的是**本步累积**的正文，不是增量，而且清空重来时不单独发一条：
       * 新一轮的累积不再以已发布内容开头时整段追加。空正文只出现在只带推理的片段里，
       * 那种片段同时说明本步正文还是空的，基准跟着归零。判断都靠前缀。
       *
       * 这条通道上跑的是**过程**：每一步的正文后面都跟着一次工具调用（「让我先看看…」），
       * 只有该回合最后一条才是答案（见收尾处按 `tail` 取正文）。所以按**思考**上报：
       * 页面折成一行、要细节时展开，而不是让过程把气泡灌满。思考是完整覆盖语义，
       * 上报的因此是累计值 `process`，不是这一步的增量。
       */
      let sentLive = ''
      let process = ''
      const forwardLive = (event: unknown) => {
        if (signal.aborted) return
        if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== 'live') return
        const live = (event as { live?: { text?: unknown } | null }).live
        const text = typeof live?.text === 'string' ? live.text : ''
        // 累积值不以已发布内容开头（换段，或只带推理的片段把正文清空）就整段追加。
        const next = text.startsWith(sentLive) ? text.slice(sentLive.length) : text
        sentLive = text
        if (next === '') return
        process += next
        // 上报只是呈现数据：失败（授权或协作已失效）时由主循环按真实回合状态收尾，
        // 不因为一条思考把订阅拆掉。
        try { request.onProgress({ kind: 'thinking', thinking: process }) } catch { /* 主循环会复核授权与回合状态。 */ }
      }
      const notify = () => { updates++; wake?.(); wake = undefined }
      const stopOwned = async () => {
        if (!turnId) return
        // `assertBound` 与 `index.request` 现在都是 PG 往返 ⇒ 本函数（本来就 async）逐处 await。
        await assertBound()
        const turn = await index.request(owner, turnId)
        invariant(turn.conversationId === conversationId, '博客请求不属于当前协作会话', 403)
        // 避免旧请求的迟到取消停止同一会话里后来开始的另一轮。
        if (pending.has(turn.status)) await chat.stop(actor, conversationId)
      }
      const abort = () => {
        if (turnId) { stopPromise ??= stopOwned(); void stopPromise.catch(() => {}); }
        notify()
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        unsubscribe = chat.subscribe(actor, conversationId, (event: unknown) => { forwardLive(event); notify() }, () => { closed = true; notify() })
        await assertBound()
        signal.throwIfAborted()
        request.onProgress({ kind: 'status', text: '博客会话已连接', conversationId,
          conversationArtifact: { kind: 'conversation', title: '查看博客原对话', path } })
        signal.throwIfAborted()
        await assertBound()
        const started = await chat.send(actor, {
          conversationId, requestId: 'pirate-turn-' + digest({ missionId, requestId }),
          text: request.message, research: false, attachments: [],
        })
        turnId = started.id
        for (;;) {
          const observed = updates
          await assertBound()
          if (signal.aborted) { stopPromise ??= stopOwned(); await stopPromise }
          invariant(!closed, '博客会话订阅已结束，请重新查看任务', 503)
          // `turnId` 刚在上面赋成 `started.id`；TS 因为闭包里也可能写它而放弃收窄，这里断言非空。
          const turn = await index.request(owner, turnId!)
          invariant(turn.conversationId === conversationId, '博客请求不属于当前协作会话', 403)
          if (!pending.has(turn.status)) {
            const history = await chat.history(actor, conversationId)
            await assertBound()
            const start = history.messages.findIndex(message => message.role === 'user' && 'requestId' in message && message.requestId === turnId)
            invariant(start >= 0 || turn.status !== 'succeeded', '无法核验本轮博客回答，请查看原对话', 409)
            /**
             * **本轮**的消息：从本轮的 user 消息切起，在**下一条 user 消息**处停住。
             *
             * 运行时的 `TurnHistory` 天然只装一轮，而这里的 `history.messages` 是**整个会话**
             * ⇒ 两条收尾路径的形状差异必须在这里补平。漏了它，多轮会话会把**每一轮**的答案都
             * 拼进兜底正文（实测：第 1 轮答「X」、第 2 轮又问一句，回放第 1 轮时交回的是
             * 「X\n\nX」），"本轮算数的那一条"也会指错轮。**成功与未成功两条分支共用这一份切片**。
             */
            const after = start < 0 ? [] : history.messages.slice(start + 1)
            const nextUser = after.findIndex(message => message.role === 'user')
            const turnMessages = nextUser < 0 ? after : after.slice(0, nextUser)
            /**
             * —— 回合成功：收尾交给**唯一实现** ——
             *
             * 与 `AgentDefinition.projectResult` 同源（都走 `createBlogProjector`）。**非成功**
             * （取消、失败）仍走下面的旧分支：那种情形的状态与文案由回合结局决定，而投影只产出
             * `completed` / `external_pending` 两种（见 `createBlogProjector` 的注释）。
             */
            if (turn.status === 'succeeded') {
              const asTurnMessage = (message: (typeof history.messages)[number]) => ({
                role: message.role as 'user' | 'assistant',
                text: typeof message.text === 'string' ? message.text : '',
                time: message.time,
                ...(typeof message.id === 'string' ? { id: message.id } : {}),
                ...(typeof message.turn === 'number' ? { turn: message.turn } : {}),
                ...(message.interrupted === true ? { interrupted: true } : {}),
              })
              const tailMessage = turnMessages.filter(message => message.tail === true).at(-1)
              const projected = await projector({
                actor,
                history: {
                  conversationId,
                  // 运行时那条路径会填 `finalText`；投影**只用 `tail`**（见其注释：`finalText`
                  // 连被中断的那条也算），所以这里如实给空串，不伪造一个值。
                  finalText: '',
                  messages: turnMessages
                    .filter(message => message.role === 'user' || message.role === 'assistant')
                    .map(asTurnMessage),
                  ...(tailMessage === undefined ? {} : { tail: asTurnMessage(tailMessage) }),
                },
                request: {
                  message: request.message,
                  ...(request.acceptance === undefined ? {} : { acceptance: request.acceptance }),
                  ...(request.reworkOf === undefined ? {} : { reworkOf: request.reworkOf }),
                },
                // 投影读的是**业务库**（由 `createBlogProjector` 闭包注入的 `storage`）；运行时的
                // 存储门面在这条路径上不存在 ⇒ 如实给 undefined，不塞一个假的。
                storage: undefined,
                /**
                 * 本轮的结构化产出。索引库的 `chat_results` 就是它在旧载体上的形态，映射成运行时
                 * `TurnResultRecord` 的形状（业务载荷进 `payload`）。
                 *
                 * ⚠️ **只取本轮**（`requestId === turnId`）：运行时的 `loadResults()` 口径就是
                 * "只读本轮"，所以它只喂**"本轮交回的候选正文"**那一半。**跨轮**的那半（"这个会话
                 * 还有没有未采用的候选稿"）走投影输入里注入的 `results.list`（见 `participant.ts`
                 * 上方构造 `projector` 处，以及 `BlogDefinitionInput.results` 的注释）。
                 *
                 * 早先这里把两半都按本轮收窄，于是"早先轮次留下的候选"在后续轮次不再报
                 * `external_pending`——那是**静默的语义退步**，被 `tests/participant.test.mjs` 那条
                 * "a later progress question preserves earlier unresolved candidates" 抓住。
                 */
                loadResults: async () => history.results
                  .filter(result => result.requestId === turnId)
                  .map((result, index) => ({
                    id: `${String(turnId)}:${index}`,
                    turnId: String(turnId),
                    operationId: '',
                    seq: index,
                    createdAt: 0,
                    payload: { ...result },
                  })),
              })
              return {
                status: projected.status,
                conversationId,
                text: projected.text,
                ...(projected.artifacts === undefined ? {} : { artifacts: projected.artifacts }),
                ...(projected.externalPending === undefined ? {} : { externalPending: projected.externalPending }),
              }
            }
            const said = turnMessages
              .filter(message => turn.status !== 'succeeded' || !('interrupted' in message && message.interrupted))
              .flatMap(message => message.role === 'assistant' && 'text' in message && typeof message.text === 'string' ? [message] : [])
            /**
             * 交回的正文只取**该回合最后一条**，不把过程叙述一起拼进来。
             *
             * 每一步的正文（「让我先看看…」「找到了相关文章！」）后面都跟着一次工具调用，
             * 拼进来会让交回的材料大半是过程，真正的答案埋在最后：实测一轮 7 条消息里
             * 6 条是过程叙述，只有最后 1 条 3890 字是答案。
             *
             * 哪一条算数由会话投影标出（`tail`：该回合最后一条未被中断、且有正文的
             * assistant 消息），不是自然语言判断。没有 `tail`（例如本轮被停止）时保留
             * 全部已生成内容，不丢东西。
             */
            const final = said.filter(message => 'tail' in message && message.tail === true).at(-1)
            // `tail` 只标在该回合最后一条**有正文**的 assistant 消息上（会话投影保证非空字符串），
            // 所以这里的 `!` 只是把投影的不变量告诉类型系统，运行期取值与改造前完全一致。
            const text = final !== undefined ? final.text! : said.map(message => message.text).join('\n\n')
            const confirmation = history.operations.some((operation: { status: string }) => ['prepared', 'running', 'uncertain', 'conflict'].includes(operation.status))
            // some() 不等待异步谓词，候选判定必须逐条 await 核对（草稿在业务库里）。
            let candidate = false
            for (const result of history.results) {
              if (result.kind !== 'candidate' || !result.proposal?.id) continue
              if ((await storage.get(owner, result.draftId)).proposal?.id === result.proposal.id) { candidate = true; break }
            }
            const currentCandidates = new Map<string, { title: string, text: string }>()
            for (const result of history.results) {
              if (result.requestId !== turnId || result.kind !== 'candidate' || !result.proposal?.id) continue
              const proposal = (await storage.get(owner, result.draftId)).proposal
              if (proposal?.id === result.proposal.id) currentCandidates.set(result.draftId, { title: proposal.fields.title, text: proposal.fields.text })
            }
            // 这两种「没跑完」要分开报：材料已经交回、剩下的事在博客里办（采用候选稿、核对操作），
            // 与等着用户在协作通道里补一句话，是两件不同的事。前者这一轮可以结束、也能开新活，
            // 但那件事并没有办完，所以绝不能报成 `completed`。
            const external = confirmation || candidate
            const status = turn.status === 'succeeded' ? (external ? 'external_pending' : 'completed')
              : turn.status === 'interrupted' && signal.aborted ? 'cancelled' : 'failed'
            const unfinished = status === 'cancelled' ? '本轮已停止，尚未完成；保留已生成的内容。'
              : status === 'failed' ? '博客本轮未完成，请在原对话查看并继续。' : ''
            const note = confirmation ? '博客操作仍需在原对话核对或确认；此处没有执行发布。'
              : candidate ? '候选稿已准备，须在博客原对话选择采用；候选稿不等于正文已保存或发布。' : ''
            await assertBound()
            return {
              status, conversationId, text: publicResultText(text, [unfinished, note], [...currentCandidates.values()]),
              artifacts: [{ kind: confirmation ? 'confirmation' : candidate ? 'draft' : 'conversation',
                title: confirmation ? '在博客核对并确认' : candidate ? '在博客查看并采用候选稿' : '查看博客原对话', path }],
              // 声明里的理由是给用户看的原话，与 `text` 里那句同源，不另编一份。
              ...(external ? { externalPending: {
                reason: note,
                next: '在博客里采用或确认之后，可以再派一轮继续处理后续。',
              } } : {}),
            }
          }
          if (!signal.aborted && turn.status !== lastStatus) {
            lastStatus = turn.status
            request.onProgress({ kind: 'status', text: turn.status === 'queued' ? '博客任务已接收' : turn.status === 'stopping' ? '博客正在停止' : '博客正在整理资料与回答', conversationId })
          }
          await new Promise<void>(resolve => { wake = resolve; if (updates !== observed) resolve() })
        }
      } catch (error) {
        try { if (turnId) await chat.settleAccepted(actor, conversationId, turnId) }
        finally { throw error }
      } finally {
        signal.removeEventListener('abort', abort)
        unsubscribe()
        wake = undefined
      }
    },
  }
}
