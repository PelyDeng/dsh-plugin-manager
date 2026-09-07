import { randomUUID } from 'node:crypto'
import { article, ownerKey } from './store.mjs'
import { invariant } from './settings.mjs'

export class BlogApplication {
  constructor(store,access,blog,images,backups,jobs,attachments) { Object.assign(this,{store,access,blog,images,backups,jobs,attachments}) }
  async call(actor,action,args={}) {
    this.access.assert(actor)
    const owner=ownerKey(actor)
    let result
    switch(action) {
      case 'drafts': result=this.store.list(owner,args.query);break
      case 'create': result=this.store.create(owner);break
      case 'draft': result=this.store.get(owner,args.id);break
      case 'save': result=this.store.edit(owner,args.id,args.revision,args.content);break
      case 'apply': result=this.store.applyProposal(owner,args.id,args.revision,args.proposalId,args.fields);break
      case 'articles': result=await this.blog.list(args.query??'',args.page??1);break
      case 'metadata': result=await this.blog.call('status');break
      case 'import': {
        result=await this.importDraft(actor,args.cid,args.variant);break
      }
      case 'tasks': result=this.store.jobList(owner,args.draftId);break
      case 'attachments': result=this.attachments.list(actor,args.draftId);break
      case 'attachment-remove': result=this.attachments.remove(actor,args.draftId,args.id);break
      case 'attachment-select': result=this.attachments.select(actor,args.draftId,args.id,args.selected,args.range);break
      case 'attachment-content': result=this.attachments.content(actor,args.draftId,args.id);break
      case 'task-start': result=await this.jobs.start(actor,{...args,callerId:'web'});break
      case 'task': result=this.jobs.get(actor,args.id);break
      case 'task-cancel': result=this.jobs.cancel(actor,args.id);break
      case 'prepare': result=await this.prepare(actor,args);break
      case 'confirm': result=await this.confirm(actor,args);break
      case 'reconcile': result=await this.reconcile(actor,args.id);break
      case 'operations': result=this.store.db.prepare('SELECT id,data FROM operations WHERE owner=? AND draftId=? ORDER BY rowid DESC LIMIT 20').all(owner,args.draftId).map(r=>{const o=JSON.parse(r.data);return{id:r.id,status:o.status,mode:o.mode,url:o.result?.url,createdAt:o.createdAt}});break
      case 'backup-status': result=await this.backups.call(actor,'status');break
      case 'backup-run': result=await this.backups.call(actor,'run');break
      case 'backup-schedule': result=await this.backups.call(actor,'schedule',args);break
      case 'backup-verify': result=await this.backups.call(actor,'verify',args);break
      case 'backup-restore-prepare': result=await this.backups.call(actor,'restore-prepare',args);break
      case 'backup-restore-confirm': result=await this.backups.call(actor,'restore-confirm',args);break
      default: invariant(false,'不支持的博客操作',404)
    }
    this.access.assert(actor);return result
  }
  async readImport(actor,cid,variant,signal){
    this.access.assert(actor);signal?.throwIfAborted()
    invariant(['published','savedDraft'].includes(variant),'请选择导入公开版或保存稿')
    const remote=await this.blog.get(cid,signal);this.access.assert(actor);signal?.throwIfAborted()
    const source=remote[variant];invariant(source,'所选版本不存在',404)
    return{source,remote,variant}
  }
  importSnapshot(actor,{source,remote,variant},cid){
    this.access.assert(actor)
    const owner=ownerKey(actor),result=this.store.create(owner,{title:source.title,text:source.text,slug:source.slug,format:source.format,tags:source.tags.map(t=>typeof t==='string'?t:t.name),categories:source.categories.map(c=>typeof c==='number'?c:c.id)},{...remote,selectedVariant:variant})
    this.store.record(owner,'import',{draftId:result.id,cid,variant});return result
  }
  async importDraft(actor,cid,variant){return this.importSnapshot(actor,await this.readImport(actor,cid,variant),cid)}
  operation(owner,id) { const row=this.store.db.prepare('SELECT data FROM operations WHERE id=? AND owner=?').get(id,owner);invariant(row,'发布记录不存在',404);return JSON.parse(row.data) }
  operationSave(id,value) { this.store.db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(value),id) }
  async prepare(actor,args) {
    const owner=ownerKey(actor), d=this.store.get(owner,args.id)
    invariant(d.revision===args.revision,'草稿已变化，请重新预览',409)
    invariant(['draft','publish'].includes(args.mode),'目标状态无效')
    invariant(d.title.trim() && d.text.trim(),'标题和正文不能为空')
    const pending=this.store.db.prepare('SELECT data FROM operations WHERE owner=? AND draftId=?').all(owner,d.id).some(r=>['running','uncertain'].includes(JSON.parse(r.data).status))
    invariant(!pending,'有提交结果待核对，完成核对前不能重复发布',409)
    let remote=null
    if(d.remote) {
      remote=await this.blog.get(d.remote.published?.cid??d.remote.savedDraft?.cid)
      invariant(remote.version===d.remote.version,'博客已被其他窗口修改，请重新导入比较',409)
      remote.selectedVariant=d.remote.selectedVariant??(remote.savedDraft?'savedDraft':'published')
    }
    this.access.assert(actor)
    const op={id:randomUUID(),owner,sessionId:actor.sessionId,draftId:d.id,revision:d.revision,mode:args.mode,status:'prepared',nonce:randomUUID(),expiresAt:Date.now()+10*60*1000,createdAt:Date.now(),payload:{content:article(d),base:remote},before:remote}
    this.store.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(op.id,owner,d.id,d.revision,JSON.stringify(op))
    return {id:op.id,nonce:op.nonce,expiresAt:op.expiresAt,mode:op.mode,title:d.title,before:remote?.published?this.jobs.modelArticle(remote.published):null,after:article(d),hasSavedDraft:!!remote?.savedDraft,sources:d.sources}
  }
  async confirm(actor,args) {
    const owner=ownerKey(actor),op=this.operation(owner,args.id)
    if(op.status==='succeeded')return {status:op.status,result:op.result}
    invariant(op.status==='prepared','提交已开始，请查询回执核对结果',409)
    invariant(op.nonce===args.nonce && op.sessionId===actor.sessionId && op.expiresAt>Date.now(),'确认已失效，请重新预览',409)
    const d=this.store.get(owner,op.draftId);invariant(d.revision===op.revision,'草稿已变化，请重新预览',409)
    if(op.before?.savedDraft && op.mode==='publish')invariant(args.consumeSavedDraft===true,'请明确确认发布会消费现有博客保存稿')
    this.access.assert(actor)
    const otherPending=this.store.db.prepare('SELECT data FROM operations WHERE owner=? AND draftId=? AND id<>?').all(owner,d.id,op.id).some(r=>['running','uncertain'].includes(JSON.parse(r.data).status))
    invariant(!otherPending,'同一草稿已有提交待核对',409)
    op.status='running';delete op.nonce;this.operationSave(op.id,op)
    this.store.record(owner,'submit-before',{operationId:op.id,draftId:d.id,mode:op.mode,snapshot:op.before,content:op.payload.content})
    try {
      const result=await this.blog.call('save',{requestId:op.id,mode:op.mode,...op.payload})
      op.status='succeeded';op.result=result;this.operationSave(op.id,op)
      this.store.record(owner,'submit-success',{operationId:op.id,version:result.version})
      this.store.save(owner,d.id,d.revision,{remote:result.snapshot})
      this.access.assert(actor);return {status:op.status,result}
    } catch(error) {
      if(op.status==='succeeded')throw error
      op.status=error?.status===409?'conflict':'uncertain';this.operationSave(op.id,op)
      throw error
    }
  }
  async reconcile(actor,id) {
    const owner=ownerKey(actor),op=this.operation(owner,id)
    if(op.status==='succeeded')return {status:op.status,result:op.result}
    const result=await this.blog.call('receipt',{requestId:op.id});this.access.assert(actor)
    if(result.status==='succeeded') {
      op.status='succeeded';op.result=result.result;this.operationSave(id,op)
      const draft=this.store.get(owner,op.draftId)
      if(draft.revision===op.revision)this.store.save(owner,draft.id,draft.revision,{remote:result.result.snapshot})
      this.store.record(owner,'reconciled',{operationId:id});return {status:op.status,result:op.result}
    }
    return {status:'uncertain',message:'未取得成功回执；本地稿与提交记录已保留，请核对博客后再处理'}
  }
  async upload(actor,bytes) {this.access.assert(actor);const result=await this.images.upload(bytes);this.access.assert(actor);this.store.record(ownerKey(actor),'upload',result);return result}
}
