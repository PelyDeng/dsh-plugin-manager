import Schema from '@deepseek-ai/schemastery'

/** 博客工作台的部署配置。 */
export interface Config {
  /**
   * 访问模式。
   *
   * 博客按用户隔离草稿、附件与备份，业务前提就是「必须有可信身份」，所以只接受
   * `authenticated`。群组跑 standalone 时它会报认证不可用，而不是退化成匿名可写。
   */
  accessMode: 'authenticated'
  publicOrigin: string
  routePrefix: string
  runtimeConfig: string
  dataPath: string
  turnTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  accessMode: Schema.const('authenticated').default('authenticated'),
  publicOrigin: Schema.string().default(''),
  // 允许多段：迁入群组后页面前缀是 /agents/blog 这样的嵌套路径。
  routePrefix: Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/).default('/blog'),
  runtimeConfig: Schema.string().default(''),
  dataPath: Schema.string().default(''),
  turnTimeoutMs: Schema.natural().min(10000).max(900000).default(240000),
})
