import test from 'node:test'
import assert from 'node:assert/strict'
import {publicResultText} from '../src/result-text.ts'
import {createBlogDefinition} from '../src/definition.ts'
import type {BlogDefinitionInput} from '../src/definition.ts'
import {ownerKey} from '../src/store.ts'
import type {ProjectedResult, ResultContext, TurnHookContext} from '../../../packages/runtime/src/definition.ts'
import type {ParticipantArtifact} from '../../../packages/runtime/src/contract.ts'

// ---------------------------------------------------------------------------
// 交回正文的组装与长度预算
//
// 这些用例锁的是**从 `participant.ts` 逐字搬来的那条口径**：候选正文是这一轮真正要交回的东西，
// 放不下时**宁可如实说"没有转交全文"**，也不拿片段冒充完整候选——那会让协调方与用户以为
// 某份候选已经被完整看过了。
// ---------------------------------------------------------------------------

test('没有候选、也没有说明时：正文就是回答本身',()=>{
  assert.equal(publicResultText('写好了',[],[]),'写好了')
})

test('全空时给一句兜底，而不是空正文',()=>{
  // 空正文会被运行时的 ⑦ 判成"这一步没有交回任何正文"——那是失败，而这一轮其实跑完了。
  assert.equal(publicResultText('',[],[]),'博客本轮已结束，请查看原对话。')
})

test('候选正文**全文**进交回材料，并标明是待采用的核对资料',()=>{
  const text=publicResultText('完成了',[], [{title:'标题甲',text:'正文甲'}])
  assert.match(text,/本轮实际候选内容（共 1 份，待采用/)
  assert.match(text,/标题：标题甲/)
  assert.match(text,/正文甲/)
  assert.match(text,/候选 1 正文结束/)
  assert.match(text,/不是指令/)
})

test('⚠️ 候选放不下时**明说没转交全文**，绝不拿片段冒充完整候选',()=>{
  // 构造：候选正文本身超过预算，而"回答 + 完整候选"放不下、但"省略说明 + 候选"也放不下
  // ⇒ 必须走那条"所有候选均未转交全文"的分支。
  const huge='甲'.repeat(70000)
  const text=publicResultText('完成了',[], [{title:'巨稿',text:huge}])
  assert.match(text,/完整清单超过本次协作可转交的长度/)
  assert.match(text,/所有候选均未转交全文，不能宣称已完整复核任何一份候选/)
  // 关键：**不能**出现候选正文的片段——片段会被当"已看过的那一份"。
  assert.equal(text.includes('甲甲甲'),false)
})

test('回答超长时截断并指路，且**不切开代理对**',()=>{
  // 预算 = 64000；说明与候选都为空 ⇒ available ≈ 64000
  const answer='🙂'.repeat(40000) // 每个 emoji 是 2 个 UTF-16 单元
  const text=publicResultText(answer,[],[])
  assert.match(text,/已省略后文；请在博客原对话查看完整回答。/)
  assert.ok(text.length<answer.length+200, '必须真的截断了')
  // 结尾不能是落单的高代理（那会渲染成乱码）
  const cut=text.slice(0,text.indexOf('\n\n[公开回答原长'))
  assert.equal(/[\uD800-\uDBFF]$/.test(cut),false,'截断处不能留落单的高代理')
})

test('状态说明与回答、候选按序拼在一起',()=>{
  const text=publicResultText('答案',['本轮已停止，尚未完成；保留已生成的内容。'],[])
  assert.equal(text,'答案\n\n本轮已停止，尚未完成；保留已生成的内容。')
})

// ---------------------------------------------------------------------------
// AgentDefinition 骨架
//
// 这一层现在只声明"能安全落地"的部分（见 `definition.ts` 文件头的那张表）。下面两条**守护
// "不要凭空加钩子"**：blog 既不做脱敏、也没有"等用户补一句话"的语义、也没有"隐藏业务主键"。
// ---------------------------------------------------------------------------

