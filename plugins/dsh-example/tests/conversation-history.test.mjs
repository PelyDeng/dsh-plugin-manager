import {afterEach,expect,test} from 'vitest'
import {fixture} from './fixture.mjs'
import {HistoryStore} from '../src/history.ts'
import {historyGroup,conversationMarkdown} from '../web/conversation-history.js'
import {DatabaseSync} from 'node:sqlite'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {conversationProviders} from '@dsh-plugin-manager/plugin-kit'
const fixtures=[]
afterEach(async()=>{for(const f of fixtures.splice(0))await f.close()})
test('历史按时间和置顶分组；导出仅包含真实问答正文',()=>{
 const now=new Date(2026,8,8,12).getTime(),day=86400000
 expect([0,1,3,12,40].map(age=>historyGroup({updatedAt:now-age*day},now))).toEqual(['今天','昨天','7 天内','30 天内','更早'])
 expect(historyGroup({pinned:true,updatedAt:0},now)).toBe('置顶')
 expect(conversationMarkdown('标题',[{role:'user',text:'问题'},{role:'assistant',text:'**回答**',reasoning:'私有思考'},{role:'tool',text:'工具密钥'}])).toBe('# 标题\n\n## 我\n\n问题\n\n---\n\n## 助手\n\n**回答**\n')
})
test('旧索引原位迁移；元数据操作隔离用户且批量删除原子执行',()=>{
 const dir=mkdtempSync(join(tmpdir(),'example-history-')),path=join(dir,'history.sqlite'),old=new DatabaseSync(path),alice={namespace:'user',userId:'a'},bob={namespace:'user',userId:'b'}
 old.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,title TEXT NOT NULL,updatedAt INTEGER NOT NULL,ready INTEGER NOT NULL DEFAULT 0);PRAGMA user_version=1;INSERT INTO conversations VALUES('old','user:a','旧标题',1,1)");old.close()
 const store=new HistoryStore(path)
 try{
  expect(store.list(alice,0,30)[0].title).toBe('旧标题')
  store.reserve('foreign',bob,'其他人');store.publish('foreign')
  expect(()=>store.mutate(alice,{operation:'delete',ids:['old','foreign']})).toThrow('会话不存在')
  expect(store.list(alice,0,30)).toHaveLength(1)
  store.mutate(alice,{operation:'rename',ids:['old'],title:'新标题 100%'})
  store.mutate(alice,{operation:'pin',ids:['old'],pinned:true})
  expect(store.list(alice,0,30,'%')[0]).toMatchObject({title:'新标题 100%',pinned:1})
  expect(store.list(alice,0,30,'_')).toHaveLength(0)
  expect(()=>store.mutate(alice,{operation:'rename',ids:['old'],title:' '})).toThrow()
  store.mutate(alice,{operation:'delete',ids:['old']})
  expect(store.list(alice,0,30)).toHaveLength(0);expect(()=>store.assertOwner('old',alice)).toThrow()
  expect(store.list(bob,0,30)).toHaveLength(1)
 }finally{store.close();rmSync(dir,{recursive:true,force:true})}
})
test('对话操作 HTTP 拒绝未登录、跨用户、外站、忙碌会话，删除后原会话不可继续',async()=>{
 const f=await fixture();fixtures.push(f)
 const response=await f.request('/chat',{message:'目标标题'}),h=f.handles[0],input={operation:'rename',ids:[h.id],title:'新名称'}
 expect((await f.request('/conversation-action',input,'')).status).toBe(401)
 expect((await f.request('/conversation-action',input,'bob')).status).toBe(404)
 expect((await f.request('/conversation-action',input,'alice',{origin:'https://foreign.invalid'})).status).toBe(403)
 expect((await f.request('/conversation-action',input)).status).toBe(409)
 f.emit(h,'assistant/message',{message:{id:'m',content:[{type:'text',text:'正文'}]}});f.emit(h,'turn/end',{reason:{kind:'completed'}});await response.text()
 expect((await f.request('/conversation-action',input)).status).toBe(200)
 expect((await(await f.request('/conversations?q='+encodeURIComponent('新名称'))).json()).items).toHaveLength(1)
 expect((await f.request('/conversation-action',{operation:'delete',ids:[h.id]})).status).toBe(200)
 expect((await f.request('/history?id='+h.id)).status).toBe(404)
 expect((await f.request('/chat',{message:'不得复活',conversationId:h.id})).status).toBe(404)
})

test('管理预览只读取本人日志；分页预览不启动智能体，移除同步归档并保留原日志',async()=>{
 const logs=new Map(),f=await fixture({logs});fixtures.push(f)
 const response=await f.request('/chat',{message:'预览问题'}),h=f.handles[0]
 f.emit(h,'assistant/message',{message:{id:'answer',content:[{type:'reasoning',text:'思考依据'},{type:'text',text:'预览回答'}]}})
 f.emit(h,'turn/end',{reason:{kind:'completed'}});await response.text()
 const provider=conversationProviders(f.ctx).get('example'),alice={namespace:'user',userId:'alice',sessionId:'login-a'},bob={namespace:'user',userId:'bob',sessionId:'login-c'}
 const before=JSON.stringify(logs.get(h.id)),handles=f.handles.length
 expect(await provider.preview(alice,h.id)).toMatchObject({messages:[{role:'user',text:'预览问题'},{role:'assistant',text:'预览回答',reasoning:'思考依据'}]})
 expect(f.handles.length).toBe(handles);expect(JSON.stringify(logs.get(h.id))).toBe(before)
 await expect(provider.preview(bob,h.id)).rejects.toThrow('会话不存在')
 expect((await provider.remove(alice,[h.id])).results).toEqual([{id:h.id,status:'removed'}])
 expect(f.ctx.workspaceRegistry.archivedSessionIds).toContain(h.id);expect(JSON.stringify(logs.get(h.id))).toBe(before)
 expect((await provider.list(alice,{offset:0,limit:30,q:'',state:''})).total).toBe(0)
 expect((await provider.remove(alice,[h.id])).results[0].status).toBe('alreadyRemoved')
})
