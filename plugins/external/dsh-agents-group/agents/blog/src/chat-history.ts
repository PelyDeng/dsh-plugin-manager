/// <reference lib="es2023.array" />
/**
 * Safe human transcript over official Session surface, stream and token projections.
 *
 * `/// <reference lib="es2023.array" />`：本文件的 `Array.prototype.findLast` 是 Node ≥18 的运行期面，
 * 而本包 `lib` 是 ES2022（`tsconfig.json` 由主线持有，不在本次改动范围）⇒ 按官方机制补这一份 lib，
 * 不改调用点、不改 tsconfig，运行期行为一字不变。
 */
import {BlockAssembler} from '@deepseek-ai/dsh-llm'
import type {ContentBlock} from '@deepseek-ai/dsh-llm/types'

/** 会话事件（`dsh-session` 的持久化事件；本文件只读 `type`/`seq`/`time`/`data`）。 */
interface HistoryEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: EventPayload
}

/**
 * 事件载荷。
 *
 * **逐事件不同**：`turn/start` 只有 `turn`，`tool/result` 才有 `message`，`turn/end` 才有 `reason`…
 * 而两个调用口径也不一样 —— `chat.ts` 传 `readonly SessionEvent[]`（判别联合），四个测试文件传裸对象
 * 字面量。要在这里把每个分支的载荷写成联合，就得先让调用点满足那份联合 ⇒ 按**开放字典**读
 * （与 `store.ts` 的 `BlogRecord` 同一口径：形状由事件类型决定，读点自己知道）。
 */
type EventPayload = Record<string, any>

/** `tool/result` 的 content 块（本文件只读 `type`/`isError`）。 */
interface ToolResultBlock {
  readonly type?: string | undefined
  readonly isError?: boolean | undefined
}

/** 助手流里的一帧（`expandAssistantStream` 的产出；本文件只读 `chunk.type`、`chunk.usage.outputTokens` 与 `time`）。 */
interface StreamFrame {
  readonly chunk: { readonly type: string; readonly [key: string]: any }
  readonly time: number
}

/**
 * `BlockAssembler` 在本文件里用到的两个面。
 *
 * 不直接用 `new BlockAssembler()` 的推断类型：`push()` 的参数是 `dsh-llm` 的 `StreamChunk` 判别联合，
 * 而 SDK 面的返回类型必须放得下 `chat.ts` 的 `ChatSdk`（它只声明 `{chunk:{type,text?},time}`）。
 * 这里按"消费面"声明一次（方法参数按双变检查，`BlockAssembler` 满足），调用与取值都不变。
 */
interface ChunkAssembler {
  push(chunk: StreamFrame['chunk']): void
  blocks(): readonly ContentBlock[]
}

/**
 * `projectChat` 用到的会话 SDK 面（`runtime/chat-sdk.mjs` 的四个导出与 `chat.ts` 的 `ChatSdk` 都满足）。
 *
 * ⚠️ `deriveEventMessage`/`expandAssistantStream`/`deriveTurnTokenUsage` 的返回类型刻意**从宽**：
 * `chat.ts` 把 `deriveEventMessage` 声明成它自己的投影类型（没有 `content`/`source`）、把
 * `expandAssistantStream` 声明成 `Iterable<{chunk:{type,text?},time}>`。若这里按 `dsh-session` /
 * `dsh-llm` 的真实类型声明，`chat.ts` 的两处 `projectChat(events, requests, this.sdk)` 会当场不成立
 * （那份声明的口径问题见交付说明，本文件不改别人文件）。
 */
interface HistorySdk {
  isAppendSurfaceEvent(event: unknown): boolean
  deriveEventMessage(event: unknown): DerivedMessage | undefined
  expandAssistantStream(stream: unknown): Iterable<StreamFrame>
  deriveTurnTokenUsage(events: readonly unknown[]): unknown
}

