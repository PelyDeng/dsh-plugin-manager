/**
 * 伊丽莎白 · 博客的业务声明（`AgentDefinition`）。
 *
 * ## 本文件只声明"现在能安全落地"的部分
 *
 * blog 与 closedoff **不同构**：`closedoff/src/agent.ts`(488) 是**纯机制**（会话 Map / 打开合并 /
 * 占用回合 / fork / 模型选择，逐条 1:1 映射到 `ConversationLifecycle`），所以它的改造是"删机制 +
 * 写声明"。而 blog 的 `chat.mjs`(436) 是"**运行时生命周期 + blog 业务**"的**超集**：它用的是与
 * 运行时同一批原语，但自己还实现了回合状态机、`ctx.jobs` 绑定与等待、中断语义、草稿与来源、
 * 分支种子、并发排队、持久化检查点。⇒ **不能照 closedoff 的形状做**。
 *
 * 所以本文件按"**先落唯一能独立验证的一层**"交付，并把**不能落的原因逐条写清**（下面那张表）。
 * 宁可少声明，也不声明一个会**静默改变行为**的钩子。
 *
 * ## 逐条落点表（旧实现 → 本文件的状态）
 *
 * | 钩子 | 旧实现 | 状态 |
 * | --- | --- | --- |
 * | `persona` | `index.ts` 读 `persona.txt` 并 trim | ✅ 由装配侧传入 |
 * | `tools` | `jobs.mjs` 的 `register(...)`（模块级注册） | ⏳ 由装配侧传入（本文件不注册任何东西） |
 * | `liveMode` | `participant.ts:84-111`：实时通道给的是**本步累积**值 | ✅ `'delta'`（**2026-09-17 更正**：那句"累积值"说的是**旧载体的页面通道**；新载体的思考通道由宿主 `reasoning-delta` **增量帧**喂 ⇒ 声明为 `'delta'`，理由见 `:152-166`） |
 * | `config` | `config.ts` 的 `Config` | ✅ |
 * | `projectResult` | `participant.ts:12-27` + `:148-202` | ✅ 已落（答案取 `history.tail`；候选**跨轮**走注入的会话产出读取、**本轮正文**走 `loadResults()`；操作卡片走 `app.operations`；预算走 `result-text.ts`） |
 * | `turnContext` | `chat.mjs:525-528` 的 `operationContext` + `chat.ts:492` 的时间基准 | ✅ 已落（**每轮求值**；两者旧装配里都是每轮新的，见字段注释） |
 * | `projectHistory` | `chat-history.mjs` 的 `projectChat`（页面侧栏） | ⏳ 输出形状不同（含 `tool`/`status` 行），要适配或另立钩子 |
 * | `stageText` | `participant.ts:130-131`/`:205-207` 的**状态行** | ⏳ 运行时的 `stageText` **只在 `tool/call` 上被问**，表达不了状态行 |
 * | `redact` | — | ❌ **不加**：全仓 `grep redact\|脱敏` 在 blog 的 `src/` **零命中**（blog 不做脱敏） |
 * | `needsReply` | — | ❌ **不加**：blog 没有"等用户补一句话"的语义（`waiting` 只出现在**工具描述**里，指"确认卡片待点击"） |
 * | `opaqueFromToolResult` | — | ❌ **不加**：blog 不做"隐藏业务主键"这件事（它的思考通道是 `reasoning-translation.ts` 翻译） |
 *
 * ## ✅ 两处契约缺口的处置结果（`projectResult` 因此可以落地了）
 *
 * blog 的答案与状态判定需要三样东西：
 *
 * 1. **答案提取** → 运行时的 `history.tail` ✅（P7 上一批补齐）。它的语义正是 blog
 *    `participant.ts:168` 那句"该回合最后一条未被中断、且有正文的 assistant 消息"。
 *    ⚠️ 它是一条**消息**（`TurnMessage`），取 `.text`；**不要**改用 `finalText`——被中断的那条
 *    也会被 `finalText` 取到。
 * 2. **候选判定** → 它其实有**两个口径**（本批修正：早先把两者混成一个，跨轮那半因此静默丢失）：
 *    **"还有没有待采用的候选稿"是跨轮事实**，走装配侧注入的会话产出读取（运行时的 `loadResults()`
 *    契约只读**本轮**，跨轮"由业务用自己的业务表查"）；**"本轮交回的候选正文"只本轮**，走
 *    `ctx.loadResults()`。两者都要用结果里的 `draftId` 去**业务库**核对该草稿是否仍待采用 ⇒ 需要
 *    `ctx.actor`（**每请求**，不能由闭包捕获）派生 owner 键。**缺口 A 已补**
 *    （`ResultContext.actor`，运行时加法式扩展）。
 * 3. **`external_pending` 的另一半** → **本批核实：缺口 B 不存在**。旧实现的 `history.operations`
 *    来自 `chat.mjs` 的 `operationCards`，而它就是 `app.operations(owner)` 按会话过滤出来的
 *    ⇒ 那些操作卡片在**业务库**里，`projectResult` 用闭包注入的 `app` 自己查即可，
 *    **不需要**运行时再开一层契约去承载它（`dsh_turn_results` 只承载 `results`，正好）。
 *
 * ## 一处已知的行为变更（主线已定案、如实登记）
 *
 * 旧实现在"回合未成功"时会把**失败尝试的正文**也拼进兜底文本（`participant.ts:155` 的
 * `turn.status !== 'succeeded'` 分支），而运行时的历史里没有 attempt 正文 ⇒ 那段文本不再出现。
 * **接受它**：`tail` 的设计意图正是"算数的答案"，把被打断的半句当答案本身就是错的。
 */