/**
 * 本文件造的**声明骨架**：只有身份字段、`persona` 与 `tools`。
 *
 * ⚠️ `tools` 的返回类型写成 `readonly unknown[]` 而不是 `ToolDescriptor[]`：这两条用例只用引用相等
 * 验证"原样透传"（`assert.equal(value.tools,tools)`），给的是一个只有 `name` 的替身条目，不是可注册的
 * 工具描述符。`BlogDefinitionInput` 的其余四项（`storage` / `app` / `routePrefix` / `results`）只有
 * `projectResult` 与 `turnContext` 读 —— 那两组用例各自把需要的传全（见 `projectOf` / `turnContextWith`）。
 */
type DefinitionOverrides = { persona?: string; tools?: () => readonly unknown[] }

const definition=(overrides: DefinitionOverrides = {})=>createBlogDefinition({
  persona:'你是伊丽莎白',
  tools:()=>[],
  ...overrides,
  // 夹具只造被测路径用到的面（见 {@link DefinitionOverrides}）：装配侧（`src/index.ts` 的 `mount()`）
  // 给的是真业务存储与真产出读取，这里不假造一份。
} as unknown as BlogDefinitionInput)

test('身份与旧协作入口逐字相同（改名会让协调方与用户看到两个成员）',()=>{
  const value=definition()
  assert.equal(value.id,'blog')
  assert.equal(value.displayName,'伊丽莎白 · 博客')
  assert.equal(value.description,'查询博客、整理资料并提出文章候选；采用候选和发布确认仍在博客原页面完成。')
})

test('实时通道声明为 delta：思考通道由宿主的**增量帧**喂（不是本步累积值）',()=>{
  /**
   * ⚠️ **2026-09-17 更正（原断言写的是 `'cumulative'`）**：旧载体说的"本步累积值"是**页面通道**的
   * 事实（`chat.ts` 自己 `b.live[type] += …`）。新载体的思考通道**不由页面喂**：它由宿主的
   * `reasoning-delta` 帧经 `participant.ts:399` 直接喂，那是**增量**。
   * 声明成 `'cumulative'` 时 `projection.ts:191` 会**整段替换**该 step 的内容 ⇒ 每一步的思考
   * 只剩**最后一个片段**（协调方台面上就是被打碎的思考）。
   *
   * 这条字段的判据**不只看它自己**：`tests/participant.test.ts` 的两条思考通道用例喂的是
   * **真增量**，把 `definition.ts:169` 改回 `'cumulative'` 它们会红（本轮变异验证过）。
   * 与已完成的同类物一致：`closedoff/src/definition.ts:113` 也是 `'delta'`（运行时的缺省）。
   */
  assert.equal(definition().liveMode,'delta')
})

test('会话寻址声明为 derived：同一 mission 只建一条会话（取代旧映射表）',()=>{
  // 这条声明的**唯一作用**是让运行时用 `missionRequestId(owner, missionId)` 做创建幂等键
  // （`conversation.ts` 的 `openByMission`）。旧实现靠 `pirate_blog_conversations` 映射表保证
  // "同一 mission 一条会话"，而那张表**已经取消**（设计 §3.2）⇒ 这条声明一旦丢失，退步是
  // **静默**的：每个子任务各建一条会话，协调方下次派活找不到上一次的上下文。
  assert.equal(definition().conversationAddressing,'derived')
})

test('persona 与 tools 原样透传（本文件不注册任何东西）',()=>{
  const tools=()=>[{name:'blog_propose'}]
  const value=definition({persona:' 人设 ',tools})
  assert.equal(value.persona,' 人设 ')
  assert.equal(value.tools,tools)
})

test('⚠️ 不凭空加 blog 没有的钩子（脱敏 / 等待 / 隐藏主键）',()=>{
  const value=definition()
  /**
   * 三条都**不是**"顺手补上就更完整"的钩子：加 `redact` 会改变交回正文，加 `needsReply` 会让本该
   * 结束的回合变成等待。**但"不加"不等于"没问题"**——`opaqueFromToolResult`（以及 `projectReasoning`）
   * 的缺席是一个**开放缺口 Q2**：新载体的 `thinking` 通道装的是**原始推理**，而旧载体结构上不会
   * 转发推理（旧 `participant.ts:95-107` 只读 `live.text`）⇒ 协调方可见面因此变了。
   * 证据、判定与修好后的动作见 `tests/participant.test.ts` 里那条"特征登记"用例与切换记录。
   */
  assert.equal('redact' in value,false)
  assert.equal('needsReply' in value,false)
  assert.equal('opaqueFromToolResult' in value,false)
})

