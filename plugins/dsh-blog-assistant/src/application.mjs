import { randomUUID } from 'node:crypto'
import { article, ownerKey, digest } from './store.mjs'
import { invariant } from './settings.mjs'

export class BlogApplication {
  constructor(store,access,blog,images,backups,jobs,attachments) { Object.assign(this,{store,access,blog,images,backups,jobs,attachments}) }
  async call(actor,action,args={}) {
    this.access.assert(actor)
    const owner=ownerKey(actor)
    let result
    switch(action) {
      case 'drafts': result=this.store.list(owner,args.query);break
      case 'search-drafts': result=await this.jobs.searchDrafts(owner,args);break
      case 'search-articles': result=await this.blog.search(args);break
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
  operation(owner,id) { const row=this.store.db.prepare('SELECT data FROM operations WHERE id=? AND owner=?').get(id,owner);invariant(row,'操作记录不存在或无权访问',404);return JSON.parse(row.data) }
  operationSave(id,value) { this.store.db.prepare('UPDATE operations SET data=? WHERE id=?').run(JSON.stringify(value),id) }
  operations(owner) { return this.store.db.prepare('SELECT data FROM operations WHERE owner=? ORDER BY rowid').all(owner).map(row=>JSON.parse(row.data)) }
  assertPending(owner,draftId,remoteCid,except) {
    invariant(!this.operations(owner).some(op=>op.id!==except&&['running','uncertain'].includes(op.status)&&(op.draftId===draftId||remoteCid&&(op.before?.published?.cid??op.before?.savedDraft?.cid)===remoteCid)), '同一文章已有提交待核对，不能重复操作',409)
  }
  preview(op) {
    return {id:op.id,nonce:op.nonce,expiresAt:op.expiresAt,mode:op.mode,title:op.title??op.payload.content?.title??'',before:op.before?.published?this.jobs.modelArticle(op.before.published):null,after:op.payload.content??null,hasSavedDraft:!!op.before?.savedDraft,sources:op.sources??[],source:op.proposal?'proposal':'draft',deletedArticles:op.mode==='delete'?[op.before.published,op.before.savedDraft].filter(Boolean).map(p=>({cid:p.cid,title:p.title,type:p.type})):[]}
  }
  async prepare(actor,args,signal,chat) {
    this.access.assert(actor);signal?.throwIfAborted()
    const owner=ownerKey(actor), d=this.store.get(owner,args.id)
    invariant(d.revision===args.revision,'草稿已变化，请重新预览',409)
    invariant(['draft','publish'].includes(args.mode),'目标状态无效')
    invariant(!d.remote?.deleted,'博客原文已删除；如需重新发布，请明确创建新文章',409)
    const proposal=args.proposalId?d.proposal:null
    if(args.proposalId)invariant(proposal?.id===args.proposalId&&proposal.baseRevision===d.revision,'候选稿已变化，请重新选择并预览',409)
    const content=article(proposal?{...d,...proposal.fields}:d)
    invariant(content.title.trim() && content.text.trim(),'标题和正文不能为空')
    this.assertPending(owner,d.id,d.remote?.published?.cid??d.remote?.savedDraft?.cid)
    let remote=null
    if(d.remote) {
      remote=await this.blog.get(d.remote.published?.cid??d.remote.savedDraft?.cid,signal)
      invariant(remote.version===d.remote.version,'博客已被其他窗口修改，请重新导入比较',409)
      remote.selectedVariant=d.remote.selectedVariant??(remote.savedDraft?'savedDraft':'published')
    }
    this.access.assert(actor);signal?.throwIfAborted()
    const op={id:randomUUID(),owner,sessionId:actor.sessionId,draftId:d.id,revision:d.revision,mode:args.mode,status:'prepared',nonce:randomUUID(),expiresAt:Date.now()+10*60*1000,createdAt:Date.now(),title:content.title,payload:{content,base:remote},before:remote,proposal,sources:proposal?.sources??d.sources,...(chat?{chat}:{})}
    this.store.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(op.id,owner,d.id,d.revision,JSON.stringify(op))
    return this.preview(op)
  }
  async prepareDelete(actor,cid,signal,chat) {
    this.access.assert(actor);signal?.throwIfAborted()
    const status=await this.blog.call('status',{},signal)
    invariant(status.deleteArticle===true,'博客桥接扩展尚未支持删除，请先更新 DshBlogBridge',503)
    const remote=await this.blog.get(cid,signal),rootCid=remote.published?.cid??remote.savedDraft?.cid
    // Deleting a child draft must never silently delete its published parent.
    invariant(cid===rootCid,'该 ID 是文章的保存稿；删除整篇文章请核对主文章 ID',409)
    this.access.assert(actor);signal?.throwIfAborted()
    const owner=ownerKey(actor),draftId=`remote:${rootCid}`
    this.assertPending(owner,draftId,rootCid)
    const op={id:randomUUID(),owner,sessionId:actor.sessionId,draftId,revision:0,mode:'delete',status:'prepared',nonce:randomUUID(),expiresAt:Date.now()+10*60*1000,createdAt:Date.now(),title:(remote.published??remote.savedDraft).title,payload:{cid:rootCid,base:remote},before:remote,chat}
    this.store.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(op.id,owner,draftId,0,JSON.stringify(op))
    return this.preview(op)
  }
  applyResult(op,result) {
    if(op.mode==='delete') {
      const ids=new Set([op.before.published?.cid,op.before.savedDraft?.cid].filter(Boolean))
      for(const row of this.store.list(op.owner))if(ids.has(row.remote?.publishedCid)||ids.has(row.remote?.savedDraftCid)){
        const d=this.store.get(op.owner,row.id)
        if(d.remote?.deleteOperationId!==op.id)this.store.save(op.owner,d.id,d.revision,{remote:{...d.remote,deleted:true,deletedAt:Date.now(),deleteOperationId:op.id}})
      }
      return
    }
    const d=this.store.get(op.owner,op.draftId)
    // Keep edits made while the remote request was in flight. The receipt still records success.
    if(d.revision===op.revision&&(!op.proposal||digest(d.proposal)===digest(op.proposal)))this.store.save(op.owner,d.id,d.revision,{remote:result.snapshot,...(op.proposal?{...op.payload.content,proposal:null,sources:op.sources}: {})})
  }
  async confirm(actor,args,conversationId) {
    this.access.assert(actor)
    const owner=ownerKey(actor),op=this.operation(owner,args.id)
    if(op.chat)invariant(conversationId===op.chat.conversationId,'请在原对话卡片确认该操作',403)
    if(op.status==='succeeded')return {status:op.status,result:op.result}
    invariant(op.status==='prepared','提交已开始，请查询回执核对结果',409)
    invariant(op.nonce===args.nonce && op.sessionId===actor.sessionId && op.expiresAt>Date.now(),'确认已失效，请重新预览',409)
    if(op.mode!=='delete') {
      const d=this.store.get(owner,op.draftId);invariant(d.revision===op.revision,'草稿已变化，请重新预览',409)
      if(op.proposal)invariant(digest(d.proposal)===digest(op.proposal),'候选稿已变化，请重新预览',409)
    }
    if(op.before?.savedDraft && op.mode==='publish')invariant(args.consumeSavedDraft===true,'请明确确认发布会消费现有博客保存稿')
    this.access.assert(actor)
    this.assertPending(owner,op.draftId,op.before?.published?.cid??op.before?.savedDraft?.cid,op.id)
    op.status='running';delete op.nonce;this.operationSave(op.id,op)
    this.store.record(owner,'submit-before',{operationId:op.id,draftId:op.draftId,mode:op.mode,snapshot:op.before,content:op.payload.content})
    try {
      const result=await this.blog.call(op.mode==='delete'?'delete':'save',{requestId:op.id,mode:op.mode,...op.payload})
      op.status='succeeded';op.result=result;this.operationSave(op.id,op)
      this.store.record(owner,'submit-success',{operationId:op.id,version:result.version})
      this.applyResult(op,result)
      this.access.assert(actor);return {status:op.status,result}
    } catch(error) {
      if(op.status==='succeeded')throw error
      op.status=error?.status===409?'conflict':'uncertain';this.operationSave(op.id,op)
      throw error
    }
  }
  async reconcile(actor,id) {
    this.access.assert(actor)
    const owner=ownerKey(actor),op=this.operation(owner,id)
    if(op.status==='succeeded'){this.applyResult(op,op.result);return {status:op.status,result:op.result}}
    invariant(['running','uncertain'].includes(op.status),'该操作不需要核对回执',409)
    const result=await this.blog.call('receipt',{requestId:op.id});this.access.assert(actor)
    if(result.status==='succeeded') {
      op.status='succeeded';op.result=result.result;this.operationSave(id,op)
      this.applyResult(op,result.result)
      this.store.record(owner,'reconciled',{operationId:id});return {status:op.status,result:op.result}
    }
    return {status:'uncertain',message:'未取得成功回执；本地稿与提交记录已保留，请核对博客后再处理'}
  }
  async upload(actor,bytes) {this.access.assert(actor);const result=await this.images.upload(bytes);this.access.assert(actor);this.store.record(ownerKey(actor),'upload',result);return result}
}
