/**
 * 牛马大总管插件的入口。
 *
 * 它做三件事：
 *
 * 1. 在插件目录里登记自己，让页面和别的插件知道有这个应用。
 * 2. 打开一个牛马大总管 Agent，负责理解目标、拆解任务和汇总。
 * 3. 提供工作台页面、SSE 接口和只读就绪探针。
 *
 * 业务存储只有 PostgreSQL 一种（方案 §2.5 启动序列）：读配置 → 建池 → `init()` 校验结构
 * 版本 → `failInterrupted()` 收敛上次未完成的任务 → 就绪。缺配置或校验失败都让 `apply`
 * 抛错、插件不激活，绝不静默回退别的后端。
 *
 * 子 Agent 不由这里创建：每个业务插件在自己的生命周期里向 `butler/executors`
 * 登记执行入口，牛马大总管据此把子任务交给它们。
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createAccess, registerPlugin } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole } from './butler.ts'
import { Config as ConfigSchema, type Config as PluginConfig } from './config.ts'
import { MemoryStore } from './memories.ts'
import { resolveStorageDsn } from './storage/dsn.ts'
import { PostgresTaskStorage, STORAGE_SCHEMA_VERSION } from './storage/postgres.ts'
import { installWeb } from './web.ts'

export { ConfigSchema as Config }
export type { PluginConfig }
export { BUTLER_EXECUTORS_EVENT } from './protocol.ts'
export type {
  ButlerAgentExecutor,
  ButlerDispatchRequest,
  ButlerDispatchResult,
  ButlerProgressUpdate,
} from './protocol.ts'
/** 对外 HTTP 契约的版本号；`/identity` 也会返回它。 */
export { CONTRACT_VERSION } from './web.ts'

/** Cordis 插件名，与 `cordis.patch.yml` 里的 id 和包名保持一致的关系。 */
export const name = 'butler'

export const inject = [
  'agents',
  'agentDefaultModel',
  'llm',
  'sessionPersistence',
  'systemPrompt',
  'tools',
  'webServer',
] as const

/** 人设目录的权威拼装顺序（设计 §6.1：等价期按 persona.txt 原文线性顺序切分，逐字节等价迁移的基准）。 */
export const PERSONA_SECTION_ORDER = [
  '01-identity-intro',
  '02-duties',
  '03-duties-not',
  '04-dispatch-plan',
  '05-acceptance-spec',
  '06-fidelity',
  '07-tools',
  '08-dispatch-select',
  '09-acceptance-final',
  '10-style',
] as const

/** 读取 persona/ 目录并按权威顺序拼装人设整体文本；任一文件缺失或为空都响亮失败。 */
export async function loadPersonaText(readTextFile: (url: URL) => Promise<string>): Promise<string> {
  const sections = await Promise.all(
    PERSONA_SECTION_ORDER.map(async name => {
      const text = (await readTextFile(new URL(`../persona/${name}.md`, import.meta.url))).trim()
      if (text === '') throw new Error(`butler-console persona/${name}.md must not be empty`)
      return text
    }),
  )
  return sections.join('\n\n')
}

