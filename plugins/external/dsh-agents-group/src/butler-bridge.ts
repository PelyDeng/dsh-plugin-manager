/**
 * 把子包的参与者桥接成牛马大总管的执行入口。
 *
 * 两个协议的字段几乎一一对应，所以这一层只做翻译，不做任何业务决定：
 *
 * | 牛马大总管 | 参与者 |
 * | --- | --- |
 * | `taskId` / `subtaskId` | `missionId` / `requestId` |
 * | `brief`（含 `goal`） | `message` |
 * | `actor` | `actor`（原样传，不从 `owner` 字符串重建） |
 * | `acceptance` / `reworkOf` | 同名（派单）；续问只沿用 `acceptance`——口径不变，变的是用户又补了一句话 |
 * | `onProgress` | `onProgress`（形态转换） |
 * | `succeeded` / `waiting_user` / `external_pending` / `cancelled` / `failed` | `completed` / `waiting` / `external_pending` / `cancelled` / `failed` |
 * | `artifacts` / `externalPending` / `question` / `selfCheck` | 同名字段原样透传 |
 *
 * 为什么需要这一层：`AgentParticipant` 是给协作页面用的（一轮活怎么跑、拿到什么结论），
 * `ButlerAgentExecutor` 是给牛马大总管用的（派活、收结论、追问）。两者描述的是同一件事，
 * 但归属不同插件，所以由群组在中间翻译，双方都不必知道对方的存在。
 *
 * 这一层只翻译，**不做业务判断**：状态是什么就报什么，声明缺了就不传，绝不从 `text` 的措辞
 * 里推断「它大概是想结束这一轮」。
 */

import type {
  AgentArtifact,
  AgentDispatchRequest,
  AgentExecutionPhase,
  AgentExecutionProgress,
  AgentExecutionResult,
  AgentExecutor,
  AgentReplyRequest,
} from '@dsh-plugin-manager/plugin-kit'
import type { AgentParticipant, ParticipantArtifact, ParticipantResult } from '../packages/common/src/participant.ts'
import { PARTICIPANT_PROTOCOL } from '@dsh-agents-group/common'
import type { AgentManifest } from './agents/registry.ts'

/**
 * 牛马大总管的执行入口契约。
 *
 * 形状来自 kit 的 `execution.ts`，调度方（牛马大总管）和这里导入的是同一份定义，所以字段名
 * 对不上是**编译错误**而不是线上故障。历史上双方各写一份接口，靠人眼对齐字段名，结果协调方
 * 读 `stage`、这里发 `text`，第一条进度就让整轮子任务抛 `TypeError`，而两侧类型检查全绿。
 *
 * 事件名仍由调度方声明（`BUTLER_EXECUTORS_EVENT`），那是它自己的事，这里只按名订阅。
 */
export type ButlerAgentExecutor = AgentExecutor

export type ButlerDispatchRequest = AgentDispatchRequest

export type ButlerReplyRequest = AgentReplyRequest

export type ButlerProgressUpdate = AgentExecutionProgress

export type ButlerDispatchResult = AgentExecutionResult

/** 参与者的链路环节是自由字符串，只有落在 kit 的固定集合里才上报给协调方。 */
function toPhase(value: unknown): AgentExecutionPhase | undefined {
  return (['analyzing', 'tool', 'waiting_user'] as const).find(phase => phase === value)
}

/** 牛马大总管事件名。与牛马大总管插件的 `BUTLER_EXECUTORS_EVENT` 必须一致。 */
export const BUTLER_EXECUTORS_EVENT = 'butler/executors'

/**
 * 本模块认知的事件映射。
 *
 * **不要**用 `declare module '@deepseek-ai/cordis'` 重塑 `butler/executors`：那是牛马大总管的事件，
 * 两边各写一份同名类型会在 `exactOptionalPropertyTypes` 下互不兼容，让同时编译两个插件的
 * 仓库报错。契约靠事件名与字段对齐，运行时由真实宿主验收与跨插件契约测试证明。
 *
 * 所以这里只在自己的命名空间里描述签名，调用方用 {@link onButlerExecutors} 订阅。
 */
export interface ButlerEvents {
  'butler/executors': (accept: (executor: ButlerAgentExecutor) => void) => void
}

/**
 * 订阅牛马大总管的执行入口收集事件，交出本插件要登记的入口。
 *
 * 收在这一处，避免每个调用点各自做类型断言。
 */
export function onButlerExecutors(
  ctx: { on(name: string, listener: (accept: (executor: ButlerAgentExecutor) => void) => void, options: { global: boolean }): () => void },
  executor: ButlerAgentExecutor,
): () => void {
  return ctx.on(BUTLER_EXECUTORS_EVENT, accept => accept(executor), { global: true })
}

