import { randomUUID } from 'node:crypto'
import { digest, ownerKey } from './store.mjs'
import { invariant } from './settings.mjs'
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import type {
  AgentDatabasePort,
  ConversationPayloadShape,
  ConversationQueryShape,
  ConversationRecordShape,
  ManagedConversationShape,
  OwnerKey,
  TurnRecord,
} from '../../../packages/runtime/src/storage/ports.ts'
import {
  decodeTurnPayload, decodeTurnResultPayload, encodeTurnPayload,
  type BlogTurnPayload, type BlogTurnStatus,
} from './turns-payload.ts'

/** 一条对话索引记录（对外形状不变；字段来源从 SQLite 的 `data` 列变成 PG 的列 + `payload`）。 */
export interface ChatConversation {
  id: string
  owner: string
  requestId: string
  title: string
  titleSource: 'automatic' | 'generated' | 'manual'
  ready: boolean
  pinned: boolean
  deletedAt: number | null
  createdAt: number
  updatedAt: number
  parent: string | null
  attachments: readonly ChatAttachmentRef[]
  /** 删除围栏标记；缺省（未标记）按空串处理。 */
  removalState?: string
  [key: string]: unknown
}

/** 对话携带的资料引用（继承自各轮请求）。 */
export interface ChatAttachmentRef {
  readonly requestId: string
  readonly id: string
}

/** 一条对话请求记录（旧 `chat_requests` 的一行；现在 = `dsh_turns` 的一行 + `payload`）。 */
export interface ChatRequestRecord {
  id: string
  owner: string
  conversationId: string
  requestId: string
  input: Record<string, unknown>
  /** **业务**状态（`payload.status`），不是 `dsh_turns.status` 的 `claimed`/`finished`。 */
  status: string
  createdAt: number
  operationId: string
  draftId: string | null
  sources: readonly unknown[]
  attachments: readonly ChatAttachmentRef[]
  userSeq: number | null
  [key: string]: unknown
}

/** 侧栏一项（对外只暴露这几个字段）。 */
export interface ChatListItem {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly ready: boolean
  readonly pinned: boolean
}

/** 「对话操作」的入参（改名 / 置顶 / 删除）。 */
export interface ChatMutationInput {
  readonly operation: string
  readonly ids: readonly string[]
  readonly title?: string
  readonly pinned?: boolean
}

/** 这一轮还在跑的业务状态（同一会话同时只允许一个）。 */
const ACTIVE_STATUSES: readonly BlogTurnStatus[] = ['queued', 'running', 'stopping']

/** 一页 30 条（与旧实现的 `LIMIT 31 OFFSET ?` 同一口径）。 */
const PAGE_SIZE = 30

/** 读不出来时的兜底载荷：**存在这一轮**比"状态准不准"更要紧（见 `turns-payload.ts` 的说明）。 */
const EMPTY_TURN_PAYLOAD: BlogTurnPayload = {
  status: 'queued', input: {}, operationId: '', draftId: null, sources: [], attachments: [], userSeq: null,
}

/** 端口行的形状：`detail` 多给四个列字段、`fenceOf` 多给 `titleSource`，其余是围栏六字段。 */
type ShapeInput = ConversationRecordShape & {
  readonly titleSource?: 'automatic' | 'generated' | 'manual'
  readonly pinned?: boolean
  readonly createdAt?: number
  readonly requestId?: string
}

/**
 * `owner` 字符串（`namespace:userId`，见 `store.mjs` 的 `ownerKey`）→ 端口的归属值对象。
 *
 * 端口侧一律双列 AND（`owner_namespace` + `owner_id`），所以这里必须切**第一个**冒号：
 * 用 `split(':')` 会在 userId 本身含冒号时切错，而那种错法是"别人的数据读不到"这类静默失效。
 */
function ownerOf(owner: string): OwnerKey {
  const at = typeof owner === 'string' ? owner.indexOf(':') : -1
  invariant(at > 0 && at < owner.length - 1, '会话归属无效')
  return { namespace: owner.slice(0, at), userId: owner.slice(at + 1) }
}

