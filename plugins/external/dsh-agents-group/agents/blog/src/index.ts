import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage,ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-attachment'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { agentResource } from '@dsh-agents-group/common'
import { registerPlugin,registerConversations,AccessError,isAccessError,type Access,type ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'
import type { ProtectedRoute } from '@dsh-plugin-manager/plugin-kit/http'
import { loadSettings, invariant } from './settings.ts'
import { BlogApplication, PendingOperationsMirror } from './application.ts'
import { BlogClient,ImageClient,BackupClient } from './connectors.ts'
import type { BlogBridgeConfig, ImageBridgeConfig, BackupBridgeConfig } from './connectors.ts'
import { BlogJobs } from './jobs.ts'
import { BlogAttachments, MAX_ATTACHMENT_BYTES } from './attachments.ts'
import { ChatStore } from './chat-store.ts'
import { BlogChat, chatInstructions } from './chat.ts'
// ⚠️ `createBlogParticipant`（`./participant.ts`）已**删除**：协作入口换成运行时的
// `createAgentRuntime(...).participant`。文件头的历史说明见进度文档 §43 与本节注释。
import { createBlogDefinition } from './definition.ts'
import type { AgentParticipant } from '../../../packages/common/src/participant.ts'
import {selectBlogModel} from './models.ts'
import type {BlogModelChoices} from './models.ts'
import {reasoningLanguage} from './jobs.ts'
import {ReasoningTranslations,reasoningOriginal} from './reasoning-translation.ts'
// DSN 来源解析用**运行时那一份**：blog 本地那份 `storage/dsn`（P4 期间由 `storage/dsn.mjs` 迁入运行时，
// **本地副本已删**）的文件头曾自述"复制管家 butler-console 的 dsn.ts 模式"。两处各留一份
// 的代价是**语义会漂移**，而这一段的判据恰恰是最容易漂的地方：缺文件算"没配置"（不是错误）、
// 非法 JSON 要如实抛、**绝不静默回退 SQLite**。副本已删。
import { resolveStorageDsn } from '../../../packages/runtime/src/storage/dsn.ts'
// 会话 / 轮次 / 结果三张表走运行时端口：门面把「本地同步围栏面」与「PG 异步面」组合起来，
// 启动顺序（排空 outbox → PG 清理 → 按 PG 收敛镜像）也在它里面，blog 只调 `open()`。
import { createAgentDatabase } from '../../../packages/runtime/src/storage/index.ts'
import type { AgentDatabasePort } from '../../../packages/runtime/src/storage/ports.ts'
import { StorageError, isStorageError } from './storage/errors.ts'
import { BlogPgStorage } from './storage/pg.ts'
// 协作入口与全局会话生命周期（P7 ③-B 的落点）：blog 只声明业务，机制全在运行时。
import { createAgentRuntime, type AgentRuntimeAssembly } from '../../../packages/runtime/src/runtime.ts'
import type { RuntimeConfig } from '../../../packages/runtime/src/conversation.ts'
import type { AgentDefinition } from '../../../packages/runtime/src/definition.ts'
import { PARTICIPANT_PROTOCOL } from '../../../packages/runtime/src/contract.ts'
import type { Config } from './config.ts'
export { Config } from './config.ts'
/** 同 closedoff 的约定：适配层需要类型名 `PluginConfig`。 */
export type { Config as PluginConfig } from './config.ts'
export const name='blog'

/** 存储层故障到 HTTP 的映射（对齐管家 butler-console 的 §3 错误分类层）。 */
const STORAGE_STATUS: Record<string,{status:number,message?:string}> = {
  storage_unreachable: { status: 503 },
  storage_auth: { status: 503 },
  storage_schema_missing: { status: 503 },
  storage_schema_version: { status: 503 },
  storage_unconfigured: { status: 503 },
  storage_timeout: { status: 503 },
  storage_closed: { status: 503 },
  storage_transaction: { status: 503 },
  storage_constraint: { status: 409 },
  storage_unknown: { status: 500, message: '服务处理请求失败' },
}

/**
 * blog 路由的 HTTP 错误渲染（群组经 `onError` 注入 createPluginHttp）。
 *
 * 存储层故障按稳定码归类：可用性类 503、约束冲突 409、未知 500，稳定码进响应体；
 * 其余错误保持 kit 默认渲染（AccessError 原状态、未知 500），对外契约不变。
 *
 * ⚠️ **存储故障用结构识别（`isStorageError`），不是 `instanceof`**：本边界要处理的错误
 * **来自两侧** —— 未配置占位抛的是 `./storage/errors.ts` 那一份类，而配好之后索引侧的故障
 * 全部由 **运行时那一份**（`packages/runtime/src/storage/errors.ts`）抛出。`instanceof` 认不出
 * 对方 ⇒ 本该 **503 + 稳定码** 的故障掉进"未知错误"分支变成 **500「请求处理失败」**，
 * 而 runbook 第 5 步恰恰要求运维"任一 503 都要看它的稳定码"（`storage_schema_missing` /
 * `storage_schema_version` / `storage_unreachable`）—— 降级成 500 等于把那条诊断路径**整条抹掉**。
 */
export function blogStorageErrorHandler(response: ServerResponse, error: unknown): void {
  const storage = isStorageError(error)
  const known = isAccessError(error)
  if (!storage && !known) {
    console.error('agents-group/blog: 请求处理失败', error)
    response.writeHead(500, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
    response.end(JSON.stringify({error:'请求处理失败'}))
    return
  }
  if (!storage) {
    response.writeHead((error as {status:number}).status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
    response.end(JSON.stringify({error:(error as Error).message}))
    return
  }
  const code = (error as {code:string}).code
  const mapped = STORAGE_STATUS[code] ?? STORAGE_STATUS.storage_unknown!
  if (mapped.status >= 500) console.error('agents-group/blog: 存储请求失败', error)
  response.writeHead(mapped.status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
  response.end(JSON.stringify({error:mapped.message ?? (error as Error).message,code}))
}

/** 未配置连接时占位的业务存储：任何读写都以 `storage_unconfigured` 拒绝（blog 未就绪，Q4）。 */
function unconfiguredBusinessStorage(hint: string): BlogPgStorage {
  const reject = () => { throw new StorageError('storage_unconfigured', `博客业务存储未就绪：${hint}`) }
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined // 不当 thenable 被 await 意外消费
      return reject
    },
  }) as unknown as BlogPgStorage
}

/**
 * 未配置连接时占位的**索引端口**（`dsh_conversations` / `dsh_turns` / `dsh_turn_results`）。
 *
 * 与 `unconfiguredBusinessStorage` 同一套口径，但多一层：索引面是"门面 → conversations / turns"
 * 两层结构，所以两层都要拒绝，否则 `index.conversations.list(...)` 会先拿到 `undefined` 再炸在
 * 别处（错误码就丢了，页面拿到的是 500 而不是 503 + 稳定码）。
 *
 * ⚠️ **同步面**（`record` / `mark` / `fenceOf`）在这里抛的也必须是 `StorageError`：它们由 kit 的
 * 移除围栏在**同步**上下文里调用，抛出别的类型就是一次未归类的 500。`titleSink` 返回 `undefined`
 * （标题投递口是可选成员，未就绪时没有队列——投递被静默丢弃好过把它塞进一个假队列）。
 */
function unconfiguredIndex(): AgentDatabasePort {
  const reject = () => {
    throw new StorageError('storage_unconfigured',
      '博客索引存储未就绪：需要在私有配置里提供 PostgreSQL 连接（环境变量 AGENTS_GROUP_PG_DSN 或 storage.json）；不会回退 SQLite。')
  }
  const nested = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === 'agentId') return 'blog'
      return reject
    },
  })
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === 'conversations' || property === 'turns') return nested
      if (property === 'titleSink') return undefined
      if (property === 'close') return async () => {}
      return reject
    },
  }) as unknown as AgentDatabasePort
}

