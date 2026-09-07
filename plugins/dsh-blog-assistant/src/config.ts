import Schema from '@deepseek-ai/schemastery'
export interface Config { accessMode:'authenticated'; publicOrigin:string; routePrefix:string; runtimeConfig:string; dataPath:string; turnTimeoutMs:number }
export const Config:Schema<Config> = Schema.object({
  accessMode:Schema.const('authenticated').default('authenticated'),
  publicOrigin:Schema.string().default(''),
  routePrefix:Schema.string().pattern(/^\/[a-z0-9][a-z0-9-]*$/).default('/blog'),
  runtimeConfig:Schema.string().default(''),
  dataPath:Schema.string().default(''),
  turnTimeoutMs:Schema.natural().min(10000).max(900000).default(240000),
})