/** `deriveEventMessage` 的产出：会话消息本体（`content`/`source`…按开放字典读）。 */
type DerivedMessage = Record<string, any>

/** 一轮对话请求的记录（`chat-store` 的落库记录；本文件只读这四项，`input` 恒有）。 */
interface RequestRecord {
  readonly id: string
  readonly userMessageId?: string | undefined
  readonly input: { readonly text?: string | undefined }
  readonly attachments?: readonly RequestAttachment[] | undefined
}

/** 请求里的资料引用（落库那层只有 `id`；运行期塞进来的是冻结后的完整附件）。 */
interface RequestAttachment {
  readonly id: string
  readonly name?: string | undefined
  readonly kind?: string | undefined
  readonly range?: { readonly from: number; readonly to: number } | null | undefined
  readonly partial?: boolean | undefined
}

/** 投影到用户消息上的资料引用（字段取值与 `request.attachments` 逐字相同，含 `undefined`）。 */
interface ProjectedAttachment {
  readonly id: string
  readonly name: string | undefined
  readonly kind: string | undefined
  readonly range: { readonly from: number; readonly to: number } | null | undefined
  readonly partial: boolean | undefined
}

/**
 * 投影出的一条消息。
 *
 * 与 `chat.ts` 的 `ChatMessage` 同形（`role` 区分用户/助手/工具/状态行，字段按需出现）——`chat.ts`
 * 会把本函数的产出 `as` 成它自己那份 `ChatProjection`。`status`/`feedback`/`tail`/`forkCut`
 * 在构造之后仍会被写（工具结果、回合结束时的反馈与尾节点标记），故不声明 `readonly`。
 */
export interface ProjectedMessage {
  readonly id: string
  readonly role: string
  readonly seq: number
  readonly time: number
  readonly turn: unknown
  readonly text?: string | undefined
  readonly reasoning?: string | undefined
  readonly name?: string | undefined
  status?: string | undefined
  readonly interrupted?: boolean | undefined
  feedback?: boolean | undefined
  tail?: boolean | undefined
  forkCut?: number | null | undefined
  readonly requestId?: string | undefined
  readonly model?: string | undefined
  readonly provider?: string | undefined
  readonly attachments?: readonly ProjectedAttachment[] | undefined
}

/** 一轮对话在本文件里的状态；`turns` 对外只保留下面 `ProjectedTurnSummary` 那些字段。 */
interface ProjectedTurn {
  turn: unknown
  readonly startSeq: number
  readonly startIndex: number
  readonly startedAt: number
  status: string | undefined
  readonly messageIds: string[]
  usage: unknown
  runMs: number | null
  ttftMs: number | null
  tokensPerSecond: number | null
  attempts: number
  cut: number | null
  endedAt?: number | undefined
}

/** 对外的一轮：去掉只给内部用的 `startIndex`（切片）与 `messageIds`（尾节点标记）。 */
export type ProjectedTurnSummary = Omit<ProjectedTurn, 'startIndex' | 'messageIds'>

/** `projectChat` 的完整产出。 */
export interface ChatProjection {
  readonly messages: readonly ProjectedMessage[]
  readonly turns: readonly ProjectedTurnSummary[]
}

