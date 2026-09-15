import test from 'node:test'
import assert from 'node:assert/strict'
import {selectBlogModel} from '../src/models.mjs'

function fixture(){
  const ctx={get(name){return this[name]},
    agentDefaultModel:{currentSelection:()=>({provider:'default',model:'default'})},
    sessionController:{async modelCatalog(){return{groups:[{id:'default',name:'Default',models:[{id:'default',name:'Default'}]},{id:'zhipu',name:'GLM',models:[{id:'text',name:'Text'},{id:'vision',name:'Vision'}]}],failures:[]}},selectModel(){assert.fail('validation must not submit a selection')}},
    llm:{resolveCallConfig:async selection=>selection},
  }
  return ctx
}

test('text and image selections share credential readiness and never silently fall back',async()=>{
  let configured=true,lookups=[]
  const ctx=fixture()
  ctx.credentials={describe:async ref=>{assert.equal(ref,'ZHIPU_API_KEY');return{configured}}}
  ctx.llm.resolveModelInfo=async(provider,model)=>{lookups.push({provider,model});return{inputModalities:model==='vision'?['text','image']:['text']}}
  const models={text:{provider:'zhipu',model:'text'},vision:{provider:'zhipu',model:'vision'}}
  assert.deepEqual(await selectBlogModel(ctx,models,false),models.text)
  assert.deepEqual(await selectBlogModel(ctx,models,true),models.vision)
  configured=false
  await assert.rejects(selectBlogModel(ctx,models,false),/模型设置/)
  await assert.rejects(selectBlogModel(ctx,models,true),/模型设置/)
  assert.equal(lookups.length,1)
  const route=ctx.llm.resolveCallConfig
  ctx.llm.resolveCallConfig=async()=>{throw new Error('missing credential route')}
  await assert.rejects(selectBlogModel(ctx,models,false),/模型设置/)
  ctx.llm.resolveCallConfig=route
  assert.deepEqual(await selectBlogModel(ctx,undefined,false),{provider:'default',model:'default'})
  await assert.rejects(selectBlogModel(ctx,undefined,true),/未声明支持图片/)
})

test('default and configured models must exist in the official directory and have a valid route',async()=>{
  const ctx=fixture(),original=ctx.agentDefaultModel.currentSelection()
  for(const models of [undefined,{text:{provider:'default',model:'removed'}}]){
    ctx.agentDefaultModel.currentSelection=()=>({provider:'default',model:'removed'})
    await assert.rejects(selectBlogModel(ctx,models,false),/不在当前目录/)
  }
  ctx.agentDefaultModel.currentSelection=()=>original
  ctx.llm.resolveCallConfig=async()=>{throw new Error('no route')}
  await assert.rejects(selectBlogModel(ctx,undefined,false),/路由当前不可用/)
  assert.deepEqual(ctx.agentDefaultModel.currentSelection(),original)
})

test('implicit validation preserves historical reasoning effort without submitting a selection',async()=>{
  const ctx=fixture(),pinned=Object.freeze({provider:'default',model:'default',reasoningEffort:'high'})
  ctx.llm.resolveCallConfig=async selection=>{assert.deepEqual(selection,{provider:'default',model:'default'});return{...selection}}
  assert.deepEqual(await selectBlogModel(ctx,{text:pinned},false),pinned)
  assert.deepEqual(ctx.agentDefaultModel.currentSelection(),{provider:'default',model:'default'})
})

test('abort while resolving the directory prevents further image inspection',async()=>{
  const ctx=fixture(),controller=new AbortController(),gate=Promise.withResolvers(),entered=Promise.withResolvers()
  const catalog=await ctx.sessionController.modelCatalog()
  ctx.sessionController.modelCatalog=async()=>{entered.resolve();await gate.promise;return catalog}
  ctx.llm.resolveModelInfo=()=>assert.fail('aborted selection must stop before image inspection')
  const pending=selectBlogModel(ctx,undefined,true,controller.signal)
  const rejected=assert.rejects(pending,{name:'AbortError'})
  await entered.promise;controller.abort();gate.resolve();await rejected
})
