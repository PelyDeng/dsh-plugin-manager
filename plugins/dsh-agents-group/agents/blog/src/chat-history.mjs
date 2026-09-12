/** Safe human transcript over official Session surface, stream and token projections. */
import {BlockAssembler} from '@deepseek-ai/dsh-llm'
export function projectChat(events,requests,sdk) {
  const messages=[],turns=[],tools=new Map(),requestsByMessage=new Map(requests.filter(r=>r.userMessageId).map(r=>[r.userMessageId,r]))
  let turn=null,stepStart=null,decodeMs=0,outputTokens=0,firstStep=null
  const text=content=>content.filter(b=>b.type==='text').map(b=>b.text).join('')
  const reasoning=content=>content.filter(b=>b.type==='reasoning').map(b=>b.text).join('')
  for(let index=0;index<events.length;index++) {
    const event=events[index],data=event.data
    if(event.type==='turn/start'){
      turn={turn:data.turn,startSeq:event.seq,startIndex:index,startedAt:event.time,status:'running',messageIds:[],usage:null,runMs:null,ttftMs:null,tokensPerSecond:null,attempts:0,cut:null}
      turns.push(turn);stepStart=null;decodeMs=0;outputTokens=0;firstStep=null
    }
    if(event.type==='step/start'){stepStart=event.time;if(firstStep===null)firstStep=data.step}
    if(event.type==='tool/call'){
      const node={id:'tool-'+event.seq,role:'tool',turn:turn?.turn,seq:event.seq,time:event.time,name:data.name,status:'running'}
      messages.push(node);tools.set(data.callId,node)
    }
    if(event.type==='tool/result'){
      const node=tools.get(data.message.source.callId);if(node)node.status=data.error||data.message.content.some(block=>block.type==='tool-result'&&block.isError===true)?'failed':'succeeded'
    }
    if(event.type==='llm/retry')messages.push({id:'retry-'+event.seq,role:'status',seq:event.seq,time:event.time,turn:turn?.turn,text:'模型请求失败，正在重试'})
    if(event.type==='assistant/attempt'){
      const stream=sdk.expandAssistantStream(data.stream)
      const assembler=new BlockAssembler()
      for(const {chunk} of stream)assembler.push(chunk)
      const blocks=assembler.blocks()
      const value={id:'attempt-'+event.seq,role:'assistant',seq:event.seq,time:event.time,turn:turn?.turn,text:text(blocks),reasoning:reasoning(blocks),interrupted:true,feedback:false}
      if(value.text||value.reasoning)messages.push(value)
      if(turn)turn.attempts++
    }
    if(sdk.isAppendSurfaceEvent(event)){
      const message=sdk.deriveEventMessage(event)
      if(message&&message.role==='user'&&message.source.kind==='user'){
        const request=requestsByMessage.get(message.id)
        messages.push({id:message.id,role:'user',seq:event.seq,time:event.time,turn:turn?.turn,text:request?.input.text??text(message.content),requestId:request?.id,attachments:(request?.attachments??[]).map(a=>({id:a.id,name:a.name,kind:a.kind,range:a.range,partial:a.partial}))})
      }
      if(event.type==='assistant/message'){
        if(turn)turn.attempts++
        if(message){
          const node={id:message.id,role:'assistant',seq:event.seq,time:event.time,turn:turn?.turn,text:text(message.content),reasoning:reasoning(message.content),interrupted:!!data.interrupted,feedback:false,model:message.source.model,provider:message.source.provider}
          if(node.text||node.reasoning){messages.push(node);turn?.messageIds.push(node.id)}
        }
        const chunks=sdk.expandAssistantStream(data.stream),first=chunks.find(m=>['text-delta','reasoning-delta','tool-call-delta'].includes(m.chunk.type))
        if(turn&&first){
          if(data.step===firstStep&&turn.ttftMs===null&&Number.isFinite(stepStart))turn.ttftMs=Math.max(0,first.time-stepStart)
          const tokens=data.usage?.outputTokens??chunks.findLast(m=>m.chunk.type==='usage')?.chunk.usage.outputTokens
          if(Number.isFinite(tokens)&&tokens>=0&&event.time>first.time){decodeMs+=event.time-first.time;outputTokens+=tokens}
        }
      }
    }
    if(event.type==='turn/end'&&turn&&turn.turn===data.turn){
      turn.status=data.reason.kind;turn.endedAt=event.time;turn.cut=event.seq+1;turn.runMs=Math.max(0,event.time-turn.startedAt)
      turn.usage=sdk.deriveTurnTokenUsage(events.slice(turn.startIndex,index+1))??null
      if(decodeMs>0)turn.tokensPerSecond=outputTokens/(decodeMs/1000)
      for(const message of messages)if(message.role==='assistant'&&message.turn===turn.turn&&!message.interrupted)message.feedback=data.reason.kind==='completed'
      const tail=messages.findLast(m=>m.role==='assistant'&&m.turn===turn.turn&&!m.interrupted&&m.text)
      if(tail){tail.feedback=data.reason.kind==='completed';tail.tail=true;tail.forkCut=data.reason.kind==='completed'?turn.cut:null}
      for(const node of tools.values())if(node.turn===turn.turn&&node.status==='running')node.status='interrupted'
    }
  }
  return{messages,turns:turns.map(({startIndex,messageIds,...safe})=>safe)}
}