// ---------------------------------------------------------------------------
// projectResult：从旧协作入口的收尾段（`participant.ts:148-203`）逐条迁移
//
// ⚠️ 注意两个 storage 是**不同的东西**：`input.storage` 是装配侧传进来的**业务**存储
// （`BlogPgStorage`，读草稿），`ctx.storage` 是运行时的会话门面。夹具把两者分开传，免得
// 将来有人以为"投影读的是运行时的库"。
// ---------------------------------------------------------------------------

/** `app.operations` 的条目：本文件只读 `status` 与 `chat.conversationId`（`definition.ts:329-330` 的确认判定）。 */
type OperationRow = { readonly status: string; readonly chat?: { readonly conversationId?: string } | null }

/** `loadResults()` 的产物：本文件只读 `payload`（`definition.ts:310` 拿它判候选）。 */
type LoadedResult = { readonly payload: Record<string, unknown> }

/** `projectOf` 的输入：每一条用例只给这一项，其余走缺省。 */
type ProjectOfInput = {
  history?: ResultContext['history']
  actor?: ResultContext['actor']
  request?: ResultContext['request']
  storage?: BlogDefinitionInput['storage']
  app?: { operations(owner: string): Promise<readonly OperationRow[]> }
  results?: BlogDefinitionInput['results']
  loadResults?: () => Promise<readonly LoadedResult[]>
  routePrefix?: string
}

/**
 * `projectResult` 的产物：实现里**每个分支都给** `artifacts`（`definition.ts:343`），而
 * `ProjectedResult` 把它声明成可选 ⇒ 用例按"这条钩子在这个 Agent 上必给"取一次。
 */
type BlogProjection = ProjectedResult & { readonly artifacts: readonly ParticipantArtifact[] }

/** 跑一次 `projectResult`：只给这一个钩子需要的输入。 */
async function projectOf({history,actor,request,storage,app,loadResults,results,routePrefix}: ProjectOfInput = {}): Promise<BlogProjection> {
  const value=createBlogDefinition({
    persona:'你是伊丽莎白',tools:()=>[],routePrefix:routePrefix??'/agents/blog',
    storage:storage??{get:async()=>({})},
    // 用例造的条目只带 `status` / `chat`（见 {@link OperationRow}），而 `BlogDefinitionInput` 声明的
    // 条目还带 `id`/`title`/`mode`/`result` —— 那四项进的是 `turnContext` 的文本，这里不造。
    app:(app??{operations:async()=>[]}) as unknown as BlogDefinitionInput['app'],
    results:results??{list:async()=>[]},
  })
  return await value.projectResult!({
    history:history??{messages:[{role:'assistant',text:'答案',time:1}],conversationId:'c',finalText:'答案'},
    actor:actor??{namespace:'user',userId:'alice',sessionId:'s1'},
    request:request??{message:'写一篇'},
    storage:undefined,
    // 用例造的产出记录只带 `payload`（见 {@link LoadedResult}）；`TurnResultRecord` 的
    // `id`/`turnId`/`operationId`/`seq`/`createdAt` 是账目字段，这条钩子不读。
    loadResults:(loadResults??(async()=>[])) as unknown as ResultContext['loadResults'],
  }) as BlogProjection
}

test('⚠️ 答案取"算数的那一条"（tail），不取被中断的最后一条',async()=>{
  // 这条是**本轮最容易静默改变行为**的地方：`finalText` 会取最后一条 assistant 消息（被中断的
  // 那条也算），而 blog 的旧实现是按 `tail === true` 取的。用 `finalText` 会把一次被打断的
  // 产出当成最终回答交出去——不报错，只是答案错了。
  const value=await projectOf({history:{
    conversationId:'c',finalText:'被打断的半句',
    tail:{role:'assistant',text:'算数的答案',time:1},
    messages:[{role:'assistant',text:'算数的答案',time:1},{role:'assistant',text:'被打断的半句',time:2,interrupted:true}],
  }})
  assert.equal(value.text.includes('算数的答案'),true)
  assert.equal(value.text.includes('被打断的半句'),false)
})

