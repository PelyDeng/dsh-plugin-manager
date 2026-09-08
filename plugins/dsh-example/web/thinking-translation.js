import {element,stat,updateThinking} from './chat-ui.js'

// Same conservative prose check as the server; code and links retain their spelling.
export function needsChineseTranslation(text){
  const prose=text.replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+/g,'')
  return (prose.match(/[A-Za-z]/g)??[]).length>=16&&(prose.match(/[A-Za-z]+/g)??[]).length>=4&&(prose.match(/[A-Za-z]/g)??[]).length>(prose.match(/\p{Script=Han}/gu)??[]).length*2
}

/** Translate only observed saved thoughts; keep original streams and feedback untouched. */
export function createThinkingTranslations(base){
  const entries=new Map(),active=new Set(),queue=[]
  let bindings=new WeakMap(),epoch=0
  const observer=new IntersectionObserver(rows=>{for(const row of rows){const binding=bindings.get(row.target);if(row.isIntersecting&&binding?.entry?.state==='idle')enqueue(binding.entry)}})
  function reset(){epoch++;observer.disconnect();for(const entry of active)entry.controller.abort();active.clear();entries.clear();queue.length=0;bindings=new WeakMap()}
  function sweep(){for(const entry of entries.values())for(const node of entry.views)if(!node.isConnected){entry.views.delete(node);observer.unobserve(node)}}
  function extras(details){
    let panel=details.querySelector('.qa-translation-panel')
    if(panel)return panel
    panel=element('div',undefined,'qa-translation-panel')
    const note=element('p',undefined,'qa-translation-note'),retry=element('button','重试译文','qa-translation-retry'),original=element('details',undefined,'qa-thinking-original'),originalText=element('pre'),metadata=element('div',undefined,'qa-translation-metadata')
    retry.type='button';retry.hidden=true;retry.addEventListener('click',()=>{const entry=bindings.get(details)?.entry;if(entry&&entry.state==='failed'){entry.state='idle';entry.error='';enqueue(entry)}})
    original.append(element('summary','查看模型原文'),originalText);panel.append(note,retry,original,metadata);details.append(panel)
    const badge=element('span','中文译文','qa-translation-badge');badge.hidden=true;details.querySelector('summary .qa-thinking-title').after(badge)
    return panel
  }
  function render(details,binding){
    const entry=binding.entry,result=entry?.result,panel=extras(details),note=panel.querySelector('.qa-translation-note'),retry=panel.querySelector('button'),body=details.querySelector('.qa-thinking-body'),top=body.scrollTop
    const oldOriginal=panel.querySelector('pre'),originalTop=oldOriginal.scrollTop
    oldOriginal.textContent=binding.text;oldOriginal.scrollTop=originalTop
    const translated=result?.status==='translated'
    details.querySelector('.qa-translation-badge').hidden=!translated
    let copy=result?.text??(entry?.state==='failed'?'中文译文暂不可用；可以重试或查看原文。':binding.sourceId?'正在整理中文译文…':'正在生成思考，稍后整理中文译文…')
    updateThinking(details,copy,binding.done);body.scrollTop=top
    note.textContent=translated?`上方为中文译文，模型原文保持不变。${result.partial?'原文已中断，仅翻译已保存部分。':''}`:entry?.error??'中文译文单独生成，不影响正文回答。'
    retry.hidden=entry?.state!=='failed';retry.disabled=entry?.state==='loading'
    const metadata=panel.querySelector('.qa-translation-metadata')
    if(translated&&metadata.dataset.result!==String(result.createdAt)){
      metadata.replaceChildren();metadata.dataset.result=String(result.createdAt)
      const u=result.usage,rows=[['翻译模型',result.provider+' / '+result.model],['未缓存输入',u?.inputTokens],['缓存读取',u?.cacheReadTokens],['缓存写入',u?.cacheWriteTokens],['输出',u?.outputTokens],['其中思考',u?.reasoningTokens],['合计',u?.totalTokens],['用时',Number.isFinite(result.elapsedMs)?(result.elapsedMs/1000).toFixed(2)+' 秒':null],['译文生成于',new Date(result.createdAt).toLocaleString('zh-CN')]]
      metadata.append(stat('database','译文用量',rows))
    }
  }
  function notify(entry){for(const details of entry.views){const binding=bindings.get(details);if(details.isConnected&&binding?.entry===entry)render(details,binding)}}
  function enqueue(entry){if(entry.state!=='idle')return;entry.state='queued';queue.push(entry);notify(entry);pump()}
  function pump(){while(active.size<2&&queue.length){const entry=queue.shift();if(![...entry.views].some(n=>n.isConnected)){entry.state='idle';continue}void load(entry)}}
  async function load(entry){
    const version=epoch;entry.state='loading';entry.controller=new AbortController();active.add(entry);notify(entry)
    try{
      const r=await fetch(base+'/reasoning-translation',{method:'POST',headers:{'content-type':'application/json'},signal:entry.controller.signal,body:JSON.stringify({conversationId:entry.conversationId,sourceId:entry.sourceId})})
      const result=await r.json();if(!r.ok)throw Error(result.error??'中文译文生成失败，请重试')
      if(version!==epoch)return
      entry.result=result;entry.state='done'
    }catch(error){if(version!==epoch)return;entry.state='failed';entry.error=error.name==='AbortError'?'译文请求已取消':error.message}
    finally{active.delete(entry);if(version===epoch){notify(entry);pump()}}
  }
  function watch(details,{text='',conversationId,sourceId,done=true}){
    const prior=bindings.get(details)
    if(prior)prior.entry?.views.delete(details)
    observer.unobserve(details)
    if(!needsChineseTranslation(text)){
      bindings.delete(details);details.querySelector('.qa-translation-panel')?.remove();details.querySelector('.qa-translation-badge')?.remove();updateThinking(details,text,done);return
    }
    let entry
    if(conversationId&&sourceId){
      const key=JSON.stringify([conversationId,sourceId,text]);entry=entries.get(key)
      if(!entry){entry={conversationId,sourceId,text,state:'idle',result:null,error:'',views:new Set(),controller:null};entries.set(key,entry)}
      entry.views.add(details)
    }
    const binding={text,sourceId,done,entry};bindings.set(details,binding);render(details,binding)
    if(entry?.state==='idle')observer.observe(details)
  }
  window.addEventListener('beforeunload',reset)
  return {watch,reset,sweep}
}
