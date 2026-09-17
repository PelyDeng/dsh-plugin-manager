/**
 * 封闭化助手的**运行时装配**：把"DSN 从哪来 → 建存储 → 装配运行时"收在一处。
 *
 * ## 为什么单独一个文件，而不是塞回 `index.ts`
 *
 * `index.ts` 的 `mount()` 只该做两件事：读业务资源（persona / 环境凭据 / 清单）、把装配
 * 结果接到群组的注册口上。而"存储未就绪时怎么办"这一段有它自己的语义（Q4 口径、就绪探针），
 * 摊在 `mount()` 里会把它淹掉。
 *
 * ## Q4 口径：缺 PG 配置 = **本 Agent 未就绪**，不是装载失败
 *
 * 设计 §3.2 要求三个私有 Agent 统一用 PG 的 `dsh_conversations`，所以 closedoff 从此
 * **依赖 PG**。缺配置时：
 *
 * - **插件照常装载**：页面、目录条目、探针都还在，运维能一眼看出"谁没起来、为什么"；
 *   抛给群组只会让整个子包凭空消失（那是 `butler-console` 的口径，它没有群组兜底）。
 * - **未就绪**：`ready()` 返回 `{ok:false}` 并**说明配置方法**（`AGENTS_GROUP_PG_DSN`
 *   或 `AGENTS_GROUP_PG_CONFIG`），群组的 `/agents/<id>/ready` 据此 503。
 * - **绝不回退 SQLite**：静默降级到另一个后端会让"以为在用 PG、其实在写本地文件"这种
 *   问题在运行很久之后才暴露，而那时数据已经分叉。
 *
 * ## 旧 SQLite 存量：**不再读写**
 *
 * 迁移前 closedoff 用 `dshHomePath('plugins','closedoff','conversations.sqlite')` 自己
 * 维护一份归属索引（v2/v3/v4 schema）。设计 §6.1 的决策是**存量直接删除**（实测 22 行 /
 * 16 KB、单 namespace、无保留价值），所以：
 *
 * - 本模块**不打开**那个文件，也不迁移它的内容；
 * - 运行时的本地库是另一个文件（`mirror.sqlite`，见 {@link closedoffLocalMirrorPath}），
 *   它装的是**围栏镜像 + 持久 outbox**，不是归属索引；
 * - 文件名刻意不叫 `conversations.sqlite`：那个名字在部署机上已经被旧索引占着。同名不只是
 *   含混——`LocalFenceStore` 对一个真·旧索引文件的回答是"结构版本不认识 ⇒ 拒绝启动"，
 *   于是"新机制误读了旧文件"会表现成插件起不来。
 */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Access, ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type { RuntimeConfig } from '../../../packages/runtime/src/conversation.ts'
import type { AgentDefinition } from '../../../packages/runtime/src/definition.ts'
import { createAgentRuntime, type AgentRuntimeAssembly } from '../../../packages/runtime/src/runtime.ts'
import { resolveStorageDsn } from '../../../packages/runtime/src/storage/dsn.ts'
import { StorageError } from '../../../packages/runtime/src/storage/errors.ts'

/** 这个 Agent 的 id；与 `AgentDefinition.id`、`dsh_conversations.agent_id` 是同一份取值。 */
const AGENT_ID = 'closedoff'

/**
 * 群组级 PG 配置文件的缺省路径。
 *
 * 与 blog 用**同一个**默认文件：三个私有 Agent 统一用 PG 的 `dsh_conversations`，配置来源
 * 也应该只有一处，否则运维要为每个 Agent 各写一份 `{"dsn":…}`。
 *
 * 文件名与全项目一致用 `env.conf`（DSH 的配置约定），内容写 `AGENTS_GROUP_PG_DSN=postgresql://…`
 * 一行；旧的 JSON 写法仍被读取（见 `resolveStorageDsn` 的格式说明），改名不会让既有部署失效。
 */
