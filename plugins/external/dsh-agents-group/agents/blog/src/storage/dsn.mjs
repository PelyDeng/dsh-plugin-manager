/**
 * blog 业务库 PostgreSQL 连接配置的来源解析（复制管家 butler-console 的 dsn.ts 模式，
 * 不跨插件 import；变量名按方案 Q5，不混入 AGENTS_GROUP_CONFIG）。
 *
 * 优先级两路：
 *
 * 1. 环境变量 `AGENTS_GROUP_PG_DSN`（开发/测试）：直接给 DSN；
 * 2. 私有配置文件：环境变量 `AGENTS_GROUP_PG_CONFIG` 指定路径，未指定时回落到
 *    `<DSH 主目录>/plugins/agents-group/storage.json`（存在才读），内容形如
 *    `{"dsn":"postgres://…"}`。默认路径由调用方以 dshHomePath 解析后传入（接线在
 *    B2-2b：群组根 manifest 的插件 id 为 `agents-group`）。
 *
 * 两处都没有返回 `undefined`，由装载方按「blog 未就绪」处理并说明配置方法——绝不静默
 * 回退 SQLite。凭据只走环境变量与该私有文件，不进 cordis 配置与 Git。文件存在但读不出
 * 合法 DSN 属于配置错误：如实抛出，不当作「没有配置」。
 */

/** @returns {{ dsn: string, origin: 'env' | 'file' } | undefined} */
export async function resolveStorageDsn(env, defaultConfigPath, readTextFile) {
  const fromEnv = env.AGENTS_GROUP_PG_DSN?.trim() ?? ''
  if (fromEnv !== '') return { dsn: fromEnv, origin: 'env' }

  const path = env.AGENTS_GROUP_PG_CONFIG?.trim() || defaultConfigPath
  let text
  try {
    text = await readTextFile(path)
  } catch {
    return undefined // 文件不存在：视为没有配置，由调用方按 blog 未就绪说明。
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`PostgreSQL 配置文件不是有效 JSON（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
  const dsn = typeof parsed === 'object' && parsed !== null && typeof parsed.dsn === 'string' ? parsed.dsn.trim() : ''
  if (dsn === '') throw new Error(`PostgreSQL 配置文件（${path}）缺少非空的 "dsn" 字段`)
  return { dsn, origin: 'file' }
}
