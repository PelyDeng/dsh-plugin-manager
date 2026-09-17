/**
 * 私有侧存储端口：业务与运行时只依赖这里的形状。
 *
 * ## 为什么会话相关的类型在这里重新定义，而不是直接 import `plugin-kit`
 *
 * 框架（`plugin-kit`）**预期对外开放**：外部作者会照抄公开样板，所以框架的会话契约与私有需求
 * 必须解耦。私有侧的落地方式是在 `adapter/conversations.ts` 里满足 kit 的
 * `ConversationProvider` / `ConversationRemovalStore`——**那是全仓唯一接触点**，框架改契约时
 * 只需要跟那一个文件，业务代码零改动。
 *
 * 所以本文件**不 import 会话契约**。区别对待两类类型：
 *
 * - **身份与鉴权**（`Actor` / `Access`）是稳定的公开契约，直接 import；
 * - **会话契约**（`ConversationProvider` / `ConversationRemovalStore` / `ConversationQuery` …）
 *   随框架演进，本地按形状定义等价的类型，由 adapter 负责两侧对应。
 *
 * ## 表侧一律双列
 *
 * `OwnerKey` 是端口侧的不可变值对象，落到 PG 一律展开成 `owner_namespace` + `owner_id`
 * 两列 AND。**每一个**面向 `dsh_conversations` 的查询都必须再带 `agent_id`——三张 `dsh_*`
 * 表是所有 Agent 共用的，而 `(namespace, user_id)` 只区分**人**、不区分 Agent，漏了就跨
 * Agent 串数据（实测：管家侧栏会列出别的 Agent 的会话）。
 */
import type { Access, Actor } from '@dsh-plugin-manager/plugin-kit'
import type { TitleSink } from '../conversation.ts'

/** 归属键。端口内用一个值对象表达，落库时展开成两列。 */
export interface OwnerKey {
  readonly namespace: string
  readonly userId: string
}

/**
 * 业务载荷：`dsh_conversations.payload` / `dsh_turns.payload` 里那一层 JSON 对象。
 *
 * 它是**业务自己的字段**（blog 的 `parent` / `attachments` / `inheritedRequests` /
 * `openingAt` / `sessionCreatedAt`，管家与 closedoff 的同类余项），运行时**不认识任何键**，
 * 只负责整层读写与合并。所以这里是一个开放字典，不是一份需要跟着业务改的 schema。
 *
 * ⚠️ 与 `dsh_turns.status` 的分工是刻意的：**运行时的幂等状态机只占列**，业务状态只占载荷
 * （例如 blog 的业务状态在 `payload.status`，而列的 `status` 恒为 `claimed` / `finished`）。
 * 把业务状态写进列，等于让一台状态机有两个主人。
 */
export type ConversationPayloadShape = Record<string, unknown>

/**
 * 会话索引行。
 *
 * ⚠️ 它必须能回答四件事，缺一个都会让上层出问题：
 * 存在性 / 归属 / `ready`（发布握手）/ 围栏状态（`deletedAt` + `removalState`）。
 * `ConversationRemovalStore.record` 是**同步读**且返回值参与 kit 的分支判定
 * （`conversations.ts:130-131` 判 `alreadyRemoved`），所以这些字段**都要在本地镜像里**，
 * 只存一个"标记"回答不了。
 */
export interface ConversationRecordShape {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly deletedAt: number | null
  readonly removalState: string
  /**
   * 发布握手是否完成。
   *
   * **陷阱字段**：三个消费方都拿它当"可见 / 可删"的门（列表过滤、移除围栏的 409、
   * `conversation-store.ts:63/99`）。而管家**没有**"会话 ready"概念——它建会话时必须显式写
   * `ready = TRUE` 一步到位，否则它的会话会永久停在"创建未完成"：侧栏看不到，也删不掉。
   */
  readonly ready: boolean
  /**
   * 业务载荷（`dsh_conversations.payload`）。
   *
   * 它与上面六个字段走**同一条**可见性路径：`record` 是同步读，回答的是**本地镜像**，
   * 所以载荷也必须进镜像（`conversation_mirror.payload`）——否则重启后、PG 收敛完成之前，
   * 依赖载荷的业务字段（blog 的 `inheritedRequests` 就来自它）会读到空。
   *
   * 标成可选是为了兼容"只用框架字段、没有业务余项"的实现与调用方；`undefined` 与 `{}`
   * 对调用方**同义**（都表示"没有业务字段"），实现不必两者都产出。
   */
  readonly payload?: ConversationPayloadShape
}

/** 会话归属的判据。返回 `undefined` 表示不存在或不属于该 owner。 */
export interface ConversationOwner {
  readonly conversationId: string
  readonly agentId: string
  readonly owner: OwnerKey
}