/** 参与者状态到牛马大总管状态的映射。五种状态一一对应，不做归并。 */
function toButlerStatus(status: string): ButlerDispatchResult['status'] {
  switch (status) {
    case 'completed': return 'succeeded'
    case 'waiting': return 'waiting_user'
    case 'external_pending': return 'external_pending'
    case 'cancelled': return 'cancelled'
    // 认不出来的状态按失败处理：当成成功会把一次没跑完的活报成成果。
    default: return 'failed'
  }
}

/**
 * 材料的字段映射。
 *
 * 参与者的 `kind` 是它自己的有限集合，协调方的 `kind` 是开放的字符串；这里原样搬过去，
 * 不替对方归并成几类 —— 分类的含义只有发布方清楚。
 */
function toButlerArtifacts(artifacts: readonly ParticipantArtifact[]): AgentArtifact[] {
  return artifacts.map(artifact => ({ title: artifact.title, path: artifact.path, kind: artifact.kind }))
}

/**
 * 结论的公共部分：状态、正文、会话、材料，以及两种等待原因各自的声明。
 *
 * **不解析 `text` 猜状态。** 参与者说 `external_pending` 就是 `external_pending`，说
 * `waiting` 就是 `waiting_user`；缺声明时宁可少传一个字段，也不从文案里推断「它大概是想
 * 让我结束这一轮」。协调方那边同样是「没有明确声明就不动」。
 */
function toButlerResult(result: ParticipantResult): ButlerDispatchResult {
  return {
    status: toButlerStatus(result.status),
    summary: result.text,
    conversationId: result.conversationId,
    ...(result.question === undefined ? {} : { question: result.question }),
    ...(result.artifacts === undefined ? {} : { artifacts: toButlerArtifacts(result.artifacts) }),
    ...(result.externalPending === undefined ? {} : { externalPending: result.externalPending }),
    // 自检结论原样透传，缺声明就不传：协调方据此把「没自检」与「自检通过」分开，
    // 这里替参与者补一个 passed 会把一次没人核验过的交付显示成已核验。
    ...(result.selfCheck === undefined ? {} : { selfCheck: result.selfCheck }),
  }
}

/**
 * 进度形态转换。
 *
 * 参与者上报的是 `ParticipantProgress`（`text` 是状态或消息正文，外加可选增量），协调方要的
 * 是 kit 的 `AgentExecutionProgress`（`stage` 是状态行）。所以这里做一次**改名**：`text` → `stage`，
 * 并保证它一定是字符串 —— 对方拿它去压平空白，缺字段会直接抛
 * `Cannot read properties of undefined`，把整轮子任务打成失败（线上出现过）。参与者没给
 * 正文时给空串：对方自己会把空状态行显示成「干活中」，这里不替它编一个没发生过的阶段。
 */
function toButlerProgress(progress: Record<string, unknown>): ButlerProgressUpdate {
  const text = typeof progress.text === 'string' ? progress.text : undefined
  const tool = typeof progress.tool === 'string' ? progress.tool : undefined
  const phase = toPhase(progress.phase)
  // 原业务会话引用原样透传（G02）：获得即上报，协调方尽早落库——final 前失败或进程
  // 重启时，任务记录里仍找得回原会话，不需要重新派活去补。
  const conversationId = typeof progress.conversationId === 'string' ? progress.conversationId : undefined
  const conversationArtifact = isConversationArtifact(progress.conversationArtifact)
  return {
    stage: text ?? '',
    ...(tool === undefined ? {} : { tool }),
    ...(phase === undefined ? {} : { phase }),
    ...(typeof progress.delta === 'string' ? { delta: progress.delta } : {}),
    ...(typeof progress.thinking === 'string' ? { thinking: progress.thinking } : {}),
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(conversationArtifact === undefined ? {} : { conversationArtifact }),
  }
}

/** 会话材料定位按字段类型核验后才透传；缺字段的声明整条不传，不让坏数据混进协调方。 */
function isConversationArtifact(value: unknown): ButlerProgressUpdate['conversationArtifact'] {
  if (typeof value !== 'object' || value === null) return undefined
  const artifact = value as { title?: unknown; path?: unknown; kind?: unknown }
  if (typeof artifact.title !== 'string' || typeof artifact.path !== 'string' || artifact.kind !== 'conversation') return undefined
  return { title: artifact.title, path: artifact.path, kind: 'conversation' }
}

/** 参与者的进度上报是结构化对象，字段按需读取。 */
const asProgressFields = (update: unknown): Record<string, unknown> =>
  typeof update === 'object' && update !== null ? update as Record<string, unknown> : {}

