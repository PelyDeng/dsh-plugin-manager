import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { agentResource } from '@dsh-agents-group/common'
import { onRevoked } from '@dsh-plugin-manager/plugin-kit'
import { invariant } from './settings.mjs'
import { ownerKey } from './store.mjs'

export const MAX_ATTACHMENT_BYTES=20*1024*1024
const types={txt:'text',md:'markdown',markdown:'markdown',csv:'csv',json:'json',pdf:'pdf',docx:'docx',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'}
/**
 * 附件存业务库（PG；表结构与中断翻转由存储 init 序列负责）。
 *
 * 四耦合点之 4：`assertScope` 是异步谓词——会话路径（blog-chat-*）由索引侧同步核验，
 * 草稿路径由业务存储侧核验（storage.get 的 404 口径不变），get/list 因此异步化。
 */
export class BlogAttachments {
  constructor(ctx,access,storage,assertScope=async(owner,id)=>storage.get(owner,id)) {
    Object.assign(this,{ctx,access,storage,assertScope});this.active=new Map();this.closed=false
    ctx.effect(()=>onRevoked(ctx,()=>this.recheck()))
    ctx.effect(()=>{const timer=setInterval(()=>this.recheck(),1000);timer.unref();return()=>clearInterval(timer)})
  }
  async write(a){return this.storage.attachmentWrite(a)}
  async get(actor,draftId,id){this.access.assert(actor);await this.assertScope(ownerKey(actor),draftId);return this.storage.attachmentGet(ownerKey(actor),draftId,id)}
  public(a){const {owner,original,image,parsed,...safe}=a;return {...safe,unit:parsed?.unit,totalUnits:parsed?.totalUnits,parsedUnits:parsed?.units.length,characters:parsed?.characters,partial:parsed?.partial,preview:parsed?.units.slice(0,3).map(u=>u.text).join('\n').slice(0,300)}}
  async list(actor,draftId){this.access.assert(actor);await this.assertScope(ownerKey(actor),draftId);return (await this.storage.attachmentList(ownerKey(actor),draftId)).map(a=>this.public(a))}
  recheck(){for(const job of this.active.values()){try{this.access.assert(job.actor)}catch{job.abort.abort()}}}
  async guard(job){job.abort.signal.throwIfAborted();this.access.assert(job.actor);invariant(!this.closed,'附件服务正在停止',503);const a=await this.get(job.actor,job.a.draftId,job.a.id);invariant(a.version===job.a.version,'附件解析版本已变化',409)}
  async upload(actor,draftId,name,read) {
    this.access.assert(actor);await this.assertScope(ownerKey(actor),draftId)
    invariant(!this.closed && this.active.size<2,'同时最多处理两个资料文件，请稍后重试',429)
    invariant(typeof name==='string' && name.length>0 && name.length<=180 && !/[\\/\u0000-\u001f]/.test(name),'文件名无效')
    const kind=types[name.split('.').at(-1).toLowerCase()];invariant(kind,'支持 TXT、Markdown、CSV、JSON、PDF、DOCX、PNG、JPEG、WebP、GIF')
    invariant((await this.list(actor,draftId)).length<10,'当前草稿或对话最多选择 10 个资料文件',413)
    const a={id:randomUUID(),owner:ownerKey(actor),draftId,name,kind,version:1,status:'uploading',selected:true,range:null,createdAt:Date.now()}
    await this.storage.attachmentInsert(a)
    const job={actor,a,abort:new AbortController(),worker:null,done:null};this.active.set(a.id,job)
    let finished;job.done=new Promise(resolve=>{finished=resolve})
    try {
      const bytes=await read(job.abort.signal);await this.guard(job)
      invariant(bytes.length>0 && bytes.length<=MAX_ATTACHMENT_BYTES,'单个资料文件必须为 1 字节至 20 MiB',413)
      a.bytes=bytes.length
      const provider=this.ctx.get('attachments');invariant(provider?.saveFileStream,'宿主尚未挂载支持原文件的附件服务',503)
      a.original=await provider.saveFileStream({data:(async function*(){yield bytes})(),name,signal:job.abort.signal});await this.guard(job)
      a.status='parsing';await this.write(a)
      if(kind.startsWith('image/')) {
        a.image=await provider.saveImage({data:bytes,mediaType:kind,name});await this.guard(job)
        a.message=kind==='image/gif'?'模型读取规范化单帧；原 GIF 完整保留':'图片资料将发送至支持图片的模型'
      } else a.parsed=await this.parse(job,bytes)
      await this.guard(job);a.status='ready'
      if(a.parsed?.partial){a.selected=false;a.message=`仅解析前 ${a.parsed.units.length} ${a.parsed.unit}，请明确选择已覆盖范围`}
      await this.write(a);await this.storage.record(a.owner,'attachment-upload',{id:a.id,draftId,name,bytes:a.bytes})
      return this.public(a)
    } catch(error) {
      const row=await this.storage.attachmentRaw(a.id)
      if(row && row.status!=='removed')await this.write({...a,status:'failed',selected:false,message:job.abort.signal.aborted?'解析已取消':error?.code==='DSH_ACCESS_ERROR'?error.message:job.parseError??'文件无法解析，请检查格式、大小或宿主附件服务'})
      throw error?.code==='DSH_ACCESS_ERROR'?error:new Error('资料处理未完成；请查看附件状态')
    } finally {await job.worker?.terminate();this.active.delete(a.id);finished();this.access.assert(actor)}
  }
  async parse(job,bytes) {
    return new Promise((resolve,reject)=>{
      const worker=new Worker(agentResource(import.meta.url,'blog','runtime/parse-document.mjs'),{workerData:{bytes,kind:job.a.kind},resourceLimits:{maxOldGenerationSizeMb:192,maxYoungGenerationSizeMb:32,stackSizeMb:4}});job.worker=worker
      let settled=false
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);job.abort.signal.removeEventListener('abort',cancel);error?reject(error):resolve(value)}
      const cancel=()=>{void worker.terminate();finish(new Error('cancelled'))}
      const timer=setTimeout(()=>{job.parseError='解析超过 30 秒，已停止';cancel()},30000)
      job.abort.signal.addEventListener('abort',cancel,{once:true})
      worker.on('message',m=>{if(m.ok)finish(null,m.result);else{job.parseError=String(m.message).slice(0,200);finish(new Error('parse'))}})
      worker.on('error',()=>finish(new Error('worker')));worker.on('exit',()=>{if(!settled)finish(new Error('worker exited'))})
      if(job.abort.signal.aborted)cancel()
    })
  }
  async select(actor,draftId,id,selected,range){const a=await this.get(actor,draftId,id);invariant(typeof selected==='boolean','附件选择无效');if(range!==null&&range!==undefined)this.validateRange(a,range);a.selected=selected;a.range=range??null;return this.public(await this.write(a))}
  validateRange(a,range){invariant(a.parsed && Number.isSafeInteger(range?.from) && Number.isSafeInteger(range?.to) && range.from>=1 && range.to>=range.from && range.to<=a.parsed.units.length,'所选页/段/行范围未被解析')}
  async remove(actor,draftId,id){const a=await this.get(actor,draftId,id);this.active.get(id)?.abort.abort();await this.write({...a,status:'removed',selected:false,version:a.version+1});await this.storage.record(ownerKey(actor),'attachment-remove',{id,draftId});return {removed:true}}
  async content(actor,draftId,id){const a=await this.get(actor,draftId,id);invariant(a.status==='ready','附件尚未就绪');return {...this.public(a),units:a.parsed?.units??[]}}
  async original(actor,draftId,id){return this.readOriginal(actor,await this.get(actor,draftId,id),async()=>this.get(actor,draftId,id))}
  async readOriginal(actor,a,guard){await guard();invariant(a.original,'原文件尚未保存',409);const chunks=[];let size=0;for await(const chunk of this.ctx.attachments.readFileStream(a.original)){this.access.assert(actor);size+=chunk.length;invariant(size<=MAX_ATTACHMENT_BYTES,'原文件超过限制',413);chunks.push(Buffer.from(chunk))}await guard();return {name:a.name,bytes:Buffer.concat(chunks)}}
  async freeze(actor,draftId,selections=[]) {
    invariant(Array.isArray(selections)&&selections.length<=10,'最多选择 10 个资料文件')
    const ids=new Set();let bytes=0,chars=0
    const frozen=[]
    for(const s of selections){
      invariant(s && typeof s.id==='string'&&!ids.has(s.id),'资料选择无效或重复');ids.add(s.id)
      const a=await this.get(actor,draftId,s.id);invariant(a.status==='ready','所选资料尚未完成解析',409)
      invariant(a.version===s.version,'资料版本已变化，请重新选择',409)
      bytes+=a.bytes
      if(a.parsed?.partial)invariant(s.range,'部分解析的资料必须明确选择已解析范围')
      if(s.range)this.validateRange(a,s.range)
      const units=a.parsed?.units.filter(u=>!s.range||u.number>=s.range.from&&u.number<=s.range.to)
      chars+=units?.reduce((n,u)=>n+u.text.length,0)??0
      frozen.push({id:a.id,version:a.version,name:a.name,kind:a.kind,range:s.range??null,unit:a.parsed?.unit,partial:!!a.parsed?.partial,units,image:a.image,original:a.original})
    }
    invariant(bytes<=40*1024*1024,'本次资料总量超过 40 MiB，请减少选择',413)
    invariant(chars<=100000,'本次资料正文超过 100000 字符，请选择较小的页/段/行范围',413)
    return frozen
  }
  async close(){this.closed=true;const jobs=[...this.active.values()];for(const j of jobs)j.abort.abort();await Promise.all(jobs.map(j=>j.done))}
}