/**
 * 单条会话的**完整**一行（{@link ConversationPort.detail} 的返回）。
 *
 * 它比 {@link ConversationRecordShape} 多四个**列上的**字段，理由是同步面 `record` **有意**
 * 只回答围栏要的六个字段（见上面的说明），而按 id 读一条会话的业务需要它们：
 *
 * - `titleSource`：决定"这一轮的首句还能不能当标题"（blog 的 `chat.ts` 用它，读不到就
 *   **用户可见地**永远不自动改标题，会话标题一直是"新对话"）；
 * - `pinned`：页面置顶徽标；
 * - `createdAt`：展示"什么时候建的"；
 * - `requestId`：创建幂等键；离线备份的归属清单也用它（备份进程**网络禁用**，只能读本地）。
 *
 * ⚠️ 这四个字段**只来自列**，不是业务载荷的副本：载荷放的是业务余项，列才是框架字段的权威。
 */
export interface ConversationDetailShape extends ConversationRecordShape {
  readonly titleSource: 'automatic' | 'generated' | 'manual'
  readonly pinned: boolean
  readonly createdAt: number
  readonly requestId: string
}

/**
 * 本地镜像里一行的形状（{@link ConversationPort.fenceOf} 的返回）。
 *
 * 比 {@link ConversationRecordShape} 多一个 `titleSource`：同步的标题回调要**同步**判断
 * "这次写入会不会被守卫接受"（守卫里就有 `title_source` 这一条），拿不到它就只能恒真 ⇒
 * "标题变了才广播"退化成"总是广播"。多给这一个，是因为镜像里**本来就有**这一列
 *（`conversation_mirror.title_source`），不是为业务新加的数据。
 */
export interface ConversationFenceShape extends ConversationRecordShape {
  readonly titleSource: 'automatic' | 'generated' | 'manual'
}

export interface ConversationQueryShape {
  readonly offset: number
  readonly limit: number
  readonly q: string
  readonly from?: number | undefined
  readonly to?: number | undefined
  readonly state: string
  /**
   * 搜索只匹配**标题**，不匹配会话 id。
   *
   * 缺省（`undefined` / `false`）保留"标题 OR id"的既有口径——kit 侧栏没有"只搜标题"这个
   * 要求，改默认值等于替它改行为。
   *
   * ⚠️ **谁该传 `true`**：业务页面的搜索入口，也就是 `agents/closedoff/src/web.ts` 里构造列表
   * 查询的那一处（页面 placeholder 写的是"搜索对话标题"）。会话 id 形如
   * `closedoff-web-<uuid>`，把 id 也算命中项会让 `-` / `web` / 单个数字这类短查询命中**全部**
   * 会话。本端口只提供开关，不替业务决定。
   */
  readonly titleOnly?: boolean | undefined
  /**
   * 列表里**是否包含还没完成发布握手的行**（`ready = FALSE`）。
   *
   * 缺省（`undefined` / `false`）只列已发布的——那是 kit 侧栏与 closedoff 页面的口径：
   * 预留段"不可见、也不能发消息"。**谁会传 `true`**：blog 的页面列表（`chat-store.ts` 的 `list`）。
   * 它的"新建对话"是**两段**：先建会话、用户打完第一条消息才发布；中间那段时间旧实现能看到它，
   * 切库后若按侧栏口径过滤，用户会看到刚建的对话在刷新后**消失**（用户可见的行为倒退）。
   *
   * 与 {@link titleOnly} 同性质：这是**页面口径的开关**，端口只提供，不替业务决定默认值。
   */
  readonly includeUnready?: boolean | undefined
}

/**
 * 侧栏列表项。
 *
 * 前六个字段是 **kit 的契约**（`ConversationProvider.list` 的返回项）；最后两个不是——
 * 它们是**给业务自己的页面**用的，见各自的说明。
 */
export interface ManagedConversationShape {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly state: string
  readonly canRemove: boolean
  readonly blockedReason?: string
  /**
   * 置顶标记：**只有业务自己的页面用它**（`closedoff/web/conversation-history.js` 的"置顶"徽标
   * 与置顶菜单文案）。**kit 的侧栏忽略它**，也没有对应的调用口——它不改变会话内容、不改变围栏
   * 状态，只影响列表排序（`postgres.ts` 的 `ORDER BY pinned DESC, updated_at DESC, id`）。
   *
   * 可选而不是必填：kit 侧栏只要前六个字段，把业务字段做成必填等于让 kit 的契约跟着业务需求
   * 走——那正是 `ports.ts` 顶上"私有需求与框架契约解耦"要避免的事。
   */
  readonly pinned?: boolean
  /**
   * 标题来源：**同样只给业务页面用**（`closedoff/web/app.js` 靠 `titleSource !== 'automatic'`
   * 决定要不要停止首句标题刷新）。**kit 的侧栏忽略它**。
   *
   * 不放进 `ConversationRecordShape`：那是**围栏读**（`record`，同步、返回值参与 kit 的
   * `alreadyRemoved` 分支）的形状，往里塞展示语义会让同步面承担它不该管的事。
   */
  readonly titleSource?: 'automatic' | 'generated' | 'manual'
  /**
   * 发布握手是否完成（`ready` 列）。**只给业务页面用**（kit 侧栏忽略）。
   *
   * 为什么列表项也要给：`state` 是"围栏 / busy / legacy / ready"那套 5 态，未发布的行落到
   * `else` 分支也是 `'ready'` —— 光看 `state` 分不出"真已发布"和"还在创建握手"。而传了
   * {@link ConversationQueryShape.includeUnready} 的调用方（blog 页面）恰恰要这个区分。
   */
  readonly ready?: boolean
}

