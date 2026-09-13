import {invariant} from './settings.mjs'
import {defaultConversationModel,requestedConversationModel} from '@dsh-plugin-manager/plugin-kit/models'

export function historyHasImages(events){
  return events.some(event=>event.type==='user/message'&&event.data.content?.some(part=>part.type==='image'))
}

/** Select once before Agent creation; image history must keep a capable model. */
export async function selectBlogModel(ctx,models,hasImages,signal){
  signal?.throwIfAborted()
  const selected=(hasImages?models?.vision:models?.text)??models?.text??defaultConversationModel(ctx)
  const selection={provider:selected.provider,model:selected.model,...(selected.reasoningEffort===undefined?{}:{reasoningEffort:selected.reasoningEffort})}
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
