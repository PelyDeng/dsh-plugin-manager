import Schema from '@deepseek-ai/schemastery'

/** Deployment values for the closed-off assistant. */
export interface Config {
  accessMode: 'standalone' | 'authenticated'
  publicOrigin: string
  authRecheckMs: number
  reasoningEffort: string
  terrainUrl: string
  tilesetUrl: string
  tilesetHeight: number
  trackDeviceRadiusMeters: number
  trackDwellMaxGapSeconds: number
  routePrefix: string
  requestTimeoutMs: number
  toolTimeoutMs: number
  turnTimeoutMs: number
  maxPageSize: number
  maxQueryRangeDays: number
  maxRequestBodyBytes: number
  maxResponseBodyBytes: number
  maxActiveConversations: number
}

/** Cordis configuration schema. */
export const Config: Schema<Config> = Schema.object({
  accessMode: Schema.union(['standalone', 'authenticated']).default('standalone'),
  publicOrigin: Schema.string().default(''),
  authRecheckMs: Schema.natural().min(100).max(30000).default(1000),
  reasoningEffort: Schema.string().pattern(/^(?:off|low|high|max)$/).default('low'),
  terrainUrl: Schema.string().pattern(/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/)
    .default('https://hyzhmodel.scshyzh.cn:50068/Models/ChongQing/Terrain/ChongQing_all'),
  tilesetUrl: Schema.string().pattern(/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/)
    .default('https://hyzhmodel.scshyzh.cn:50068/Models/ChongQing/Fuling/Models/B3DM/tileset.json'),
  tilesetHeight: Schema.number().min(-10000).max(10000).default(60),
  trackDeviceRadiusMeters: Schema.number().min(1).max(10000).default(100),
  trackDwellMaxGapSeconds: Schema.natural().min(1).max(3600).default(300),
  routePrefix: Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/).default('/closedoff-qa'),
  requestTimeoutMs: Schema.natural().min(1000).max(120000).default(20000),
  toolTimeoutMs: Schema.natural().min(1000).max(600000).default(45000),
  turnTimeoutMs: Schema.natural().min(1000).max(1800000).default(480000),
  maxPageSize: Schema.natural().min(1).max(1000).default(500),
  maxQueryRangeDays: Schema.natural().min(1).max(366).default(30),
  maxRequestBodyBytes: Schema.natural().min(1024).max(1048576).default(65536),
  maxResponseBodyBytes: Schema.natural().min(1024).max(16777216).default(2097152),
  maxActiveConversations: Schema.natural().min(1).max(500).default(50),
})