export interface ConversationPageShape {
  readonly items: readonly ManagedConversationShape[]
  readonly total: number
  readonly nextOffset: number | null
}

/** 与 kit 的 `PreviewMessage` 同形。 */
export interface PreviewMessageShape {
  readonly role: 'user' | 'assistant' | 'tool'
  readonly text: string
  readonly reasoning?: string
  readonly time?: number
  readonly truncated?: boolean
}

export interface ConversationPreviewShape {
  readonly messages: readonly PreviewMessageShape[]
  readonly previousBefore: number | null
  readonly total: number
}

export interface RemovalResultShape {
  readonly id: string
  readonly status: 'removed' | 'alreadyRemoved' | 'blocked' | 'failed'
  readonly message?: string
}

/**
 * 侧栏入口的形状（对应 kit 的 `ConversationProvider`）。
 *
 * 由 `adapter/conversations.ts` 登记到宿主；本模块只描述形状，不 import 那个接口。
 */
export interface ConversationProviderShape {
  readonly protocol: 1
  readonly pluginId: string
  list(actor: Actor, query: ConversationQueryShape): Promise<ConversationPageShape>
  preview(actor: Actor, id: string, before?: number): Promise<ConversationPreviewShape>
  remove(actor: Actor, ids: readonly string[]): Promise<{ readonly results: readonly RemovalResultShape[] }>
}

/**
 * 会话端口（落 `dsh_conversations` + `dsh_turns`）。
 *
 * ⚠️ `record` / `mark` 是**同步**的——这不是遗漏，是 kit 契约的硬要求
 * （`conversations.ts:90-93`，被 `conversationRemover` 在 `:130/:139/:141/:149` 同步调用）。
 * 实现分两段：**同步写本地 SQLite**（满足契约、原子），再由**门面自己的后台排空**
 * （`AgentDatabaseFacade.scheduleDrain()`，`mark` 与 `titleSink().submit` 之后各触发一次）
 * 把权威状态补进 PG 的 `removal_state`；启动时**先排空 outbox、再**按 PG 收敛。
 *
 * ⚠️ 那句"由 adapter 异步补写"曾经是**反的**：adapter 只装 `managed`（`conversationRemover`），
 * 它不碰 outbox。补写点只有门面一处，而它此前只被 `open()` 调过一次 ⇒ 运行期的 `mark` 与标题
 * 投递**在本进程内永不落 PG**。改动这一层时请一起看 `storage/index.ts` 的 `scheduleDrain()`。
 *
 * ⚠️ 围栏的真值方向：**pending 窗口内本地权威**。写成"PG 权威 + 本地可从 PG 重建"是**反的**——
 * 崩溃窗口里 PG 什么都没有，按 PG 重建会把本地 pending 抹成空串，围栏失效而宿主可能已经归档，
 * 于是留下幽灵会话。
 */
export interface ConversationPort {
  readonly agentId: string

  /** 会话归属——**授权判据**。返回 `undefined` 表示不存在或不属于该 owner。 */
  conversationOf(owner: OwnerKey, conversationId: string): Promise<ConversationOwner | undefined>

  /**
   * 按 id 读**一整行**（{@link ConversationDetailShape}）；不存在或不属于该 owner ⇒ `undefined`。
   *
   * **与 `record` 的分工**：`record` 是**同步**的围栏读，只回答六个字段（kit 契约要求同步）；
   * 本方法是**异步**的业务读，多给 `titleSource` / `pinned` / `createdAt` / `requestId`。
   * 两者不是"快慢两个版本"，而是**两个面**：把 `record` 撑大去满足业务读，会让同步面承担它
   * 不该管的事；反过来让业务只靠 `record`，就会在缺字段时**静默**给出错的行为（标题不再自动
   * 更新、置顶徽标消失）。
   *
   * `undefined` 而**不是抛 404**：存在性要不要摊开成 404 是调用方的语义（"读会话详情"要 404，
   * "读一下有没有这一行"不要），与 {@link conversationOf} / {@link TurnStorePort.turnById} 同一条口径。
   */
  detail(owner: OwnerKey, conversationId: string): Promise<ConversationDetailShape | undefined>