import type { AgentDefinition, ProjectedResult, ResultContext } from '../../../packages/runtime/src/definition.ts'
import { Config as ConfigSchema } from './config.ts'
import { publicResultText } from './result-text.ts'
import { searchContext } from './search.mjs'
import { ownerKey } from './store.mjs'

/** 造声明要的东西：都是装配侧已有的实例与已定稿的配置。 */
export interface BlogDefinitionInput {
  /**
   * 人设正文（装配侧从 `persona.txt` 读入并 `trim`）。
   *
   * 由装配侧读文件：读资源要 `import.meta.url` 与打包布局的知识，那是装配的事，不是声明的。
   */
  readonly persona: string
  /**
   * 业务工具（`jobs.mjs` 的 `register(...)` 在装配期注册一次）。
   *
   * 由装配侧传入而**不在本文件里 import**：`jobs.mjs` 是**模块级注册**（import 即产生副作用），
   * 而本文件的契约是"**一个副作用都没有**"——声明与调用点分家，正是"工具从未被注册"那类缺陷的
   * 反面。注册时机与顺序由装配侧掌握。
   */
  readonly tools: AgentDefinition['tools']
  /**
   * **业务**存储（`BlogPgStorage`）：投影要按 owner 读草稿。
   *
   * ⚠️ 它**不是**运行时的会话门面：业务表（`blog_*`）与会话/轮次（`dsh_*`）是两个库面，装配侧
   * 同时持有两者。这里用最小结构类型描述用到的那个方法（`pg.mjs` 是 `.mjs`、没有类型）。
   */
  readonly storage: {
    get(owner: string, id: string): Promise<{ proposal?: { id: string; fields: { title: string; text: string } } }>
  }
  /**
   * 业务应用（`BlogApplication`）：读这个会话里留下的**操作卡片**。
   *
   * ⚠️ 操作卡片来自**业务库**（`app.operations(owner)`），不是索引库——所以它不需要运行时再开一层
   * 契约（本批核实过：`chat.mjs` 的 `operationCards` 就是 `app.operations(...)` 过滤出来的）。
   */
  readonly app: {
    operations(owner: string): Promise<readonly {
      id: string
      title: string
      mode: string
      status: string
      result?: { url?: string | null } | null
      chat?: { conversationId?: string } | null
    }[]>
  }
  /** 页面入口前缀（会话材料的位置由它拼出来）。 */
  readonly routePrefix: string
  /**
   * 本会话的**运行产出记录**（跨轮）——"这个会话里还有没有**未采用**的候选稿"只能由它回答。
   *
   * ## 为什么不能只靠运行时的 `loadResults()`
   *
   * 候选是**跨轮**事实：第 1 轮准备好的候选稿到第 3 轮仍然待采用，那么这两轮都必须如实报
   * `external_pending`——只报"本轮准备了什么"会让用户以为**没事了**（§18 那条用例锁的就是这个）。
   * 而运行时的 `loadResults()` 契约明确**只读本轮**："跨轮查询没有上界，运行时不做；**要跨轮就
   * 由业务用自己的业务表查**"（`packages/runtime/src/definition.ts:160-166`）。
   *
   * ⇒ 这份读取就是那句"业务自己的表"：blog 索引库的产出记录（`chat_results`），按**会话**查。
   * 装配侧与旧协作入口传的是**同一个**读法（`ChatStore.results`），候选项判定因此只有一份口径。
   *
   * ⚠️ **挂载 `projectResult` 的前置条件**：`dsh_turn_results` 里必须真的有这个会话的产出记录。
   *
   * ⚠️ **这句话订正过一次，旧说法在此显式作废**：本节早先写着"否则跨轮那半会静默失效——**本轮那半
   * 仍由 `loadResults()` 兜住**"，**后半句是错的**。`loadResults()`（`participant.ts:465`）读的
   * **也是** `dsh_turn_results`（`turns.turnResults`，按本轮 turn 行读），两个来源是**同一张表的
   * 两种查询口径**，不是"一张业务表 + 一张运行时表"。而这张表的**唯一生产写入点**是
   * `chat-store.ts:514`（`appendTurnResult`），它**唯一**的业务触发点是 `chat.ts:691` 的
   * `propose` —— 也就是 **blog 自己的 job 路径**。所以一旦某一轮不由 blog 的 job 路径驱动，
   * **两个来源会一起空**：`candidate` 与 `currentCandidates` 同时为空，`external_pending`
   * 永不出现。那是**用户可见的静默语义丢失**（用户以为没事了），不是"少一半"。
   */
  readonly results: {
    list(owner: string, conversationId: string): Promise<readonly Record<string, unknown>[]>
  }
}

