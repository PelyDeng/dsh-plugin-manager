import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TEST_DSN,httpFixture } from './http-fixture.mjs'

/**
 * 真 PG 门控：下面三条老用例的证据全部落在业务库与索引库上（会话、草稿、附件、备份授权），
 * 而两处存储现在都只有 PostgreSQL 一种后端（Q4 口径）⇒ 没有 `AGENTS_GROUP_TEST_PG_DSN`
 * 时它们**无法**被验证（没有库就没有后端，全会 503）。
 *
 * 跳过与通过是两件事：这里把原因打进输出，不静默通过。J6 验的正是"没有配置"，所以
 * **不**受这个门控影响，无 PG 也照常跑。
 */
const pgOnly=TEST_DSN===''?{skip:'未设置 AGENTS_GROUP_TEST_PG_DSN（真 PG 测试库），跳过 3 条依赖业务/索引存储的用例'}:{}

test('auth protects pages, private drafts, attachments and backup roles',pgOnly,async t=>{
  const f=await httpFixture();t.after(()=>f.close())
  assert.equal((await f.request('/identity',{actor:null})).status,401)
  assert.equal((await f.request('/identity',{actor:'eve'})).status,403)
  const page=await f.request('');assert.equal(page.status,200);assert.match(await page.text(),/<title>博客助手<\/title>/)
  const conversation=await (await f.api('chat-create',{requestId:'http-conversation'})).json()
  assert.equal((await f.api('drafts')).status,200)
  assert.deepEqual(await (await f.api('drafts')).json(),[])
  const chatAttachment=await f.request(`/attachment?draftId=${conversation.id}&name=chat.txt`,{method:'POST',body:'CHAT-PRIVATE',headers:{'content-type':'application/octet-stream'}})
  assert.equal(chatAttachment.status,200)
  assert.equal((await f.api('attachments',{draftId:conversation.id},'bob')).status,404)
  assert.equal((await f.api('chat-list',{},'bob')).status,200)
  assert.equal((await (await f.api('chat-list',{},'bob')).json()).items.length,0)
  const draft=await (await f.api('create',{requestId:'http-native-create'})).json()
  const saved=await f.api('save',{id:draft.id,revision:draft.revision,content:{...draft,title:'manual',text:'# body\n<!-- unchanged -->'}});assert.equal(saved.status,200)
  assert.equal((await f.api('draft',{id:draft.id},'bob')).status,404)
  const attachment=await f.request(`/attachment?draftId=${draft.id}&name=private.txt`,{method:'POST',body:'PRIVATE-MARKER-812',headers:{'content-type':'application/octet-stream'}})
  assert.equal(attachment.status,200);const a=await attachment.json();assert.equal(a.status,'ready');assert.equal(a.original,undefined)
  const downloaded=await f.request(`/attachment-download?draftId=${draft.id}&id=${a.id}`);assert.equal(await downloaded.text(),'PRIVATE-MARKER-812')
  assert.equal((await f.request(`/attachment-download?draftId=${draft.id}&id=${a.id}`,{actor:'bob'})).status,404)
  assert.equal((await f.api('backup-status',{},'bob')).status,403)
  const external=await f.request('/backup-authorize',{method:'POST',body:JSON.stringify({actor:f.actors.alice}),headers:{'content-type':'application/json'}});assert.equal(external.status,403)
  const authorized=()=>f.request('/backup-authorize',{method:'POST',actor:null,body:JSON.stringify({actor:f.actors.alice}),headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json'}})
  assert.equal((await authorized()).status,200)
  f.revoked.add('session-a');f.ctx.emit('ecosystem/revoked',{sessionId:'session-a'})
  assert.equal((await f.api('draft',{id:draft.id})).status,403);assert.equal((await authorized()).status,403)
})
test('cross-origin mutation cannot use a valid login cookie',pgOnly,async t=>{
  const f=await httpFixture();t.after(()=>f.close())
  const response=await f.request('/api',{method:'POST',body:JSON.stringify({action:'create',args:{}}),headers:{origin:'https://untrusted.invalid','content-type':'application/json'}})
  assert.equal(response.status,403)
})

test('history API searches renamed titles and retains records when official archival is unavailable',pgOnly,async t=>{
  const f=await httpFixture();t.after(()=>f.close())
  const first=await(await f.api('chat-create',{requestId:'http-history-first'})).json()
  const other=await(await f.api('chat-create',{requestId:'http-history-other'},'bob')).json()
  assert.equal((await f.api('chat-update',{operation:'rename',ids:[first.id],title:'DSH 100%_稿'})).status,200)
  assert.equal((await f.api('chat-update',{operation:'pin',ids:[first.id],pinned:true})).status,200)
  const found=await(await f.api('chat-list',{query:'dsh 100%_'})).json()
  assert.equal(found.items.length,1);assert.equal(found.items[0].pinned,true)
  assert.equal((await f.api('chat-update',{operation:'delete',ids:[first.id,other.id]})).status,503)
  assert.equal((await f.api('chat-update',{operation:'rename',ids:[first.id],title:'中'.repeat(101)})).status,400)
  assert.equal((await f.api('chat-list',{query:'x'.repeat(121)})).status,400)
  assert.equal((await f.api('chat-update',{operation:'delete',ids:[first.id,first.id]})).status,400)
  assert.equal((await f.api('chat-update',{operation:'delete',ids:[first.id]})).status,503)
  assert.equal((await(await f.api('chat-list')).json()).items[0].id,first.id)
  assert.equal((await(await f.api('chat-create',{requestId:'http-history-first'})).json()).id,first.id)
  assert.equal((await(await f.api('chat-list',{},'bob')).json()).items[0].id,other.id)
})

/**
 * 判据 J6：**没有配置 PostgreSQL 时 blog 未就绪，但装载照常、且绝不回退 SQLite**（Q4 口径）。
 *
 * 六项：① 清掉 `AGENTS_GROUP_PG_DSN`、把私有配置指向不存在的文件（缺文件 = "没有配置"，
 * 不是错误，见 `packages/runtime/src/storage/dsn.ts:47-51`）；② `mount()` 正常返回；③ 探针
 * `ok === false`，且原因点明该配哪个变量；④ 索引侧路由 503 + 稳定码；⑤ 业务侧路由 503 +
 * 同一稳定码；⑥ `dataPath` 下不出现任何 SQLite 文件。
 *
 * ⚠️ ⑤ 用的是 `create`（写）与 `draft`（读），**不是** `drafts`：`application.mjs:63` 的
 * `drafts` 走的是远端博客桥接（Typecho 列表），根本不碰 `BlogPgStorage`——拿它当业务库的证据
 * 会变成一条永远绿的空断言。真正落业务库的是草稿的读写两条路。
 *
 * ⚠️ 断言强度刻意停在"稳定码 + 原因"上：只断 503 的话，"未配置"与"配了但连不上"在测试里就
 * 分不开了，而它们对运维是两个完全不同的动作（去写配置 / 去查网络与库）。
 */
test('J6：未配置 PG 时装载照常、探针与业务端点按 storage_unconfigured 拒绝、绝不回退 SQLite',async t=>{
  const previousDsn=process.env.AGENTS_GROUP_PG_DSN,previousConfig=process.env.AGENTS_GROUP_PG_CONFIG
  delete process.env.AGENTS_GROUP_PG_DSN
  // 显式指向不存在的文件：开发机上恰好存在缺省 storage.json 也不该改变结论。
  process.env.AGENTS_GROUP_PG_CONFIG=join(tmpdir(),'dsh-blog-http-missing-storage.json')
  t.after(()=>{
    if(previousDsn===undefined)delete process.env.AGENTS_GROUP_PG_DSN;else process.env.AGENTS_GROUP_PG_DSN=previousDsn
    if(previousConfig===undefined)delete process.env.AGENTS_GROUP_PG_CONFIG;else process.env.AGENTS_GROUP_PG_CONFIG=previousConfig
  })
  const f=await httpFixture({storage:'unconfigured'});t.after(()=>f.close())
  // ② 装载照常：页面在、工具照旧注册（未就绪 ≠ 不装载；少了工具这一条，"未就绪"会退化成"装了个空壳"，
  // 而空壳在界面上完全看不出来）。
  assert.equal((await f.request('')).status,200)
  assert.ok(f.mounted.tools.length>0,'未配置时也必须照常注册业务工具')
  // ③ 就绪探针如实报未就绪，并给出配置方法。
  const health=await f.health()
  assert.equal(health.ok,false)
  assert.match(health.error,/AGENTS_GROUP_PG_DSN/)
  assert.match(health.error,/AGENTS_GROUP_PG_CONFIG/)
  // ④ 索引侧（会话/轮次）：稳定码拒绝，而不是 500。
  const conversation=await f.api('chat-create',{requestId:'j6-unconfigured-conversation'})
  assert.equal(conversation.status,503)
  assert.equal((await conversation.json()).code,'storage_unconfigured')
  // ⑤ 业务侧（草稿写入 / 草稿读取）：同一口径、同一稳定码。
  for(const [action,args] of [['create',{requestId:'j6-unconfigured-draft'}],['draft',{id:'missing'}]]){
    const response=await f.api(action,args)
    assert.equal(response.status,503,action)
    assert.equal((await response.json()).code,'storage_unconfigured',action)
  }
  // ⑥ 绝不回退 SQLite：夹具目录（含 config.dataPath）下不能出现任何 SQLite 文件。
  assert.deepEqual(await f.sqliteFiles(),[])
})
