/**
 * 把子包的参与者桥接成管家的执行入口。
 *
 * 两个协议的字段几乎一一对应，所以这一层只做翻译，不做任何业务决定：
 *
 * | 管家 | 参与者 |
 * | --- | --- |
 * | `taskId` / `subtaskId` | `missionId` / `requestId` |
 * | `brief`（含 `goal`） | `message` |
 * | `actor` | `actor`（原样传，不从 `owner` 字符串重建） |
 * | `onProgress` | `onProgress`（形态转换） |
 * | `completed` / `waiting` / `cancelled` / `failed` | `succeeded` / `waiting_user` / `cancelled` / `failed` |
 *
 * 为什么需要这一层：`AgentParticipant` 是给协作页面用的（一轮活怎么跑、拿到什么结论），
 * `ButlerAgentExecutor` 是给管家用的（派活、收结论、追问）。两者描述的是同一件事，
 * 但归属不同插件，所以由群组在中间翻译，双方都不必知道对方的存在。
 */

import type { AgentParticipant } from 'dsh-pirate-command/protocol'
import type { AgentManifest } from './agents/registry.ts'

/**
 * 管家的执行入口契约。
 *
 * 与 `plugins/dsh-butler-console/src/protocol.ts` 的 `ButlerAgentExecutor` 形状一致，
 * 但不导入它的类型：管家是独立插件，群组不该编译期依赖它的源码。契约靠**事件名与字段**
 * 对齐，并由真实宿主运行时验收实际验证（而不是只靠类型）。
 */
export interface ButlerAgentExecutor {
  readonly protocol: 1
  readonly agentId: string
  readonly capabilities?: readonly string[]
  dispatch(request: ButlerDispatchRequest): Promise<ButlerDispatchResult>
  reply?(request: ButlerReplyRequest): Promise<ButlerDispatchResult>
}

export interface ButlerDispatchRequest {
  readonly taskId: string
  readonly subtaskId: string
  readonly goal: string
  readonly brief: string
  readonly taskGoal: string
  readonly owner: string
  readonly actor: { readonly namespace: 'standalone'; readonly userId: 'local' } | { readonly namespace: 'user'; readonly userId: string; readonly sessionId: string }
  readonly onProgress?: (update: ButlerProgressUpdate) => void
  readonly signal: AbortSignal
}

export interface ButlerReplyRequest {
  readonly taskId: string
  readonly subtaskId: string
  readonly text: string
  readonly decideByAgent: boolean
  readonly owner: string
  readonly actor: ButlerDispatchRequest['actor']
  readonly onProgress?: (update: ButlerProgressUpdate) => void
  readonly signal: AbortSignal
}

export interface ButlerProgressUpdate {
  readonly kind: string
  readonly stage?: string
  readonly text?: string
  readonly phase?: string
  readonly tool?: string
  readonly delta?: string
  readonly detail?: string
}

export interface ButlerDispatchResult {
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_user'
  readonly summary: string
  readonly conversationId?: string
  readonly question?: string
}

/** 管家事件名。与管家插件的 `BUTLER_EXECUTORS_EVENT` 必须一致。 */
export const BUTLER_EXECUTORS_EVENT = 'butler/executors'

declare module '@deepseek-ai/cordis' {
  interface Events {
    // 管家插件声明同一事件；两边靠事件名与字段对齐，不互相导入源码。
    'butler/executors': (accept: (executor: ButlerAgentExecutor) => void) => void
  }
}

/** 参与者状态到管家状态的映射。四种状态一一对应，不做归并。 */
function toButlerStatus(status: string): ButlerDispatchResult['status'] {
  switch (status) {
    case 'completed': return 'succeeded'
    case 'waiting': return 'waiting_user'
    case 'cancelled': return 'cancelled'
    default: return 'failed'
  }
}

/**
 * 进度形态转换。
 *
 * 参与者上报的是 `ParticipantProgress`（阶段 + 可选文本/工具/增量），管家要的是
 * `ButlerProgressUpdate`。只搬真实存在的字段，不替参与者编造阶段 —— 编造会让页面显示
 * 一个没发生过的协作环节。
 */
function toButlerProgress(progress: Record<string, unknown>): ButlerProgressUpdate {
  const text = typeof progress.text === 'string' ? progress.text : undefined
  const tool = typeof progress.tool === 'string' ? progress.tool : undefined
  const phase = typeof progress.phase === 'string' ? progress.phase : undefined
  return {
    kind: typeof progress.kind === 'string' ? progress.kind : 'status',
    ...(text === undefined ? {} : { text }),
    ...(tool === undefined ? {} : { tool }),
    ...(phase === undefined ? {} : { phase }),
    ...(typeof progress.delta === 'string' ? { delta: progress.delta } : {}),
  }
}

/** 参与者的进度上报是结构化对象，字段按需读取。 */
const asProgressFields = (update: unknown): Record<string, unknown> =>
  typeof update === 'object' && update !== null ? update as Record<string, unknown> : {}

/**
 * 把一位参与者包成执行入口。
 *
 * 能力摘要取清单里的分类与自述：管家用它决定把子任务派给谁，所以必须是插件自己声明的，
 * 不能由群组代写。
 */
export function executorFor(manifest: AgentManifest, participant: AgentParticipant): ButlerAgentExecutor {
  const capabilities = [manifest.category, manifest.description].filter(part => part.trim() !== '')
  return {
    protocol: 1,
    agentId: manifest.id,
    capabilities,
    async dispatch(request) {
      // `message` 用完整简报：它已经含整体目标、这位成员负责的部分和产出要求。
      const message = request.brief.trim() === '' ? request.goal : request.brief
      const result = await participant.run({
        actor: request.actor,
        missionId: request.taskId,
        requestId: request.subtaskId,
        message,
        signal: request.signal,
        onProgress: update => request.onProgress?.(toButlerProgress(asProgressFields(update))),
      })
      return {
        status: toButlerStatus(result.status),
        summary: result.text,
        conversationId: result.conversationId,
        // 参与者的 `text` 同时承载「阶段性成果」与「等待回答的问题」，而管家把两者分开。
        // 没有单独的 question 字段可用时，如实留空而不是把成果当作问题重复一遍。
      }
    },
    async reply(request) {
      // 参与者的追问走同一条 run：它按 conversationId 续发，不需要另一套协议。
      const result = await participant.run({
        actor: request.actor,
        missionId: request.taskId,
        requestId: request.subtaskId,
        message: request.text,
        signal: request.signal,
        onProgress: update => request.onProgress?.(toButlerProgress(asProgressFields(update))),
      })
      return {
        status: toButlerStatus(result.status),
        summary: result.text,
        conversationId: result.conversationId,
      }
    },
  }
}