  /**
   * **预留段**：插入一行归属，`ready = false`——会话此时还不可见、也不能发消息。
   *
   * `requestId` 参与**创建幂等**（部分唯一索引 `WHERE request_id <> ''`）：同一个 `requestId`
   * 再来一次返回已存在的那一行，不新建。
   *
   * ⚠️ **id 由调用方铸，不是本方法生成的**：两个既有实现的铸点不同（blog 的
   * `chat-store.ts:41` 在 `create` 内部铸 `'blog-chat-' + randomUUID()`，closedoff 的
   * `agent.ts:261` 与管家都在外面铸），统一后一律**外面铸、这里收**——因为格式契约是
   * 按 `agent_id` 参数化的（见 `conversation.ts` 的 `CONVERSATION_PREFIX`），而只有调用方
   * 知道自己是哪个 Agent。
   *
   * `requestId` 是**创建幂等键**（部分唯一索引 `WHERE request_id <> ''`）：同一个 requestId
   * 再来一次返回已存在的那一行，不新建。管家没有这个语义，传空串。
   *
   * `initial.payload` 是**建行时**要落的业务载荷（`{}` 与省略同义）。它只在这一行**首次**
   * 被创建时生效：幂等命中既有行时返回的是**原来那一行的载荷**，不是这次传进来的。
   *
   * `initial.titleSource` 缺省按"标题非空 ⇒ `'manual'`，否则 `'automatic'`"判定（历史的
   * "给了标题就是人工标题"口径）。**要显式给它是为了那种组合**：业务想落一个**默认标题**
   * （"新对话"）又希望它之后能被官方首句标题覆盖——那是 `title` + `'automatic'`。缺了这个入口，
   * 业务只能二选一：要么标题为空，要么永远盖不上（实测过一次：侧栏标题永久为空）。
   */
  create(owner: OwnerKey, conversationId: string, requestId: string,
    initial?: {
      readonly title?: string
      readonly payload?: ConversationPayloadShape
      readonly titleSource?: 'automatic' | 'generated' | 'manual'
    }): Promise<ConversationRecordShape>

  /**
   * 合并写业务载荷：**浅合并**（`payload || $patch`，与 `jsonb` 的 `||` 同义），只覆盖给出的键。
   *
   * 为什么必须是"合并"而不是"整层替换"：业务侧的更新天然是**按字段**来的
   * （blog 的 `save(owner, id, patch)` 就是 `{...old, ...patch}`），整层替换要求每个调用方
   * 都先读一次再写回，那会出现"两个页面各改一个字段、后写的吃掉先写的"。
   *
   * 返回值是**合并后落下的那一层**（不是补丁本身）——调用方据此知道这次到底写进去了什么，
   * 不必再读一次。
   *
   * ⚠️ 归属判定与存在性由实现自己保证（`agent_id` + owner 三列全参与 WHERE）；不是本 owner
   * 的行**不会被改**。实现可以选择"不改也不抛"（幂等）或抛 404，但**不能**跨 owner 改到别人
   * 的行——这是本方法与 `syncTitle` / `pin` 共有的硬要求。
   */
  patchPayload(owner: OwnerKey, conversationId: string,
    patch: ConversationPayloadShape): Promise<ConversationPayloadShape>

  /**
   * **发布段**：把 `ready` 翻成 true，会话从此在侧栏可见、可以发送。
   *
   * ⚠️ 这一项是实施时补上的：设计 §4.4 的端口清单里只有 `create`，但两个既有实现都是
   * **两段握手**（blog 的 `chat-store.ts:41` 写 `ready:false`，`chat.ts` 随后翻真；
   * closedoff 的 `conversation-store.ts:50-59` 是 `reserve` + `publish`）。只有"预留"没有
   * "发布"，会话会永久停在"创建未完成"：侧栏看不到，也删不掉。
   *
   * **管家是例外**：它没有"发布握手"这个概念，建会话时必须**一步到位写 `ready = TRUE`**。
   */
  publish(owner: OwnerKey, conversationId: string): Promise<void>

  /**
   * 协作任务的会话寻址：**派生的 requestId + 部分唯一索引，不建映射表**。
   *
   * ⚠️ 派生的是 **requestId** 而不是会话 id——会话 id 是 `randomUUID()`，只有 `requestId`
   * 是 missionId 的函数。含 `agentId`，避免跨 Agent 撞键。
   */
  missionRequestId(owner: OwnerKey, missionId: string): string

  /**
   * 供侧栏：列表查询。
   *
   * `scope` 里的两个集合**必须一起用**，否则侧栏会给出错误的可移除判定：
   * - `busy`：本实例正在跑的会话 + **宿主侧正在跑的会话**（`hostBusyConversationIds`），
   *   后者可能不属于本插件，但移除围栏必须看见它；
   * - `archived`：宿主归档清单（`conversationArchive().archivedSessionIds`）。
   */
  list(owner: OwnerKey, query: ConversationQueryShape,
    scope: { readonly busy: readonly string[]; readonly archived: readonly string[] }): Promise<ConversationPageShape>