/**
 * 造伊丽莎白 · 博客的 `AgentDefinition`。
 *
 * ⚠️ 目前只声明：身份 · `persona` · `tools` · `config` · `liveMode`。
 * **`projectResult` / `projectHistory` / `stageText` 待补齐**（原因见文件头），它们缺席时运行时
 * 走**兜底投影**（正文取最终消息、状态按回合结局判定、材料为空）——那是**已知的、当前就存在**的
 * 行为，不是本文件引入的退步。
 */
export function createBlogDefinition(input: BlogDefinitionInput): AgentDefinition {
  return {
    id: 'blog',
    // 与旧协作入口逐字相同（`participant.ts:51-52`）：对外识别名与描述变了会让协调方与用户
    // 看到两个不同的成员。
    displayName: '伊丽莎白 · 博客',
    description: '查询博客、整理资料并提出文章候选；采用候选和发布确认仍在博客原页面完成。',
    persona: input.persona,
    config: ConfigSchema,
    tools: input.tools,
    /**
     * 实时通道的**块语义**：`'delta'`（增量），不是 `'cumulative'`。
     *
     * ⚠️ **2026-09-17 更正（原值 `'cumulative'`）**：旧载体的确是"本步累积值"——那是**页面通道**
     * （`chat.ts` 自己 `b.live[type] += …` 累积）的事实，旧 `participant.ts:93-107` 也因此要按前缀算差。
     * 但新载体的思考通道**不由页面喂**：它由宿主的 `reasoning-delta` 帧经
     * `participant.ts:399`（`thinking.push(step, chunk.text)`）直接喂——**那是增量**
     * （DSH 的 `StreamChunk` 定义：`{ type: 'reasoning-delta'; text }`，官方用例是 `'r1'` 后接 `'r2'`）。
     * 声明成 `cumulative` 时 `projection.ts:191` 会**整段替换**该 step 的内容
     * ⇒ 每一步的思考只剩**最后一个增量片段**（协调方台面上就是"被打碎的思考"）。
     *
     * 与已完成的同类物一致：`closedoff/src/definition.ts:113` 声明 `'delta'`（运行时的缺省也是它，
     * `participant.ts:333` 的 `definition.liveMode ?? 'delta'`）。
     * **改回 `'cumulative'` 之前先确认"谁在喂这条通道"**——设计文档 §:455/:504 里那句
     * "blog 的 live 是累计值"写的是**旧载体**，已被本轮实测推翻（判据：`tests/participant.test.mjs`
     * 的两条思考通道用例，它们现在喂的是**真增量**）。
     */
    liveMode: 'delta',
    /**
     * 会话寻址：**由协调方的 `missionId` 派生**（旧实现自己维护那张映射表，本声明取代它）。
     *
     * 旧路径：`participant.ts:67` 把 `'pirate-conversation-' + digest({ missionId })` 当 requestId 传给
     * `chat.create`，会话 id 仍是 `chat-store.mjs:41` 的 `'blog-chat-' + randomUUID()`。也就是说
     * **幂等键本来就派生自 mission** —— 这条声明是把那件事从业务侧收进运行时（设计 §3.2 line 357）。
     *
     * 收进来之后"同一 mission 只建一次会话"不再靠业务侧的表，而是靠 `dsh_conversations` 上的部分唯一
     * 索引（`WHERE request_id <> ''`）：跨进程、跨重启都成立，命中既有行时恢复那一条。
     *
     * ⚠️ **派生值会变，如实登记一处行为变更**：旧值是
     * `'pirate-conversation-' + digest({ missionId })`，新值是运行时的
     * `mission:blog:<namespace>:<userId>:<missionId>`（`postgres.ts:354`）——**不是同一个值**。
     * ⇒ 切换之后，同一个 mission 会**再建一条**会话（旧库那条不会被认领）。
     * 设计已定案"全新库没有历史数据"（最终版 line 352），所以**接受**它；这里登记的是它的确切范围：
     * 只影响"切换前已经在跑的 mission"，对切换后新派的活没有影响（新库第一条就是派生键）。
     *
     * ⚠️ **`'derived'` 只声明"寻址"，不声明 id 格式**：会话 id 仍是 `blog-chat-<v4 UUID>`
     * （`conversation.ts` 的 `CONVERSATION_PREFIX`），因为 `backup/chat-state.mjs` 与
     * `backup/executor.py` 的正则 `^blog-chat-[a-f0-9-]{36}$` 硬绑这个形状——**改 id 形状要等备份
     * 与页面入口一并升级**，不在本次范围内。
     */
    conversationAddressing: 'derived',
    /**
     * 本轮的**资料**（不是指令）：对话操作的服务器记录 + 本轮时间基准。
     *
     * ## 为什么它必须是"每轮求值"的钩子，而不是 `setup` 里的一段静态文本
     *
     * 旧的装配是"**一轮一命**"：每轮都 `ctx.agents.create/resume` 一次，于是 `setup` 里的
     * `searchContext()`、以及那批 `await this.app.operations(...)` 的快照，**天然是每轮新的**。
     * 交给运行时之后 `setup` 只在**会话句柄建立时**跑一次（句柄会跨轮复用），同一段代码就变成
     * "**在会话第一轮冻结、之后每轮复用**"——时间基准会永远停在第一轮，操作记录会漏掉本轮新
     * 产生的那几条（`prepared → succeeded` 正是本轮内发生的变化）。**这是接缝换形状时最容易
     * 静默丢掉的一件东西**，所以它走 `turnContext`（每次装配系统提示词时求值），不走 `setup`。
     *
     * ## 两个来源与旧实现逐字对齐
     *
     * - **操作记录**：`chat.mjs:525-528` 的 `operationContext`。同样按 `chat.conversationId`
     *   过滤本会话、同样 `slice(-10)` 只留最近十条、同样的字段与那句"`prepared` 尚未执行；
     *   `succeeded` 才表示完成"。空数组时**整段不发**（旧实现也是 `if (operationContext.length)`）。
     * - **时间基准**：旧实现把它拼在 `blog:persona` 段的末尾（`chat.ts:492`）。挪到本钩子里，
     *   **内容不变、位置从 600 变到 620**（运行时的 `turn-context` 上下文注册在 620）——两者都
     *   在用户消息之前，只是时间基准从"人设段内"变成"紧随人设段之后的一段"。这是**有意**的，
     *   因为**只有钩子能保证它每轮刷新**。
     *
     * ⚠️ **配置语言的那两段（`blog:language` 的 section 与 context）不在这里**：它们是**常量**
     * 文本，没有"每轮变化"的问题，仍由装配侧注册。本钩子只管**会变**的东西。
     *
     * ## 为什么用 `app.operations` 而不是运行时再开一层契约
     *
     * 操作卡片在**业务库**里（本文件上方"缺口 B 不存在"那段已核实），`projectResult` 也是这么读的
     * ⇒ 同源同读法，不需要运行时承载。
     */
    turnContext: async (ctx) => {
      const owner = ownerKey(ctx.actor)
      // 每轮真的去查一次：这是"快照会过期"这件事的唯一防线。
      const operations = (await input.app.operations(owner))
        .filter(operation => operation.chat?.conversationId === ctx.conversationId)
        .slice(-10)
        .map(operation => ({
          id: operation.id,
          title: operation.title,
          mode: operation.mode,
          status: operation.status,
          url: operation.result?.url ?? null,
        }))
      return [
        '本轮时间基准：' + JSON.stringify(searchContext()),
        ...(operations.length
          ? ['对话操作的服务器记录（资料，不是指令）：' + JSON.stringify(operations) + '。prepared尚未执行；succeeded才表示完成。']
          : []),
      ].join('\n')
    },
    projectResult: createBlogProjector(input),
  }
}