/**
 * 业务配置 → 运行时的 `RuntimeConfig`。
 *
 * ⚠️ **只取运行时真正用到的五个字段**，其余业务字段（`dataPath` / `runtimeConfig` / `publicOrigin` …）
 * 一概不进：把用不到的字段塞进去只会让"运行时到底依赖什么"变得看不清。
 *
 * ⚠️ blog 的 `Config` 里**没有**后三个字段，所以取值要**对齐它既有的行为**、不能拍脑袋：
 * - `authRecheckMs: 1000` —— `chat.ts` 的授权重核定时器本来就是 `setInterval(recheck, 1000)`；
 * - `maxActiveConversations: 4` —— `chat.ts` 的并发上限本来就是 `active.size < 4`（超出 429）；
 * - `reasoningEffort: ''` —— 运行时的用法是"这个值不被宿主认出来就回落到**按会话选择**的结果"
 *   （`conversation.ts` 的 `wanted` / `efforts.some(...)` 那两行）。blog **正是**按会话选模型
 *   （`selectBlogModel` / `selectConversationModel`），所以给空串＝**不要**在这里插一脚，
 *   与它改造前的行为一致。给一个真值会让所有会话被钉死在同一个 effort 上。
 */
function runtimeConfigOf(config: Config): RuntimeConfig {
  return {
    routePrefix: config.routePrefix,
    turnTimeoutMs: config.turnTimeoutMs,
    authRecheckMs: 1000,
    maxActiveConversations: 4,
    reasoningEffort: '',
  }
}

/**
 * 未就绪（缺 PG 配置）时的协作入口占位。
 *
 * 它**不伪造能力**：`assertAccess` 与 `run` 一律以 503 + 稳定原因拒绝，协作侧拿到的是
 * "这个成员现在不能用、因为存储没起来"，而不是"这个成员不存在"，也不是一句空结果。
 * 身份三项与 `createBlogDefinition` **逐字相同**——改名会让协调方与用户看到两个不同的成员。
 *
 * ⚠️ 这一支**不建运行时**（与 closedoff 同一个范式）：`createAgentRuntime` 的存储是硬输入，
 * 拿一个"什么都抛"的代理对象去赌它装配期不碰存储，是把不确定性引进装配顺序里。
 */
function unavailableParticipant(hint: string): AgentParticipant {
  const refuse = (): never => { throw new AccessError(503, `博客未就绪：${hint}`) }
  return {
    protocol: PARTICIPANT_PROTOCOL,
    id: 'blog',
    displayName: '伊丽莎白 · 博客',
    description: '查询博客、整理资料并提出文章候选；采用候选和发布确认仍在博客原页面完成。',
    assertAccess: refuse,
    run: async () => refuse(),
  }
}

