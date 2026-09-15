/**
 * 牛马大总管插件的入口。
 *
 * 它做三件事：
 *
 * 1. 在插件目录里登记自己，让页面和别的插件知道有这个应用。
 * 2. 打开一个牛马大总管 Agent，负责理解目标、拆解任务和汇总。
 * 3. 提供工作台页面、SSE 接口和只读就绪探针。
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
import { TaskStore } from './store.ts'
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

/** 装载工作台索引、牛马大总管会话、调度入口发现和页面。 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const [personaText, manifestText] = await Promise.all([
    readFile(new URL('../persona.txt', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])
  const persona = personaText.trim()
  if (persona === '') throw new Error('butler-console persona.txt must not be empty')
  const manifest = JSON.parse(manifestText) as {
    name: string
    version: string
    description: string
    deepseekPlugin: { id: string; displayName: string; permissions: string[]; category?: string }
  }

  const access = createAccess(ctx, {
    mode: config.accessMode,
    pluginId: manifest.deepseekPlugin.id,
    publicOrigin: config.publicOrigin,
  })
  const store = new TaskStore(dshHomePath('plugins', manifest.deepseekPlugin.id, 'butler.sqlite'))
  // 上次进程没有正常退出时留下的执行中状态要收敛，否则页面会一直显示转圈。
  const interrupted = store.failInterrupted()
  if (interrupted > 0) console.warn(`butler-console: 标记 ${interrupted} 个上次未完成的任务为失败`)
  const console_ = new ButlerConsole(ctx, config, access, store, persona)

  ctx.effect(() => () => { void console_.dispose(); store.close() })
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

  await installWeb(ctx, config, console_, access)
}
