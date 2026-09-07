import {invariant} from './settings.mjs'

export function historyHasImages(events){
  return events.some(event=>event.type==='user/message'&&event.data.content?.some(part=>part.type==='image'))
}

/** Select once before Agent creation; image history must keep a capable model. */
export async function selectBlogModel(ctx,models,hasImages,signal){
  const selected=(hasImages?models?.vision:models?.text)??models?.text??ctx.agentDefaultModel.currentSelection()
  const selection={provider:selected.provider,model:selected.model}
  if(selection.provider==='blog-zhipu'){
    const credentials=ctx.get('credentials')
    invariant(typeof credentials?.describe==='function','宿主未提供官方模型凭据服务',503)
    const status=await credentials.describe('ZHIPU_API_KEY')
    signal?.throwIfAborted()
    invariant(status.configured,'请先在“账号与应用 → 模型设置 → 智谱 GLM”中配置 API Key',422)
  }
  if(hasImages){
    const info=await ctx.llm.resolveModelInfo(selection.provider,selection.model,signal)
    invariant(info.inputModalities?.includes('image'),'当前模型未声明支持图片，请切换到支持图片的模型再试',422)
  }
  signal?.throwIfAborted()
  return selection
}
