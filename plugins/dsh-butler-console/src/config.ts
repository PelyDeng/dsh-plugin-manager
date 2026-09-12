import Schema from '@deepseek-ai/schemastery'

/** 牛马大总管的部署配置。字段名与 `cordis.patch.yml`、管理器生成的 patch 保持一致。 */
export interface Config {
  accessMode: 'standalone' | 'authenticated'
  publicOrigin: string
  authRecheckMs: number
  reasoningEffort: string
  routePrefix: string
  /** 单个子任务的最长执行时间，超时按失败处理并中止子 Agent。 */
  subtaskTimeoutMs: number
  /** 一次牛马大总管回答的最长时间。 */
  turnTimeoutMs: number
  /** 单条用户消息字符数上限。 */
  maxMessageChars: number
  /** 单个子任务摘要写回页面的字符数上限。 */
  maxResultChars: number
  /** 一次计划里允许的子任务数量上限。 */
  maxSubtasks: number
  /** 请求体上限。 */
  maxRequestBodyBytes: number
  /** 成员头像大小上限。 */
  maxAvatarBytes: number
  /** 同时保留的牛马大总管会话数。 */
  maxActiveConversations: number
  /** 运行历史每页条数上限。 */
  maxHistoryPageSize: number
}

/** Cordis 配置 schema。默认值与设计文档第 2 节的能力范围一致。 */
export const Config: Schema<Config> = Schema.object({
  accessMode: Schema.union(['standalone', 'authenticated']).default('authenticated'),
  publicOrigin: Schema.string().default(''),
  authRecheckMs: Schema.natural().min(100).max(30000).default(1000),
  reasoningEffort: Schema.string().pattern(/^(?:off|low|high|max)$/).default('low'),
  routePrefix: Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/).default('/butler'),
  subtaskTimeoutMs: Schema.natural().min(1000).max(1800000).default(300000),
  turnTimeoutMs: Schema.natural().min(1000).max(3600000).default(600000),
  maxMessageChars: Schema.natural().min(1).max(32000).default(8000),
  maxResultChars: Schema.natural().min(100).max(64000).default(8000),
  maxSubtasks: Schema.natural().min(1).max(20).default(6),
  maxRequestBodyBytes: Schema.natural().min(1024).max(1048576).default(65536),
  maxAvatarBytes: Schema.natural().min(4096).max(2097152).default(262144),
  maxActiveConversations: Schema.natural().min(1).max(500).default(32),
  maxHistoryPageSize: Schema.natural().min(1).max(100).default(30),
})