const storageConfigPath = (): string => dshHomePath('plugins', 'agents-group', 'env.conf')

/**
 * 运行时的**本地围栏库**路径。
 *
 * 它不是"另一个数据库后端"：权威数据在 PG，本地只放同步面（`record` / `mark` 读写的会话行
 * 镜像）与持久 outbox。可以删掉重建——`LocalFenceStore` 的版本检查比 PG 宽松，正是这个原因。
 */
export const closedoffLocalMirrorPath = (): string => dshHomePath('plugins', AGENT_ID, 'mirror.sqlite')

/**
 * 缺配置时给运维看的那句话。
 *
 * 必须同时说清"缺什么"与"怎么配"：只说"未配置"会让接手的人不知道去配哪个变量，而这条
 * 消息是探针与装载日志里唯一的线索。
 */
export const unconfiguredStorageHint
  = '封闭化助手业务存储未配置。设置环境变量 AGENTS_GROUP_PG_DSN，或在私有配置文件'
  + '（环境变量 AGENTS_GROUP_PG_CONFIG 指定路径，缺省 <DSH 主目录>/plugins/agents-group/env.conf）'
  + '里写一行 AGENTS_GROUP_PG_DSN=postgresql://…（旧的 {"dsn":"…"} 写法仍被接受）。不会回退 SQLite。'

/** 装配一个已就绪的 closedoff 运行时需要的东西。 */
export interface ClosedoffRuntimeInput {
  /** 群组注入的业务作用域；`definition.tools` 会拿它注册工具。 */
  readonly ctx: Context
  readonly definition: AgentDefinition
  readonly access: Access
  readonly config: RuntimeConfig
  /** 本 Agent 能用的工具名（本分类 + 通用集），由群组注入、在 agent 作用域内应用。 */
  readonly allowedTools: () => readonly string[]
}

/** 装配结果。 */
export interface ClosedoffRuntimeAssembly {
  /** 未就绪时是 `undefined`——调用方必须显式处理这种状态，不要用假对象糊过去。 */
  readonly assembly: AgentRuntimeAssembly | undefined
  /**
   * 本次装配注册的工具目录条目。
   *
   * **未就绪时也不是空数组**：工具是在这个 ctx 上注册的（插件级、一次），而"能不能用到 PG"
   * 是运行期的事。缺配置就不注册会让群组算出空的 `allowedTools`，于是模型手里一个业务工具
   * 都没有，而且**不报错**——正是本仓反复出现的那类静默失效。
   */
  readonly tools: readonly ToolDescriptor[]
  /**
   * 就绪探针。未就绪的两种原因**分开报**：`未配置` 与 `storage_unreachable` 是两件事，
   * 混成一句"存储不可用"会让运维无法区分"没配"和"配错了"。
   */
  ready(): Promise<{ readonly ok: boolean; readonly error?: string }>
  dispose(): Promise<void>
}

/** 造一条"存储不可用"的就绪答复；文案由调用方给，这里只管形状。 */
function unavailable(reason: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error: reason }
}

/**
 * 装配 closedoff 的运行时。
 *
 * 这个函数**不抛**存储类错误：文档里"未就绪 ≠ 不装载"是硬要求，而一旦往外抛，群组会把整个
 * 子包标成装载失败——页面与探针一起消失，运维反而看不到原因。文件在但内容不合法（不是 JSON、
 * 缺 `dsn`）是**例外**：那是配置错误，由 `resolveStorageDsn` 如实抛出。
 */
