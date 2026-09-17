import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { TEST_DSN,httpFixture } from './http-fixture.mjs'
import { createFakeHost } from './fixtures/fake-host.mjs'

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

/**
 * 判据：**就绪探针不许说谎** —— 业务存储好、索引存储坏时，探针必须是 not-ok。
 *
 * 为什么单列一条：索引与业务**共用一个 DSN**，但要求的是**不同的表与不同的版本行**
 * （业务读 `dsh_schema_versions` 的 `blog` 行，索引读 `runtime` 行 + 三张 `dsh_*` 表）。
 * 只探业务那一侧的实现在这里会报 **ready**，而侧栏列表 / 历史 / 发消息（都走索引侧）全失败
 * —— 而 runbook 第 5 步正是拿这个探针判断"切换成功没有"。
 *
 * 触发条件是**真实可达**的：PG 短暂不可达时 `index.open()` 在装载期失败（原来只 `console.warn`），
 * 业务探针随后恢复 ⇒ 探针绿、索引**整个进程**再没打开过。
 */
test('J6b：业务好、索引坏时探针必须 not-ok（不能只探业务那一侧）',pgOnly,async t=>{
  const f=await httpFixture({storage:'business-only'});t.after(()=>f.close())
  // 装载照常：页面在（与"缺配置"同一条口径）。
  assert.equal((await f.request('')).status,200)
  const health=await f.health()
  assert.equal(health.ok,false,'索引侧不可用时必须 not-ok')
  assert.match(health.error,/索引/)
  // 索引侧端点：稳定码拒绝，而不是 500、也不是"看起来成功"。
  const conversation=await f.api('chat-create',{requestId:'j6b-index-broken'})
  assert.equal(conversation.status,503)
  assert.equal((await conversation.json()).code,'storage_schema_missing')
  // 业务侧**确实是好的**（这条把"探针 not-ok"与"整个存储都坏了"区分开：否则随便一个坏法都能让本用例绿）。
  assert.equal((await f.api('create',{requestId:'j6b-business-ok'})).status,200)
})

/**
 * ⭐ **守卫 `mount()` 里那一行 `withTurnBinding`**（`src/index.ts:412`）。
 *
 * ## 为什么需要它
 *
 * 那一行是"协作入口驱动的那一轮里，业务工具拿得到委派身份"的**唯一来源**：
 * `jobs.mjs:51` 的授权口是 `authorize: agent => this.bound(agent)`，而 `bound()`
 * （`jobs.mjs:135`）在取不到绑定时一律 **403「博客工具没有有效的委派身份」**。
 * 绑定的写点只有两个：页面路径自己建的句柄（`chat.ts` 的 `run()`），以及
 * `withTurnBinding` 的 `onTurnStart` → `bindRuntimeTurn`。
 *
 * ⇒ 装配里删掉那一行，**生产上模型手里的每一个 blog 工具都会 403**，
 * 而界面看不出来、装载也不失败——这正是本仓反复出现的"**声明了却零接线**"。
 *
 * ## 为什么现有的 `coordinator.test.mjs` 挡不住它
 *
 * 那个文件是**手搭** `ConversationLifecycle` + `createParticipant` 的，而且它**自己就调了
 * `withTurnBinding`**。它证明的是"**这个函数管用**"，**不是"装配真的调了它"**——
 * 把 `src/index.ts` 里那一行删掉，它不会变红（已实测）。⇒ 守卫必须走**真 `mount()`**。
 *
 * ## 判别力来自**成对断言**（不是"跑绿就算"）
 *
 * - **负向对照**：一个**没有任何绑定**的 Agent 调同一个工具必须被 403 —— 它证明探针不是恒真；
 * - **正向**：真跑出来的那一轮里，同一个工具**不得**报"委派身份"。
 *
 * ⇒ 删掉 `withTurnBinding` 时**正向**那条变红（负向仍绿）；而"工具压根没注册"时**负向**先红。
 * 两条都在，就没有"因为探针是废的所以恒绿"这种假绿。
 */
