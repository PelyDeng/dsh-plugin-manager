/**
 * PostgreSQL 连接配置的来源解析（方案 §2.5 启动序列 / §4.4 DSN 只走私有渠道）。
 *
 * 优先级两路：
 *
 * 1. 环境变量 `BUTLER_PG_DSN`（开发/测试）：直接给 DSN；
 * 2. 私有配置文件：环境变量 `BUTLER_PG_CONFIG` 指定路径，未指定时回落到
 *    `<DSH 主目录>/plugins/butler/storage.json`（存在才读），内容形如 `{"dsn":"postgres://…"}`。
 *
 * 两处都没有返回 `undefined`，由 apply 按「装载失败」处理并说明配置方法——**绝不静默回退
 * SQLite**。凭据只走环境变量与该私有文件，不进 cordis 配置与 Git（无凭据模板文件由 T1-3
 * 提供）。文件存在但读不出合法 DSN 属于配置错误：如实抛出，不当作「没有配置」。
 */

export interface ResolvedDsn {
  readonly dsn: string
  readonly origin: 'env' | 'file'
}

export interface DsnEnv {
  readonly BUTLER_PG_DSN?: string | undefined
  readonly BUTLER_PG_CONFIG?: string | undefined
}

export async function resolveStorageDsn(
  env: DsnEnv,
  defaultConfigPath: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<ResolvedDsn | undefined> {
  const fromEnv = env.BUTLER_PG_DSN?.trim() ?? ''
  if (fromEnv !== '') return { dsn: fromEnv, origin: 'env' }

  const path = env.BUTLER_PG_CONFIG?.trim() || defaultConfigPath
  let text: string
  try {
    text = await readTextFile(path)
  } catch {
    return undefined // 文件不存在：视为没有配置，由调用方按装载失败说明。
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`PostgreSQL 配置文件不是有效 JSON（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }
  const dsn = typeof parsed === 'object' && parsed !== null && typeof (parsed as { dsn?: unknown }).dsn === 'string'
    ? (parsed as { dsn: string }).dsn.trim()
    : ''
  if (dsn === '') throw new Error(`PostgreSQL 配置文件（${path}）缺少非空的 "dsn" 字段`)
  return { dsn, origin: 'file' }
}