export async function installClosedoffRuntime(input: ClosedoffRuntimeInput): Promise<ClosedoffRuntimeAssembly> {
  const { ctx, definition, access, config, allowedTools } = input
  const source = await resolveStorageDsn(process.env, storageConfigPath(), path => readFile(path, 'utf8'))
  const unconfigured = source === undefined ? unavailable(unconfiguredStorageHint) : undefined

  let assembly: AgentRuntimeAssembly | undefined
  /** 本次装配注册的工具目录条目（未就绪路径也必须有，见字段说明）。 */
  let tools: readonly ToolDescriptor[] = []

  if (source === undefined) {
    // 没有存储 ⇒ 工厂不会走到它内部的 `definition.tools` 调用点，所以这里显式调一次。
    // 未就绪的**两条**路径（缺配置 / 配了但不可达）各调一次，加上工厂内部那一次，装配期一共
    // 三个调用点；它们互斥（每次装配只可能走其中一条），所以"注册一次"这件事仍然成立。
    console.warn(`agents-group/closedoff: ${unconfiguredStorageHint}`)
    tools = definition.tools({ ctx, storage: undefined, conversationId: undefined })
  } else {
    try {
      const created = await createAgentRuntime({
        ctx,
        definition,
        access,
        config,
        allowedTools,
        database: { dsn: source.dsn, localPath: closedoffLocalMirrorPath() },
      })
      assembly = created
      tools = created.tools
      // 标题投递口**不在这里接**：`createAgentRuntime` 装配期已经把它接上了，而且槽位里装的是
      // 一份按 `agentId` 路由的分发器（见 `packages/runtime/src/runtime.ts` 的 `titleRouter`）——
      // 那是"一个进程多个 Agent"的正确形状。这里再装一次只会把分发器顶掉，先装配的 Agent
      // 又变回被静默丢弃标题。装配顺序（工厂先、本行后）也保证了投递口在任何会话事件之前就位。
    } catch (error: unknown) {
      // 配了但连不上/结构不对：同样是"本 Agent 未就绪"，装载继续（页面与探针照常在线）。
      //
      // ⚠️ 这里**不**尝试关掉失败路径上的存储句柄：`createAgentRuntime` 是"要么返回完整装配、
      // 要么抛出"的语义，抛出的那一刻已经不再交出门面，所以工厂外拿不到那个句柄。本地 SQLite
      // 的文件句柄会随进程退出释放，PG 池的 socket 也一样；而按"未就绪即不服务"的口径，这个
      // 进程本来就要带着这条错误去修配置（真正的兜底是重启，不是局部回收）。
      //
      // ⚠️ **这条分支也必须登记工具目录**（与"缺配置"那条一样）。异步工厂内部的
      // `definition.tools` 只在存储建好之后才被走到，所以不可达路径上不同样登记一次，
      // `tools` 就是空数组 ⇒ 群组算出空的 `allowedTools` ⇒ 模型手里一个业务工具都没有，
      // **而且不报错**（限制一份空集合是合法的）。这与"缺配置"那条是同一个失效形态，只是
      // 触发条件更难碰到：线上 PG 抖一下就会静默降级成"没有工具"。
      console.error('agents-group/closedoff: 业务存储未就绪', error)
      tools = definition.tools({ ctx, storage: undefined, conversationId: undefined })
    }
  }

  let disposing: Promise<void> | undefined
  return {
    assembly,
    tools,
    /** 未就绪时说明原因；就绪时再探一次 PG（已配置但运行中不可达 = 已装载未就绪）。 */
    async ready() {
      if (unconfigured !== undefined) return unconfigured
      if (assembly === undefined) {
        return unavailable(`封闭化助手业务存储未就绪（storage_unreachable）：启动时未能连上 PG，详见装载日志。${unconfiguredStorageHint}`)
      }
      try {
        // `assertSchema()` 是只读核验（不建表），也是**真实往返**：连接断了会在这里抛。
        await assembly.db.assertSchema()
        return { ok: true }
      } catch (error: unknown) {
        const code = error instanceof StorageError ? error.code : 'storage_unknown'
        return unavailable(`封闭化助手业务存储不可用（${code}）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    dispose: () => {
      disposing ??= (async () => {
        // 标题投递口由运行时在释放链里摘除（只摘自己那一份），本文件不碰它。
        await assembly?.dispose()
      })()
      return disposing
    },
  }
}