/** 装载工作台索引、牛马大总管会话、调度入口发现和页面。 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const [persona, manifestText] = await Promise.all([
    loadPersonaText((url: URL) => readFile(url, 'utf8')),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])
  if (persona === '') throw new Error('butler-console persona/ sections must not be empty')
  const manifest = JSON.parse(manifestText) as {
    name: string
    version: string
    description: string
    deepseekPlugin: { id: string; displayName: string; permissions: string[]; category?: string }
  }

  // §2.5 启动序列：缺 PG 配置 = 装载失败（不激活），消息说清两条配置路径；不回退 SQLite。
  const source = await resolveStorageDsn(
    process.env,
    dshHomePath('plugins', manifest.deepseekPlugin.id, 'storage.json'),
    path => readFile(path, 'utf8'),
  )
  if (source === undefined) {
    throw new Error(
      'butler-console 缺少 PostgreSQL 存储配置：设置环境变量 BUTLER_PG_DSN，'
      + '或在私有配置文件（环境变量 BUTLER_PG_CONFIG 指定路径，缺省 <DSH 主目录>/plugins/butler/storage.json）'
      + '里写 {"dsn":"postgres://…"}。不会回退其他存储后端。',
    )
  }

  const access = createAccess(ctx, {
    mode: config.accessMode,
    pluginId: manifest.deepseekPlugin.id,
    publicOrigin: config.publicOrigin,
  })
  const storage = new PostgresTaskStorage(source.dsn)
  try {
    // init 失败 = 插件不激活：StorageError 带稳定码（storage_unreachable / storage_schema_missing /
    // storage_schema_version / …）原样抛给装载日志。failInterrupted 是恢复写，纳入同一序列。
    await storage.init()
    // 上次进程没有正常退出时留下的执行中状态要收敛，否则页面会一直显示转圈。
    const interrupted = await storage.failInterrupted()
    if (interrupted > 0) console.warn(`butler-console: 标记 ${interrupted} 个上次未完成的任务为失败`)  } catch (error) {
    // init 阶段失败也要把池收掉：装载失败后进程还在，留着空池只会占着连接与定时器。
    await storage.close().catch(() => {})
    throw error
  }
  // 附件服务由 ButlerConsole 自己在构造时装配（页面那条路读 `console_.attachments`），
  // 这里不再单独造一个：两处各造一个就会各持一份状态。
  // 记忆存储复用同一个池（第二只池=第二份状态与两倍连接数）；生命周期随 storage.close() 终结。
  const memories = new MemoryStore(storage.clientPool, 'butler')
  const console_ = new ButlerConsole(ctx, config, access, storage, persona, memories)
  // 移除围栏的同步镜像要在路由就绪前装满：围栏的 record 是同步查表，空镜像会把正常
  // 会话的删除请求误判成「不存在」。加载失败按装载失败处理（否则删除面带着空镜像上线）。
  await console_.loadConversationIndex()
  // 就绪状态来自启动序列的缓存结果（§2.5 口径：已装载未就绪 → 业务与 /ready 503）；
  // probe 供 /ready 在运行期核实 PG 此刻真的可达（已配置但运行中不可达 = 已装载未就绪）。
  const storageReady = {
    ready: true,
    schemaVersion: STORAGE_SCHEMA_VERSION,
    probe: () => storage.readyProbe(),
  } as const

  ctx.effect(() => () => {
    void console_.dispose()
    // 有界关闭（§2.6）：effect 清理不能 await——发起 close（实现内部有 5 秒上限，超时放弃
    // 等待并记录，池终结交给进程退出），失败只落服务端日志，不阻塞也不外溢。
    void storage.close().catch(error => {
      console.error(`butler-console: 存储关闭失败：${error instanceof Error ? error.message : String(error)}`)
    })
  })
  ctx.effect(() => registerPlugin(ctx, {
    id: manifest.deepseekPlugin.id,
    packageName: manifest.name,
    version: manifest.version,
    displayName: manifest.deepseekPlugin.displayName,
    description: manifest.description,
    entryPath: config.routePrefix,
    permissions: manifest.deepseekPlugin.permissions,
    ...(manifest.deepseekPlugin.category === undefined ? {} : { category: manifest.deepseekPlugin.category }),
    tools: [],
  }))

  // 牛马大总管会话的事件只用于填充当前轮次；其他插件的会话事件在这里被忽略。
  ctx.on('session/event', (session, event) => { console_.observe(session, event) })
  // 它自己的回答也要边收边上：实时帧只转发它自己会话的正文增量，其余一律忽略。
  ctx.on('agent/assistant-stream', ({ agent, frame }) => { console_.observeStream(agent, frame) })

  await installWeb(ctx, config, console_, access, storageReady)
}
