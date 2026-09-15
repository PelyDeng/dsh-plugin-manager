import Schema from '@deepseek-ai/schemastery'

/** 牛马-老板的部署配置。字段名与 `cordis.patch.yml`、管理器生成的 patch 保持一致。 */
export interface Config {
  accessMode: 'standalone' | 'authenticated'
  publicOrigin: string
  routePrefix: string
}

/** Cordis 配置 schema。每个字段都有默认值，管理器的 patch 会整体替换 config。 */
export const Config: Schema<Config> = Schema.object({
  accessMode: Schema.union(['standalone', 'authenticated']).default('authenticated'),
  publicOrigin: Schema.string().default(''),
  routePrefix: Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/).default('/niuma-boss'),
})