  /** 侧栏操作入口（对应 kit 的 `ConversationProvider`）。 */
  managed(owner: OwnerKey): ConversationProviderShape

  /** 标题投影；`source` 决定它能否覆盖手动标题。 */
  syncTitle(owner: OwnerKey, conversationId: string, title: string,
    source: 'automatic' | 'generated' | 'manual'): Promise<void>

  /**
   * 推进 `updated_at`：**"这个会话刚受理了一条用户消息"的时间戳**。
   *
   * 侧栏排序是 `pinned DESC, updated_at DESC, id`，`from` / `to` 过滤也按这一列。而
   * {@link syncTitle} 的 `UPDATE` **不碰它**（守卫只认 `title` / `title_source`），
   * 所以"续问一条消息"如果只调 `syncTitle`，排序键就退化成**创建时间**：刚说过话的会话沉在
   * 下面，时间范围过滤也算错。`ConversationLifecycle.followup` 因此必须两步都做。
   *
   * `at` 是调用方给的时刻（缺省由实现取当前时间）。**实现要保证这一列单调不减**：倒退会让
   * 分页窗口重叠或跳空，表现为"翻页时某些会话凭空消失"。
   *
   * 与 {@link pin} 一样，它**没有** `ready` / `deleted_at` / `removal_state` 守卫：归属与
   * 存在性由那条 `UPDATE` 的 owner 条件保证，两套判定必然漂移。
   */
  touch(owner: OwnerKey, conversationId: string, at?: number): Promise<void>

  /**
   * 置顶标记。它只影响侧栏排序，不改变会话内容与围栏状态。
   *
   * ⚠️ 归属与存在性**由同一条 `UPDATE` 的 owner 条件保证**（`id` + `agent_id` +
   * `owner_namespace` + `owner_id` 一起 AND），这里**不另做一次预查询**：两套判定必然漂移，
   * 而漂移的表现是"查得到、改不动"这类只在页面上显示为"点了没反应"的缺陷。
   *
   * 与标题不同，它**没有**"谁能覆盖谁"的守卫，也不要求会话已发布：置顶是纯展示状态，
   * 未发布的会话本来也不在侧栏里，拦一道只会让调用方多一个失败分支。
   *
   * 落库与镜像的顺序与 {@link syncTitle} 一致：**先写 PG，PG 成功后再更新本地镜像**——
   * 无条件改本地会让镜像显示一个 PG 里并不存在的状态。
   */
  pin(owner: OwnerKey, conversationId: string, pinned: boolean): Promise<void>

  /** 删除围栏读：**同步**（kit 契约的硬要求，见上）。 */
  record(actor: Actor, conversationId: string): ConversationRecordShape

  /**
   * 按会话 id 读**本地镜像**里的一行；镜像里没有 ⇒ `undefined`。**同步**，且**不做归属判定**。
   *
   * 它与 {@link record} 的分工是刻意的：`record` 是 kit 的围栏读（要 `Actor`，未知 / 他人 /
   * 别的 Agent 一律同一个 404）。本方法服务的是**本进程的同步回调**——
   * `registerConversationTitles` 的回调只给会话 id（拿不到 `Actor`），而它必须**同步**判断
   * "这次标题写入会不会被守卫接受"，才能决定"要不要广播 changed"。
   * M21 记着这条：把那个判断改成异步（或恒真）会让"标题变了才广播"**静默**退化成"总是广播"。
   *
   * ⚠️ 所以它**不是**给业务查询用的读口：没有归属过滤。调用方必须是"本进程刚刚处理过这个
   * 会话"的同步路径（标题事件正是如此）；要带归属判定的读一律走 {@link record} 或
   * {@link detail}。
   */
  fenceOf(conversationId: string): ConversationFenceShape | undefined

  /** 删除围栏写：**同步**——写本地标记 + 写**持久 outbox**，后台按每会话 FIFO 补写 PG。 */
  mark(actor: Actor, conversationId: string, state: 'pending' | 'failed' | 'removed'): void
}

/**
 * 一条**结果记录**（`dsh_turn_results` 的一行）。
 *
 * 业务载荷（`kind` / `proposal` / `draftId` …）全在 {@link payload} 里：运行时**不理解**它的
 * 形状，只负责按轮次存取——理解它的是写出它的那个业务的 `projectResult`。
 */
