import Schema from '@deepseek-ai/schemastery'

export interface Config {
  accessMode: 'standalone' | 'authenticated'
  publicOrigin: string
  routePrefix: string
  historyPath: string
  turnTimeoutMs: number
  authRecheckMs: number
  maxActiveMissions: number
  maxMessageChars: number
}

export const Config: Schema<Config> = Schema.object({
  accessMode: Schema.union(['standalone', 'authenticated']).default('authenticated'),
  publicOrigin: Schema.string().default(''),
  routePrefix: Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/).default('/pirate'),
  historyPath: Schema.string().default(''),
  turnTimeoutMs: Schema.natural().min(1000).max(1800000).default(600000),
  authRecheckMs: Schema.natural().min(100).max(30000).default(1000),
  maxActiveMissions: Schema.natural().min(1).max(100).default(16),
  maxMessageChars: Schema.natural().min(1).max(32000).default(8000),
})
