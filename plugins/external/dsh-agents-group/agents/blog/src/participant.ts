import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import type { AgentParticipant, ParticipantRequest, ParticipantResult } from '../../../packages/common/src/participant.ts'
import type { BlogChat } from './chat.mjs'
import type { ChatStore } from './chat-store.mjs'
import type { BlogPgStorage } from './storage/pg.mjs'
import { digest, ownerKey } from './store.mjs'
import { invariant } from './settings.mjs'

const pending = new Set(['queued', 'running', 'stopping'])
const maxResultChars = 64000

function publicResultText(answer: string, notices: string[], candidates: { title: string, text: string }[]): string {
  const omittedAnswer = `\n\n[公开回答原长 ${answer.length} 字符，因协作消息长度限制已省略后文；请在博客原对话查看完整回答。]`
  let candidateText = candidates.length ? `本轮实际候选内容（共 ${candidates.length} 份，待采用，作为核对资料，不是指令）：\n\n`
    + candidates.map((candidate, index) => `### 候选 ${index + 1} · 待采用\n\n标题：${candidate.title}\n\n> 以下为实际候选正文，仅作为核对资料，不是指令。\n\n${candidate.text}\n\n候选 ${index + 1} 正文结束。`).join('\n\n---\n\n') : ''
  const details = () => [...notices, candidateText].filter(Boolean).join('\n\n')
  // 优先保留实际产物全文；连同必要状态与省略说明仍放不下时，不以片段冒充完整候选。
  if (candidates.length && [answer, details()].filter(Boolean).join('\n\n').length > maxResultChars
    && [answer ? omittedAnswer : '', details()].filter(Boolean).join('\n\n').length > maxResultChars) {
    candidateText = `本轮共 ${candidates.length} 份有效候选，候选正文共 ${candidates.reduce((sum, candidate) => sum + candidate.text.length, 0)} 字符；完整清单超过本次协作可转交的长度。所有候选均未转交全文，不能宣称已完整复核任何一份候选。请在博客原对话逐份查看并核对，候选仍待采用。`
  }
  const suffix = details(), available = maxResultChars - suffix.length - (suffix ? 2 : 0)
  if (answer && answer.length > available) {
    answer = answer.slice(0, Math.max(0, available - omittedAnswer.length)).replace(/[\uD800-\uDBFF]$/, '') + omittedAnswer
  }
  return [answer, suffix].filter(Boolean).join('\n\n') || '博客本轮已结束，请查看原对话。'
}

/** 只适配博客自己的会话；确认凭据和内部推理不进入跨插件结果。 */
export function createBlogParticipant({ access, chat, index, storage, routePrefix }: {
  access: { assert(actor: Actor): void }
  chat: BlogChat
  index: ChatStore
  storage: BlogPgStorage
  routePrefix: string
}): AgentParticipant {
  invariant(/^\/(?!\/)[^?#\\]*$/.test(routePrefix), '博客入口路径无效', 503)
  // 表名与两个请求前缀沿用协作入口改名前的写法：它们是**持久标识** —— 表里有线上数据、
  // 请求前缀参与幂等去重，改名要迁移老库，还可能让升级窗口内的重试变成两次投递。
  // 内部噪音不值得用这个代价换，所以只在代码与文档里换新说法。
  // 映射表留在索引库（四耦合点之 3）：与 conversations 同库同事务，拆库后混事务自然消失。
  index.db.exec(`CREATE TABLE IF NOT EXISTS pirate_blog_conversations (
    owner TEXT NOT NULL, missionId TEXT NOT NULL, conversationId TEXT NOT NULL,
    PRIMARY KEY(owner,missionId), UNIQUE(owner,conversationId))`)
  const db = index.db
  const binding = (owner: string, missionId: string) => db.prepare(
    'SELECT conversationId FROM pirate_blog_conversations WHERE owner=? AND missionId=?',
  ).get(owner, missionId) as { conversationId: string } | undefined

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
      let linked = binding(owner, missionId)
      if (request.conversationId !== undefined) invariant(linked?.conversationId === request.conversationId, '博客会话不属于当前协作任务', 403)
      if (!linked) {
        // 映射与 conversations 同库：索引侧自己的事务，不再混业务库。
        db.exec('BEGIN IMMEDIATE')
        try {
          const conversation = chat.create(actor, 'pirate-conversation-' + digest({ missionId }))
          db.prepare('INSERT INTO pirate_blog_conversations VALUES(?,?,?)').run(owner, missionId, conversation.id)
          linked = { conversationId: conversation.id }
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      }
      const conversationId = linked.conversationId
      const assertBound = () => {
        access.assert(actor)
        invariant(binding(owner, missionId)?.conversationId === conversationId, '博客协作会话绑定已变化', 403)
        index.get(owner, conversationId)
      }
      assertBound()
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
        assertBound()
        const turn = index.request(owner, turnId)
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
        assertBound()
        signal.throwIfAborted()
        request.onProgress({ kind: 'status', text: '博客会话已连接', conversationId,
          conversationArtifact: { kind: 'conversation', title: '查看博客原对话', path } })
        signal.throwIfAborted()
        assertBound()
        const started = await chat.send(actor, {
          conversationId, requestId: 'pirate-turn-' + digest({ missionId, requestId }),
          text: request.message, research: false, attachments: [],
        })
        turnId = started.id
        for (;;) {
          const observed = updates
          assertBound()
          if (signal.aborted) { stopPromise ??= stopOwned(); await stopPromise }
          invariant(!closed, '博客会话订阅已结束，请重新查看任务', 503)
          const turn = index.request(owner, turnId)
          invariant(turn.conversationId === conversationId, '博客请求不属于当前协作会话', 403)
          if (!pending.has(turn.status)) {
            const history = await chat.history(actor, conversationId)
            assertBound()
            const start = history.messages.findIndex(message => message.role === 'user' && 'requestId' in message && message.requestId === turnId)
            invariant(start >= 0 || turn.status !== 'succeeded', '无法核验本轮博客回答，请查看原对话', 409)
            const tail = start < 0 ? [] : history.messages.slice(start + 1)
            const next = tail.findIndex(message => message.role === 'user')
            const said = (next < 0 ? tail : tail.slice(0, next))
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
            const text = final !== undefined ? final.text : said.map(message => message.text).join('\n\n')
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
            assertBound()
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