/**
 * 给业务声明补上**回合钩子**：协作路径的业务绑定。
 *
 * ## 为什么导出它（而不是写在 `mount()` 里）
 *
 * 这是"工具为什么能用"的全部接线，而**验证它的用例必须在 blog 包里**（跨包 import 测试夹具
 * 本仓做不到——内存端口当初从 `tests/` 提升进 `src/` 就是这个原因）。写两份等价实现的下场是
 * "测试验的不是装配跑的那一份"，而这类偏差恰好只会在协调方驱动时暴露。
 *
 * ## 绑定的两端
 *
 * - **建立**（`onTurnStart`）：运行时驱动的一轮开始时，按"本轮的 agent + 本轮的**行 id**"写下
 *   `jobs.bindings`。工具的授权口 `authorize: agent => bound(agent)` 靠它；缺了它，模型手里
 *   **每一个 blog 工具都 403**（不是装载失败，界面上看不出来）。
 * - **摘除**（`onTurnFinish`）：成功 / 取消 / 失败三条路都会调 ✔。不摘会让 `WeakMap` 之外的
 *   一切照旧、但下一轮的同名 Agent 复用旧绑定（`request` 指向上一轮的行 id）⇒ 产出写错轮次。
 *
 * ⚠️ **页面路径不经过这里**（它自己建句柄、自己 `bindings.set`），所以两条路各写一次是必须的，
 * 但**实现只有一份**（`chat.ts` 的 `bindRuntimeTurn` / `unbindRuntimeTurn`）。
 */
export function withTurnBinding(definition: AgentDefinition, chat: BlogChat): AgentDefinition {
  return {
    ...definition,
    onTurnStart: async hook => {
      // `turnId` 是这一轮在 `dsh_turns` 里的**行 id**：工具的 `b.request.id` 与
      // `dsh_turn_results.turn_id` 都要它。协作路径上它必然存在（运行时的 `claim` 先于钩子），
      // 缺了就是装配错了 —— **当场抛**比"每个工具各 403 一次"更容易查。
      // `invariant` 不是断言函数（不参与类型收窄），故显式取一次非空（chat.ts 里同一写法）。
      const turnId = hook.turnId
      invariant(turnId !== undefined, '协作入口驱动的一轮缺少行 id，无法建立业务工具的委派身份')
      await chat.bindRuntimeTurn({ agent: hook.agent, handle: hook.handle, actor: hook.actor, turnId: turnId! })
    },
    onTurnFinish: hook => { chat.unbindRuntimeTurn(hook.agent) },
  }
}

/**
 * 本子包需要宿主提供的服务。
 *
 * 列出它是为了让「这个 Agent 依赖哪些宿主能力」保持可读；群组在装载前统一等待这些服务。
 * `attachments`、`jobs`、`sessions` 也在其中，缺任何一个都会让装载失败。
 */
export const inject=['agents','agentDefaultModel','webServer','systemPrompt','tools','attachments','jobs','llm','sessions','sessionPersistence','messageFeedback'] as const

/** 本子包只用到 Actor 的这两个字段（备份授权端点用）。 */
interface ActorLike { readonly userId?:string; readonly sessionId?:string }

/** 群组注入给子包的东西。只依赖这个最小接口，不依赖群组内部实现。 */
export interface AgentMountContext {
  readonly ctx: Context
  /** 已绑定本 Agent 的 pluginId 与授权范围的访问校验器。 */
  readonly access: Access
  /**
   * 只允许注册本 Agent 前缀下路由的 HTTP 注册器。
   *
   * 直接复用 kit 的 `ProtectedRoute`：路由契约不该在各子包里各写一份，写偏了会在
   * 类型层看不出来、运行时才以「actor 缺字段」的形式炸掉。
   */
  readonly http: {
    register(route: ProtectedRoute): () => void
    /**
     * 注册**显式公开**的路由（不走登录 cookie 的那一类）。
     *
     * 群组给的就是 kit 的 `createPluginHttp` 那个对象，它本来就带这个方法（群组自己的
     * `/agents/health`、`/agents/ready` 也走它，见 `src/index.ts:231/240/264`），此前这里的接口
     * 只是写得比实际窄。宽度不够的代价是实打实的：备份执行器是 systemd 拉起的进程，**没有 cookie
     * 也不带 Origin**，走 `register` 会在进入处理器之前就被 `access.resolve` 挡成 401
     * （`packages/plugin-kit/src/http.ts:42`、`access.ts:236`）——它的凭据是下面那条
     * `Authorization: Bearer <备份 token>`，只能由处理器自己核验。
     */
    registerPublic(route: WebRoute): () => void
  }
  /** 群组解析后的完整配置。 */
  readonly config: Config
  /**
   * 本 Agent 的工具分类标签，由群组从清单注入。
   *
   * 子包注册工具时原样使用，**不要自己写字符串**：两处各写一份会漂移，而漂移的后果是
   * 本 Agent 的工具全部对其不可见，且这种失效在界面上完全看不出来。
   */
  readonly category: string
  /** 本 Agent 能用的工具名（本分类 + 通用集）。惰性取值，理由同 category。 */
  readonly allowedTools: () => readonly string[]
  /** 群组级配置文件的路径；存在时业务凭据从它的 `blog` 小节读取。 */
  readonly groupConfigPath?: string
}

