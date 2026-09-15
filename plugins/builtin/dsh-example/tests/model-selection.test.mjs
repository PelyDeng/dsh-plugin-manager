import {test,expect,afterEach} from 'vitest'
import {fixture} from './fixture.mjs'
const fixtures=[]
afterEach(async()=>{for(const f of fixtures.splice(0))await f.close()})
async function setup(){const f=await fixture();fixtures.push(f);return f}
test('catalog is protected; explicit switches use the host controller for the live conversation',async()=>{
  const f=await setup()
  expect((await f.request('/models',undefined,'')).status).toBe(401)
  expect((await (await f.request('/models')).json()).default).toEqual({provider:'test',model:'test'})
  expect((await f.request('/chat',{message:'bad',modelSelection:{provider:'test',model:'missing'}})).status).toBe(400)
  expect(f.handles).toHaveLength(0)
  const response=await f.request('/chat',{message:'first',modelSelection:{provider:'test',model:'second'}})
  expect(response.status).toBe(200)
  const handle=f.handles[0]
  expect(handle.selected).toEqual({provider:'test',model:'second'})
  expect(f.ctx.agentDefaultModel.currentSelection()).toEqual(handle.selected)
  expect((await f.request('/chat',{message:'busy',conversationId:handle.id,modelSelection:null})).status).toBe(409)
  f.emit(handle,'turn/end',{reason:{kind:'completed'}});await response.text()
  expect((await f.request('/models?conversationId='+handle.id,undefined,'bob')).status).toBe(404)
  expect((await f.request('/chat',{message:'foreign',conversationId:handle.id,modelSelection:null},'bob')).status).toBe(404)
  f.ctx.agentDefaultModel.currentSelection=()=>({provider:'test',model:'test'})
  expect((await (await f.request('/models?conversationId='+handle.id)).json()).selected).toEqual({provider:'test',model:'second'})
  const second=await f.request('/chat',{message:'switch',conversationId:handle.id,modelSelection:null})
  expect(handle.selected).toEqual({provider:'test',model:'test'})
  f.emit(handle,'turn/end',{reason:{kind:'completed'}});await second.text()
})
test('revocation during model validation rejects before the host selection command',async()=>{
  const f=await setup();let calls=0
  f.ctx.sessionController.selectModel=async()=>{calls++;throw Error('must not call')}
  f.ctx.llm.resolveCallConfig=async v=>{f.revoked.add('login-a');return v}
  expect((await f.request('/chat',{message:'revoked',modelSelection:null})).status).toBe(403)
  expect(calls).toBe(0);expect(f.handles).toHaveLength(0)
})
