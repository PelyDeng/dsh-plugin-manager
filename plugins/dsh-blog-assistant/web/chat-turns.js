/** One presentation card per user turn. Official messages and tool records stay intact. */
export function chatTurns(messages,{busy=false,operations=[],requests=[]}={}){
  const result=[];let group=null,userId='legacy',sequence=0
  function start(message){group={...message,id:message.id??'pending-'+userId,role:'assistant',displayKey:'answer-'+userId+'-'+sequence++,text:'',reasoning:'',reasoningSource:undefined,tools:[],steps:[],statuses:[],feedback:false};result.push(group);return group}
  for(const message of messages){
    if(message.role==='user'){result.push(message);group=null;userId=message.id;continue}
    if(!group||(message.turn!==undefined&&group.turn!==undefined&&message.turn!==group.turn))start(message)
    if(message.role==='tool'){group.tools.push(message);continue}
    if(message.role==='status'){group.statuses.push(message.text);continue}
    if(message.role!=='assistant')continue
    group.steps.push(message)
    if(message.reasoning){group.reasoning=message.reasoning;group.reasoningSource=message.id}
    if(message.text||!group.text){for(const key of ['id','text','time','seq','turn','feedback','forkCut','tail','model','provider','interrupted'])group[key]=message[key]}
  }
  if(busy&&!group&&messages.at(-1)?.role==='user')start({turn:messages.at(-1).turn,time:messages.at(-1).time})
  const requestByUser=new Map(requests.map(r=>[r.userMessageId,r.id])),pending=new Map(),timeline=[]
  for(const operation of operations){const cards=pending.get(operation.requestId)??[];cards.push({role:'operation',id:operation.id,operation});pending.set(operation.requestId,cards)}
  let requestId
  const flush=()=>{if(requestId!==undefined){timeline.push(...pending.get(requestId)??[]);pending.delete(requestId)}}
  for(const message of result){
    if(message.role==='user'){flush();requestId=message.requestId??requestByUser.get(message.id)}
    timeline.push(message)
  }
  flush()
  // Older history can lack the originating request. Keep these cards visible without assigning them to a new turn.
  return [...[...pending.values()].flat().map(card=>({...card,unassociated:true})),...timeline]
}