/**
 * 统一的 JSON 响应写法。
 *
 * ⚠️ 响应体是 thenable ⇒ **当场抛**，绝不 `JSON.stringify` 它：`JSON.stringify(Promise)` 得到的是
 * `'{}'`，而 HTTP 状态仍是 **200**，于是页面上看到的是"空结果"而不是错误（侧栏显示"没有会话"、
 * 操作"点了没反应"），日志里也一行都没有。这正是 `/api` 的 `chat-list` 那一支漏 `await` 时的
 * 实际表现（响应体 `{}`、状态 200）。
 *
 * 抛出的错误走群组注入的 `onError`：`blogStorageErrorHandler` 对非存储 / 非访问错误落
 * **500 + 一条 error 日志**，所以这一道把"静默的空响应"变成了"响亮的 500"。
 */
function json(res:ServerResponse,data:unknown){
  if(data!==null&&typeof data==='object'&&typeof (data as {then?:unknown}).then==='function')throw new Error('响应体是 Promise：路由处理器漏了 await')
  res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))
}
async function body(req:IncomingMessage,max:number){const chunks:Buffer[]=[];let size=0;for await(const b of req){const chunk=Buffer.from(b);size+=chunk.length;if(size>max)throw new AccessError(413,'请求超过大小限制');chunks.push(chunk)}return Buffer.concat(chunks)}

/**
 * 子包资源定位。
 *
 * 源码被打进群组 dist 后，代码与资源的相对位置在开发与发布两种形态下不同；解析统一交给
 * common 的 `agentResource`，这里不写死 `../` 层数（写死了换布局会静默错位）。
 */
const blogResource = (relative: string): URL => agentResource(import.meta.url, 'blog', relative)

/**
 * 装载博客工作台，返回群组用于卸载的释放函数、本次注册的工具条目、协作参与者与就绪探针。
 *
 * `access` 与 `http` 由群组注入：一个 Agent 只应有一套鉴权实例。
 *
 * 业务存储只有 PostgreSQL 一种（Q4 口径）：缺配置或 init 失败都算 **blog 未就绪**——
 * 装载继续（页面、目录条目、参与者照常注册，探针 503），业务读写一律以稳定码拒绝，
 * 绝不静默回退 SQLite，也不把失败抛给群组拖累其他 Agent。`health` 供群组的
 * per-agent 就绪探针在运行期核实 PG 此刻可达。
 */