export interface TurnResultRecord {
  readonly id: string
  /** 属于哪一轮：`dsh_turns.id`（**行 id**，不是幂等键，见 {@link TurnStorePort.turnId}）。 */
  readonly turnId: string
  readonly operationId: string
  /** 插入序（`GENERATED ALWAYS AS IDENTITY`）：同轮内按它排就是业务写入的顺序。 */
  readonly seq: number
  readonly createdAt: number
  readonly payload: Record<string, unknown>
}

/** 落一条结果记录的入参。 */
export interface AppendTurnResultInput {
  readonly conversationId: string
  /** `dsh_turns.id`：由 {@link TurnStorePort.turnId} 查回来的那个值。 */
  readonly turnId: string
  readonly operationId: string
  readonly payload: Record<string, unknown>
  /** 缺省取当前时间（由实现决定）。 */
  readonly createdAt?: number
}

/**
 * 一轮的**记录**（`dsh_turns` 的一行）。
 *
 * ⚠️ **`id` 与 `requestId` 是同名不同义的两个东西**，DDL 第 150 行专门写了这条：
 * `id` 是**行 id**（`dsh_turn_results.turn_id` 指向它），`requestId` 是**幂等键**
 * （部分唯一索引 `WHERE request_id <> ''`）。把两者当同一个东西，结果层就会拿幂等键去当
 * `turn_id`，**查不到任何结果**。
 */
export interface TurnRecord {
  /** `dsh_turns.id` —— **行 id**，不是幂等键。 */
  readonly id: string
  readonly conversationId: string
  /**
   * 幂等键。**空串是"等待行"**（`setPendingQuestion` 落的那种：没有幂等语义、可以有多条）。
   * 调用方按它区分"真正的轮次"与"等待占位"。
   */
  readonly requestId: string
  readonly inputHash: string
  /**
   * 运行时**自己的**记账状态（`claimed` / `finished` / `waiting`…）。
   *
   * ⚠️ **业务状态不在这里**：业务要记的状态（"排队 / 进行 / 停止中"那一类）住 `payload.status`
   * ——写进这一列等于让一台状态机有两个主人（`claim` / `finish` 会覆盖它）。
   */
  readonly status: string
  /**
   * 插入序（库生成的 `IDENTITY`，与 `dsh_turn_results.seq` **同形**）。
   *
   * ⚠️ **轮次列表按它排序，不要按 `createdAt`**：`createdAt` 只到毫秒，同一毫秒内的两条轮次按它
   * 排会退化成按 `id`（随机 UUID）排 ⇒ **列表显示顺序不确定**。`createdAt` 仍回答"这一轮什么时候
   * 发生的"，但它不是顺序的权威。
   */
  readonly seq: number
  readonly createdAt: number
  /** 业务载荷（`dsh_turns.payload`）；运行时**不理解**它的形状。 */
  readonly payload: ConversationPayloadShape
}

/**
 * 轮次幂等与待答问题（落 `dsh_turns`），以及一轮的业务产出（`dsh_turn_results`）。
 *
 * 两张表都**只在 PG**：本地侧没有镜像（`local.ts` 里 `dsh_turns` 零命中）——它们是运行期的
 * 记账，不是"会话行"那种要参与同步围栏的东西。结果层沿用这一点。
 */
export interface TurnStorePort {
  /**
   * 幂等：同一 `requestId` 只跑一轮。同 ID 不同 `inputHash` 应报冲突而不是重跑。
   *
   * `payload` 是**建行时**要落的业务载荷（`{}` 与省略同义）。⚠️ 它只在这一行**首次**被创建时
   * 生效：幂等命中既有行时返回的是**原来那一行**，载荷**不被覆盖**（与 `ConversationPort.create`
   * 的 `initial` 同一条口径）。要改已有行的载荷，用 {@link patchTurnPayload}。
   */
  claim(owner: OwnerKey, conversationId: string, requestId: string, inputHash: string,
    payload?: ConversationPayloadShape)
    : Promise<'claimed' | 'duplicate'>

  /** 这一轮跑完了。 */
  finish(owner: OwnerKey, requestId: string): Promise<void>

  /**
   * 这一轮现在处于什么状态；没有行时 `undefined`。
   *
   * **必须与 {@link claim} 成对使用**：`claim` 只回答"有没有这一轮"，`'duplicate'` 把"已经交付过"
   * 与"上一轮认领后崩在半路"混成同一个答案。不加区分就按 `'duplicate'` 跳过，等于把崩溃的那一轮
   * **永久判成已结算** —— 把一个"静默重放"缺陷换成"静默丢活"缺陷，后者更坏。
   *
   * 单独放在这里而不是把 `claim` 改成三态：`claim` 的现有语义已被存储契约测试固化
   * （未 `finish` 与已 `finish` 都返回 `'duplicate'`），改返回值会动既有断言。
   */
  turnStatus(owner: OwnerKey, requestId: string): Promise<'claimed' | 'finished' | undefined>

