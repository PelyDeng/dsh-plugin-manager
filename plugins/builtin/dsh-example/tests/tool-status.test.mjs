import {test,expect} from 'vitest'
import {projectTurns} from '../src/turns.ts'

test('tool result error flag is authoritative even without optional diagnostic metadata',()=>{
  const events=[{type:'turn/start',seq:0,time:0,data:{turn:1}}]
  for(const [callId,isError,error] of [['failed',true,undefined],['diagnostic',false,{code:'FAIL'}],['success',false,undefined]]){
    events.push({type:'tool/call',seq:events.length,time:1,data:{turn:1,callId,name:callId}})
    events.push({type:'tool/result',seq:events.length,time:2,data:{turn:1,message:{source:{kind:'tool',callId},content:[{type:'tool-result',isError,content:[{type:'text',text:'PRIVATE-RESULT'}]}]},...(error?{error}:{})}})
  }
  const turns=projectTurns(events)
  expect(turns[0].tools.map(tool=>tool.status)).toEqual(['failed','failed','succeeded'])
  expect(JSON.stringify(turns)).not.toContain('PRIVATE-RESULT')
})