test('没有 tail（本轮被停止、或只调了工具没说话）时保留全部已生成正文，不丢东西',async()=>{
  const value=await projectOf({history:{
    conversationId:'c',finalText:'',
    messages:[{role:'assistant',text:'第一段',time:1},{role:'assistant',text:'第二段',time:2}],
  }})
  assert.equal(value.text.includes('第一段'),true)
  assert.equal(value.text.includes('第二段'),true)
})

test('有待确认的操作 ⇒ external_pending + confirmation 材料',async()=>{
  const value=await projectOf({app:{operations:async()=>[{status:'prepared',chat:{conversationId:'c'}}]}})
  assert.equal(value.status,'external_pending')
  assert.equal(value.artifacts[0]!.kind,'confirmation')
  assert.match(value.externalPending!.reason,/核对或确认/)
  assert.equal(value.text.includes('核对或确认'),true)
})

test('别的会话的操作卡片**不算**这一轮的确认',async()=>{
  // 漏了这会话过滤，管家页面上任何一条待确认操作都会把别的会话判成 external_pending。
  const value=await projectOf({app:{operations:async()=>[{status:'prepared',chat:{conversationId:'other'}}]}})
  assert.equal(value.status,'completed')
  assert.equal(value.artifacts[0]!.kind,'conversation')
})

test('有候选稿且业务库里的草稿核对通过 ⇒ external_pending + draft 材料',async()=>{
  const value=await projectOf({
    loadResults:async()=>[{payload:{kind:'candidate',draftId:'d1',proposal:{id:'p1'}}}],
    storage:{get:async()=>({proposal:{id:'p1',fields:{title:'标题甲',text:'正文甲'}}})},
  })
  assert.equal(value.status,'external_pending')
  assert.equal(value.artifacts[0]!.kind,'draft')
  assert.match(value.text,/标题甲/)
  assert.match(value.text,/正文甲/)
  assert.match(value.externalPending!.reason,/候选稿已准备，须在博客原对话选择采用/)
})

test('⚠️ 草稿已被采用/改写（proposal.id 对不上）⇒ **不报候选**，落 completed',async()=>{
  // 只看索引结果会说"有候选"，而那份草稿可能已经被采用或丢弃——两边都要核。
  const value=await projectOf({
    loadResults:async()=>[{payload:{kind:'candidate',draftId:'d1',proposal:{id:'p1'}}}],
    storage:{get:async()=>({proposal:{id:'p2',fields:{title:'旧标题',text:'旧正文'}}})},
  })
  assert.equal(value.status,'completed')
  assert.equal(value.artifacts[0]!.kind,'conversation')
  assert.equal('externalPending' in value,false)
  assert.equal(value.text.includes('旧正文'),false)
})

test('既没有待确认操作、也没有候选 ⇒ completed（不能凭空 external_pending）',async()=>{
  const value=await projectOf({})
  assert.equal(value.status,'completed')
  assert.equal('externalPending' in value,false)
})

test('材料位置由 routePrefix 拼出，并去掉尾部斜杠',async()=>{
  const value=await projectOf({routePrefix:'/agents/blog/'})
  assert.equal(value.artifacts[0]!.path,'/agents/blog?conversationId=c')
})

test('非 candidate 的结果不参与候选判定（kind 别的就当没看见）',async()=>{
  const value=await projectOf({
    loadResults:async()=>[{payload:{kind:'report',draftId:'d1',proposal:{id:'p1'}}}],
    storage:{get:async()=>({proposal:{id:'p1',fields:{title:'标题甲',text:'正文甲'}}})},
  })
  assert.equal(value.status,'completed')
})

