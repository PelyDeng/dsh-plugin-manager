import test from 'node:test'
import assert from 'node:assert/strict'
import {selectBlogModel} from '../src/models.mjs'

test('text and image selections share credential readiness and never silently fall back',async()=>{
  let configured=true,lookups=[]
  const ctx={get:()=>({describe:async ref=>{assert.equal(ref,'ZHIPU_API_KEY');return{configured}}}),agentDefaultModel:{currentSelection:()=>({provider:'default',model:'default'})},llm:{resolveModelInfo:async(provider,model)=>{lookups.push({provider,model});return{inputModalities:model==='vision'?['text','image']:['text']}}}}
  const models={text:{provider:'blog-zhipu',model:'text'},vision:{provider:'blog-zhipu',model:'vision'}}
  assert.deepEqual(await selectBlogModel(ctx,models,false),models.text)
  assert.deepEqual(await selectBlogModel(ctx,models,true),models.vision)
  configured=false
  await assert.rejects(selectBlogModel(ctx,models,false),/模型设置/)
  await assert.rejects(selectBlogModel(ctx,models,true),/模型设置/)
  assert.equal(lookups.length,1)
  assert.deepEqual(await selectBlogModel(ctx,undefined,false),{provider:'default',model:'default'})
  await assert.rejects(selectBlogModel(ctx,undefined,true),/未声明支持图片/)
})
