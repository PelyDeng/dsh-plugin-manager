/**
 * 封闭化助手：作为智能体群组的一个子包被装载。
 *
 * 与迁移前的两点差别：
 * 1. `Access` 与 HTTP 注册器由群组注入。一个 Agent 只应有一套鉴权实例，各自再建一份会
 *    出现两个 `Access`、两份前缀校验，出错时很难判断以谁为准。
 * 2. 业务配置从群组级配置文件的 `closedoff` 小节读取（群组只能有一个 runtimeConfig）。
 *    为兼容期保留旧来源：没有群组配置时仍读 `CLOSEDOFF_ENV_CONF` 或包内 `env.conf`。
 *
 * 业务本身（网关工具、会话管理、三维页面）未作改动。
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-message-feedback'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createPluginHttp, onRevoked, registerPlugin, registerConversations, type Access } from '@dsh-plugin-manager/plugin-kit'
import { ConversationManager } from './agent.ts'
import { ConversationStore } from './conversation-store.ts'
import { Config as ConfigSchema, type Config as PluginConfig } from './config.ts'
import { loadEnvConf, parseEnvConf } from './env.ts'
import { ClosedoffGateway } from './gateway.ts'
import { registerTools, TOOL_NAMES } from './tools.ts'
import { createClosedoffParticipant } from './participant.ts'
import { installWeb } from './web.ts'

export { ConfigSchema as Config }
export type { PluginConfig }

/**
 * 本子包需要宿主提供的服务。
 *
 * 群组本身只声明它自己要用的；子包需要什么由群组统一汇总（见群组 `src/index.ts`），
 * 这里保留导出是为了让「这个 Agent 依赖哪些宿主能力」保持可读、可测试。
 */
export const inject = [
  'agents',
  'agentDefaultModel',
  'llm',
  'messageFeedback',
  'sessionPersistence',
  'systemPrompt',
  'tools',
  'webServer',
] as const

/** 群组注入给子包的东西。只依赖这个最小接口，不依赖群组内部实现。 */
export interface AgentMountContext {
  readonly ctx: Context
  /** 已绑定本 Agent 的 pluginId 与授权范围的访问校验器。 */
  readonly access: Access
  /** 只允许注册本 Agent 前缀下路由的 HTTP 注册器。 */
  readonly http: ReturnType<typeof createPluginHttp>
  /** 群组解析后的完整配置：Schema 默认值 + 部署覆盖 + 群组注入的公共字段。 */
  readonly config: PluginConfig
  /** 群组级配置文件的路径；存在时业务凭据从它的 `closedoff` 小节读取。 */
  readonly groupConfigPath?: string
}

/** Schema 默认值。用它做底座，避免把默认值再手写一遍导致两处漂移。 */
function schemaDefaults(): PluginConfig {
  return { ...(ConfigSchema.meta.default as PluginConfig) }
}

/**
 * 加载业务凭据。
 *
 * 优先群组级配置文件（JSON）里的 `closedoff` 小节。该小节写成同名环境变量的键值对
 * 或 `KEY=VALUE` 文本都接受，两者都交给原有的 `parseEnvConf` 校验 —— 这样校验规则
 * 只有一份，不会因为换了配置文件就把必填、HTTPS、占位符等检查漏掉。
 *
 * 没有群组配置时回落到旧来源（`CLOSEDOFF_ENV_CONF` 或包内 `env.conf`），
 * 这样切换过程不会因为配置文件搬家而中断。
 */
async function loadEnvironment(groupConfigPath: string | undefined): Promise<ReturnType<typeof parseEnvConf>> {
  if (groupConfigPath !== undefined && groupConfigPath !== '') {
    let raw: string
    try {
      raw = await readFile(groupConfigPath, 'utf8')
    } catch (cause: unknown) {
      // 只有「文件不存在」才回落到旧来源；读得到但内容有问题要如实抛出。
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return loadEnvConf()
      throw cause
    }
    const document = JSON.parse(raw) as Record<string, unknown>
    const section = document.closedoff
    if (section !== undefined && section !== null) {
      const text = typeof section === 'string'
        ? section
        : Object.entries(section as Record<string, unknown>)
          .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
          .map(([key, value]) => `${key}=${String(value)}`)
          .join('\n')
      if (text.trim() !== '') return parseEnvConf(text)
    }
  }
  return loadEnvConf()
}

/** 装载封闭化助手，返回群组用于卸载的释放函数。 */
export async function mount(context: AgentMountContext): Promise<{ dispose(): Promise<void> }> {
  const { ctx, access, http, groupConfigPath } = context
  const config: PluginConfig = { ...schemaDefaults(), ...context.config }

  const [personaText, environment] = await Promise.all([
    readFile(new URL('../persona.txt', import.meta.url), 'utf8'),
    loadEnvironment(groupConfigPath),
  ])
  const persona = personaText.trim()
  if (persona === '') throw new Error('closedoff persona.txt must not be empty')

  const gateway = new ClosedoffGateway(config, environment)
  // 数据路径保持 plugins/closedoff 不变：本次不迁移数据，旧记录仍可读，
  // 同时它也是回滚到旧插件时的保险。
  const store = new ConversationStore(dshHomePath('plugins', 'closedoff', 'conversations.sqlite'))
  const manager = new ConversationManager(ctx, config, persona, TOOL_NAMES, access, store)
  const participant = createClosedoffParticipant(ctx, config, manager, access)
  ctx.effect(() => ctx.on('pirate/participants', accept => accept(participant), { global: true }))
  if (access.mode === 'authenticated') ctx.effect(() => registerConversations(ctx, manager.management()))

  const tools = registerTools(ctx, gateway, config, agent => manager.authorizeAgent(agent))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string; version: string; description: string
  }
  ctx.effect(() => registerPlugin(ctx, {
    id: 'closedoff',
    packageName: manifest.name,
    version: manifest.version,
    displayName: '封闭化管理智能助手',
    description: manifest.description,
    entryPath: config.routePrefix,
    permissions: ['closedoff:access'],
    tools,
  }))
  ctx.effect(() => onRevoked(ctx, () => manager.revokeInvalid()))
  await installWeb(ctx, config, manager, access, http)

  return {
    dispose: async () => {
      // 会话与存储由本子包负责释放；注册的路由随 ctx 作用域回收。
      await manager.dispose()
    },
  }
}