test('⚠️ 早先轮次留下的候选（本轮没有新结果）⇒ 仍报 external_pending，但不把旧候选正文塞进本轮',async()=>{
  // 候选是**跨轮**事实：第 1 轮准备的候选稿到第 3 轮仍待采用，那两轮都必须如实报 external_pending
  // ——只报"本轮准备了什么"会让用户以为**没事了**。而**交回的正文**只该是本轮新准备的那几份：
  // 把旧候选正文再塞一遍，"本轮实际候选内容"那句话就成了假话。
  const value=await projectOf({
    // 本轮没有新结果：`loadResults()` 空，跨轮那半只可能来自会话产出读取。
    loadResults:async()=>[],
    results:{list:async()=>[{kind:'candidate',draftId:'d1',proposal:{id:'p1'}}]},
    storage:{get:async()=>({proposal:{id:'p1',fields:{title:'旧标题',text:'旧正文'}}})},
  })
  assert.equal(value.status,'external_pending')
  assert.equal(value.artifacts[0]!.kind,'draft')
  assert.match(value.externalPending!.reason,/候选稿已准备，须在博客原对话选择采用/)
  assert.equal(value.text.includes('旧正文'),false)
  assert.equal(value.text.includes('本轮实际候选内容'),false)
  // 跨轮那半也要**核对业务库**：只看会话产出会说"有候选"，而那份草稿可能已经被采用或丢弃。
  const adopted=await projectOf({
    loadResults:async()=>[],
    results:{list:async()=>[{kind:'candidate',draftId:'d1',proposal:{id:'p1'}}]},
    storage:{get:async()=>({proposal:{id:'p2',fields:{title:'旧标题',text:'旧正文'}}})},
  })
  assert.equal(adopted.status,'completed')
  assert.equal('externalPending' in adopted,false)
})

test('跨轮候选按 owner 与**本会话**查（查错会话会把别的会话的候选算到这一轮头上）',async()=>{
  const seen: [string, string][]=[]
  const value=await projectOf({
    history:{conversationId:'c-9',finalText:'答案',messages:[{role:'assistant',text:'答案',time:1}]},
    actor:{namespace:'user',userId:'alice',sessionId:'s1'},
    results:{list:async(owner,conversationId)=>{seen.push([owner,conversationId]);return[]}},
  })
  assert.deepEqual(seen,[[ownerKey({namespace:'user',userId:'alice',sessionId:'s1'}),'c-9']])
  assert.equal(value.status,'completed')
})

// ---------------------------------------------------------------------------
// turnContext：每轮的资料（操作记录 + 时间基准）
//
// 这一层守护的是**接缝换形状时最容易静默丢掉的那件东西**：旧装配"一轮一命"，`setup` 里读到的
// 操作记录与时间基准天然是每轮新的；交给运行时之后会话句柄跨轮复用，若把它挪进 `setup` 就会
// **在会话第一轮冻结**。所以下面既锁"内容对"，也锁"**每轮真的重新求值**"——只锁内容的用例
// 抓不住"冻结"，那正是要防的失败。
// ---------------------------------------------------------------------------

/**
 * 造**一份**声明，并返回"用同一份声明再调一次 `turnContext`"的函数。
 *
 * ⚠️ **必须复用同一个 `definition` 实例**：运行时的会话句柄是**跨轮复用**的，`setup` 只跑一次
 * ——"快照被冻结"这个风险只在**同一个实例被调第二次**时才可能出现。早先的夹具每次调用都新建
 * 一份声明，于是"把操作记录冻结在闭包里"这种真实错误**被夹具掩盖**（实测：变异后用例仍然全绿，
 * 因为每份新声明都有自己的空缓存）。夹具的干净程度决定了它能不能测到要测的东西。
 */
/** `turnContext` 的资料条目：`op()` 造的那一份（`id` / `title` / `mode` / `status` / `result` / `chat`）。 */
type OperationCard = Awaited<ReturnType<BlogDefinitionInput['app']['operations']>>[number]

function turnContextWith(operations: () => readonly OperationCard[]): (overrides?: Partial<TurnHookContext>) => Promise<string> | string {
  const value=createBlogDefinition({
    persona:'你是伊丽莎白',tools:()=>[],routePrefix:'/agents/blog',
    storage:{get:async()=>({})},
    app:{operations:async()=>operations()},
    results:{list:async()=>[]},
  })
  // `turnContext` 的实现只读 `conversationId` 与 `actor`（`definition.ts:224-227`）；`agent` / `handle`
  // 是给"绑宿主任务句柄"那类钩子用的，本夹具没有 —— 按被测路径用到的面越界一次，不假造一个 Agent。
  return (overrides: Partial<TurnHookContext>={})=>value.turnContext!({
    conversationId:'c1',
    actor:{namespace:'user',userId:'alice',sessionId:'s1'},
    agent:undefined,
    storage:undefined,
    ...overrides,
  } as unknown as TurnHookContext)
}