/**
 * blog 的会话索引与回合索引——**运行时存储端口之上的一层业务适配**。
 *
 * ## 存储已经换了：SQLite 三表 → PG（`dsh_conversations` / `dsh_turns` / `dsh_turn_results`）
 *
 * | 旧（`blog.sqlite`） | 现在 |
 * | --- | --- |
 * | `conversations` 表 | `dsh_conversations`（列：`title` / `title_source` / `ready` / `pinned` / `deleted_at` / `removal_state` / `updated_at`；业务余项进 `payload`） |
 * | `chat_requests` 表 | `dsh_turns`（`input_hash` 就是幂等判定；业务字段与**业务状态**进 `payload`） |
 * | `chat_results` 表 | `dsh_turn_results`（`turn_id` 是 **turn 的行 id**，不是幂等键） |
 * | `pirate_blog_conversations` 映射表 | **取消**：`requestId` 由运行时按 mission 派生（`missionRequestId`） |
 *
 * ⚠️ **业务状态不进 `dsh_turns.status`**：那一列是运行时的幂等状态机（恒为 `claimed` / `finished`），
 * 写进去会被 `claim` / `finish` 覆盖。blog 的 `queued` / `running` / `stopping` / `interrupted`
 * 一律住 `payload.status`，读也一律从那里读（`turns-payload.ts` 的文件头写了全套 schema）。
 *
 * ⚠️ **本地 SQLite 没有消失，但它降级了**：它现在是"会话行镜像 + 同步围栏标记 + 持久 outbox"，
 * 由运行时门面（`createAgentDatabase`）持有。本类**不再自己开库**，也不再直接写 SQL——
 * 两套写同一份数据必然漂移，而漂移的表现是"页面看到的和侧栏看到的不一样"。
 *
 * ## 同步面（`record` / `mark` / `syncTitle`）为什么仍然是同步的
 *
 * 这三个的调用方都在**同步上下文**里：kit 的移除围栏（`conversationRemover`）同步调 `record` /
 * `mark`，官方的标题事件同步调 `registerConversationTitles` 的回调。所以它们只能走**本地镜像**
 * （`ConversationPort.record` / `fenceOf` / `mark`），**不能**改成 `async`：
 *
 * ```ts
 * if (index.syncTitle(id, title, manual, complete)) this.emit(id, { type: 'changed' })
 * ```
 *
 * 改成 `async` 会让返回值变成恒真的 Promise，"标题变了才广播"**静默**退化成"总是广播"。
 * 标题的**落库**由 `titleSink`（本地 outbox + 后台 FIFO 补写 PG）承担，返回值只回答
 * "这次写入**被守卫接受**了吗"。
 *
 * ## 页面列表与 side-bar 列表的口径差
 *
 * `list`（页面 `/api` 的 `chat-list`）传 `titleOnly: true`：页面 placeholder 写的是"搜索对话标题"，
 * 而会话 id 形如 `blog-chat-<uuid>`，把 id 也算命中项会让 `-` / `chat` / 单个数字这类短查询命中
 * **全部**会话。`managed`（kit 侧栏）**不加**这个开关：侧栏没有这个口径要求，改默认值等于替它改行为。
 */
export class ChatStore {
  private readonly db: AgentDatabasePort
  private readonly pendingSource: () => readonly string[]

  /**
   * @param db 运行时存储门面（`AgentDatabasePort`）——本类只经端口读写，不碰 SQL
   * @param pendingOperations 待核对会话 id 的同步镜像读取（四耦合点之 2）
   */
  constructor(db: AgentDatabasePort, pendingOperations: () => readonly string[] = () => []) {
    this.db = db
    this.pendingSource = pendingOperations
  }

  id(value: unknown): string {
    invariant(typeof value === 'string' && /^[\w-]{8,100}$/.test(value), '请求标识无效')
    return value as string
  }

  // ---------------------------------------------------------------------
  // 同步面（kit 的围栏契约 + 标题广播判据）
  // ---------------------------------------------------------------------

  /**
   * 围栏读：**同步**，走本地镜像。
   *
   * 它回答"存在 / 归属 / `ready` / 围栏状态"，且**不做 `removal_state` 过滤**——`removed` 的行
   * 也必须返回，否则 kit 的 `alreadyRemoved` 分支永远走不到。
   */
  record(actor: Actor, id: string): ChatConversation {
    return this.shape(ownerKey(actor), this.db.conversations.record(actor, id))
  }