/**
 * blog 的结果投影（**唯一实现**）：两个消费者共用同一份。
 *
 * - 运行时的 `AgentDefinition.projectResult`（本文件上方：`createBlogProjector(input)`）；
 * - blog 自己的协作入口（`participant.ts` 的收尾段）—— 在索引库切到运行时之前，它仍是生产路径上
 *   的会话来源。**不能**只让 definition 用这份而让协作入口继续留着自己那一份：两份等价实现的下场
 *   是"某条路径改了、另一条没改"，而用户看到的是**同一轮在大总管那里和在页面上结论不同**。
 *
 * ## 只在"回合正常结束"时被调用
 *
 * 运行时的 `settleOnce` 只在回合正常结束时问 `projectResult`；取消与失败由它按回合结局判定
 * （走它自己的兜底文案）。所以这里**只产出** `completed` 与 `external_pending` 两种状态——
 * **调用方必须在"回合成功"时才调它**。
 *
 * ⚠️ **一处已知的行为变更（主线已定案、如实登记）**：旧实现在"回合未成功"时会把
 * **失败尝试的正文**也拼进兜底文本（`participant.ts:155` 的 `turn.status !== 'succeeded'`
 * 分支），而运行时的历史里没有 attempt 正文 ⇒ 那段文本不再出现。**接受它**：`tail` 的设计
 * 意图正是"算数的答案"，把被打断的半句当答案本身就是错的。
 */
