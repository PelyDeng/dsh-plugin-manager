/**
 * 接入验收成员：一只最小「验收娃娃」。
 *
 * 它是群组接入路径的**活样例**（方案 G06）：子包、清单、适配层、装载分支、构建与
 * 归档一处不缺，但业务只有协作契约本身——派活先等回话，回话沿原会话续接，两次回话
 * 后交差。新成员接入时照着这个目录做，缺哪一环验收就会在哪里红。
 *
 * 语义刻意钉死三条（对应 B 批验收核心）：
 *
 * 1. **不重复执行**：同一个 `requestId` 再来（重试），返回同一份结论，不产生新副作用；
 * 2. **不丢会话**：业务一开始就把会话引用随进度交回（早期上报），续问必须沿它续接；
 * 3. **不混轮次**：每次回话的 `requestId` 不同才算新回话，同 ID 不同内容直接拒绝。
 *
 * 与 closedoff/blog 的分层一致：目录条目由子包**自己**登记（分类 `agents`），群组不
 * 代注册；类型按相对路径引 common 的源码、值按包名引（构建期内联）。状态只在内存里：
 * 验收成员没有真实业务，重启丢掉反而是想要的行为。
 */

import type { Access, Actor, ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import { registerPlugin } from '@dsh-plugin-manager/plugin-kit'
import { PARTICIPANT_PROTOCOL } from '@dsh-agents-group/common'
import type { AgentParticipant, ParticipantRequest, ParticipantResult } from '../../../packages/common/src/participant.ts'

/** 子包需要的装载入参：宿主上下文、访问校验器与自己的页面前缀。 */
export interface MountInput {
  readonly ctx: Parameters<typeof registerPlugin>[0]
  readonly access: Access
  readonly routePrefix: string
}

/** 一条回话记录：哪一次（requestId）、说了什么。 */
interface ReplyEntry {
  readonly requestId: string
  readonly text: string
}

/** 一场验收业务的全部状态，按原会话标识归档。 */
interface DollSession {
  /** 该会话已经收到的回话，按到达顺序。 */
  readonly replies: ReplyEntry[]
  /** 同一 requestId 的结论重放，保证幂等。 */
  readonly settled: Map<string, ParticipantResult>
}

/** 装载：登记目录条目并交出一个参与者，不注册页面与工具。 */
export async function mount(input: MountInput): Promise<{
  tools: readonly ToolDescriptor[]
  participant: AgentParticipant
  dispose(): Promise<void>
}> {
  const sessions = new Map<string, DollSession>()
  // 目录条目：牛马大总管按分类 `agents` 发现成员。没有这条，名单里就看不到验收娃娃——
  // 之前贯通测试手工编造条目掩盖的就是这处缺失。
  input.ctx.effect(() => registerPlugin(input.ctx, {
    id: 'verify-doll',
    packageName: '@dsh-agents-group/verify-doll',
    version: '0.1.0',
    displayName: '验收娃娃',
    description: '最小接入验收成员：等待、续问与幂等语义',
    entryPath: input.routePrefix,
    permissions: ['verify-doll:access'],
    category: 'agents',
    tools: [],
  }))
  return {
    tools: [],
    participant: {
      protocol: PARTICIPANT_PROTOCOL,
      id: 'verify-doll',
      displayName: '验收娃娃',
      description: '最小接入验收成员：等待、续问与幂等语义',
      assertAccess: (actor: Actor) => { input.access.assert(actor) },
      async run(request: ParticipantRequest): Promise<ParticipantResult> {
        // 派活按子任务标识幂等：重试回到同一份等待结论，不把问题问两遍。
        const conversationId = `doll-${request.missionId}-${request.actor.userId}`
        const settled = sessions.get(conversationId)?.settled.get(`dispatch:${request.requestId}`)
        if (settled !== undefined) return settled
        // 业务一开始就交回会话引用：协调方落库后，final 前失败也找得回原会话。
        request.onProgress({
          kind: 'status',
          text: '验收娃娃开工',
          conversationId,
          conversationArtifact: {
            kind: 'conversation',
            title: '查看验收会话',
            path: `${input.routePrefix}/verify-doll?conversationId=${conversationId}`,
          },
        })
        const result: ParticipantResult = {
          status: 'waiting',
          conversationId,
          text: '第一版和第二版都准备好了',
          question: '先用哪一版？',
        }
        remember(sessions, conversationId, `dispatch:${request.requestId}`, result)
        return result
      },
      async reply(request: ParticipantRequest): Promise<ParticipantResult> {
        // 没有原会话引用的续问不接：接了就等于让验收成员另起炉灶，那正是要防的丢会话。
        if (request.conversationId === undefined) {
          return { status: 'failed', conversationId: '', text: '续问必须携带原会话引用' }
        }
        const session = sessions.get(request.conversationId)
        if (session === undefined) {
          return { status: 'failed', conversationId: request.conversationId, text: '原会话已不存在，请重新派活' }
        }
        // 同 ID 不同内容 = 客户端把身份生成错了：按契约拒绝，不静默当同一次。
        // 这条检查必须先于缓存命中——先回缓存会把异文请求也当成合法重试吞掉。
        const clash = session.replies.find(entry => entry.requestId === request.requestId)
        if (clash !== undefined && clash.text !== request.message) {
          return { status: 'failed', conversationId: request.conversationId, text: '同一回话身份不能用在不同内容上' }
        }
        const seen = session.settled.get(`reply:${request.requestId}`)
        if (seen !== undefined) return seen
        session.replies.push({ requestId: request.requestId, text: request.message })
        if (session.replies.length < 2) {
          const result: ParticipantResult = {
            status: 'waiting',
            conversationId: request.conversationId,
            text: `收到第 1 句：${request.message}`,
            question: '还有什么要补充的？',
          }
          remember(sessions, request.conversationId, `reply:${request.requestId}`, result)
          return result
        }
        const summary = session.replies.map(entry => entry.text).join('；')
        const result: ParticipantResult = {
          status: 'completed',
          conversationId: request.conversationId,
          text: `两句话都收到：${summary}`,
          artifacts: [{
            kind: 'report',
            title: '验收报告',
            path: `${input.routePrefix}/verify-doll?conversationId=${request.conversationId}`,
          }],
        }
        remember(sessions, request.conversationId, `reply:${request.requestId}`, result)
        return result
      },
    },
    async dispose() { sessions.clear() },
  }
}

function remember(sessions: Map<string, DollSession>, conversationId: string, key: string, result: ParticipantResult): void {
  const session = sessions.get(conversationId) ?? { replies: [], settled: new Map() }
  session.settled.set(key, result)
  sessions.set(conversationId, session)
}