  /**
   * 围栏写：**同步**（标记 + outbox 同一个本地事务），PG 由后台排空补写。
   *
   * 参数收窄成端口的三态：kit 只会传这三个值，别的一律是接线错误，**当场抛**比静默写一个
   * PG 侧 `CHECK` 会拒绝的值更好（那种错法要等到排空才暴露，而排空失败只记日志）。
   */
  mark(actor: Actor, id: string, removalState: string): void {
    // `invariant` 不是断言函数（不参与类型收窄），所以显式收窄一次：运行期上面的白名单已经保证
    // 取值域，这里只是把同一条判定交给类型系统。
    invariant(removalState === 'pending' || removalState === 'failed' || removalState === 'removed',
      '移除状态无效')
    this.db.conversations.mark(actor, id, removalState as 'pending' | 'failed' | 'removed')
  }

  /**
   * 标题投影：**同步返回**"这次写入被守卫接受了吗"。
   *
   * 判定读**本地镜像**（`fenceOf`，无归属过滤——标题事件只带会话 id），与 PG 侧那条 `UPDATE`
   * 的守卫逐字对应：已发布、未删除、无围栏标记，且（当前是自动标题 **或** 本次是人工改名）。
   *
   * ⚠️ 镜像可能**滞后于 PG**（后台排空补写 PG 之后不会回头改镜像）。所以这里的分工是：
   * - **返回值**（要不要广播 `changed`）取自镜像：滞后最多让页面少刷一次或多刷一次；
   * - **落库**交给 `titleSink` 的队列，由**排空那条 SQL 自带的守卫**兜底（它才是权威）。
   *
   * 两边都判一次不是重复：镜像那一份决定"要不要广播"，PG 那一份决定"能不能写"。把落库也交给
   * 镜像判定，就会在镜像滞后时**丢掉一次本该成功的自动标题**。
   */
  syncTitle(id: string, title: string, manual = false, complete = false): boolean {
    const source: 'automatic' | 'generated' | 'manual' = manual ? 'manual' : complete ? 'generated' : 'automatic'
    // ⚠️ **先判定、后投递**。反过来也能"看起来工作"，但那是靠"投递是异步的"这个巧合：投递一旦
    // 同步落地（本地 outbox 的补写点在某些实现里就是同步的，测试夹具也是），镜像里的
    // `titleSource` 已经被这次投递改掉，再判"当前是不是 automatic"就变成问**写入之后**的状态
    // ——自动标题会被自己刚写下的值挡住。本批次实测过一次（`complete=true` 的那条断言红了）。
    const row = this.db.conversations.fenceOf(id)
    const accepted = row !== undefined && row.ready && row.deletedAt === null && row.removalState === ''
      && (row.titleSource === 'automatic' || manual)
    // 投递**总是**发生：镜像里没有这一行也照投（队列是持久的，PG 侧守卫会拒绝不该写的）。
    this.db.titleSink?.().submit(this.db.conversations.agentId, id, title, source)
    return accepted
  }

  pendingOperations(): readonly string[] {
    return this.pendingSource()
  }

  // ---------------------------------------------------------------------
  // 会话（`dsh_conversations`）
  // ---------------------------------------------------------------------

