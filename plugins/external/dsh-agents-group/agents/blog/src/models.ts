import {invariant} from './settings.ts'
import {defaultConversationModel,requestedConversationModel} from '@dsh-plugin-manager/plugin-kit/models'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/**
 * 一次模型选择：**面向宿主**的形状（`provider` / `model` / `reasoningEffort`）。
 *
 * ⚠️ **`reasoningEffort` 必须用宿主的 branded id，不能用 `string`**：kit 的公开类型
 * （`plugin-kit/src/models.ts:6`）把它写成 `string`，而宿主的 `AgentOptions.reasoningEffort`
 * 要的是 `ReasoningEffortId`（`dsh-llm` 的 `Branded<'ReasoningEffortId'>`）⇒ 用 `string` 的话
 * **每一个消费方**（例如 `jobs.ts` 把 selection 塞进 `agentOptions`）都得在原地写一次收窄。
 * 收窄放在**源头这一处**（见 `:26` 的说明），消费方就都是干净的类型。
 */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  /**
   * ⚠️ **不要写成 `ReasoningEffortId | undefined`**：`exactOptionalPropertyTypes` 下
   * "可选且可为 undefined"与宿主 `AgentOptions.reasoningEffort?: ReasoningEffortId` 的
   * "可选但**不可**显式 undefined"**不是同一种形状** ⇒ 消费方（`jobs.ts` 把它展开进 `agentOptions`）
   * 会报 TS2375。省略 `| undefined` 才是与宿主逐字同形（构造侧本来就只在有值时展开这个键）。
   */
  readonly reasoningEffort?: ReasoningEffortId
}
/**
 * 业务配置里的两个档位（`text` / `vision`），可能整段缺失。
 *
 * 输入侧**故意保持 `string`**：值来自 JSON 配置，合法性由下面的 `requestedConversationModel`
 * 目录校验兜住（非法即 422），类型层不该假称"配置里一定是合法 id"。
 */
export interface BlogModelChoices {
  readonly text?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string | undefined }
  readonly vision?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string | undefined }
}

export function historyHasImages(events: readonly SessionEvent[]): boolean {
  return events.some(event=>event.type==='user/message'&&event.data.content?.some((part: {type?: string})=>part.type==='image'))
}

/** Select once before Agent creation; image history must keep a capable model. */
export async function selectBlogModel(ctx: Context, models: BlogModelChoices | undefined, hasImages: boolean, signal?: AbortSignal): Promise<ModelSelection> {
  signal?.throwIfAborted()
  const selected=(hasImages?models?.vision:models?.text)??models?.text??defaultConversationModel(ctx)
  /**
   * ⚠️ **唯一一处收窄断言**，理由有两半：
   * ① **类型层**：值的来源是 kit 的公开类型（`reasoningEffort?: string`），而宿主要 branded id
   *    —— 这个差距**不在本站**，在 kit（改它要先落公共库，见仓库 AGENTS.md 的公共库规则）；
   * ② **运行期**：这个值紧接着就被 `requestedConversationModel(ctx, selection)` 拿到宿主的模型目录里去核
   *    （`:23` 下面那行），**非法值在那里就被拒**（实测报错是"模型不在当前目录"一类 4xx），
   *    所以"到了下游还是合法 id"是有守卫的，不是凭空断言。
   */
  const effort=selected.reasoningEffort as ReasoningEffortId | undefined
  const selection: ModelSelection = {provider:selected.provider,model:selected.model,...(effort===undefined?{}:{reasoningEffort:effort})}
  // 智谱路由的凭据前置校验：早报错比让整轮跑到模型调用才失败更清楚。
  // provider 已是通用选项（id `zhipu`），这里只对智谱做这道检查。
  if(selection.provider==='zhipu'){
    const credentials=ctx.get('credentials')
    invariant(typeof credentials?.describe==='function','宿主未提供官方模型凭据服务',503)
    const status=await credentials.describe('ZHIPU_API_KEY')
    signal?.throwIfAborted()
    invariant(status.configured,'请先在“账号与应用 → 模型设置 → 智谱”中配置 API Key',422)
  }
  // 只验证目录与路由；隐式恢复保留原推理强度，不提交选择或改写宿主默认。
  await requestedConversationModel(ctx,selection)
  signal?.throwIfAborted()
  if(hasImages){
    const info=await ctx.llm.resolveModelInfo(selection.provider,selection.model,signal)
    invariant(info.inputModalities?.includes('image'),'当前模型未声明支持图片，请切换到支持图片的模型再试',422)
  }
  signal?.throwIfAborted()
  return selection
}