  /**
   * 这一轮的**行 id**（`dsh_turns.id`）；没有这一轮时 `undefined`。
   *
   * ⚠️ **它不等同于幂等键**。幂等身份是 `(agent, owner, request_id)` 上的**部分唯一索引**，
   * 而 `dsh_turn_results.turn_id` 指向的是 **turn 的行 id**——DDL 第 150 行专门写了这条
   * "同名不同义"，别把两者当同一个东西。
   *
   * 为什么需要它：`claim` 只回答"认领成功 / 重复"，**不返回行 id**（那个返回值已被存储契约
   * 测试固化，改它会动既有断言）；而结果层要按 `turn_id` 读写。所以用一个**只读**查回补上，
   * 不碰 `claim` 的语义。
   *
   * 空 `requestId` 与不存在的轮次都返回 `undefined`（不抛）：调用方按"这一轮还没落地"处理。
   */
  turnId(owner: OwnerKey, requestId: string): Promise<string | undefined>

  /**
   * 按**行 id** 读一轮；没有这一行（或不属于本 owner）时 `undefined`。
   *
   * 与 {@link turnId} 配对使用：`turnId` 回答"幂等键对应哪个行 id"，本方法回答"这个行 id 现在
   * 是什么样"。业务据此读回自己写在 `payload` 里的字段（含业务状态）。
   */
  turnById(owner: OwnerKey, turnId: string): Promise<TurnRecord | undefined>

  /**
   * 读一个会话下的**全部轮次**，按 **`seq`（插入序）**升序。
   *
   * 旧实现的排序是 `created_at, id`：`created_at` 只到毫秒，测试里两条轮次几乎必然落在同一毫秒，
   * 于是退化成按随机 UUID 排 ⇒ **列表显示顺序不确定**。`dsh_turns` 原先没有单调列（旧 SQLite
   * 索引库靠 `rowid`），`seq` 就是为补上它而加的，见 {@link TurnRecord.seq}。
   *
   * ⚠️ **包含 `request_id = ''` 的等待行**（`setPendingQuestion` 落的那种）。调用方按
   * `requestId === ''` 自行区分——在这里悄悄过滤掉，会让"这个会话在等什么"那条线**静默消失**。
   */
  turnsOf(owner: OwnerKey, conversationId: string): Promise<readonly TurnRecord[]>

  /**
   * 合并写一轮的业务载荷：**浅合并**（`payload || $patch`，与 `jsonb` 的 `||` 同义），只覆盖
   * 给出的键。
   *
   * 与会话的 `patchPayload` 同一条口径：**行不存在或不属于本 owner ⇒ 404**。载荷是**业务数据**，
   * 静默丢掉一个"成功"返回会让调用方以为写进去了；返回 `undefined` 也不行——`{}` 与"没写"在
   * 下游同形。返回值是**合并后落下的那一层**（不是补丁本身）。
   */
  patchTurnPayload(owner: OwnerKey, turnId: string, patch: ConversationPayloadShape)
    : Promise<ConversationPayloadShape>

  /**
   * 落一条**结果记录**（`dsh_turn_results`）：一轮里交回的一条结构化产出。
   *
   * 与 `dsh_turns` 的分工：`dsh_turns` 回答"这一轮跑没跑过、跑完没有"（幂等与状态），
   * `dsh_turn_results` 存**业务产出**（`chat_results` 那类：候选稿引用、操作确认……）。
   *
   * ⚠️ **刻意没有 `(turn_id, operation_id)` 唯一约束**（DDL 第 156 行）：一轮里同一次操作
   * 可以有多条结果（不同 `kind` / `revision`），结果的真实身份就是它自己的 `id`。
   * 所以重复调用**会插入多行**，防重复是调用方的事。
   */
  appendTurnResult(owner: OwnerKey, input: AppendTurnResultInput): Promise<string>

  /** 读某一轮的全部结果记录，按 `seq` 升序（`seq` 是插入序，同轮内天然有序）。 */
  turnResults(owner: OwnerKey, turnId: string): Promise<readonly TurnResultRecord[]>

  /**
   * 读**一个会话下所有轮次**的结果记录，按轮次插入序、再按结果插入序。
   *
   * 为什么不能只用 {@link turnResults} 拼：那要先 {@link turnsOf} 拿全部轮次、再逐轮查一次
   * ——会话有几十轮时就是几十次 PG 往返，而这条路径在**每个 history 请求**上都会走
   * （blog 的 `chat.ts` 用它回答"这个会话还有没有未采用的候选稿"）。这里一条 JOIN 就够。
   *
   * 只认自己的 owner（别人的结果读不到），与 {@link turnResults} 同一条口径。
   */
  turnResultsOf(owner: OwnerKey, conversationId: string): Promise<readonly TurnResultRecord[]>