  /**
   * 预留一条会话（`ready = false`），`requestId` 参与创建幂等。
   *
   * ⚠️ **会话 id 仍由 blog 铸**（`blog-chat-<uuid>` + `assertScope` 校验）：`requestId` 是
   * **幂等身份**（同一个 mission 派两次只建一条），不是会话 id。
   */
  async create(owner: string, requestId: string, initial: Partial<ChatConversation> = {}): Promise<ChatConversation> {
    this.id(requestId)
    const key = ownerOf(owner)
    // `ready` 是**列**上的发布握手，不是业务余项 ⇒ 不进 payload；它由下面的 `publish` 承担。
    const { title, ready, ...business } = initial
    const named = typeof title === 'string' && title !== ''
    const record = await this.db.conversations.create(key, `blog-chat-${randomUUID()}`, requestId, {
      // 没有显式标题时落**默认标题**"新对话"（旧实现的默认值），但来源必须是 `automatic`：
      // 官方的首句标题要能覆盖它。只给 `title` 会让端口按"给了标题 ⇒ manual"落库，于是官方标题
      // **永远盖不上**（侧栏一直显示"新对话"）；反过来不给 title 则侧栏一开始是空标题。
      // 两个都要，所以显式给 `titleSource`（`ConversationPort.create` 的说明写了这条）。
      title: named ? title : '新对话',
      titleSource: named ? 'manual' : 'automatic',
      payload: {
        ...business,
        // ⚠️ 这两个是**不可变**字段的副本（列仍是权威），专门为**离线备份**留的：备份容器
        // **网络禁用**，只能读本地镜像的 `payload`，看不到 PG 的列（见 `backup/README.md`）。
        requestId,
        createdAt: Date.now(),
      },
    })
    // 旧实现的 `create` 把 `initial` 整行展开进那一行，所以 `{ ready: true }` 是合法入参（管家那种
    // 没有创建握手的 Agent 一步到位）。端口是两段握手 ⇒ 这里显式补一次发布。
    if (ready === true && record.ready !== true) await this.db.conversations.publish(key, record.id)
    // 统一从库里读回一次，两个理由：
    // ① 返回值里的 `ready` / `updatedAt` / `titleSource` 必须是**库里的权威值**（刚 publish 过的
    //    行，端口返回的那份快照还是旧的）；
    // ② 幂等命中一条**已删除**的行时旧实现是 404（`create` 内部走 `get`）。这条语义必须保留：
    //    否则一次重放就能"复活"一个已删除的会话。
    return this.get(owner, record.id)
  }

  /** 业务读：不存在 / 已删除 / 有围栏标记都是同一个 404（不泄露存在性）。 */
  async get(owner: string, id: string): Promise<ChatConversation> {
    const row = await this.db.conversations.detail(ownerOf(owner), id)
    // `invariant` 不是断言函数 ⇒ 收窄一次（运行期判定就是这一条）。
    invariant(row !== undefined && row.deletedAt === null && row.removalState === '',
      '对话不存在或无权访问', 404)
    return this.shape(owner, row!)
  }

  /** 会话路径的 scope 校验（`blog-chat-*` 前缀判定，索引侧只管会话；草稿路径由业务存储核验）。 */
  async assertScope(owner: string, id: string): Promise<ChatConversation> {
    invariant(typeof id === 'string' && id.startsWith('blog-chat-'), '会话标识无效')
    return this.get(owner, id)
  }

  /**
   * 按字段分派写一格会话。
   *
   * 它**不是**"整行替换"（旧 SQLite 实现是 `{...old, ...patch}` 整行写回）：三张表的列各有自己的
   * 写入口与守卫（标题有"自动不覆盖手动"、`ready` 有发布握手、围栏只能走 `mark`），
   * 一次整行写回等于绕过它们全部。
   *
   * ⚠️ `deletedAt` / `removalState` **不在这里写**：围栏状态的唯一写入口是 `mark`（同步、与
   * outbox 同一个本地事务）。从这里静默写进去会让围栏绕过 outbox——标记生效而排空链不知道，
   * 宿主归档与围栏状态随之脱节（幽灵会话）。
   */
  async save(owner: string, id: string, patch: Partial<ChatConversation>): Promise<ChatConversation> {
    const key = ownerOf(owner)
    const { title, ready, pinned, deletedAt, removalState, ...business } = patch
    // ⚠️ **先核验可见性，再校验补丁**：旧实现的 `save` 第一步就是 `get`（已删除 / 有围栏 ⇒ 404），
    // 所以一条"给已删除会话写 `deletedAt`"的调用得到的是 404 而不是 409。顺序反了会改变对外状态码
    // （而调用方按状态码分支）。
    await this.get(owner, id)
    invariant(deletedAt === undefined && removalState === undefined,
      '移除状态只能通过移除围栏修改', 409)
    // ⚠️ **顺序**：发布要在写标题之前。标题那条守卫要求 `ready = TRUE`（"未发布的会话不该有官方
    // 标题"），反过来的话 `{ ready: true, title: … }` 这一次调用会把标题吞掉——而调用方看到的是
    // 一个"保存成功"的返回值（本批次最容易犯的静默丢字段）。
    if (ready === true) await this.db.conversations.publish(key, id)
    if (typeof pinned === 'boolean') await this.db.conversations.pin(key, id, pinned)
    if (typeof title === 'string') {
      // `save` 是**自动**标题的入口（首句当标题）；人工改名走 `mutate` 的 rename。
      // `syncTitle` 自带"不覆盖手动标题"的守卫，所以这里传 `automatic` 而不是 `manual`。
      await this.db.conversations.syncTitle(key, id, title, 'automatic')
    }
    const { id: _id, owner: _owner, updatedAt: _updatedAt, requestId: _requestId, createdAt: _createdAt,
      ...payloadPatch } = business
    if (Object.keys(payloadPatch).length > 0) {
      await this.db.conversations.patchPayload(key, id, payloadPatch as ConversationPayloadShape)
    }
    return this.get(owner, id)
  }

