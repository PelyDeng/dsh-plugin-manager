import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { article, ownerKey, digest } from './store.mjs'
import { invariant } from './settings.mjs'

// Older bridge hashes included theme view counters. Compare full variants to retain
// existing workbench drafts across the hash upgrade without hiding actual edits.
function sameBlogContent(a,b) {
  const variants=snapshot=>{
    const value=structuredClone({published:snapshot.published??null,savedDraft:snapshot.savedDraft??null})
    for(const variant of Object.values(value))if(variant?.raw)delete variant.raw.views
    return value
  }
  return isDeepStrictEqual(variants(a),variants(b))
}
function remoteArticle(source) {
  return article({title:source.title,text:source.text,slug:source.slug,format:source.format,tags:source.tags.map(t=>typeof t==='string'?t:t.name),categories:source.categories.map(c=>typeof c==='number'?c:c.id),...(source.raw?.allowComment!==undefined?{allowComment:!!Number(source.raw.allowComment)}:source.allowComment!==undefined?{allowComment:source.allowComment}:{})})
}

export class BlogApplication {
  constructor(store,access,blog,images,backups,jobs,attachments) { Object.assign(this,{store,access,blog,images,backups,jobs,attachments}) }
  async call(actor,action,args={}) {
    this.access.assert(actor)
    const owner=ownerKey(actor)
    let result
    switch(action) {
      case 'drafts': result=(await this.blog.list(args.query??'',args.page??1,undefined,'draft')).items;break
      case 'search-drafts': result=await this.jobs.searchDrafts(owner,args);break
      case 'search-articles': result=await this.blog.search(args);break
      case 'create': result=await this.createBlogDraft(actor,args.requestId);break
      case 'draft': result=this.store.get(owner,args.id);break
      case 'save': result=await this.saveBlogDraft(actor,args);break
      case 'apply': result=await this.applyBlogProposal(actor,args);break
      case 'migration-status': result={remaining:this.legacyDrafts(owner).length};break
      case 'migrate-drafts': result=await this.migrateDrafts(actor);break
      case 'discard-proposal': result=this.store.discardProposal(owner,args.id,args.revision,args.proposalId);break
      case 'articles': result=await this.blog.list(args.query??'',args.page??1,undefined,args.status??'published');break
      case 'metadata': result=await this.blog.call('status');break
      case 'manage-list': result=await this.blog.call('manage-list',args);break
      case 'manage-get': result=await this.blog.call('manage-get',args);break
      case 'manage-prepare': result=await this.prepareManagement(actor,args);break
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
      case 'prepare-delete': result=await this.prepareDelete(actor,args.cid);break
      case 'prepare': result=await this.prepare(actor,{id:args.id,revision:args.revision,mode:args.mode,proposalId:args.proposalId});break
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
  legacyDrafts(owner) { return this.store.list(owner).map(row=>this.store.get(owner,row.id)).filter(d=>!d.blogNative) }
  async commitBlogDraft(actor,op) {
    this.access.assert(actor)
    invariant(op.mode==='draft'&&op.nativeSave,'不是博客草稿保存操作',409)
    if(op.status==='succeeded')return this.store.get(op.owner,op.draftId)
    invariant(op.status!=='running','这篇文章正在保存，请稍后重试',409)
    invariant(op.status!=='conflict','博客草稿已在其他位置修改，请重新打开并比较',409)
    // Retry the same frozen request id; the bridge receipt prevents duplicate drafts.
    op.status='prepared';op.sessionId=actor.sessionId;op.nonce=randomUUID();op.expiresAt=Date.now()+10*60*1000
    this.operationSave(op.id,op)
    await this.confirm(actor,{id:op.id,nonce:op.nonce})
    return this.store.get(op.owner,op.draftId)
  }
  async createBlogDraft(actor,requestId,existing) {
    this.access.assert(actor)
    invariant(typeof requestId==='string'&&/^[\w:-]{8,160}$/.test(requestId),'新建草稿需要有效请求标识')
    const owner=ownerKey(actor),prior=this.operations(owner).find(op=>op.creationKey===requestId)
    if(prior)return this.commitBlogDraft(actor,prior)
    const status=await this.blog.call('status');this.access.assert(actor)
    invariant(status.nativeDrafts===true,'统一草稿需要更新博客桥接扩展后再使用',503)
    const concurrent=this.operations(owner).find(op=>op.creationKey===requestId)
    if(concurrent)return this.commitBlogDraft(actor,concurrent)
    const d=existing??this.store.create(owner)
    const preview=await this.prepare(actor,{id:d.id,revision:d.revision,mode:'draft',content:article(d),nativeSave:true,detached:true,creationKey:requestId})
    const op=this.operation(owner,preview.id);op.creationKey=requestId;op.legacyRemote=d.remote;this.operationSave(op.id,op)
    return this.commitBlogDraft(actor,op)
  }
  async saveBlogDraft(actor,args,clearProposal=false) {
    this.access.assert(actor)
    const owner=ownerKey(actor),d=this.store.get(owner,args.id),content=article(args.content)
    invariant(d.blogNative,'旧版内容需要先迁移到博客草稿',409)
    const prior=this.operations(owner).findLast(op=>op.nativeSave&&op.draftId===d.id&&op.revision===args.revision&&digest(op.payload.content)===digest(content)&&!!op.clearProposal===clearProposal)
    if(prior)return this.commitBlogDraft(actor,prior)
    invariant(d.revision===args.revision,'文章已在其他窗口修改，请保留输入后重新打开',409)
    if(!clearProposal&&isDeepStrictEqual(article(d),content))return d
    const preview=await this.prepare(actor,{id:d.id,revision:d.revision,mode:'draft',content,nativeSave:true,clearProposal})
    return this.commitBlogDraft(actor,this.operation(owner,preview.id))
  }
  async applyBlogProposal(actor,args) {
    const d=this.store.get(ownerKey(actor),args.id)
    invariant(d.proposal?.id===args.proposalId&&d.proposal.baseRevision===args.revision&&d.revision===args.revision,'AI 修改建议已变化，请重新比较',409)
    invariant(Array.isArray(args.fields)&&args.fields.length&&args.fields.every(key=>['title','text','tags','categories','allowComment'].includes(key)&&Object.hasOwn(d.proposal.fields,key)),'请选择要采用的修改字段')
    const content=article({...d,...Object.fromEntries(args.fields.map(key=>[key,d.proposal.fields[key]]))})
    return this.saveBlogDraft(actor,{...args,content},true)
  }
  async migrateDrafts(actor) {
    const owner=ownerKey(actor),items=[]
    for(const d of this.legacyDrafts(owner)) {
      this.access.assert(actor)
      const saved=await this.createBlogDraft(actor,'migration:'+d.id,d)
      items.push({id:d.id,cid:saved.remote.savedDraft.cid})
    }
    return {items,remaining:this.legacyDrafts(owner).length}
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
    const owner=ownerKey(actor)
    for(const row of this.store.list(owner)){
      if(!this.store.get(owner,row.id).blogNative||row.remote?.deleted||![row.remote?.publishedCid,row.remote?.savedDraftCid].includes(cid))continue
      const existing=this.store.get(owner,row.id)
      if(existing.remote.selectedVariant===variant&&sameBlogContent(existing.remote,remote))return existing
    }
    const result=this.store.create(owner,remoteArticle(source),{...remote,selectedVariant:variant},true)
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
    if(op.mode==='manage')return {id:op.id,nonce:op.nonce,expiresAt:op.expiresAt,mode:op.mode,title:op.title,management:op.payload,impact:op.impact}
    return {id:op.id,nonce:op.nonce,expiresAt:op.expiresAt,mode:op.mode,title:op.title??op.payload.content?.title??'',before:op.before?.published?this.jobs.modelArticle(op.before.published):null,after:op.payload.content??null,hasSavedDraft:!!op.before?.savedDraft,sources:op.sources??[],source:op.proposal?'proposal':'draft',deletedArticles:op.mode==='delete'?[op.before.published,op.before.savedDraft].filter(Boolean).map(p=>({cid:p.cid,title:p.title,type:p.type})):[]}
  }
  async prepareManagement(actor,args,signal,chat) {
    this.access.assert(actor);signal?.throwIfAborted()
    const data=await this.blog.call('manage-preview',args,signal)
    this.access.assert(actor);signal?.throwIfAborted()
    const owner=ownerKey(actor),draftId=`manage:${data.input.kind}:${data.input.id??'new'}`
    this.assertPending(owner,draftId)
    const op={id:randomUUID(),owner,draftId,revision:0,mode:'manage',title:data.title,payload:data.input,impact:data.impact,chat,status:'prepared',nonce:randomUUID(),sessionId:actor.sessionId,expiresAt:Date.now()+600000,createdAt:Date.now()}
    this.store.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?)').run(op.id,owner,draftId,0,JSON.stringify(op))
    return this.preview(op)
  }
  async prepare(actor,args,signal,chat) {
    this.access.assert(actor);signal?.throwIfAborted()
    const owner=ownerKey(actor), d=this.store.get(owner,args.id)
    invariant(d.revision===args.revision,'草稿已变化，请重新预览',409)
    invariant(['draft','publish'].includes(args.mode),'目标状态无效')
    invariant(!args.nativeSave||args.mode==='draft','自动保存仅适用于博客草稿')
    invariant(args.nativeSave&&args.detached||!d.remote?.deleted,'博客原文已删除；如需重新发布，请明确创建新文章',409)
    const proposal=args.proposalId?d.proposal:null
    if(args.proposalId)invariant(proposal?.id===args.proposalId&&proposal.baseRevision===d.revision,'候选稿已变化，请重新选择并预览',409)
    const content=article(args.nativeSave?args.content:proposal?{...d,...proposal.fields}:d)
    if(args.mode==='publish')invariant(content.title.trim() && content.text.trim(),'标题和正文不能为空')
    this.assertPending(owner,d.id,d.remote?.published?.cid??d.remote?.savedDraft?.cid)
    let remote=null
    if(d.remote&&!args.detached) {
      remote=await this.blog.get(d.remote.published?.cid??d.remote.savedDraft?.cid,signal)
      invariant(remote.version===d.remote.version||sameBlogContent(remote,d.remote),'博客内容或设置已有变化，当前改稿已保留，请重新导入比较',409)
      remote.selectedVariant=d.remote.selectedVariant??(remote.savedDraft?'savedDraft':'published')
    }
    this.access.assert(actor);signal?.throwIfAborted()
    const op={id:randomUUID(),owner,sessionId:actor.sessionId,draftId:d.id,revision:d.revision,mode:args.mode,status:'prepared',nonce:randomUUID(),expiresAt:Date.now()+10*60*1000,createdAt:Date.now(),title:content.title,payload:{content,base:remote},before:remote,proposal,sources:proposal?.sources??d.sources,...(chat?{chat}:{}),...(args.nativeSave?{nativeSave:true,clearProposal:args.clearProposal===true,...(args.creationKey?{creationKey:args.creationKey}:{})}:{})}
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
    if(op.mode==='manage')return
    if(op.mode==='delete') {
      const ids=new Set([op.before.published?.cid,op.before.savedDraft?.cid].filter(Boolean))
      for(const row of this.store.list(op.owner))if(ids.has(row.remote?.publishedCid)||ids.has(row.remote?.savedDraftCid)){
        const d=this.store.get(op.owner,row.id)
        if(d.remote?.deleteOperationId!==op.id)this.store.save(op.owner,d.id,d.revision,{remote:{...d.remote,deleted:true,deletedAt:Date.now(),deleteOperationId:op.id}})
      }
      return
    }
    const d=this.store.get(op.owner,op.draftId)
    const nativeContent=op.nativeSave?remoteArticle(result.snapshot.savedDraft):null
    // Keep edits made while the remote request was in flight. The receipt still records success.
    if(d.revision===op.revision&&(!op.proposal||digest(d.proposal)===digest(op.proposal)))this.store.save(op.owner,d.id,d.revision,{remote:result.snapshot,blogNative:true,...(op.nativeSave?{...nativeContent,...(Object.hasOwn(op,'legacyRemote')?{legacyRemote:op.legacyRemote}:{})}:{}),...(op.proposal||op.clearProposal?{...(nativeContent??op.payload.content),proposal:null,sources:op.sources}: {})})
  }
  async confirm(actor,args,conversationId) {
    this.access.assert(actor)
    const owner=ownerKey(actor),op=this.operation(owner,args.id)
    if(op.chat)invariant(conversationId===op.chat.conversationId,'请在原对话卡片确认该操作',403)
    if(op.status==='succeeded')return {status:op.status,result:op.result}
    invariant(op.status==='prepared','提交已开始，请查询回执核对结果',409)
    invariant(op.nonce===args.nonce && op.sessionId===actor.sessionId && op.expiresAt>Date.now(),'确认已失效，请重新预览',409)
    if(!['delete','manage'].includes(op.mode)) {
      const d=this.store.get(owner,op.draftId);invariant(d.revision===op.revision,'草稿已变化，请重新预览',409)
      if(op.proposal)invariant(digest(d.proposal)===digest(op.proposal),'候选稿已变化，请重新预览',409)
    }
    if(op.before?.savedDraft && op.mode==='publish')invariant(args.consumeSavedDraft===true,'请明确确认发布会消费现有博客保存稿')
    this.access.assert(actor)
    this.assertPending(owner,op.draftId,op.before?.published?.cid??op.before?.savedDraft?.cid,op.id)
    op.status='running';delete op.nonce;this.operationSave(op.id,op)
    this.store.record(owner,'submit-before',{operationId:op.id,draftId:op.draftId,mode:op.mode,snapshot:op.before,content:op.payload.content})
    try {
      const result=await this.blog.call(op.mode==='manage'?'manage-write':op.mode==='delete'?'delete':'save',{requestId:op.id,mode:op.mode,...op.payload})
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
