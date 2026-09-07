/** External closed-off park assistant bundle for DeepSeek Harness. */

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
import { createAccess, onRevoked, registerPlugin } from '@dsh-plugin-manager/plugin-kit'
import { ConversationManager } from './agent.ts'
import { ConversationStore } from './conversation-store.ts'
import { Config as ConfigSchema, type Config as PluginConfig } from './config.ts'
import { loadEnvConf } from './env.ts'
import { ClosedoffGateway } from './gateway.ts'
import { registerTools, TOOL_NAMES } from './tools.ts'
import { installWeb } from './web.ts'

export { ConfigSchema as Config }
export type { PluginConfig }

export const name = 'closedoff-assistant'

export const inject = [
  'agents',
  'agentDefaultModel',
  'messageFeedback',
  'sessionPersistence',
  'systemPrompt',
  'tools',
  'webServer',
] as const

/** Install the read-only gateway tools, business Agent, and dedicated Web page. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const [personaText, environment] = await Promise.all([
    readFile(new URL('../persona.txt', import.meta.url), 'utf8'),
    loadEnvConf(),
  ])
  const persona = personaText.trim()
  if (persona === '') throw new Error('closedoff-assistant persona.txt must not be empty')

  const gateway = new ClosedoffGateway(config, environment)
  const access = createAccess(ctx, { mode: config.accessMode, pluginId: 'closedoff', publicOrigin: config.publicOrigin })
  const store = new ConversationStore(dshHomePath('plugins', 'closedoff', 'conversations.sqlite'))
  const manager = new ConversationManager(ctx, config, persona, TOOL_NAMES, access, store)

  ctx.effect(() => () => manager.dispose())
  const tools = registerTools(ctx, gateway, config, agent => manager.authorizeAgent(agent))
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string; version: string; description: string; deepseekPlugin: { displayName: string }
  }
  ctx.effect(() => registerPlugin(ctx, {
    id: 'closedoff', packageName: manifest.name, version: manifest.version,
    displayName: manifest.deepseekPlugin.displayName, description: manifest.description,
    entryPath: config.routePrefix, permissions: ['closedoff:access'], tools,
  }))
  ctx.effect(() => onRevoked(ctx, () => manager.revokeInvalid()))
  await installWeb(ctx, config, manager, access)
}