export function projectChat(events: readonly HistoryEvent[],requests: readonly RequestRecord[],sdk: HistorySdk): ChatProjection {
  const messages: ProjectedMessage[]=[],turns: ProjectedTurn[]=[],tools=new Map<string, ProjectedMessage>(),requestsByMessage=new Map(requests.filter(r=>r.userMessageId).map(r=>[r.userMessageId,r] as const))
  let turn: ProjectedTurn|null=null,stepStart: number|null=null,decodeMs=0,outputTokens=0,firstStep: unknown=null
  const text=(content: readonly ContentBlock[]): string=>content.filter(b=>b.type==='text').map(b=>b.text).join('')
  const reasoning=(content: readonly ContentBlock[]): string=>content.filter(b=>b.type==='reasoning').map(b=>b.text).join('')
  // `noUncheckedIndexedAccess` 下 `events[index]` 是 `HistoryEvent | undefined`；用 `entries()` 取同一顺序
  // 与同一组下标（行为不变），`event` 于是确定非空。
  for(const [index,event] of events.entries()) {
    const data=event.data
    if(event.type==='turn/start'){
      turn={turn:data.turn,startSeq:event.seq,startIndex:index,startedAt:event.time,status:'running',messageIds:[],usage:null,runMs:null,ttftMs:null,tokensPerSecond:null,attempts:0,cut:null}
      turns.push(turn);stepStart=null;decodeMs=0;outputTokens=0;firstStep=null
    }
    if(event.type==='step/start'){stepStart=event.time;if(firstStep===null)firstStep=data.step}
    if(event.type==='tool/call'){
      const node: ProjectedMessage={id:'tool-'+event.seq,role:'tool',turn:turn?.turn,seq:event.seq,time:event.time,name:data.name,status:'running'}
      messages.push(node);tools.set(data.callId,node)
    }
    if(event.type==='tool/result'){
      const node=tools.get(data.message.source.callId);if(node)node.status=data.error||data.message.content.some((block: ToolResultBlock)=>block.type==='tool-result'&&block.isError===true)?'failed':'succeeded'
    }
    if(event.type==='llm/retry')messages.push({id:'retry-'+event.seq,role:'status',seq:event.seq,time:event.time,turn:turn?.turn,text:'模型请求失败，正在重试'})
    if(event.type==='assistant/attempt'){
      const stream=sdk.expandAssistantStream(data.stream)
      const assembler: ChunkAssembler=new BlockAssembler()
      for(const {chunk} of stream)assembler.push(chunk)
      const blocks=assembler.blocks()
      const value: ProjectedMessage={id:'attempt-'+event.seq,role:'assistant',seq:event.seq,time:event.time,turn:turn?.turn,text:text(blocks),reasoning:reasoning(blocks),interrupted:true,feedback:false}
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
          const node: ProjectedMessage={id:message.id,role:'assistant',seq:event.seq,time:event.time,turn:turn?.turn,text:text(message.content),reasoning:reasoning(message.content),interrupted:!!data.interrupted,feedback:false,model:message.source.model,provider:message.source.provider}
          if(node.text||node.reasoning){messages.push(node);turn?.messageIds.push(node.id)}
        }
        // `expandAssistantStream` 在 SDK 面上是 `Iterable`（`chat.ts` 的 `ChatSdk` 就这么声明的），
        // 而下面要按序取首帧与 usage 帧 ⇒ 物化一次数组（运行期它本来就是数组，取值与顺序不变）。
        const chunks=[...sdk.expandAssistantStream(data.stream)],first=chunks.find(m=>['text-delta','reasoning-delta','tool-call-delta'].includes(m.chunk.type))
        if(turn&&first){
          // `Number.isFinite` 不是类型谓词 ⇒ 补 `typeof`（接受集合不变）才能把 `stepStart` 当数字用。
          if(data.step===firstStep&&turn.ttftMs===null&&typeof stepStart==='number'&&Number.isFinite(stepStart))turn.ttftMs=Math.max(0,first.time-stepStart)
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
      // 回调是闭包：`let turn` 的收窄在闭包里失效，这里按块首已经成立的非空条件再收窄一次（取值不变）。
      const tail=messages.findLast(m=>m.role==='assistant'&&m.turn===turn?.turn&&!m.interrupted&&m.text)
      if(tail){tail.feedback=data.reason.kind==='completed';tail.tail=true;tail.forkCut=data.reason.kind==='completed'?turn.cut:null}
      for(const node of tools.values())if(node.turn===turn.turn&&node.status==='running')node.status='interrupted'
    }
  }
  return{messages,turns:turns.map(({startIndex,messageIds,...safe})=>safe)}
}
