/**
 * 绘语的智能体定义：身份、人设、工具、结果投影。
 *
 * 子包**不自己实现协作参与者**——那是运行时的事（`packages/runtime/src/participant.ts` 的
 * `createParticipant`）。这里只交出"这个 Agent 是什么、能做什么、怎么把一轮的产出收成结论"，
 * 会话、工具限制、进度上报、幂等、结果投影的机制全在运行时里实现一次。
 *
 * 所以本文件没有一行会话管理代码，那是刻意的。
 */

import Schema from '@deepseek-ai/schemastery'
import type { AgentDefinition, ProjectedResult, ResultContext } from '../../../packages/runtime/src/definition.ts'
import type { ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type { HuiyuToolContext } from './tools/context.ts'
import { HuiyuError } from './errors.ts'

/** 绘制的人格。写作口径：说清它是谁、怎么做事、以及**不要**做什么。 */
export const HUIYU_PERSONA = [
  '你是绘语，一位图片智能体。你能看懂图片，也能把文字画成图片。',
  '',
  '## 你怎么做事',
  '',
  '- 用户给你一张图时，先用识图工具把它取出来看清楚，再回答。**不要**凭用户对图片的描述作答。',
  '- 需要逐字读取图中文字（表格、发票、报表、截图）时用 huiyu_extract，泛泛了解画面用 huiyu_describe。',
  '- 用户要图片时，先判断这是通用出图、文章头图还是段落配图，再选对应的工具。',
  '- 用户说“上次那张”“再要一张差不多的”时，先用 huiyu_library 找历史记录，能找到就别重新生成——重新生成要花钱，而且结果不一样。',
  '',
  '## 你的边界',
  '',
  '- 生成的图片会返回一个可访问的地址，把它**原样**告诉用户，不要改写成别的形式。',
  '- 图片生成要花钱、要时间。一次不要生成很多张，也不要为了“多给几个选择”而超额生成。',
  '- 工具报“未配置”时，如实转达缺什么，**不要**改成“我帮你写一段提示词你自己去画”这类替代方案——那会让用户以为功能坏了却不知道坏在哪。',
  '- 你只处理图片。视频、图片编辑（局部重绘、扩图、去背景）都不在能力范围内，遇到时直接说明。',
].join('\n')

/** 工具的注册上下文由装配侧注入；这里只声明形状，避免定义文件依赖具体装配。 */
export interface HuiyuDefinitionInput {
  readonly category: string
  readonly permission: string
  /**
   * 工具的装配上下文。
   *
   * ⚠️ **工具不在这里注册**。注册发生在装配期（`src/index.ts` 调 `registerHuiyuTools`），
   * 本定义只**交回已注册的目录条目**——与 blog 同一口径（它的注释写着"业务工具在
   * `BlogJobs` 的构造函数里已经注册过，这里只交回目录条目"）。
   *
   * 在定义里再注册一次会撞上宿主的保护：
   * `tool "x" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)`。
   * 那条保护是对的：同一个工具名在插件作用域注册两次，第二次会被当成"跨 Agent 的名字冲突"。
   */
  readonly tools: HuiyuToolContext
  /** 装配期已注册并交回的目录条目。 */
  readonly registered: readonly ToolDescriptor[]
}

/**
 * 绘语的部署配置 Schema。
 *
 * 字段与群组注入的公共字段一致（`routePrefix` / `publicOrigin` / `accessMode`），
 * 其余业务参数走群组 `env.conf` 的 `HUIYU_` 键，不进这里——配置只有一个权威来源。
 */
export const Config: Schema<{ accessMode: 'authenticated', publicOrigin: string, routePrefix: string }> = Schema.object({
  // 绘语按会话隔离图片记录，业务前提是"必须有可信身份"，所以只接受 authenticated。
  accessMode: Schema.const('authenticated').default('authenticated'),
  publicOrigin: Schema.string().default(''),
  routePrefix: Schema.string().default('/agents/huiyu'),
})

/** 本定义的配置类型。 */
export type PluginConfig = { accessMode: 'authenticated', publicOrigin: string, routePrefix: string }

/**
 * 造绘语的智能体定义。
 *
 * @param input 分类标签、授权标识与工具装配上下文
 * @returns 可直接交给 `createAgentRuntime` 的定义
 */
export function createHuiyuDefinition(input: HuiyuDefinitionInput): AgentDefinition {
  return {
    id: 'huiyu',
    displayName: '绘语',
    description: '图片理解与生成：看懂图片内容，也能按描述生成图片',
    persona: HUIYU_PERSONA,
    config: Config as unknown as AgentDefinition['config'],
    /**
     * 交回装配期已注册的目录条目。
     *
     * 运行时会调它一次来算"这个 Agent 能用哪些工具"，**返回值必须与真正注册的一致**；
     * 少报会让对应工具对该 Agent 不可见，而那种失效在界面上看不出来。
     */
    tools: () => input.registered,
    /**
     * 一轮的结果投影。
     *
     * 绘语的产出就是正文本身（图片地址与说明都在里面），没有需要用户在原页面确认的待办，
     * 所以这里只做"成功/失败"的判断，不额外造 action 或 artifact。
     *
     * ⚠️ `waiting` 与 `external_pending` 都不产出：绘语一轮里能自己做完的事就做完，
     * 需要用户补信息时模型会在正文里直接问，那属于正常回答而不是协作层的"等待"。
     */
    projectResult: async (ctx: ResultContext): Promise<ProjectedResult> => {
      const text = ctx.history.finalText.trim()
      if (text === '') {
        return { status: 'failed', text: '这一轮没有产出任何内容。' }
      }
      return { status: 'completed', text }
    },
  }
}

/**
 * 未就绪时的协作入口占位。
 *
 * 它**不伪造能力**：`assertAccess` 与 `run` 一律以 503 加稳定原因拒绝，协作侧（牛马大总管）
 * 拿到的是"这个成员现在不能用、因为配置没到位"，而不是"这个成员不存在"，也不是一句空结果。
 *
 * 身份三项与 {@link createHuiyuDefinition} 逐字相同——改名会让协调方与用户看到两个不同的成员。
 */
export function unavailableReason(error: unknown): string {
  if (error instanceof HuiyuError) return error.message
  return error instanceof Error ? error.message : String(error)
}
