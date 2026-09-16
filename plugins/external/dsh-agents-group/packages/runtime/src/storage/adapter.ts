/**
 * 会话契约适配器：**全仓唯一** `import` kit 会话契约的地方。
 *
 * ## 这条边界为什么必须存在
 *
 * 框架（`plugin-kit`）**预期对外开放**：外部作者会照抄 `dsh-example` 与 `dsh-auth`，所以
 * 框架的公开契约不该为私有需求改动，私有代码也不该散落着对它的引用。做法是把两侧压到一个
 * 文件里：
 *
 * - 私有侧：`ConversationPort`（`storage/ports.ts`，自有形状）；
 * - 框架侧：`ConversationProvider` / `ConversationRemovalStore` / `conversationRemover`；
 * - 本文件负责把前者交给后者。
 *
 * 好处是**框架改契约时只需要跟这一个文件**：`conversationRemover` 换签名、`ConversationQuery`
 * 加字段、`ConversationRecord` 改名，改动都停在这里，业务与运行时零改动。
 *
 * ## 三个同步面在这里的落点
 *
 * `conversationRemover` 会**同步**调用 `store.record`（`:130/:139/:141/:149`）与
 * `store.mark`（`:141/:149`），并**同步**问 `busy(id)`（`:134/:140`）。三者全部直接转给
 * `ConversationPort` 的同步实现（本地 SQLite + 进程内镜像）——**不能在这里包一层 async**：
 * `busy` 一旦返回 `Promise` 就恒真，移除会永远报 409，而那个失败看起来像"会话正忙"。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  AccessError,
  conversationArchive,
  conversationRemover,
  hostBusyConversationIds,
  previewPage,
  readConversationEvents,
  type Access,
  type Actor,
  type ConversationProvider,
  type PreviewMessage,
} from '@dsh-plugin-manager/plugin-kit'
import type { ConversationPageShape, ConversationPort, ConversationQueryShape } from './ports.ts'

/** 预览消息：业务的展示口径（缺省实现由调用方给，通常是 `previewMessages`）。 */
export interface AdapterPreviewMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly reasoning?: string
  readonly time: number
}

export interface ConversationAdapterInput {
  readonly ctx: Context
  readonly port: ConversationPort
  readonly access: Access
  /** **同步**的忙判定（本实例正在跑 + 宿主侧正在跑）。 */
  readonly busy: (conversationId: string) => boolean
  /**
   * 列表查询的委托目标。
   *
   * ⚠️ 装配时传 `ConversationLifecycle.list`——它负责把**本实例**的忙集合并进去（走
   * `busyIds()`，与 `isBusy` 同源）。本适配器只补**宿主侧**那两个集合：它们来自 kit
   * （`hostBusyConversationIds` / `conversationArchive`），而 kit 的会话契约只该在这里碰。
   *
   * **为什么不让 adapter 自己合并**：那样"哪些会话在跑"就有两份算法（一份在生命周期、
   * 一份在这里），而它们会漂移——围栏看一套集合、侧栏显示另一套，页面上只表现为
   * "这条怎么删不掉"，查起来要跨两个文件。
   */
  readonly list: (actor: Actor, query: ConversationQueryShape, scope: {
    readonly hostBusy: readonly string[]
    readonly archived: readonly string[]
  }) => Promise<ConversationPageShape>
  /** 移除时释放本插件持有的会话句柄（删了就不该继续占着）。 */
  readonly release: (conversationId: string) => Promise<void>
  /** 插件是否正在停止（停止中拒绝新的移除）。 */
  readonly stopping: () => boolean
  /** 会话事件 → 预览消息（业务的展示口径）。 */
  readonly projectHistory: (events: readonly SessionEvent[]) => readonly AdapterPreviewMessage[]
}

/**
 * 把私有侧端口包成 kit 的 `ConversationProvider`。
 *
 * `list` 走 PG（异步），`preview` 读宿主日志（异步），`remove` 走 `conversationRemover`
 * （**内部同步读写围栏**）——三条路径都复用同一道围栏，所以从侧栏删掉的会话与从业务页面
 * 删掉的行为一致。
 */
export function createConversationProvider(input: ConversationAdapterInput): ConversationProvider {
  const { ctx, port, access } = input
  return {
    protocol: 1,
    pluginId: port.agentId,
    list: async (actor, query) => {
      access.assert(actor)
      const page = await input.list(actor, {
        offset: query.offset,
        limit: query.limit,
        q: query.q,
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        state: query.state,
      }, {
        // 宿主侧正在跑的会话也要算忙：它可能不属于本插件，但移除围栏必须看见它。
        hostBusy: hostBusyConversationIds(ctx),
        archived: conversationArchive(ctx).archivedSessionIds,
      })
      // 私有端口的 `items` 是只读数组，kit 的 `ConversationPage` 要可变的：展开复制一次。
      return { items: [...page.items], total: page.total, nextOffset: page.nextOffset }
    },
    preview: async (actor, id, before) => {
      access.assert(actor)
      if (port.record(actor, id).removalState === 'removed') throw new AccessError(404, '会话已移除')
      const events = await readConversationEvents(ctx, id) as readonly SessionEvent[]
      // 读事件是异步的：读完之后归属与围栏都可能变，返回内容前必须重核一次。
      access.assert(actor)
      if (port.record(actor, id).removalState === 'removed') throw new AccessError(404, '会话已移除')
      const messages = input.projectHistory(events).flatMap<PreviewMessage>(message => message.role === 'user'
        ? [{ role: 'user' as const, text: message.text, time: message.time }]
        : [{
          role: 'assistant' as const,
          text: message.text,
          ...(message.reasoning === undefined ? {} : { reasoning: message.reasoning }),
          time: message.time,
        }])
      return previewPage(messages, before)
    },
    remove: conversationRemover(ctx, {
      assert: actor => {
        access.assert(actor)
        if (input.stopping()) throw new AccessError(503, '插件正在停止')
      },
      store: {
        // 同步读：返回值参与 kit 的 alreadyRemoved 分支，还要回答存在性 / 归属 / ready。
        record: (actor, id) => port.record(actor, id),
        // 同步写：本地标记与 outbox 由存储层在同一个本地事务里完成。
        mark: (actor, id, state) => { port.mark(actor, id, state) },
      },
      busy: id => input.busy(id),
      release: id => input.release(id),
    }),
  }
}