/**
 * 把一位参与者包成执行入口。
 *
 * 先核验内部契约（G03）：协议版本与身份不一致的参与者**不包装**——把不兼容协议硬包成
 * 1 再派活，比让它缺席更难查。核验失败只影响该成员，调用方跳过登记并清理本次资源。
 *
 * 能力摘要取清单里的分类与自述：牛马大总管用它决定把子任务派给谁，所以必须是插件自己声明的，
 * 不能由群组代写。续问入口只在参与者**显式实现** `reply` 时暴露（G01）：不因「存在通用 run」
 * 推断可以续问。
 */
export function executorFor(manifest: AgentManifest, participant: AgentParticipant): ButlerAgentExecutor {
  if (participant.protocol !== PARTICIPANT_PROTOCOL) {
    throw new Error(`参与者协议版本不兼容：期望 ${PARTICIPANT_PROTOCOL}，${manifest.id} 报告 ${String(participant.protocol)}`)
  }
  if (participant.id !== manifest.id) {
    throw new Error(`参与者身份与清单不一致：清单 ${manifest.id}，参与者 ${participant.id}`)
  }
  const capabilities = [manifest.category, manifest.description].filter(part => part.trim() !== '')
  // 续问入口：参与者显式实现了 reply 才暴露（G01）。提为 const 以便闭包内保持收窄。
  const participantReply = participant.reply
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
        /**
         * ⚠️ **幂等身份必须唯一到 `(agent, owner)`，不能只用子任务 id。**
         *
         * `subtaskId` 只在**任务内**唯一（`s1`、`s2`…），而运行时的存储（`dsh_turns` 的部分唯一索引
         * `(agent_id, owner_namespace, owner_id, request_id)`）与进程内幂等缓存都按 `(agent, owner, requestId)` 分桶。
         * 直接拿 `subtaskId` 当 `requestId`，两个任务的第一个子任务就会撞同一个键，内容又必然不同
         * ⇒ 运行时按契约抛 `AccessError(409, '同一请求身份不能用在不同内容上')`。
         * **生产实测（2026-09-17）**：任务 A 的 `s1` 成功后，任务 B 的 `s1` 必然失败（换新 id 的 `s2` 重试则成功）。
         *
         * 用 `<taskId>:<subtaskId>`：任务 id 全局唯一（`butler-task-<uuid>`），
         * 同一子任务**重派仍是同一个键**（幂等语义不变），跨任务不再互撞。
         * `missionId` 仍是 `taskId`（会话派生按任务走），不受影响。
         */
        requestId: `${request.taskId}:${request.subtaskId}`,
        message,
        // 验收口径与重做溯源逐字段透传：它们决定执行方要不要自检、以及是不是换做法重跑，
        // 悄悄丢掉只会让执行方以为这是一次普通派活（而契约测试在 participant 侧取证）。
        ...(request.acceptance === undefined ? {} : { acceptance: request.acceptance }),
        ...(request.reworkOf === undefined ? {} : { reworkOf: request.reworkOf }),
        signal: request.signal,
        onProgress: update => request.onProgress?.(toButlerProgress(asProgressFields(update))),
      })
      return toButlerResult(result)
    },
    // 参与者没实现 reply 就不暴露续问：协调方会如实显示「不接受中途回话」。
    ...(participantReply === undefined ? {} : {
      async reply(request) {
        // 续问身份（G01）：requestId 是这一次回话的幂等身份（同次重试复用、新回话换新 ID），
        // 与子任务 ID 分开；conversationId 是协调方落库的原会话引用，沿它续接不再新建。
        // 缺失或空白（含空格、制表符等纯空白）时**明确拒绝**而不是回落子任务 ID——回落
        // 会让同一子任务的多次回话撞同一个幂等键（第二次被判异文冲突、同文错误命中旧
        // 结论），正是 G01 要消除的。
        if (typeof request.requestId !== 'string' || request.requestId.trim() === '') {
          throw new Error('续问缺少本次回话的幂等身份（requestId）；调用方需要按新契约升级，桥接不伪造身份')
        }
        const result = await participantReply({
          actor: request.actor,
          missionId: request.taskId,
          requestId: request.requestId,
          message: request.text,
          // 续问沿用同一份验收口径：口径不变，变的是用户又补了一句话。
          ...(request.acceptance === undefined ? {} : { acceptance: request.acceptance }),
          ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
          signal: request.signal,
          onProgress: update => request.onProgress?.(toButlerProgress(asProgressFields(update))),
        })
        return toButlerResult(result)
      },
    }),
  }
}
