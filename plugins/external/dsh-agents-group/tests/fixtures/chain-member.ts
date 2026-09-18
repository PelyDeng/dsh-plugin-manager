/**
 * 链路验收替身（**只在测试里存在**，不随包发布）。
 *
 * 群组接入路径需要一只「只有协作契约、没有业务」的成员来做贯通验收：派活先等回话、回话沿原会话
 * 续接、两次回话后交差，并且同一个 `requestId` 重试不产生第二个副作用。它以前以 `verify-doll`
 * （验收娃娃）的形式随包发布，虽然默认关闭、要显式配置才装载，但它出现在任何站点的成员名单里都
 * 是噪音——接入期的临时替身做完验收就该留在测试里。
 *
 * 语义与当时完全一致，钉死三条：
 *
 * 1. **不重复执行**：同一个 `requestId` 再来（重试）返回同一份结论，不产生新副作用；
 * 2. **不丢会话**：业务一开始就把会话引用随进度交回（早期上报），续问必须沿它续接；
 * 3. **不混轮次**：每次回话的 `requestId` 不同才算新回话，同 ID 不同内容直接拒绝。
 *
 * 状态只在内存里，进程重启即丢——测试替身没有真实业务，丢掉正是想要的。
 */
import type { Access, Actor, ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import { registerPlugin } from '@dsh-plugin-manager/plugin-kit'
import { PARTICIPANT_PROTOCOL } from '../../packages/runtime/src/contract.ts'
import type { AgentManifest } from '../../src/agents/registry.ts'
import type { AgentParticipant, ParticipantRequest, ParticipantResult } from '../../packages/runtime/src/contract.ts'

/** 替身在群组名单里的形状：分类必须是 `agents`，否则牛马大总管发现不了它。 */
export const CHAIN_MEMBER_MANIFEST: AgentManifest = {
  id: 'chain-member',
  displayName: '链路验收替身',
  directory: 'chain-member',
  category: 'agents',
  description: '测试专用最小成员：等待、续问与幂等语义',
}

/** 一条回话记录：哪一次（requestId）、说了什么。 */
interface ReplyEntry {
  readonly requestId: string
  readonly text: string
}

/** 一场验收业务的全部状态，按原会话标识归档。 */
interface MemberSession {
  /** 该会话已经收到的回话，按到达顺序。 */
  readonly replies: ReplyEntry[]
  /** 同一 requestId 的结论重放，保证幂等。 */
  readonly settled: Map<string, ParticipantResult>
}

export interface ChainMemberMount {
  readonly tools: readonly ToolDescriptor[]
  readonly participant: AgentParticipant
  dispose(): Promise<void>
}

/** 装载替身：登记目录条目并交出一个参与者，不注册页面与工具。 */
export async function mountChainMember(input: {
  ctx: Parameters<typeof registerPlugin>[0]
  access: Access
  routePrefix: string
}): Promise<ChainMemberMount> {
  const sessions = new Map<string, MemberSession>()
  // 目录条目：牛马大总管按分类 `agents` 发现成员。缺了这条，成员名单里就看不到它 ——
  // 真实装配里这处缺失曾被手工编造的条目掩盖过，所以测试要用真装配路径。
  input.ctx.effect(() => registerPlugin(input.ctx, {
    id: CHAIN_MEMBER_MANIFEST.id,
    packageName: '@dsh-agents-group/chain-member',
    version: '0.1.0',
    displayName: CHAIN_MEMBER_MANIFEST.displayName,
    description: CHAIN_MEMBER_MANIFEST.description,
    // 与群组 `mountAgents` 给出的路径一致：成员页面挂在群组前缀的下一级。
    entryPath: `${input.routePrefix}/${CHAIN_MEMBER_MANIFEST.id}`,
    permissions: [`${CHAIN_MEMBER_MANIFEST.id}:access`],
    category: 'agents',
    tools: [],
  }))
  return {
    tools: [],
    participant: {
      protocol: PARTICIPANT_PROTOCOL,
      id: CHAIN_MEMBER_MANIFEST.id,
      displayName: CHAIN_MEMBER_MANIFEST.displayName,
      description: CHAIN_MEMBER_MANIFEST.description,
      assertAccess: (actor: Actor) => { input.access.assert(actor) },
      async run(request: ParticipantRequest): Promise<ParticipantResult> {
        // 派活按子任务标识幂等：重试回到同一份等待结论，不把问题问两遍。
        const conversationId = `chain-${request.missionId}-${request.actor.userId}`
        const settled = sessions.get(conversationId)?.settled.get(`dispatch:${request.requestId}`)
        if (settled !== undefined) return settled
        // 业务一开始就交回会话引用：协调方落库后，final 前失败也找得回原会话。
        request.onProgress({
          kind: 'status',
          text: '链路验收替身开工',
          conversationId,
          conversationArtifact: {
            kind: 'conversation',
            title: '查看验收会话',
            path: `${input.routePrefix}/${CHAIN_MEMBER_MANIFEST.id}?conversationId=${conversationId}`,
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
        // 没有原会话引用的续问不接：接了就等于让成员另起炉灶，那正是要防的丢会话。
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
            path: `${input.routePrefix}/${CHAIN_MEMBER_MANIFEST.id}?conversationId=${request.conversationId}`,
          }],
        }
        remember(sessions, request.conversationId, `reply:${request.requestId}`, result)
        return result
      },
    },
    async dispose() { sessions.clear() },
  }
}

function remember(sessions: Map<string, MemberSession>, conversationId: string, key: string, result: ParticipantResult): void {
  const session = sessions.get(conversationId) ?? { replies: [], settled: new Map() }
  session.settled.set(key, result)
  sessions.set(conversationId, session)
}