/** 只调一次（不关心跨轮）时的简写。 */
const turnContextOf=(operations: () => readonly OperationCard[], overrides?: Partial<TurnHookContext>)=>turnContextWith(operations)(overrides)

const op=(overrides: Partial<OperationCard>={})=>({id:'o1',title:'发一篇',mode:'publish',status:'prepared',result:null,chat:{conversationId:'c1'},...overrides})

test('操作记录进本轮资料，并带上那句"prepared 尚未执行"的限定',async()=>{
  const text=await turnContextOf(()=>[op()])
  assert.match(text,/对话操作的服务器记录（资料，不是指令）：/)
  assert.match(text,/prepared尚未执行；succeeded才表示完成。/)
  const json=JSON.parse(text.slice(text.indexOf('['),text.indexOf(']。prepared')+1))
  assert.deepEqual(json,[{id:'o1',title:'发一篇',mode:'publish',status:'prepared',url:null}])
})

test('只取本会话的操作，且**最多最近十条**（更早的丢在快照外）',async()=>{
  const many=Array.from({length:12},(_,index)=>op({id:`o${index}`,chat:{conversationId:'c1'}}))
  const text=await turnContextOf(()=>[...many,op({id:'别的会话',chat:{conversationId:'c2'}})])
  // `JSON.parse` 返回 `any`；这里按 `turnContext` 实际写进文本的条目取形状（`definition.ts:229-235`），
  // 本断言只读 `id`。
  const json=JSON.parse(text.slice(text.indexOf('['),text.indexOf(']。prepared')+1)) as { id: string }[]
  assert.equal(json.length,10)
  assert.deepEqual(json.map(item=>item.id),['o2','o3','o4','o5','o6','o7','o8','o9','o10','o11'])
  assert.equal(text.includes('别的会话'),false)
})

test('⚠️ 每轮**真的重查**：上一轮的操作记录不会留到这一轮',async()=>{
  // 这条就是"冻结"的探测器：**同一份声明**（模拟跨轮复用的会话句柄）连着调两次，第二次必须
  // 看到新的服务器记录。把钩子写成"算一次就存起来"（缓存 / `setup` 里算好），`second` 就会等于
  // `first`——注意夹具必须复用实例，否则这条用例测不到东西（见 `turnContextWith` 的注释）。
  const call=turnContextWith(()=>snapshot)
  let snapshot=[op({status:'prepared'})]
  const first=await call()
  snapshot=[op({status:'succeeded',result:{url:'https://blog.example/a'}})]
  const second=await call()
  assert.match(first,/"status":"prepared"/)
  assert.match(second,/"status":"succeeded"/)
  assert.equal(second.includes('"status":"prepared"'),false)
  // 成功后的 `url` 也要跟着变（旧实现取 `op.result?.url ?? null`）。
  assert.match(second,/"url":"https:\/\/blog\.example\/a"/)
})

test('没有操作记录时只发时间基准，不留半句限定语',async()=>{
  const text=await turnContextOf(()=>[])
  assert.match(text,/^本轮时间基准：\{"now":/)
  assert.equal(text.includes('对话操作的服务器记录'),false)
})

test('⚠️ 时间基准也是**每次重算**的（冻结在第一轮的时钟会一直说"今天"是那天）',async()=>{
  // 时间基准的"冻结"没有别的探测器：它一天之内只有 `now` 在变，所以用**同一份声明**上相隔的
  // 两次调用比对 `now`。写死在 `setup` 或模块常量里的实现会让两者相等。
  const call=turnContextWith(()=>[])
  const base=async()=>JSON.parse((await call()).slice('本轮时间基准：'.length)).now
  const first=await base()
  await new Promise(resolve=>setTimeout(resolve,5))
  const second=await base()
  assert.notEqual(first,second)
})