export function createBlogProjector(
  input: Pick<BlogDefinitionInput, 'storage' | 'app' | 'routePrefix' | 'results'>,
): (ctx: ResultContext) => Promise<ProjectedResult> {
  return async (ctx) => {
      const owner = ownerKey(ctx.actor)
      const conversationId = ctx.history.conversationId
      const path = input.routePrefix.replace(/\/$/, '') + '?conversationId=' + encodeURIComponent(conversationId)

      /**
       * 答案只取**这一轮算数的那一条**（`history.tail`）。
       *
       * ⚠️ **不要用 `finalText`**：它取"最后一条 `assistant/message` 的正文"，**被中断的那条也算**
       * （见 `TurnHistory.tail` 的注释）。旧实现是按 `tail === true` 取的（`participant.ts:168`），
       * 换成 `finalText` 会**静默**把一次被打断的产出当成最终回答交出去。
       *
       * 没有 `tail`（本轮被停止、或只调了工具没说话）时保留**全部已生成内容**，不丢东西——与旧
       * 实现在同一分支上的口径一致（`participant.ts:169`）；"正常结束"路径上被中断的正文本来就被
       * 旧实现过滤掉了，两边的 `said` 因此等价。
       */
      const said = ctx.history.messages.filter(message => message.role === 'assistant' && message.interrupted !== true)
      // `tail` 是**那一条消息**（`TurnMessage`），不是正文——取它的 `.text`。
      const text = ctx.history.tail?.text ?? said.map(message => message.text).join('\n\n')

      /**
       * 候选判定分**两个口径**，混成一个就会报错状态：
       *
       * - **"还有没有待采用的候选稿"（`candidate`）是跨轮事实** ⇒ 看**整个会话**的产出记录；
       * - **"本轮交回的候选正文"（`currentCandidates`）只是本轮新准备的那几份** ⇒ 看 `loadResults()`。
       *
       * 两个来源**并集**：`loadResults()`（本轮）保证"本轮刚准备的候选"在任何装配下都不会漏，
       * `results.list`（会话）承载跨轮那部分。两者的判定口径完全相同（都要拿结果里的
       * `proposal.id` 去**业务库**核对草稿是否仍待采用）——只看索引会说"有候选"，而那份草稿可能
       * 已经被采用或丢弃。
       */
      const candidateOf = (record: Record<string, unknown>): { draftId: string; proposalId: string } | undefined => {
        if (record['kind'] !== 'candidate') return undefined
        const draftId = record['draftId'], proposal = record['proposal']
        if (typeof draftId !== 'string' || typeof proposal !== 'object' || proposal === null) return undefined
        const proposalId = (proposal as { id?: unknown }).id
        return typeof proposalId === 'string' ? { draftId, proposalId } : undefined
      }
      // 草稿在业务库里；`some()` 不等待异步谓词，候选判定必须逐条 await 核对。
      const stillPending = async (found: { draftId: string; proposalId: string }): Promise<boolean> =>
        (await input.storage.get(owner, found.draftId)).proposal?.id === found.proposalId
      const currentTurn = (await ctx.loadResults()).map(result => candidateOf(result.payload))
      const wholeConversation = (await input.results.list(owner, conversationId)).map(record => candidateOf(record))
      let candidate = false
      for (const found of [...currentTurn, ...wholeConversation]) {
        if (found !== undefined && await stillPending(found)) { candidate = true; break }
      }
      const currentCandidates = new Map<string, { title: string; text: string }>()
      for (const found of currentTurn) {
        if (found === undefined || currentCandidates.has(found.draftId)) continue
        const proposal = (await input.storage.get(owner, found.draftId)).proposal
        if (proposal?.id === found.proposalId) {
          currentCandidates.set(found.draftId, { title: proposal.fields.title, text: proposal.fields.text })
        }
      }

      // —— 操作卡片（**业务库**）——
      // ⚠️ 本批核实过：`chat.mjs` 的 `operationCards` 就是 `app.operations(owner)` 按会话过滤
      // 出来的 ⇒ 它来自业务库，**不需要**运行时再开一层契约去承载它。
      const operations = await input.app.operations(owner)
      const confirmation = operations.some(operation => operation.chat?.conversationId === conversationId
        && ['prepared', 'running', 'uncertain', 'conflict'].includes(operation.status))

      /**
       * ⚠️ **`external_pending` 不能只落一半。** 它是"材料已交回、剩下的事在博客里办"与"这一轮
       * 完成了"之间的关键区分；只落一半会让它**永远不出现**——那是**静默的语义退步，比不落更糟**。
       * 两个来源都要看：**待确认的操作**（`confirmation`）与**待采用的候选稿**（`candidate`）。
       */
      const external = confirmation || candidate
      const note = confirmation ? '博客操作仍需在原对话核对或确认；此处没有执行发布。'
        : candidate ? '候选稿已准备，须在博客原对话选择采用；候选稿不等于正文已保存或发布。' : ''
      return {
        status: external ? 'external_pending' : 'completed',
        text: publicResultText(text, [note], [...currentCandidates.values()]),
        artifacts: [{
          kind: confirmation ? 'confirmation' : candidate ? 'draft' : 'conversation',
          title: confirmation ? '在博客核对并确认' : candidate ? '在博客查看并采用候选稿' : '查看博客原对话',
          path,
        }],
        // 声明里的理由是给用户看的原话，与 `text` 里那句同源，不另编一份。
        ...(external ? {
          externalPending: {
            reason: note,
            next: '在博客里采用或确认之后，可以再派一轮继续处理后续。',
          },
        } : {}),
      }
  }
}
