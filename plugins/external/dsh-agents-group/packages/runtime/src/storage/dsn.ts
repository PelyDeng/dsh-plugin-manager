/**
 * Agent 业务库 PostgreSQL 连接配置的来源解析。
 *
 * 机制只实现一次：这是运行时对「DSN 从哪来」的唯一实现，closedoff（P4）与 blog（P7）共用，
 * 各自只传自己的 `defaultConfigPath`。
 *
 * 优先级两路：
 *
 * 1. 环境变量 `AGENTS_GROUP_PG_DSN`（开发/测试）：trim 后非空即用，`origin: 'env'`；
 * 2. 私有配置文件：环境变量 `AGENTS_GROUP_PG_CONFIG` 指定路径，未指定时用调用方传入的缺省
 *    路径（由调用方用 `dshHomePath` 解析，群组侧是
 *    `<DSH 主目录>/plugins/agents-group/env.conf`），`origin: 'file'`。
 *
 * ## 配置文件支持两种写法（**格式与全项目统一：`env.conf` 用 KEY=VALUE**）
 *
 * 先按 JSON 解析（`{"dsn":"postgres://…"}`）——旧部署的归档与私有文件都是这个形状，不能因为
 * 改名就让它们失效；JSON 解析失败时再按 `env.conf` 的 KEY=VALUE 解析：
 *
 * ```
 * AGENTS_GROUP_PG_DSN=postgresql://用户:密码@主机:5432/库名
 * ```
 *
 * 两种都解析不出 DSN 才按配置错误抛出。判据是**内容**而不是名字：改文件名的动作与改格式的
 * 动作因此可以分开做，中间任何一刻都有一套可用的配置。
 *
 * 键名沿用环境变量那个名字（`AGENTS_GROUP_PG_DSN`），这样同一份文件既能被本函数读、也能被
 * 直接 `set -a; . env.conf` 之类的方式喂进环境变量 —— 与根 `env.conf` 的既有用法一致。
 *
 * 两处都没有返回 `undefined`，由装载方按「该 Agent 未就绪」处理并说明配置方法——**绝不静默
 * 回退 SQLite**。文件存在但读不出合法 DSN 属于配置错误：如实抛出（消息里带路径与原因），
 * 不当作「没有配置」。DSN 是凭据，只走环境变量与该私有文件：不进 cordis 配置、不进 Git，
 * 也不进日志。
 *
 * 三个入参都是注入的（`env` / `defaultConfigPath` / `readTextFile`），这是刻意的可测试性
 * 设计：本文件**不** `import node:fs`，读文件由调用方给，于是优先级与全部错误分支都能在纯
 * 内存里钉住，不必碰真实文件系统或真实 PG。
 */
import { parseEnv } from 'node:util'

/** 配置文件里承载 DSN 的键名；与同名环境变量一致。 */
const DSN_KEY = 'AGENTS_GROUP_PG_DSN'

/** 解析结果：DSN 与它来自哪一路；与函数签名里的内联返回类型是同一个类型。 */
export interface ResolvedDsn {
  readonly dsn: string
  readonly origin: 'env' | 'file'
}

/** 只看这两个变量的环境（`process.env` 天然满足）。 */
export interface DsnEnv {
  readonly AGENTS_GROUP_PG_DSN?: string | undefined
  readonly AGENTS_GROUP_PG_CONFIG?: string | undefined
}

export async function resolveStorageDsn(
  env: DsnEnv,
  defaultConfigPath: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<{ readonly dsn: string; readonly origin: 'env' | 'file' } | undefined> {
  const fromEnv = env.AGENTS_GROUP_PG_DSN?.trim() ?? ''
  if (fromEnv !== '') return { dsn: fromEnv, origin: 'env' }

  const path = env.AGENTS_GROUP_PG_CONFIG?.trim() || defaultConfigPath
  let text: string
  try {
    text = await readTextFile(path)
  } catch {
    return undefined // 文件不存在：视为没有配置，由调用方按「未就绪」说明。
  }
  const dsn = readDsn(text, path)
  if (dsn === '') throw new Error(`PostgreSQL 配置文件（${path}）里没有可用的 DSN：既不是 {"dsn":"…"}，也没有 ${DSN_KEY}=…`)
  return { dsn, origin: 'file' }
}

/**
 * 从配置文件内容里读出 DSN。**先 JSON、后 KEY=VALUE**（顺序与理由见文件头）。
 *
 * 两个刻意的细节：
 *
 * - **JSON 解析失败不算错**，那正是 `env.conf` 这种写法的正常入口，所以继续尝试 K/V；
 * - **JSON 解析成功但 `dsn` 不是非空字符串时，直接按"没有 DSN"返回空串**，不再回退 K/V ——
 *   文件已经明确是 JSON 了，还去按 K/V 找一遍只会把"字段名写错"（例如写成 `DSN`）这种
 *   配置错误伪装成"文件格式不对"，而前者的提示更接近真因。
 */
function readDsn(text: string, path: string): string {
  let parsed: unknown
  let isJson = true
  try {
    parsed = JSON.parse(text)
  } catch {
    isJson = false // 不是 JSON：按 env.conf 的 KEY=VALUE 继续。
  }
  if (isJson) {
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { dsn?: unknown }).dsn === 'string'
      ? (parsed as { dsn: string }).dsn.trim()
      : ''
  }
  // `node:util` 的 parseEnv 是 Node 内置实现：注释、空行、引号、`export ` 前缀都能正确处理，
  // 不在这里重写一份解析器（项目里 closedoff 的业务凭据也走它）。
  const values = parseEnv(text)
  const value = values[DSN_KEY]
  if (typeof value !== 'string') return ''
  // 未加引号的值在 parseEnv 里会保留行尾注释之外的全部内容；DSN 不含空格，直接 trim。
  return value.trim()
}
