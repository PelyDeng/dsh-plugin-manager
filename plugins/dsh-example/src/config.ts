/** Deployment settings for the copyable chat plugin. */
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  accessMode: 'standalone' | 'authenticated'
  publicOrigin: string
  routePrefix: string
  systemPrompt: string
  historyPath: string
  authRecheckMs: number
  turnTimeoutMs: number
  idleTimeoutMs: number
  maxConversations: number
  maxMessageChars: number
}

export const Config: Schema<Config> = Schema.object({
  accessMode: Schema.union(['standalone', 'authenticated']).default('standalone'),
  publicOrigin: Schema.string().default(''),
  routePrefix: Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/).default('/example'),
  systemPrompt: Schema.string().default('你是一位清晰、友好的 AI 助手。用用户的语言回答，区分事实与推测；不知道时直接说明。'),
  historyPath: Schema.string().default(''),
  authRecheckMs: Schema.natural().min(100).max(30000).default(1000),
  turnTimeoutMs: Schema.natural().min(1000).max(1800000).default(180000),
  idleTimeoutMs: Schema.natural().min(1000).max(86400000).default(1800000),
  maxConversations: Schema.natural().min(1).max(500).default(32),
  maxMessageChars: Schema.natural().min(1).max(32000).default(8000),
})
