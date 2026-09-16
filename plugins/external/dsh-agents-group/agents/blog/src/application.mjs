import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { article, ownerKey, digest } from './store.mjs'
import { invariant } from './settings.mjs'

/**
 * 待核对操作的进程内镜像（四耦合点之 2）。
 *
 * `busy()` 与 provider.list 是 kit 的同步契约，不能读业务库；镜像由**写路径**维护
 * （operationInsert/operationSave 后调用 record），启动时从业务存储恢复一次
 * （restore）。条目按操作 id 记 status/expiresAt，查询时重算会话集合——prepared 过期
 * 与状态翻转都能如实反映，与原 SQLite 直查的过滤口径一致。
 */
export class PendingOperationsMirror {
  constructor() { this.entries = new Map() }
  record(op) {
    if (op?.chat?.conversationId === undefined) return
    this.entries.set(op.id, { conversationId: op.chat.conversationId, status: op.status, expiresAt: op.expiresAt })
  }
  ids(now = Date.now()) {
    const ids = new Set()
    for (const entry of this.entries.values())
      if (['running', 'uncertain'].includes(entry.status) || (entry.status === 'prepared' && entry.expiresAt > now)) ids.add(entry.conversationId)
    return [...ids]
  }
  async restore(storage) {
    for (const op of await storage.pendingOperationRecords()) this.record(op)
    return this
  }
}

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
  constructor(storage,access,blog,images,backups,jobs,attachments,pending) {
    Object.assign(this,{storage,access,blog,images,backups,jobs,attachments,pending})
    /** confirm / prepare 的「读-核-占」互斥段串行链（原 SQLite 同步段的原子性，异步化后显式化）。 */
    this.mutex = Promise.resolve()
  }
  /** 串行执行一段互斥逻辑：同实例内按到达顺序排队，失败不断链。 */
  critical(section) {
    const run = this.mutex.then(section, section)
    this.mutex = run.then(() => {}, () => {})
    return run
  }
  async call(actor,action,args={}) {
    this.access.assert(actor)
    const owner=ownerKey(actor)
    let result
    switch(action) {
      case 'drafts': result=(await this.blog.list(args.query??'',args.page??1,undefined,'draft')).items;break
      case 'search-drafts': result=await this.jobs.searchDrafts(owner,args);break
      case 'search-articles': result=await this.blog.search(args);break
      case 'create': result=await this.createBlogDraft(actor,args.requestId);break
      case 'draft': result=await this.storage.get(owner,args.id);break
      case 'save': result=await this.saveBlogDraft(actor,args);break
      case 'apply': result=await this.applyBlogProposal(actor,args);break
      case 'migration-status': result={remaining:(await this.legacyDrafts(owner)).length};break
      case 'migrate-drafts': result=await this.migrateDrafts(actor);break
      case 'discard-proposal': result=await this.storage.discardProposal(owner,args.id,args.revision,args.proposalId);break
      case 'articles': result=await this.blog.list(args.query??'',args.page??1,undefined,args.status??'published');break
      case 'metadata': result=await this.blog.call('status');break
      case 'manage-list': result=await this.blog.call('manage-list',args);break
      case 'manage-get': result=await this.blog.call('manage-get',args);break
      case 'manage-prepare': result=await this.prepareManagement(actor,args);break
      case 'import': {
        result=await this.importDraft(actor,args.cid,args.variant);break
      }
      case 'tasks': result=await this.storage.jobList(owner,args.draftId);break
      case 'attachments': result=await this.attachments.list(actor,args.draftId);break
      case 'attachment-remove': result=await this.attachments.remove(actor,args.draftId,args.id);break
      case 'attachment-select': result=await this.attachments.select(actor,args.draftId,args.id,args.selected,args.range);break
      case 'attachment-content': result=await this.attachments.content(actor,args.draftId,args.id);break
      case 'task-start': result=await this.jobs.start(actor,{...args,callerId:'web'});break
      case 'task': result=await this.jobs.get(actor,args.id);break
      case 'task-cancel': result=await this.jobs.cancel(actor,args.id);break
      case 'prepare-delete': result=await this.prepareDelete(actor,args.cid);break
      case 'prepare': result=await this.prepare(actor,{id:args.id,revision:args.revision,mode:args.mode,proposalId:args.proposalId});break
      case 'confirm': result=await this.confirm(actor,args);break
      case 'reconcile': result=await this.reconcile(actor,args.id);break
      case 'operations': result=(await this.storage.operationsForDraft(owner,args.draftId)).map(({id,record})=>({id,status:record.status,mode:record.mode,url:record.result?.url,createdAt:record.createdAt}));break
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
  async legacyDrafts(owner) { return (await this.storage.draftRecords(owner)).filter(d=>!d.blogNative) }
  async commitBlogDraft(actor,op) {
    this.access.assert(actor)
    invariant(op.mode==='draft'&&op.nativeSave,'不是博客草稿保存操作',409)
    if(op.status==='succeeded')return this.storage.get(op.owner,op.draftId)
    invariant(op.status!=='running','这篇文章正在保存，请稍后重试',409)
    invariant(op.status!=='conflict','博客草稿已在其他位置修改，请重新打开并比较',409)
    // Retry the same frozen request id; the bridge receipt prevents duplicate drafts.
    op.status='prepared';op.sessionId=actor.sessionId;op.nonce=randomUUID();op.expiresAt=Date.now()+10*60*1000
    await this.operationSave(op.id,op)
    await this.confirm(actor,{id:op.id,nonce:op.nonce})
    return this.storage.get(op.owner,op.draftId)
  }
  async createBlogDraft(actor,requestId,existing,content) {
    this.access.assert(actor)
    invariant(typeof requestId==='string'&&/^[\w:-]{8,160}$/.test(requestId),'新建草稿需要有效请求标识')
    const owner=ownerKey(actor),prior=(await this.operations(owner)).find(op=>op.creationKey===requestId)
    if(prior)return this.commitBlogDraft(actor,prior)
    const status=await this.blog.call('status');this.access.assert(actor)
    invariant(status.nativeDrafts===true,'统一草稿需要更新博客桥接扩展后再使用',503)
    const concurrent=(await this.operations(owner)).find(op=>op.creationKey===requestId)
    if(concurrent)return this.commitBlogDraft(actor,concurrent)
    const d=existing??await this.storage.create(owner)
    const preview=await this.prepare(actor,{id:d.id,revision:d.revision,mode:'draft',content:content??article(d),nativeSave:true,detached:true,creationKey:requestId})
    const op=await this.operation(owner,preview.id);op.creationKey=requestId;op.legacyRemote=d.remote;await this.operationSave(op.id,op)
    return this.commitBlogDraft(actor,op)
  }
  async saveBlogDraft(actor,args,clearProposal=false) {
    this.access.assert(actor)
    const owner=ownerKey(actor),d=await this.storage.get(owner,args.id),content=article(args.content)
    if(!d.blogNative) {
      // First save on a pre-upgrade draft migrates it in place: the frozen migration receipt
      // creates the blog draft with the editor content, and a stale receipt replay is topped
      // up by a normal save so newer edits are never lost.
      const saved=await this.createBlogDraft(actor,'migration:'+d.id,d,content)
      if(digest(article(saved))===digest(content))return saved
      return this.saveBlogDraft(actor,{...args,id:saved.id,revision:saved.revision,content},clearProposal)
    }
    const prior=(await this.operations(owner)).findLast(op=>op.nativeSave&&op.draftId===d.id&&op.revision===args.revision&&digest(op.payload.content)===digest(content)&&!!op.clearProposal===clearProposal)
    if(prior)return this.commitBlogDraft(actor,prior)
    invariant(d.revision===args.revision,'文章已在其他窗口修改，请保留输入后重新打开',409)
    if(!clearProposal&&isDeepStrictEqual(article(d),content))return d
    const preview=await this.prepare(actor,{id:d.id,revision:d.revision,mode:'draft',content,nativeSave:true,clearProposal})
    return this.commitBlogDraft(actor,await this.operation(owner,preview.id))
  }
  async applyBlogProposal(actor,args) {
    const d=await this.storage.get(ownerKey(actor),args.id)
    invariant(d.proposal?.id===args.proposalId&&d.proposal.baseRevision===args.revision&&d.revision===args.revision,'AI 修改建议已变化，请重新比较',409)
    invariant(Array.isArray(args.fields)&&args.fields.length&&args.fields.every(key=>['title','text','tags','categories','allowComment'].includes(key)&&Object.hasOwn(d.proposal.fields,key)),'请选择要采用的修改字段')
    const content=article({...d,...Object.fromEntries(args.fields.map(key=>[key,d.proposal.fields[key]]))})
    return this.saveBlogDraft(actor,{...args,content},true)
  }
  async migrateDrafts(actor) {
    const owner=ownerKey(actor),items=[]
    for(const d of await this.legacyDrafts(owner)) {
      this.access.assert(actor)
      const saved=await this.createBlogDraft(actor,'migration:'+d.id,d)
      items.push({id:d.id,cid:saved.remote.savedDraft.cid})
    }
    return {items,remaining:(await this.legacyDrafts(owner)).length}
  }
  async readImport(actor,cid,variant,signal){
    this.access.assert(actor);signal?.throwIfAborted()
    invariant(['published','savedDraft'].includes(variant),'请选择导入公开版或保存稿')
    const remote=await this.blog.get(cid,signal);this.access.assert(actor);signal?.throwIfAborted()
    const source=remote[variant];invariant(source,'所选版本不存在',404)
    return{source,remote,variant}
  }
  /**
   * 导入按 cid 幂等去重（四耦合点之 1 的 PG 侧半步）：命中已导入的原生稿直接复用，
   * 不创建第二份。绑定两步化后，“PG 建稿成功、索引 updateRequest 失败”的重试靠这里收敛；
   * 远端内容漂移（sameBlogContent 不匹配）时会按现状生成新副本——残余窗口已在方案 §2.1
   * 声明，由绑定并发重试用例按现行语义断言，不加守卫。
   */
  async importSnapshot(actor,{source,remote,variant},cid){
    this.access.assert(actor)
    const owner=ownerKey(actor)
    for(const existing of await this.storage.findByRemoteCid(owner,cid)){
      if(existing.remote.selectedVariant===variant&&sameBlogContent(existing.remote,remote))return existing
    }
    const result=await this.storage.create(owner,remoteArticle(source),{...remote,selectedVariant:variant},true)
    await this.storage.record(owner,'import',{draftId:result.id,cid,variant});return result
  }
  async importDraft(actor,cid,variant){return this.importSnapshot(actor,await this.readImport(actor,cid,variant),cid)}
  async operation(owner,id) { return this.storage.operation(owner,id) }
  async operationSave(id,value) { await this.storage.operationSave(id,value);this.pending?.record({...value,id});return value }
  async operationInsert(op) { await this.storage.operationInsert(op);this.pending?.record(op);return op }
  async operations(owner) { return this.storage.operations(owner) }
  async assertPending(owner,draftId,remoteCid,except) {
    invariant(!(await this.operations(owner)).some(op=>op.id!==except&&['running','uncertain'].includes(op.status)&&(op.draftId===draftId||remoteCid&&(op.before?.published?.cid??op.before?.savedDraft?.cid)===remoteCid)), '同一文章已有提交待核对，不能重复操作',409)
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
    const op={id:randomUUID(),owner,draftId,revision:0,mode:'manage',title:data.title,payload:data.input,impact:data.impact,chat,status:'prepared',nonce:randomUUID(),sessionId:actor.sessionId,expiresAt:Date.now()+600000,createdAt:Date.now()}
    await this.critical(async()=>{await this.assertPending(owner,draftId);await this.operationInsert(op)})
    return this.preview(op)
  }
  async prepare(actor,args,signal,chat) {
    this.access.assert(actor);signal?.throwIfAborted()
    const owner=ownerKey(actor), d=await this.storage.get(owner,args.id)
    invariant(d.revision===args.revision,'草稿已变化，请重新预览',409)
    invariant(['draft','publish'].includes(args.mode),'目标状态无效')
    invariant(!args.nativeSave||args.mode==='draft','自动保存仅适用于博客草稿')
    invariant(args.nativeSave&&args.detached||!d.remote?.deleted,'博客原文已删除；如需重新发布，请明确创建新文章',409)
    const proposal=args.proposalId?d.proposal:null
    if(args.proposalId)invariant(proposal?.id===args.proposalId&&proposal.baseRevision===d.revision,'候选稿已变化，请重新选择并预览',409)
    const content=article(args.nativeSave?args.content:proposal?{...d,...proposal.fields}:d)
    if(args.mode==='publish')invariant(content.title.trim() && content.text.trim(),'标题和正文不能为空')
    await this.assertPending(owner,d.id,d.remote?.published?.cid??d.remote?.savedDraft?.cid)
    let remote=null
    if(d.remote&&!args.detached) {
      remote=await this.blog.get(d.remote.published?.cid??d.remote.savedDraft?.cid,signal)
      invariant(remote.version===d.remote.version||sameBlogContent(remote,d.remote),'博客内容或设置已有变化，当前改稿已保留，请重新导入比较',409)
      remote.selectedVariant=d.remote.selectedVariant??(remote.savedDraft?'savedDraft':'published')
    }
    this.access.assert(actor);signal?.throwIfAborted()
    const op={id:randomUUID(),owner,sessionId:actor.sessionId,draftId:d.id,revision:d.revision,mode:args.mode,status:'prepared',nonce:randomUUID(),expiresAt:Date.now()+10*60*1000,createdAt:Date.now(),title:content.title,payload:{content,base:remote},before:remote,proposal,sources:proposal?.sources??d.sources,...(chat?{chat}:{}),...(args.nativeSave?{nativeSave:true,clearProposal:args.clearProposal===true,...(args.creationKey?{creationKey:args.creationKey}:{})}:{})}
    await this.critical(async()=>{await this.assertPending(owner,d.id,d.remote?.published?.cid??d.remote?.savedDraft?.cid);await this.operationInsert(op)})
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
    const op={id:randomUUID(),owner,sessionId:actor.sessionId,draftId,revision:0,mode:'delete',status:'prepared',nonce:randomUUID(),expiresAt:Date.now()+10*60*1000,createdAt:Date.now(),title:(remote.published??remote.savedDraft).title,payload:{cid:rootCid,base:remote},before:remote,chat}
    await this.critical(async()=>{await this.assertPending(owner,draftId,rootCid);await this.operationInsert(op)})
    return this.preview(op)
  }
  async applyResult(op,result) {
    if(op.mode==='manage')return
    if(op.mode==='delete') {
      const ids=new Set([op.before.published?.cid,op.before.savedDraft?.cid].filter(Boolean))
      for(const d of await this.storage.draftRecords(op.owner))if(ids.has(d.remote?.published?.cid)||ids.has(d.remote?.savedDraft?.cid)){
        if(d.remote?.deleteOperationId!==op.id)await this.storage.save(op.owner,d.id,d.revision,{remote:{...d.remote,deleted:true,deletedAt:Date.now(),deleteOperationId:op.id}})
      }
      return
    }
    const d=await this.storage.get(op.owner,op.draftId)
    const nativeContent=op.nativeSave?remoteArticle(result.snapshot.savedDraft):null
    // Keep edits made while the remote request was in flight. The receipt still records success.
    if(d.revision===op.revision&&(!op.proposal||digest(d.proposal)===digest(op.proposal)))await this.storage.save(op.owner,d.id,d.revision,{remote:result.snapshot,blogNative:true,...(op.nativeSave?{...nativeContent,...(Object.hasOwn(op,'legacyRemote')?{legacyRemote:op.legacyRemote}:{})}:{}),...(op.proposal||op.clearProposal?{...(nativeContent??op.payload.content),proposal:null,sources:op.sources}: {})})
  }
  async confirm(actor,args,conversationId) {
    this.access.assert(actor)
    const owner=ownerKey(actor)
    // 互斥段：读-核-占整体串行（重读权威记录），并发确认恰有一路翻成 running。
    const op=await this.critical(async()=>{
      const op=await this.storage.operation(owner,args.id)
      if(op.chat)invariant(conversationId===op.chat.conversationId,'请在原对话卡片确认该操作',403)
      if(op.status==='succeeded')return {replay:op}
      invariant(op.status==='prepared','提交已开始，请查询回执核对结果',409)
      invariant(op.nonce===args.nonce && op.sessionId===actor.sessionId && op.expiresAt>Date.now(),'确认已失效，请重新预览',409)
      if(!['delete','manage'].includes(op.mode)) {
        const d=await this.storage.get(owner,op.draftId);invariant(d.revision===op.revision,'草稿已变化，请重新预览',409)
        if(op.proposal)invariant(digest(d.proposal)===digest(op.proposal),'候选稿已变化，请重新预览',409)
      }
      if(op.before?.savedDraft && op.mode==='publish')invariant(args.consumeSavedDraft===true,'请明确确认发布会消费现有博客保存稿')
      this.access.assert(actor)
      await this.assertPending(owner,op.draftId,op.before?.published?.cid??op.before?.savedDraft?.cid,op.id)
      op.status='running';delete op.nonce
      invariant(await this.storage.operationClaimStatus(op.id,'prepared',op),'提交已开始，请查询回执核对结果',409)
      this.pending?.record(op)
      return {claimed:op}
    })
    if(op.replay!==undefined)return {status:op.replay.status,result:op.replay.result}
    const claimed=op.claimed
    await this.storage.record(owner,'submit-before',{operationId:claimed.id,draftId:claimed.draftId,mode:claimed.mode,snapshot:claimed.before,content:claimed.payload.content})
    try {
      const result=await this.blog.call(claimed.mode==='manage'?'manage-write':claimed.mode==='delete'?'delete':'save',{requestId:claimed.id,mode:claimed.mode,...claimed.payload})
      claimed.status='succeeded';claimed.result=result;await this.operationSave(claimed.id,claimed)
      await this.storage.record(owner,'submit-success',{operationId:claimed.id,version:result.version})
      await this.applyResult(claimed,result)
      this.access.assert(actor);return {status:claimed.status,result}
    } catch(error) {
      if(claimed.status==='succeeded')throw error
      claimed.status=error?.status===409?'conflict':'uncertain';await this.operationSave(claimed.id,claimed)
      throw error
    }
  }
  async reconcile(actor,id) {
    this.access.assert(actor)
    const owner=ownerKey(actor),op=await this.operation(owner,id)
    if(op.status==='succeeded'){await this.applyResult(op,op.result);return {status:op.status,result:op.result}}
    invariant(['running','uncertain'].includes(op.status),'该操作不需要核对回执',409)
    const result=await this.blog.call('receipt',{requestId:op.id});this.access.assert(actor)
    if(result.status==='succeeded') {
      op.status='succeeded';op.result=result.result;await this.operationSave(id,op)
      await this.applyResult(op,result.result)
      await this.storage.record(owner,'reconciled',{operationId:id});return {status:op.status,result:op.result}
    }
    return {status:'uncertain',message:'未取得成功回执；本地稿与提交记录已保留，请核对博客后再处理'}
  }
  async upload(actor,bytes) {this.access.assert(actor);const result=await this.images.upload(bytes);this.access.assert(actor);await this.storage.record(ownerKey(actor),'upload',result);return result}
}
