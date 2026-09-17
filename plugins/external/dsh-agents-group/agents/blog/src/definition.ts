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
 * | `liveMode` | `participant.ts:84-111`：实时通道给的是**本步累积**值 | ✅ `'cumulative'` |
 * | `config` | `config.ts` 的 `Config` | ✅ |
 * | `projectResult` | `participant.ts:12-27` + `:148-202` | ✅ 已落（答案取 `history.tail`；候选 = `loadResults()` + **业务库**草稿核对；操作卡片走 `app.operations`；预算走 `result-text.ts`） |
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
 * 2. **候选判定** → `history.results` 由运行时的 `ctx.loadResults()` 提供（只读**本轮**，与旧实现
 *    按 `requestId === turnId` 过滤等价）；用结果里的 `draftId` 去**业务库**核对该草稿是否仍待采用
 *    ⇒ 需要 `ctx.actor`（**每请求**，不能由闭包捕获）派生 owner 键。**缺口 A 已补**
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
import type { AgentDefinition } from '../../../packages/runtime/src/definition.ts'
import { Config as ConfigSchema } from './config.ts'
import { publicResultText } from './result-text.ts'
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
    operations(owner: string): Promise<readonly { status: string; chat?: { conversationId?: string } | null }[]>
  }
  /** 页面入口前缀（会话材料的位置由它拼出来）。 */
  readonly routePrefix: string
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
     * 实时通道给的是**本步累积**的正文，不是增量（`participant.ts:84-95` 那段注释逐字说明了
     * 这件事：新一轮的累积不再以已发布内容开头时整段追加，空正文只出现在只带推理的片段里）。
     *
     * 交给运行时代管之后，"按前缀算差"这一步由它做（`projection.ts` 的 `cumulative` 分支），
     * 业务不再自己维护 `sentLive`/`process` 那两个基准——**这正是它该由机制承担的部分**。
     */
    liveMode: 'cumulative',
    /**
     * 结果投影：从旧协作入口的收尾段（`participant.ts:148-203`）逐条迁移。
     *
     * ## 只在"回合正常结束"时被调用
     *
     * 运行时的 `settleOnce` 只在回合正常结束时问 `projectResult`；取消与失败由它按回合结局判定
     * （走它自己的兜底文案）。所以这里**只需区分** `completed` 与 `external_pending`，不需要
     * 复现旧实现那三个分支的文案。
     *
     * ⚠️ **一处已知的行为变更（主线已定案、如实登记）**：旧实现在"回合未成功"时会把
     * **失败尝试的正文**也拼进兜底文本（`participant.ts:155` 的 `turn.status !== 'succeeded'`
     * 分支），而运行时的历史里没有 attempt 正文 ⇒ 那段文本不再出现。**接受它**：`tail` 的设计
     * 意图正是"算数的答案"，把被打断的半句当答案本身就是错的。
     */
    projectResult: async (ctx) => {
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

      // —— 候选判定：这一轮准备了哪份候选稿 ——
      // 结果记录在索引库（`dsh_turn_results`），而草稿在**业务库** ⇒ 两边都要核：只看结果会说
      // "有候选"，而那份草稿可能已经被采用或丢弃。`loadResults()` 只读**本轮**，与旧实现按
      // `result.requestId === turnId` 过滤等价（还省掉业务自己拿 id 去比）。
      const results = await ctx.loadResults()
      const candidateOf = (result: { readonly payload: Record<string, unknown> }): { draftId: string; proposalId: string } | undefined => {
        if (result.payload['kind'] !== 'candidate') return undefined
        const proposal = result.payload['proposal'] as { id?: unknown } | undefined
        const draftId = result.payload['draftId']
        if (typeof proposal?.id !== 'string' || typeof draftId !== 'string') return undefined
        return { draftId, proposalId: proposal.id }
      }
      let candidate = false
      for (const result of results) {
        const found = candidateOf(result)
        if (found === undefined) continue
        // 草稿在业务库里；`some()` 不等待异步谓词，候选判定必须逐条 await 核对。
        if ((await input.storage.get(owner, found.draftId)).proposal?.id === found.proposalId) { candidate = true; break }
      }
      const currentCandidates = new Map<string, { title: string; text: string }>()
      for (const result of results) {
        const found = candidateOf(result)
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
    },
  }
}
