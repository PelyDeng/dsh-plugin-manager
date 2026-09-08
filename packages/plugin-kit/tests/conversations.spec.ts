import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { AccessError, type Actor } from '../src/access.ts'
import { conversationIds, conversationQuery, conversationRemover, queryConversationIndex, readConversationEvents, previewPage, type ConversationRecord } from '../src/conversations.ts'

const actor: Actor = { namespace: 'user', userId: 'alice', sessionId: 'login' }
describe('会话管理契约', () => {
  it('校验分页、时间、批量边界，不接受重复或路径 ID', () => {
    for (const params of ['limit=0','limit=101','offset=-1','from=2&to=1','state=deleted','q='+'a'.repeat(121)]) expect(() => conversationQuery(new URLSearchParams(params))).toThrow()
    for (const ids of [[], ['same','same'], ['../data'], Array.from({length:101},(_,i)=>String(i))]) expect(() => conversationIds(ids)).toThrow()
  })
  it('SQL 分页计数保留旧软删除，排除他人及已完成双侧移除', () => {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE TABLE conversations(id TEXT,owner TEXT,title TEXT,updatedAt INTEGER,deletedAt INTEGER,removalState TEXT); INSERT INTO conversations VALUES ('a','alice','测试',100,NULL,''),('old','alice','旧软删除',90,10,''),('done','alice','已移除',80,10,''),('b','bob','他人秘密',110,NULL,'')")
    try {
      const source = 'SELECT * FROM conversations WHERE owner=?'
      const page = queryConversationIndex(db,source,['alice'],{offset:0,limit:1,q:'',state:''},['done'],['a'])
      expect(page).toMatchObject({total:2,nextOffset:1,items:[{id:'a',state:'busy',canRemove:false}]})
      expect(queryConversationIndex(db,source,['alice'],{offset:0,limit:30,q:'',state:'legacy'},['done'],[]).items.map(r=>r.id)).toEqual(['old'])
      expect(queryConversationIndex(db,source,['alice'],{offset:0,limit:30,q:'测试',from:100,to:101,state:''},['done'],[]).total).toBe(1)
    } finally { db.close() }
  })
  it('先持久化写入围栏，再官方归档；中断可重试且不会重复归档', async () => {
    const ctx = new Context(), rows = new Map<string,ConversationRecord>(['a','busy','foreign'].map(id=>[id,{id,title:id,updatedAt:1,deletedAt:null,removalState:''}]))
    const archived: string[] = []; let fail = true, active = true
    ctx.provide('sessionPersistence', { async inspect() { return { events: [] } } })
    ctx.provide('workspaceRegistry',{archivedSessionIds:archived,async archiveSession(id:string){ expect(rows.get(id)?.removalState).toBe('pending'); if(fail)throw Error('storage');if(!archived.includes(id))archived.push(id) }})
    const remove = conversationRemover(ctx,{assert(){if(!active)throw new AccessError(403,'撤权')},store:{record(_actor,id){if(id==='foreign'||!rows.has(id))throw new AccessError(404,'会话不存在或无权访问');return rows.get(id)!},mark(_actor,id,state){rows.get(id)!.removalState=state}},busy:id=>id==='busy',async release(){}})
    const result = await remove(actor,['a','busy','foreign'])
    expect(result.results.map(r=>r.status)).toEqual(['failed','blocked','failed']);expect(rows.get('a')!.removalState).toBe('failed')
    fail=false;expect((await remove(actor,['a'])).results[0]?.status).toBe('removed')
    expect((await remove(actor,['a'])).results[0]?.status).toBe('alreadyRemoved');expect(archived).toEqual(['a'])
    active=false;await expect(remove(actor,['a'])).rejects.toThrow('撤权')
  })
  it('只打开 read 句柄并在异常时关闭；预览默认最近 30 条', async () => {
    const ctx = new Context(); let closed=false
    ctx.provide('sessionPersistence',{async open(_id:string,mode:string){expect(mode).toBe('read');return{async read(){throw Error('read failed')},async close(){closed=true}}}})
    await expect(readConversationEvents(ctx,'a')).rejects.toThrow('read failed');expect(closed).toBe(true)
    const messages = Array.from({length:61},(_,i)=>({role:'user' as const,text:String(i)}))
    expect(previewPage(messages)).toMatchObject({previousBefore:31,total:61,messages:expect.arrayContaining([{role:'user',text:'60'}])})
    expect(previewPage(messages,31).messages[0]?.text).toBe('1')
  })
  it('读取期间出现活动操作会阻止归档；宿主读取失败不会隐藏索引', async () => {
    const ctx = new Context(); let busy = false, archived = false, state = ''
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], async archiveSession() { archived = true } })
    ctx.provide('sessionPersistence', { async inspect() { busy = true; return { events: [] } } })
    const remove = conversationRemover(ctx, { assert() {}, store: { record() { return { id:'a',title:'a',updatedAt:1,deletedAt:null,removalState:state } }, mark(_actor,_id,value) { state=value } }, busy:()=>busy, async release() {} })
    expect((await remove(actor,['a'])).results[0]?.status).toBe('blocked')
    expect(state).toBe(''); expect(archived).toBe(false)
  })
})