test('mount() 装配必须给协作入口建立委派身份（删掉 withTurnBinding 这条就红）',pgOnly,async t=>{
  const root=new Context()
  const agentRegistry=root.plugin(AgentRegistry);await agentRegistry
  const jobRegistry=root.plugin(LocalJobRegistry);await jobRegistry
  const host=createFakeHost(root)
  t.after(async()=>{await host.disposeAll();await jobRegistry.dispose();await agentRegistry.dispose()})
  const f=await httpFixture({extendCtx:ctx=>{
    /**
     * `on` 必须**组合**、不能替换。`kit` 的 `createAccess` 用
     * `ctx.root.emit('ecosystem/providers', …)` 收集鉴权提供方
     * （`packages/plugin-kit/src/access.ts:127`），而本夹具的提供方就注册在这条 `on` 上
     * （`http-fixture.mjs` 里紧随 `extendCtx` 之后那一行）。整条换掉 ⇒ 提供方收不到
     * ⇒ 鉴权解析恒失败。组合之后：夹具自己的 `emit` 照旧打到夹具那份；假宿主的 `emit`
     * 打到运行时订阅的那一份（`session/event`）。
     */
    const own=ctx.on
    ctx.on=(name,listener,...rest)=>{const first=own(name,listener,...rest),second=host.ctx.on(name,listener,...rest);return()=>{first?.();second?.()}}
    /**
     * 把假宿主**除 `jobs` / `root` / `on` 之外**的面全部并入。
     *
     * 少并一个就是一个静默的坑：运行时的 `options()` 走 `conversationModel()` →
     * `agentDefaultModel` / `sessionProjections`，鉴权走 `access`，工具注册走 `tools`。
     * 只补 `agents` + `llm` 时 `run()` 会在接单之前**挂住**（表现为 `accept()` 超时，
     * 而不是某条断言红）。
     *
     * `jobs` **不能**并：本夹具的 `{attachController}` 是页面那半要用的，假宿主那份是 `root.jobs`。
     */
    for(const key of ['agents','llm','agentDefaultModel','sessionController','sessionProjections','sessions','sessionPersistence','messageFeedback','workspaceRegistry','tools'])ctx[key]=host.ctx[key]
    ctx.get=host.ctx.get
  }})
  t.after(()=>f.close())

  /** 可执行的那一份：kit 交给 `ctx.tools.register` 的（**目录条目上没有 `execute`**）。 */
  const executable=host.tool('blog_search_posts')
  assert.ok(executable!==undefined,'blog_search_posts 的可执行体必须由装配经 ctx.tools.register 交出')
  assert.ok(f.mounted.tools.some(tool=>tool.name==='blog_search_posts'),'目录条目里必须有 blog_search_posts')

  // ① 负向对照：没有委派身份的 Agent 一律 403 ⇒ 证明下面那条正向断言**有判别力**。
  await assert.rejects(
    () => executable.execute({query:'测试'},{agent:{}}),
    error=>/委派身份/.test(String(error?.message)),
    '未绑定身份的 Agent 必须被 403 拒绝（否则本用例是恒真的）',
  )

  // ② 驱动**真装配**出来的一轮协作。
  const controller=new AbortController()
  const running=f.mounted.participant.run({
    actor:{namespace:'user',userId:'alice',sessionId:'session-a'},
    missionId:'mission-turn-binding',requestId:'request-turn-binding',
    message:'查一下最近的博客',signal:controller.signal,onProgress(){},
  })
  /**
   * 只等一个**确定**的事件，不做"轮询到绿"：`onTurnStart` 在**注入之前**被 `await`
   * （`packages/runtime/src/conversation.ts:789`），而 `followup` 在它**之后**才发生（`:819`）
   * ⇒ `accept()` 返回时绑定**必然**已经写好（前提正是装配真的调了 `withTurnBinding`）。
   */
  /**
   * 等这一轮**接单**（用户消息投给 Agent）。
   *
   * 同时把 `run()` 的结局记下来：否则"**挂住**"与"**提前失败**"看起来一模一样
   * （都表现为"等接单超时"）。这两种情况的排查方向完全不同，所以这里把它写进失败信息里。
   *
   * 等的是**确定**的事件，不是"轮询到绿"：`onTurnStart` 在**注入之前**被 `await`
   * （`packages/runtime/src/conversation.ts:789`），`followup` 在它**之后**才发生（`:819`）
   * ⇒ 接单发生时绑定**必然**已经写好（前提正是装配真的调了 `withTurnBinding`）。
   */
  let runOutcome
  void running.then(()=>(runOutcome='resolved'),error=>(runOutcome=error))
  const deadline=Date.now()+6000
  while(host.followups.length===0&&runOutcome===undefined&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10))
  const settledEarly=runOutcome!==undefined
  if(host.followups.length===0)assert.fail(`装配出来的一轮没有接单；run() ${settledEarly?'提前结束了':'仍在挂住（未 settle）'}：${settledEarly?String(runOutcome?.stack??runOutcome):'（装配少并了宿主面时就是这一种）'}`)
  const conversationId=host.followups[0].id
  const outcome=await executable.execute({query:'测试'},{agent:host.sessionOf(conversationId).agent})
    .then(value=>({ok:true,value}),error=>({ok:false,error}))
  /**
   * ⚠️ 这里**必须断言"工具真的执行成功了"**，不能只断言"错误信息里没有『委派身份』"。
   *
   * 只查字符串时，工具因**别的**原因失败（DB 错、其它路径的 403、参数问题…）也会让本用例变绿
   * —— 那种"虚假安心"恰恰是这条守卫要防的东西：它挡得住"删掉 `withTurnBinding`"这个**已知**变异，
   * 却对同一条路径上的**其它**回归完全免疫。
   *
   * 所以判据取"成功"，并把 `outcome.error` 写进失败信息便于诊断（删掉那一行时它会带出
   * 「博客工具没有有效的委派身份」，一眼能认）。
   */
  assert.equal(
    outcome.ok,true,
    'mount() 装配出来的那一轮里，业务工具必须**真的执行成功**（这正是 withTurnBinding 那一行的作用）；'
    +`实际失败：${String(outcome.error?.stack??outcome.error)}`,
  )

  // ③ 收尾：把这一轮正常结束掉，别把未 settle 的 run 留过用例
  //    （假宿主文件头 §⚠️1 记的那个"静默挂死"形态：少了 `turn/end` ⇒ `run()` 永不 settle）。
  host.complete(conversationId,'好的')
  const settled=await Promise.race([
    running.then(()=>true,()=>true),
    new Promise(resolve=>setTimeout(()=>resolve(false),8000)),
  ])
  assert.equal(settled,true,'回合结束后 participant.run() 必须 settle（否则是把未完成的一轮留给了下一个用例）')
})
