import Schema from '@deepseek-ai/schemastery'

/** 单个 Agent 的部署覆盖。非敏感参数放这里，凭据走群组级 runtimeConfig 文件。 */
export interface AgentConfig {
  /** 是否装载这个 Agent。关闭时它的页面与条目都不出现。 */
  enabled: boolean
  /**
   * 该 Agent 自己的配置字段。
   *
   * 群组不重复描述子包的字段：各子包有自己的 Schema，迁移时把原 `cordis.patch.yml`
   * 的字段原样搬到这里即可。群组只负责把它交给子包，由子包自己校验。
   */
  config: Record<string, unknown>
  /**
   * 模型白名单。留空表示不过滤，行为与迁移前一致。
   *
   * 宿主的模型目录是全局扁平的、没有 scope 机制，所以只能在这里按 Agent 收窄。
   */
  models: {
    allow: string[]
    deny: string[]
  }
}

/** 群组部署配置。字段名与 `cordis.patch.yml`、管理器生成的 patch 保持一致。 */
export interface Config {
  accessMode: 'standalone' | 'authenticated'
  publicOrigin: string
  /** 群组根前缀。各 Agent 的页面是它的子路径。 */
  routePrefix: string
  /** 按 Agent id 的覆盖；没有列出的 Agent 用 Schema 默认值。 */
  agents: Record<string, AgentConfig>
  /** 认证复核间隔（毫秒）。 */
  authRecheckMs: number
}

const agentSchema: Schema<AgentConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  // 子包字段种类由各 Agent 自己决定，这里不能写成封闭对象，否则新增字段会被拒。
  config: Schema.dict(Schema.any()).default({}),
  models: Schema.object({
    allow: Schema.array(Schema.string()).default([]),
    deny: Schema.array(Schema.string()).default([]),
  }).default({ allow: [], deny: [] }),
})

/** Cordis 配置 schema。每个字段都必须有默认值：管理器的 patch 会整体替换 config。 */
export const Config: Schema<Config> = Schema.object({
  accessMode: Schema.union(['standalone', 'authenticated']).default('authenticated'),
  publicOrigin: Schema.string().default(''),
  routePrefix: Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/).default('/agents'),
  agents: Schema.dict(agentSchema).default({}),
  authRecheckMs: Schema.natural().min(100).max(30000).default(1000),
})

/** 取一个 Agent 的配置；未声明时返回默认值，而不是 undefined。 */
export function agentConfig(config: Config, agentId: string): AgentConfig {
  return config.agents[agentId] ?? { enabled: true, config: {}, models: { allow: [], deny: [] } }
}

/**
 * 该 Agent 是否启用。
 *
 * 默认启用：没在配置里写过的 Agent 应该照常工作，否则新增 Agent 会「装了但不出现」。
 */
export function isAgentEnabled(config: Config, agentId: string, defaultEnabled?: boolean): boolean {
  // 默认开关由清单给：验收成员（verificationOnly）默认关，普通成员默认开。
  return config.agents[agentId]?.enabled ?? defaultEnabled ?? true
}