  /**
   * 按**业务操作标识**读轮次（`payload.operationId`），按插入序**降序**（最新的在最前）。
   *
   * 为什么需要它："这个操作已经绑到哪份草稿/哪份产出"是**跨会话**的问题——同一轮操作会跨会话
   * 延续（从某一轮创建分支、在分支里继续时 `operationId` 被继承，`chat.ts` 的 `send` 在
   * `retryFrom` 路径上也是这么传的）。只在单个会话里找会漏掉那个绑定，结果是**新建第二份草稿**
   * ——用户看到重复，而代码一路"成功"。
   *
   * ⚠️ 它查的是 **JSONB 里的业务键**（`payload->>'operationId'`），不是列：`operation_id` 那一列
   * 在 `dsh_turn_results` 上，含义是"这条结果属于哪次操作"，与本方法问的不是同一件事。
   *
   * 空 `operationId` ⇒ 空数组（空串是"没有操作身份"的取值，不该把一堆无关轮次捞回来）。
   */
  turnsByOperationId(owner: OwnerKey, operationId: string): Promise<readonly TurnRecord[]>

  /**
   * 待答问题：重启后仍能恢复"这个会话在等用户回什么"。
   *
   * **必须有**：协调侧要求子任务确实进入 `waiting_user`，而等待上下文以前只在内存
   * （`butler.ts` 的 `waiting` Map 与定时器，进程重启即丢，重启后 `prepareReply` 会直接报
   * `waiting_expired`）。
   *
   * ⚠️ 落 PG 只解决"问题文本"这一半：重启后仍然缺 `executor` 引用与**超时闹钟**，子任务会
   * 永远停在 `waiting_user`。这三样必须**一起**恢复，"重启不再丢"这句话才成立。
   */
  pendingQuestion(owner: OwnerKey, conversationId: string): Promise<string | undefined>
  /**
   * 记下"在等什么"；`undefined` / 空串表示不再等待。
   *
   * ⚠️ **一个会话同时只有一个待答问题**：写入前会先清掉该会话上原有的 `question` 键（与传
   * `undefined` 时同一句 SQL）。清掉之后 {@link pendingQuestion} 最多命中一行；读侧仍按 `seq`
   * 定义"最新"，但那只是兜底——靠 `created_at` 猜"最新"是不行的，它只到**毫秒**。
   */
  setPendingQuestion(owner: OwnerKey, conversationId: string, question: string | undefined): Promise<void>
}

/**
 * 私有侧的 PG 单库门面。
 *
 * **框架侧仍然用 SQLite**（`plugin-kit` + `dsh-auth` + `dsh-example` 源码零改动），两侧不共享
 * 存储层：框架要对外开放，`node:sqlite` 是 Node 内置模块、框架零依赖，这是第一位的优势。
 */
export interface AgentDatabasePort {
  /**
   * 只核验，不建表（对齐 `blog/src/storage/pg.ts:69-71` 的既定做法）。
   *
   * 缺表 / 版本不符分别归类为 `storage_schema_missing` / `storage_schema_version` 并**拒绝服务**；
   * 建表由建库脚本完成（`private-deploy/db/0001_init.sql`，一次性建出，不是迁移）。
   *
   * 它同时是本门面上唯一一个**只读的连通性往返**：就绪探针在运行期可以用它核实"此刻还连得上"，
   * 而不必去碰业务数据、也不必另开一条探活 SQL。
   */
  assertSchema(): Promise<void>

  /**
   * 标题投递口：官方标题（`session/event` 的 `session/title`）经它落库。
   *
   * `ConversationLifecycle` 的回调是**同步**的（`conversations.ts:36`），而标题最终要落 PG，
   * 所以装配侧必须把这个口子接到 `installTitleSink(...)` 上——不接，标题就被静默丢弃
   * （`conversation.ts` 的 `TitleSink` 注释写了这条）。
   *
   * **可选**：注入式替身（测试用的内存门面）没有标题队列，也不该为了满足接口凭空造一个。
   * 真实实现（`AgentDatabaseFacade.titleSink()`）必有——它底层是本地 `title_outbox` 表。
   */
  titleSink?(): TitleSink

  /** **框架级**会话索引——所有 Agent 共用 `dsh_conversations`，靠 `agent_id` 区分。 */
  readonly conversations: ConversationPort

  /** **框架级**轮次幂等与待答问题——`dsh_turns`。 */
  readonly turns: TurnStorePort

  /** 业务表访问：各 Agent 自己的 `<agentId>_*` 表。 */
  query<T>(sql: string, values?: readonly unknown[]): Promise<T[]>

  transaction<T>(fn: (tx: AgentDatabasePort) => Promise<T>): Promise<T>

  close(): Promise<void>
}

/** 存储门面：目前只有一个后端（私有侧 PG 单库），保留一层是为了业务不直接碰 db。 */
export interface AgentStoragePort {
  readonly db: AgentDatabasePort
  /** 业务侧的鉴权复核。 */
  readonly access: Access
}