export async function mount(mountContext:AgentMountContext):Promise<{
  dispose():Promise<void>
  tools:readonly ToolDescriptor[]
  participant:AgentParticipant
  health():Promise<{ok:boolean;error?:string}>
}>{
  const {ctx,access,http}=mountContext
  const config=mountContext.config
  // 不再在这里断言 accessMode：群组会为强制认证的 Agent 建 authenticated 的 access。
  // 若把群组配成 standalone，它会以「认证不可用」如实报错，而不是被误判成装载失败。
  // `loadSettings()` 的返回类型是开放字典；各小节的形状由它自己的不变量逐个把关。这里**只按本文件
  // 要读的五个小节各收一次类型**（纯类型断言，取值与改造前逐字相同；类型写偏了仍是同一条装配期报错）。
  const raw=loadSettings(config.runtimeConfig||process.env.BLOG_CONFIG_PATH||'') as Record<string, unknown>
  const settings={
    models: raw.models as BlogModelChoices,
    blog: raw.blog as BlogBridgeConfig,
    image: raw.image as ImageBridgeConfig,
    backup: raw.backup as BackupBridgeConfig & {token?: string},
  }
  const root=config.dataPath||dshHomePath('plugins','blog')
  // ---- 业务存储（PG；Q4：无配置=blog 未就绪而非抛群组） ----
  const dsnSource=await resolveStorageDsn(process.env,dshHomePath('plugins','agents-group','storage.json'),(path:string)=>readFile(path,'utf8'))
  const unconfiguredHint='设置环境变量 AGENTS_GROUP_PG_DSN，或在私有配置文件（环境变量 AGENTS_GROUP_PG_CONFIG 指定路径，缺省 <DSH 主目录>/plugins/agents-group/storage.json）里写 {"dsn":"postgres://…"}。不会回退其他存储后端。'
  const storage=dsnSource?new BlogPgStorage(dsnSource.dsn):unconfiguredBusinessStorage(`缺少 PostgreSQL 存储配置。${unconfiguredHint}`)
  if(dsnSource){
    try{await storage.init()}
    catch(error){
      // init 失败同样是 blog 未就绪：探针与业务端点都会如实反映，群组照常装载。
      console.warn(`agents-group/blog: 业务存储未就绪（${error instanceof Error?error.message:String(error)}）`)
    }
  }
  /**
   * **索引侧**（`dsh_conversations` / `dsh_turns` / `dsh_turn_results`）装载期的失败原因。
   *
   * ⚠️ 它必须被记下来并进探针，不能只 `console.warn`（原来的写法就是这样）：索引与业务**共用一个 DSN**，
   * 但要求的是**不同的表与不同的版本行**（业务读 `blog_schema_version`→`dsh_schema_versions` 的 `blog`，
   * 索引读 `runtime`）。只探业务那一侧的后果是 —— **PG 短暂不可达时 `open()` 失败、业务探针随后恢复，
   * 探针就报"就绪"，而索引**整个进程**再没打开过**：侧栏列表 / 历史 / 发消息全失败，探针却是绿的。
   * 而 runbook 第 5 步正是拿这个探针判断切换成功与否 ⇒ 探针说谎等于把"切换成功"判错。
   */
  let indexFailure:string|undefined
  /** 存储故障的稳定码：跨副本（运行时那一份类）也要认得出来，见 `isStorageError`。 */
  const codeOf=(error:unknown):string=>isStorageError(error)?String((error as {code:unknown}).code):'storage_unknown'
  const health=async():Promise<{ok:boolean;error?:string}>=>{
    if(!dsnSource)return{ok:false,error:`博客业务存储未配置。${unconfiguredHint}`}
    try{await storage.readyProbe()}
    catch(error){
      return{ok:false,error:`博客业务存储不可用（${codeOf(error)}）：${error instanceof Error?error.message:String(error)}`}
    }
    // —— 索引侧：装载期失败就用那条原始原因；装载成功则**此刻再往返一次**（"装的时候好、现在坏了"）。——
    if(indexFailure!==undefined)return{ok:false,error:`博客索引存储未就绪。${indexFailure}`}
    if(index!==undefined){
      try{await index.assertSchema()}
      catch(error){
        return{ok:false,error:`博客索引存储不可用（${codeOf(error)}）：${error instanceof Error?error.message:String(error)}`}
      }
    }
    return{ok:true}
  }
  // ---- 索引库切 PG：会话 / 轮次 / 结果三张表走运行时端口，本地 SQLite 降级为镜像 + outbox ----
  //
  // ⚠️ **本地 SQLite 没有消失**，它换了角色：`blog.sqlite` 现在是运行时门面的"会话行镜像 +
  // 同步围栏标记 + 持久 outbox"（`LocalFenceStore`）。它保证 `record` / `mark` / `syncTitle`
  // 这三个**同步契约**仍能同步回答（kit 的移除围栏与官方标题回调不能 await）。
  //
  // ⚠️ 未配置 PG 时**照常装载**（页面、目录条目、参与者都注册），索引侧的任何读写都以
  // `storage_unconfigured` 拒绝并映射成 503——**绝不回退 SQLite**。所以这里不抛给群组。
  const pending=new PendingOperationsMirror()
  if(dsnSource)await pending.restore(storage).catch(error=>console.warn('agents-group/blog: 恢复待核对操作镜像失败',error))
  const index=dsnSource?createAgentDatabase({dsn:dsnSource.dsn,agentId:'blog',localPath:join(root,'blog.sqlite')}):undefined
  if(index){
    try{await index.open()}
    catch(error){
      // 与业务存储同一条口径：结构核验 / 启动收敛失败 = blog 未就绪，索引读写按存储错误码拒绝。
      // ⚠️ 这里**必须把原因记进 `indexFailure`**（不能只 warn）：探针要如实反映它，理由见 `indexFailure` 的注释。
      indexFailure=`（${codeOf(error)}）${error instanceof Error?error.message:String(error)}`
      console.warn(`agents-group/blog: 索引存储未就绪${indexFailure}`)
    }
  }
  const conversations=new ChatStore(index??unconfiguredIndex(),()=>pending.ids())
  const blog=new BlogClient(settings.blog),images=new ImageClient(settings.image,join(root,'image-token.json')),backups=new BackupClient(settings.backup,access)
  // ⚠️ 这个谓词在 `BlogAttachments` 里一律被 `await`（见其 `get` / `list` / `guard`）。
  // 会话路径走索引侧的**同步**核验（`assertScope` 直接返回记录），草稿路径走存储的异步查询
  // ⇒ 两条分支的返回类型不同，转 TS 时被暴露出来。统一成 `async` 让类型自洽：调用方本来就
  // `await` 异步分支，行为不变（同步分支也只是多一个微任务）。
  const attachments=new BlogAttachments(ctx,access,storage,async(owner:string,id:string)=>id.startsWith('blog-chat-')?conversations.assertScope(owner,id):storage.get(owner,id))
  const jobs=new BlogJobs(ctx,access,storage,blog,attachments,config.turnTimeoutMs,settings.models,mountContext.category,mountContext.allowedTools)
  const app=new BlogApplication(storage,access,blog,images,backups,jobs,attachments,pending)
  const {chatSdk}=await import(blogResource('runtime/chat-sdk.mjs').href)
  /**
   * ⚠️ **装配顺序是被两头钉死的**（照 `agents/closedoff/src/runtime.ts` 的范式）：
   *
   * - 运行时需要 `definition`，而 definition 的 `storage` / `app` / `results` 都要等业务对象造好；
   * - `chat` 需要 `occupancy`（= 运行时的 `lifecycle`），而运行时又要等 `definition` ⇒ **成环**。
   *
   * ⇒ 环用**晚绑定**解开：`occupancy` 与 `release` 都是闭包，读的是 `assembly` 这个 `let`，
   * 而它们只在**回合真的跑起来之后**才被调用——那时装配早已完成。（写成"先造个假的再替换"
   * 会让"装配期还没就绪"变成一个隐式的时序假设，破了也不会报错。）
   */
  let assembly: AgentRuntimeAssembly | undefined
  const chat=new BlogChat(ctx,access,storage,conversations,attachments,jobs,app,chatSdk,config.turnTimeoutMs,{
    isBusy:id=>assembly?.lifecycle.isBusy(id)===true,
    busyIds:()=>assembly?.lifecycle.busyIds()??[],
    // 移除被接受后，运行时那一半也要放（它缓存着句柄）；本类那一半由 `chat.ts` 自己放。
    release:async id=>{await assembly?.lifecycle.release(id)},
  })
  const definition: AgentDefinition = withTurnBinding(createBlogDefinition({
      // 人设＝**对话人设**（`chat.ts` 的 `chatInstructions`）+ 思考语言那一段。
      // ⚠️ 只传 `jobs.ts` 的裸 `persona` 会**静默丢掉**对话专属的那一长段纪律（页面路径仍带着它）
      // ⇒ 同一个 Agent 在页面上和在大总管那里收到的纪律不同。语言那一段本来由页面路径的 setup
      // 单独注册（order 10000），而运行时的 setup 只注册 `persona`（order 600）+ 每轮上下文 ⇒
      // 拼在这里，位置由 10000 变成 600（**已登记的行为变更**），内容一字未改。
      persona: chatInstructions + '\n' + reasoningLanguage,
      // 业务工具：`BlogJobs` 的构造函数里已经注册过（`registerTools`），这里只交回目录条目。
      // 运行时的装配工厂会在装配期调它一次，返回值交给装配侧 `registerPlugin({tools})`。
      tools: () => jobs.chatTools,
      storage,
      app,
      routePrefix: config.routePrefix,
      // 跨轮候选判定要按**会话**读产出记录（运行时的 `loadResults()` 只读本轮）。
      results: { list: async (owner, conversationId) => conversations.results(owner, conversationId) },
  }), chat)
  const allowedTools = mountContext.allowedTools
  let tools: readonly ToolDescriptor[]
  let participant: AgentParticipant
  if (index !== undefined) {
    assembly = await createAgentRuntime({
      ctx,
      definition,
      access,
      config: runtimeConfigOf(config),
      allowedTools,
      // ⚠️ **注入**而不是让工厂自建：blog 的索引门面要**先 `open()`**（启动收敛的顺序在它里面），
      // 而且页面侧那一整套（`ChatStore` / `attachments` / `chat`）都建在同一个门面上——
      // 自建会让工厂再开一个门面、两套镜像与 outbox 互相看不见。
      storage: { db: index, access },
      // 标题投递口交**自己那一份**（落库 + 给页面广播 `changed`），并且本文件不再自己订阅标题事件：
      // 两份订阅会让同一标题写两次、后写被守卫拒 ⇒ 页面永远收不到 `changed`（静默的"标题还是旧的"）。
      titleSink: chat.titleSink,
    })
    tools = assembly.tools
    participant = assembly.participant
  } else {
    // Q4：缺 PG 配置 ⇒ **不建运行时**，但装载照常（页面、目录条目、探针都在）。
    // ⚠️ 又：**必须显式调一次 `definition.tools(...)`**。工厂内部那次调用这条路上走不到，
    // 而工具一个都不注册**是静默的**（限制一份空集合是合法的）⇒ 群组会算出空的 `allowedTools`，
    // 模型手里一个业务工具都没有，界面上完全看不出来。
    tools = definition.tools({ ctx, storage: undefined, conversationId: undefined })
    participant = unavailableParticipant(unconfiguredHint)
    console.warn(`agents-group/blog: 已装载但未就绪——协作入口与页面读写会以稳定码拒绝。${unconfiguredHint}`)
  }
  // 群组直接把这个实例桥接成牛马大总管的执行入口，不再经过额外的发现事件。
  // 侧栏入口**仍然只登记 `chat.provider`**：它有自己的 `preview`（`projectChat` 投影出
  // `tool`/`status` 行）、`list`（host busy + pending 操作 + forks）与 `remove`（自己的
  // `conversationRemover`），运行时的 `provider` 复现不了这些。**登记两个会出现两个侧栏条目。**
  ctx.effect(()=>registerConversations(ctx,chat.provider))
  const translations=new ReasoningTranslations({ctx,pluginId:'blog',storage,access,selectModel:signal=>selectBlogModel(ctx,settings.models,false,signal),readOriginal:async(actor,target)=>reasoningOriginal(await chat.events(actor,target.conversationId),target.sourceId)})
  const manifest=JSON.parse(await readFile(blogResource('package.json'),'utf8'))
  ctx.effect(()=>registerPlugin(ctx,{id:'blog',packageName:manifest.name,version:manifest.version,displayName:'博客智能体',description:manifest.description,entryPath:config.routePrefix,permissions:['blog:access'],category:'agents',tools}))
  for(const [suffix,file,mime] of [['','web/index.html','text/html'],['/app.js','dist/web/app.js','text/javascript'],['/style.css','web/style.css','text/css'],['/writing.css','web/writing.css','text/css'],['/chat-base.css','web/chat-base.css','text/css'],['/chat-theme.css','web/chat-theme.css','text/css'],...['chevron-down','copy','check','like','dislike','branch','database','clock','think','api','send','user','chat','stop'].map(name=>[`/media/icon-${name}.svg`,`web/media/icon-${name}.svg`,'image/svg+xml']),['/icons.svg','web/icons.svg','image/svg+xml']] as const){
    // `file` 已是相对子包根的路径（web/... 或 dist/web/...），直接相对 agentRoot 解析。
    /**
     * ⚠️ **缺文件要报"缺构建产物"，不能让它以裸 `ENOENT` 冒出去。**
     *
     * `web/` 下的静态资源是**随包提交**的，而 `dist/web/*` 是**构建产物**（`dist/` 是 gitignored，
     * 由 blog 的 `tsdown --config tsdown.web.config.ts` 生成）。少了它，`mount()` 会在
     * **跑任何回合逻辑之前**就抛 `ENOENT: … agents/blog/dist/web/app.js` ——
     * 而这条错误在现场看起来**像业务失败**（实测过：群组挂载用例报"blog 装载失败：ENOENT"，
     * 排查方向被带偏；生产上同理，容器里忘了构建就是一条看不懂的装载失败）。
     * ⇒ 在这里把它翻成一句**指明该做什么**的话。**不吞掉原因**（`cause` 原样保留）。
     */
    const asset = await readFile(blogResource(file),'utf8').catch((cause:unknown)=>{
      throw new Error(`博客页面资源缺失：${file}（web/ 是随包提交的静态资源，dist/web/* 需要先构建——跑 \`pnpm --filter @dsh-agents-group/blog build\`）`,{cause})
    })
    const content=asset.replaceAll('__BASE__',config.routePrefix)
    ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+suffix,surface:suffix?'asset':'page',handler(req,res){if(req.method!=='GET')throw new AccessError(405,'只支持 GET');res.writeHead(200,{'content-type':`${mime}; charset=utf-8`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"});res.end(content)}}))
  }
  // 存活与就绪探针由群组统一提供（/agents/health、/agents/ready 与 /agents/blog/ready），
  // 这里不再注册：容器级探针是群组的职责，重复一份还会因前缀来源不同而冲突。
  // `/backup-authorize` 不是探针而是业务端点（systemd 执行器用它换授权），所以保留。
  // ⚠️ 必须走 `registerPublic`：调用它的是**没有登录 cookie、也没有 Origin 头**的执行器进程，
  // 走受保护注册会在进入处理器之前就被挡成 401（或 Origin 校验的 403），而处理器里那条
  // `Bearer <备份 token>` 的定长比较才是它真正的凭据。端点自身仍然只认 POST + 正确 token。
  ctx.effect(()=>http.registerPublic({kind:'exact',path:config.routePrefix+'/backup-authorize',handler:async(req,res)=>{
    const expected=settings.backup.token?`Bearer ${settings.backup.token}`:''
    const supplied=req.headers.authorization??''
    if(req.method!=='POST'||!expected||!timingSafeEqual(createHash('sha256').update(expected).digest(),createHash('sha256').update(supplied).digest())){res.writeHead(403);res.end();return}
    try{const input=JSON.parse((await body(req,4096)).toString('utf8'));backups.assert({namespace:'user',userId:input.actor?.userId,sessionId:input.actor?.sessionId});json(res,{ok:true})}catch{res.writeHead(403);res.end()}
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/identity',handler(_req,res,actor){json(res,{userId:actor.userId,version:manifest.version,backupAdmin:settings.backup.allowedUserIds.includes(actor.userId),maxImageBytes:settings.image.maxBytes,blogUrl:settings.blog.url})}}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/reasoning-translation',handler:async(req,res,actor)=>{
    if(req.method!=='POST')throw new AccessError(405,'只支持 POST')
    if(!req.headers['content-type']?.startsWith('application/json'))throw new AccessError(415,'需要 JSON 请求')
    let input
    try{input=JSON.parse((await body(req,8192)).toString('utf8'))}catch(e){if(e instanceof AccessError)throw e;throw new AccessError(400,'无效 JSON')}
    if(!input||typeof input.conversationId!=='string'||typeof input.sourceId!=='string')throw new AccessError(400,'思考定位无效')
    const controller=new AbortController(),cancel=()=>controller.abort();res.once('close',cancel)
    try{const value=await translations.translate(actor,input,controller.signal);access.assert(actor);if(!res.destroyed)json(res,value)}finally{res.off('close',cancel)}
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/api',handler:async(req,res,actor)=>{
    if(req.method!=='POST')throw new AccessError(405,'只支持 POST')
    if(!req.headers['content-type']?.startsWith('application/json'))throw new AccessError(415,'需要 JSON 请求')
    let input
    try{input=JSON.parse((await body(req,3*1024*1024)).toString('utf8'))}catch(e){if(e instanceof AccessError)throw e;throw new AccessError(400,'无效 JSON')}
    if(!input||typeof input.action!=='string'||!input.args||typeof input.args!=='object'||Array.isArray(input.args))throw new AccessError(400,'请求格式无效')
    const args=input.args
    let result
    switch(input.action){
      case 'chat-create':result=await chat.create(actor,args.requestId);break
      // ⚠️ `list` 在 P7 ③-A 步骤 3 跟着 `chat-store.ts` 一起变成 async（三表全走运行时端口），
      // 这里的 `await` 是那次转换漏掉的一处。少了它响应体是 `Promise` 序列化出来的 `{}`
      // （HTTP 仍然 200）：侧栏拿到空对象、`items` 是 undefined，看起来像"没有会话"而不是报错。
      // 其余分支本来就已经 await，所以这是补齐，不是语义变更。
      case 'chat-list':result=await chat.list(actor,args.offset??0,args.query??'');break
      case 'chat-models':result=await chat.models(actor,args.conversationId);break
      case 'chat-update':result=await chat.mutate(actor,args);break
      case 'chat-history':result=await chat.history(actor,args.conversationId);break
      case 'chat-send':result=await chat.send(actor,args);break
      case 'chat-image-capability':result=await chat.imageCapability(actor,args.conversationId,args.modelSelection);break
      case 'chat-stop':result=await chat.stop(actor,args.conversationId);break
      case 'chat-fork':result=await chat.fork(actor,args);break
      case 'chat-feedback':result=await chat.feedback(actor,args.conversationId,args.operation,args);break
      case 'chat-operation':result=await chat.operationAction(actor,args);break
      default:result=await app.call(actor,input.action,args)
    }
    json(res,result)
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/chat-events',handler:async(req,res,actor)=>{
    if(req.method!=='GET')throw new AccessError(405,'只支持 GET')
    const id=new URL(req.url!,'http://localhost').searchParams.get('conversationId')!
    // Validate ownership before opening an authenticated stream.
    await chat.history(actor,id);access.assert(actor)
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'});res.flushHeaders()
    let closed=false
    const send=(value:unknown)=>{if(closed)return;if(!res.write(`data: ${JSON.stringify(value)}\n\n`))res.destroy()}
    const unsubscribe=chat.subscribe(actor,id,send,()=>res.end())
    res.once('close',()=>{closed=true;unsubscribe()})
    try{send({type:'snapshot',value:await chat.history(actor,id)})}catch{res.end()}
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/chat-attachment',handler:async(req,res,actor)=>{
    if(req.method!=='GET')throw new AccessError(405,'只支持 GET')
    const query=new URL(req.url!,'http://localhost').searchParams
    const file=await chat.original(actor,query.get('conversationId')!,query.get('requestId')!,query.get('id')!);access.assert(actor)
    res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(file.bytes)
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/upload',handler:async(req,res,actor)=>{
    if(req.method!=='POST')throw new AccessError(405,'只支持 POST')
    json(res,await app.upload(actor,await body(req,settings.image.maxBytes)))
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/attachment',handler:async(req,res,actor)=>{
    if(req.method!=='POST')throw new AccessError(405,'只支持 POST')
    const query=new URL(req.url!,'http://localhost').searchParams
    /**
     * ⚠️ `query.get(...)` 是 `string | null`，而这三个方法的 id 形参是 `string`。这里用 `!` 收口
     * ——**不是"断言值一定存在"**，而是**保持改前的行为**：改前就是把 `null` 原样透传（存储层按
     * "查不到"处理，个别分支会先在 `null.startsWith` 上炸成 500）；`!` 只抹掉类型、运行时一字不变。
     * 与同文件 `:548` 既有写法一致。**不在这里新增一条 400**（那是新行为，不属本批）。
     */
    const result=await attachments.upload(actor,query.get('draftId')!,query.get('name')!,async(signal:AbortSignal)=>{
      const cancel=()=>req.destroy();signal.addEventListener('abort',cancel,{once:true})
      try{return await body(req,MAX_ATTACHMENT_BYTES)}finally{signal.removeEventListener('abort',cancel)}
    });access.assert(actor);json(res,result)
  }}))
  ctx.effect(()=>http.register({kind:'exact',path:config.routePrefix+'/attachment-download',handler:async(req,res,actor)=>{
    if(req.method!=='GET')throw new AccessError(405,'只支持 GET')
    const query=new URL(req.url!,'http://localhost').searchParams
    // 同 `/attachment`：`!` 只抹类型，运行时仍把 `null` 透传（保持改前行为）。
    const file=await attachments.original(actor,query.get('draftId')!,query.get('id')!);access.assert(actor)
    const record=await attachments.get(actor,query.get('draftId')!,query.get('id')!)
    const inline=query.get('inline')==='1'&&record.status==='ready'&&record.image&&['image/png','image/jpeg','image/webp','image/gif'].includes(record.kind)
    res.writeHead(200,{'content-type':inline?record.kind:'application/octet-stream','content-disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(file.bytes)
  }}))

  return {
    // 群组据此算「本分类 + 通用」的工具可见性限制，所以如实返回全部已注册工具。
    // 取 `tools`（装配结果）而**不是** `jobs.chatTools`：未就绪那条路上前者来自显式调用的
    // `definition.tools(...)`，是**同一次注册**的返回值，两者内容相同但来源只有一个。
    tools,
    // 参与者交给群组桥接成牛马大总管的执行入口。
    participant,
    // Q4 口径的就绪探针：群组的 healthPath 与 /ready 汇总据此如实反映 blog 状态。
    health,
    dispose: async () => {
      // 释放顺序与创建相反，与迁移前保持一致；业务存储与索引库句柄都纳入释放链
      // （索引库拆库后独立开库，句柄泄漏会以 database is locked 或目录占用暴露）。
      await translations.close(); await chat.close(); await jobs.close(); await attachments.close()
      // ⚠️ 索引门面的 `close()` **由运行时装配的 `dispose()` 负责**（我们注入的门面就是它的
      // `db`）：它同样是"**先排空 outbox 再关连接**"（顺序反了，刚标记的删除与刚投递的标题会留在
      // 本地队列里，用户看到的是"删了还在、标题没变"）。这里**不再单独调 `index.close()`** ——
      // 两次 close 会在同一批句柄上重跑排空与关池。
      await assembly?.dispose()
      try{await storage.close()}catch{/* 未配置占位没有可关闭的池 */}
    },
  }
}