  /**
   * 页面列表（`/api` 的 `chat-list`）。
   *
   * ⚠️ 两个**页面口径**的开关，都不是顺手加的：
   * - `includeUnready: true`：blog 的"新建对话"是**两段**（先建会话、用户打完第一条消息才发布），
   *   中间那段时间页面上必须看得见它。按侧栏口径（只列已发布）过滤的话，用户建完对话刷新一次
   *   它就"消失"了——那是**用户可见的倒退**（旧 SQLite 实现的页面列表不过滤 `ready`）。
   * - `titleOnly: true`：页面 placeholder 写的是"搜索对话标题"，会话 id 形如 `blog-chat-<uuid>`，
   *   把 id 也算命中项会让 `-` / `chat` / 单个数字这类短查询命中全部会话。
   *
   * `managed`（kit 侧栏）**两个都不传**：侧栏没有这两个口径要求，替它改等于改它的行为。
   */
  async list(owner: string, offset = 0, query = ''): Promise<{ items: readonly ChatListItem[]; nextOffset: number | null }> {
    invariant(Number.isSafeInteger(offset) && offset >= 0, '分页参数无效')
    invariant(typeof query === 'string' && query.length <= 120, '搜索文字应不超过 120 个字符')
    const page = await this.db.conversations.list(ownerOf(owner), {
      offset, limit: PAGE_SIZE, q: query.trim(), state: '', titleOnly: true, includeUnready: true,
    }, { busy: [], archived: [] })
    return {
      items: page.items.map(item => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
        // ⚠️ 用列表项上的 `ready` 列，**不要**用 `state === 'ready'`：`state` 的 `else` 分支也是
        // `'ready'`，未发布的会话会被标成已发布（页面据此显示"可以发消息"，而实际还不能）。
        ready: item.ready === true,
        pinned: item.pinned === true,
      })),
      nextOffset: page.nextOffset,
    }
  }

  /** side-bar 列表（kit 的 `ConversationProvider`）：口径由 kit 定，这里不替它加 `titleOnly`。 */
  async managed(owner: string, query: ConversationQueryShape, archived: readonly string[],
    busy: readonly string[]): Promise<{ items: ManagedConversationShape[]; total: number; nextOffset: number | null }> {
    const page = await this.db.conversations.list(ownerOf(owner), query, { busy, archived })
    // ⚠️ 复制成**可变**数组：kit 的 `ConversationProvider.list` 要求 `ManagedConversation[]`
    //（mutable），而端口形状是 `readonly`。直接把 `page` 传出去在类型上不兼容，而 kit 那一侧
    // 未来若真的就地排序/裁剪，只读数组会在运行期静默失败（赋值给变量时 TS 不做多余属性检查）。
    return { items: [...page.items], total: page.total, nextOffset: page.nextOffset }
  }

  /**
   * 「对话操作」：改名 / 置顶。
   *
   * 逐条操作的**原子性**由 PG 事务承担（旧实现是 `BEGIN IMMEDIATE`）：一条失败则全部回滚，
   * 否则"改 3 条、第 2 条 404"会留下半完成的列表。
   *
   * ⚠️ `delete` **不在这里**：它走移除围栏（`conversationRemover`，同步写标记 + outbox）。
   * 直接写 `deleted_at` 会绕过围栏与宿主归档的联动。
   */
  async mutate(owner: string, input: ChatMutationInput, assertIdle: (id: string) => void = () => {}): Promise<void> {
    invariant(input && ['rename', 'pin', 'delete'].includes(input.operation) && Array.isArray(input.ids) && input.ids.length > 0 && input.ids.length <= 100 && input.ids.every(id => typeof id === 'string') && new Set(input.ids).size === input.ids.length, '对话操作无效')
    invariant(input.operation === 'delete' || input.ids.length === 1, '请选择一条对话')
    if (input.operation === 'rename') invariant(typeof input.title === 'string' && input.title.trim() && input.title.trim().length <= 100, '标题应为 1–100 个字符')
    if (input.operation === 'pin') invariant(typeof input.pinned === 'boolean', '置顶参数无效')
    invariant(input.operation !== 'delete', '移除会话请走移除围栏', 409)
    const key = ownerOf(owner)
    const title = input.operation === 'rename' ? (input.title as string).trim() : ''
    const pinned = input.pinned === true
    await this.db.transaction(async tx => {
      for (const id of input.ids) {
        // 逐条核验归属与可见性（与旧实现逐条 `get` 同一条口径），核验失败 ⇒ 整个事务回滚。
        const row = await tx.conversations.detail(key, id)
        invariant(row !== undefined && row.deletedAt === null && row.removalState === '',
          '对话不存在或无权访问', 404)
        assertIdle(id)
        if (input.operation === 'rename') await tx.conversations.syncTitle(key, id, title, 'manual')
        else await tx.conversations.pin(key, id, pinned)
      }
    })
  }

  // ---------------------------------------------------------------------
  // 回合（`dsh_turns` / `dsh_turn_results`）
  // ---------------------------------------------------------------------

  /** 按**行 id** 读一轮；不存在 / 不属于本 owner ⇒ 404。 */
  async request(owner: string, id: string): Promise<ChatRequestRecord> {
    const row = await this.db.turns.turnById(ownerOf(owner), id)
    invariant(row !== undefined, '对话请求不存在或无权访问', 404)
    return this.requestOf(owner, row!)
  }

  /** 这个幂等键有没有落过地（空 `requestId` 恒 `false`）。 */
  async hasRequest(owner: string, requestId: string): Promise<boolean> {
    return (await this.db.turns.turnId(ownerOf(owner), requestId)) !== undefined
  }

  /**
   * 一个会话下的全部业务回合，按插入序。
   *
   * ⚠️ 过滤掉 `request_id = ''` 的**等待行**：它们承载"这一轮在等用户回什么"，不是用户发起的回合。
   * 不过滤会让页面上多出"空问题"的一轮。
   */
  async requests(owner: string, conversationId: string, includeRemoved = false): Promise<readonly ChatRequestRecord[]> {
    // 归属与可见性核验：默认要求会话可见（未删除、无围栏），`includeRemoved` 时只核验存在与归属。
    if (includeRemoved) {
      invariant(await this.db.conversations.detail(ownerOf(owner), conversationId) !== undefined,
        '会话不存在或无权访问', 404)
    } else {
      await this.get(owner, conversationId)
    }
    const rows = await this.db.turns.turnsOf(ownerOf(owner), conversationId)
    return rows.filter(row => row.requestId !== '').map(row => this.requestOf(owner, row))
  }

  /**
   * 受理一轮：**先查幂等、再查并发、最后认领**。
   *
   * 这个顺序不能换：先 `claim` 再查"同一会话是否已有在跑的轮次"，在检查失败（409）时已经建下了
   * 那一行；下次同一个 `requestId` 重试会拿到 `'duplicate'` ⇒ 被当成"已交付"⇒ **静默丢活**。
   */
  async start(owner: string, conversationId: string, requestId: string,
    input: Record<string, unknown>): Promise<{ request: ChatRequestRecord; fresh: boolean }> {
    this.id(requestId)
    const key = ownerOf(owner)
    await this.get(owner, conversationId)
    const hash = digest({ conversationId, ...input })
    const existing = await this.db.turns.turnId(key, requestId)
    if (existing !== undefined) {
      const row = await this.db.turns.turnById(key, existing)
      invariant(row !== undefined, '对话请求不存在或无权访问', 404)
      // 幂等键相同但正文变了 ⇒ 409。`claim` 只回答"认领成功 / 重复"，比正文是**业务**判定。
      invariant(row!.inputHash === hash, '相同请求标识不能更改问题或附件', 409)
      return { request: this.requestOf(owner, row!), fresh: false }
    }
    const running = (await this.requests(owner, conversationId))
      .some(row => ACTIVE_STATUSES.includes(row.status as BlogTurnStatus))
    invariant(!running, '此对话正在另一页面回答，请等待或停止当前任务', 409)
    const payload: BlogTurnPayload = {
      status: 'queued',
      input,
      operationId: (input.operationId as string | undefined) ?? randomUUID(),
      draftId: null,
      sources: [],
      attachments: [],
      userSeq: null,
    }
    await this.db.turns.claim(key, conversationId, requestId, hash, encodeTurnPayload(payload))
    return { request: this.requestOf(owner, await this.turnOf(key, requestId)), fresh: true }
  }

  /**
   * 合并写一轮的业务载荷（`payload`，**浅**合并）。
   *
   * ⚠️ 与旧签名相比多了 `owner`：`patchTurnPayload` 的 owner 条件是**授权判据**，不能省。
   * 调用方本来就拿着 `request.owner`。
   */
  async updateRequest(owner: string, id: string, patch: Record<string, unknown>): Promise<ChatRequestRecord> {
    const key = ownerOf(owner)
    const before = await this.db.turns.turnById(key, id)
    invariant(before !== undefined, '对话请求不存在', 404)
    const { id: _id, requestId: _requestId, conversationId: _conversationId, inputHash: _inputHash,
      createdAt: _createdAt, ...payloadPatch } = patch
    let merged = before!.payload
    if (Object.keys(payloadPatch).length > 0) {
      merged = await this.db.turns.patchTurnPayload(key, id, payloadPatch as ConversationPayloadShape)
    }
    return this.requestOf(owner, { ...before!, payload: merged })
  }

  /**
   * 这个 `operationId` 已经绑到哪份草稿（没有 ⇒ `null`）。
   *
   * **跨会话查**（`turnsByOperationId`）：同一轮操作会跨会话延续——从某一轮创建分支、在分支里
   * 继续时 `operationId` 被继承（`chat.ts` 的 `send` 在 `retryFrom` 路径上也这么传）。
   * 只在当前会话里找会漏掉那个绑定，结果是**新建第二份草稿**（用户看到重复），而代码一路"成功"。
   *
   * 取**最新**一轮的绑定（端口的插入序降序；旧实现是 `ORDER BY rowid DESC` 后取第一条匹配）。
   */
  async operationDraft(owner: string, operationId: string): Promise<string | null> {
    const rows = await this.db.turns.turnsByOperationId(ownerOf(owner), operationId)
    for (const row of rows) {
      const decoded = decodeTurnPayload(row.payload)
      if (decoded !== undefined && decoded.draftId !== null && decoded.draftId !== '') return decoded.draftId
    }
    return null
  }

  /** 落一条结果（`dsh_turn_results`）：一轮里交回的一条结构化产出。 */
  async result(owner: string, request: ChatRequestRecord, kind: string,
    draft: { id: string, revision: unknown, title: string, proposal?: unknown }
  ): Promise<Record<string, unknown> & { id: string }> {
    const value = {
      kind,
      draftId: draft.id,
      revision: draft.revision,
      title: draft.title,
      ...(draft.proposal === undefined ? {} : { proposal: structuredClone(draft.proposal) }),
      createdAt: Date.now(),
    }
    const id = await this.db.turns.appendTurnResult(ownerOf(owner), {
      conversationId: request.conversationId,
      // ⚠️ `turn_id` 装的是 **turn 的行 id**（不是幂等键）。装错了两者，结果层会静默查不到。
      turnId: request.id,
      operationId: request.operationId,
      payload: value as Record<string, unknown>,
    })
    return { id, ...value }
  }

  /**
   * 一个会话下**所有轮次**的结果（跨轮读取：J7「这个会话还有没有未采用的候选稿」）。
   *
   * 走端口的 `turnResultsOf`（一条查询按会话过滤），**不是**"先查轮次再逐轮查"——后者是 N+1 次
   * PG 往返，而这条路径在每个 history 请求上都会走。
   */
  async results(owner: string, conversationId: string): Promise<readonly (Record<string, unknown> & { requestId: string })[]> {
    invariant(await this.db.conversations.detail(ownerOf(owner), conversationId) !== undefined,
      '会话不存在或无权访问', 404)
    const rows = await this.db.turns.turnResultsOf(ownerOf(owner), conversationId)
    return rows.map(record => ({
      ...(decodeTurnResultPayload(record.payload) ?? {}),
      // `requestId` 是**轮次的行 id**（`dsh_turn_results.turn_id`）：业务用它回到"哪一轮产出的"。
      requestId: record.turnId,
    }))
  }

  /** 历史消息引用的资料（继承判定：本轮请求的附件 + 会话继承清单）。 */
  async historyAttachment(owner: string, conversationId: string, requestId: string, attachmentId: string): Promise<unknown> {
    const conversation = await this.get(owner, conversationId)
    const request = await this.request(owner, requestId)
    const inherited = conversation.attachments?.find(a => a.requestId === requestId && a.id === attachmentId)
    invariant(request.conversationId === conversationId || inherited, '资料不属于当前对话', 404)
    const attachment = request.attachments.find(a => a.id === attachmentId)
    invariant(attachment, '此消息没有这份资料', 404)
    return structuredClone(attachment)
  }

  // ---------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------

  /** 幂等键 → 行 id → 整行（`claim` 不返回行 id，见 `TurnStorePort` 的说明）。 */
  private async turnOf(key: OwnerKey, requestId: string): Promise<TurnRecord> {
    const id = await this.db.turns.turnId(key, requestId)
    invariant(id !== undefined, '对话请求不存在或无权访问', 404)
    const row = await this.db.turns.turnById(key, id!)
    invariant(row !== undefined, '对话请求不存在或无权访问', 404)
    return row!
  }

  /**
   * `dsh_turns` 的一行 → 业务形状的回合记录。
   *
   * **业务状态取自 `payload.status`**，不是列上的 `status`：后者是运行时的幂等状态机
   * （`claimed` / `finished`），读错了会让页面上"排队中"显示成别的状态。
   */
  private requestOf(owner: string, row: TurnRecord, payloadOverride?: ConversationPayloadShape): ChatRequestRecord {
    const decoded = decodeTurnPayload(payloadOverride ?? row.payload) ?? EMPTY_TURN_PAYLOAD
    // ⚠️ 载荷里**除已知字段以外**的键必须原样带回去（`...rest`）：`updateRequest` 的 patch 形状是
    // 开放的，业务往上面写了别的键（`userMessageId` / `proposalId`…）。只挑固定字段会让那些键
    // 在**读回时静默消失**——而写侧一切"成功"（实测：`userMessageId` 因此丢了，表现为页面的
    // user 气泡退回会话事件里的文本、分支会话的继承清单变空）。
    const { input, status, operationId, draftId, sources, attachments, userSeq, ...rest } = decoded
    return {
      ...rest,
      id: row.id,
      owner,
      conversationId: row.conversationId,
      requestId: row.requestId,
      input,
      status,
      createdAt: row.createdAt,
      operationId,
      draftId,
      sources,
      attachments,
      userSeq,
    }
  }

  /**
   * 端口的一行 → `ChatConversation`。
   *
   * 顺序是刻意的：**先展开 `payload` 里的业务余项，再用列字段覆盖同名键**。反过来（列字段在前）
   * 会让 `payload` 里一个同名的旧值盖掉列上的权威值，而那种错法只在"业务余项里恰好有同名字段"
   * 时出现——最难查的一类。
   */
  private shape(owner: string, row: ShapeInput): ChatConversation {
    const payload = row.payload ?? {}
    const { requestId: payloadRequestId, createdAt: payloadCreatedAt, ...business } = payload
    return {
      ...business,
      id: row.id,
      owner,
      // `requestId` / `createdAt` 列上都有；只有本地镜像那条路径（`record`）拿不到列，
      // 那时退到 `payload` 里的**不可变副本**（离线备份读的就是它）。
      requestId: row.requestId ?? (typeof payloadRequestId === 'string' ? payloadRequestId : ''),
      createdAt: row.createdAt ?? (typeof payloadCreatedAt === 'number' ? payloadCreatedAt : row.updatedAt),
      title: row.title,
      titleSource: row.titleSource ?? 'automatic',
      ready: row.ready,
      pinned: row.pinned ?? false,
      deletedAt: row.deletedAt,
      updatedAt: row.updatedAt,
      parent: (business.parent as string | null | undefined) ?? null,
      attachments: (business.attachments as readonly ChatAttachmentRef[] | undefined) ?? [],
      removalState: row.removalState,
    }
  }
}
