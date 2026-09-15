/** Public DSH event projections; no client-side estimates of model usage. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import * as llm from '@deepseek-ai/dsh-llm'

export function projectTurns(events: readonly SessionEvent[]) {
  const turns: Array<{ messageId?: string; branchSeq?: number; completedAt?: number; runMs?: number; ttftMs?: number; usage?: ReturnType<typeof deriveTurnTokenUsage>; tools: Array<{id:string;name:string;status:string}>; status:string }> = []
  let current: typeof turns[number] | undefined, start = 0, startedAt: number | undefined, firstRequest: number | undefined, firstToken: number | undefined
  const ensure=():typeof turns[number]=>{if(!current){current={tools:[],status:'running'};turns.push(current)}return current}
  for(const [i,event] of events.entries()){
    if(event.type==='turn/start'){current=undefined;start=i;startedAt=event.time;firstRequest=undefined;firstToken=undefined;ensure()}
    if(event.type==='step/start'&&firstRequest===undefined)firstRequest=event.time
    if(event.type==='assistant/message'){
      ensure().messageId=event.data.message.id
    }
    if((event.type==='assistant/message'||event.type==='assistant/attempt')&&event.data.stream&&firstToken===undefined){
      firstToken=llm.expandAssistantStream(event.data.stream).find(x=>['text-delta','reasoning-delta','tool-call-delta'].includes(x.chunk.type))?.time
    }
    if(event.type==='tool/call')ensure().tools.push({id:String(event.data.callId),name:event.data.name,status:'running'})
    if(event.type==='tool/result'){const tool=ensure().tools.find(t=>t.id===String(event.data.message.source.callId));if(tool)tool.status=event.data.error||event.data.message.content.some(block=>block.type==='tool-result'&&block.isError===true)?'failed':'succeeded'}
    if(event.type==='turn/end'){
      const turn=ensure();turn.status=event.data.reason.kind
      if(Number.isFinite(event.time)){turn.completedAt=event.time;if(Number.isFinite(startedAt))turn.runMs=Math.max(0,event.time-startedAt!)}
      if(Number.isFinite(firstRequest)&&Number.isFinite(firstToken))turn.ttftMs=Math.max(0,firstToken!-firstRequest!)
      if(event.data.reason.kind==='completed'&&Number.isSafeInteger(event.seq))turn.branchSeq=event.seq
      const usage=deriveTurnTokenUsage(events.slice(start,i+1));if(usage)turn.usage=usage
      current=undefined
    }
  }
  return turns
}
