/**
 * 绘语的私有配置加载。
 *
 * 配置来源是**群组唯一的那份 `env.conf`**（`plugins/external/dsh-agents-group/env.conf`），
 * 本子包只认自己 `HUIYU_` 前缀的键。群组下所有子 Agent 共用这一份文件，用注释分段区分——
 * 不给子包另建 `env.conf`，理由见群组 `AGENTS.md` 的配置归属约定。
 *
 * 运行时读到的是构建派生出来的那一份（`<DSH 主目录>/plugins/agents-group/env.conf`），
 * 与源码里的形态同源。所以这里只负责「按前缀取键 + 校验」，不管文件从哪来。
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

/** 绘语运行所需的全部私有配置。 */
export interface HuiyuEnvironment {
  readonly minio: {
    readonly endpoint: string
    readonly bucket: string
    readonly region: string
    readonly accessKey: string
    readonly secretKey: string
    readonly publicBaseUrl: string
  }
  readonly image: {
    /** provider 适配器标识，见 `image/provider.ts` 的注册表。 */
    readonly provider: string
    readonly baseUrl: string
    readonly model: string
    readonly apiKey: string
  }
}

/** 一个必填键缺失或仍是占位符。消息里只出现键名，**不回显取值**——那是凭据。 */
export class EnvConfError extends Error {
  constructor(readonly key: string, reason: 'missing' | 'placeholder') {
    super(reason === 'missing'
      ? `绘语未配置：群组 env.conf 缺少 ${key}`
      : `绘语未配置：群组 env.conf 的 ${key} 仍是占位符 REPLACE_ME`)
    this.name = 'EnvConfError'
  }
}

/**
 * 取一个必填键。
 *
 * `REPLACE_ME` 与空值同等对待：模板里留下的占位符如果被当成真值用，错误会推迟到调用上游时
 * 才以"认证失败"的形式出现，那时已经看不出是配置没填。
 */
function required(values: Record<string, string | undefined>, key: string): string {
  const value = values[key]?.trim()
  if (value === undefined || value === '') throw new EnvConfError(key, 'missing')
  if (value === 'REPLACE_ME') throw new EnvConfError(key, 'placeholder')
  return value
}

/** 取一个可选键；缺失时用缺省值。 */
function optional(values: Record<string, string | undefined>, key: string, fallback: string): string {
  const value = values[key]?.trim()
  return value === undefined || value === '' ? fallback : value
}

/**
 * 解析并校验一份 `env.conf` 文本。
 *
 * 只读 `HUIYU_` 前缀的键：同一份文件里还躺着 closedoff 与 blog 的段，取错前缀会把别人的
 * 凭据当成自己的。
 *
 * @param content env.conf 的完整文本
 * @returns 校验通过的运行配置
 * @throws {EnvConfError} 必填键缺失或仍是占位符
 */
export function parseEnvConf(content: string): HuiyuEnvironment {
  const values = parseEnv(content) as Record<string, string | undefined>
  return {
    minio: {
      endpoint: required(values, 'HUIYU_MINIO_ENDPOINT'),
      bucket: required(values, 'HUIYU_MINIO_BUCKET'),
      // MinIO 的默认区域就是 us-east-1，缺省不报错。
      region: optional(values, 'HUIYU_MINIO_REGION', 'us-east-1'),
      accessKey: required(values, 'HUIYU_MINIO_ACCESS_KEY'),
      secretKey: required(values, 'HUIYU_MINIO_SECRET_KEY'),
      publicBaseUrl: required(values, 'HUIYU_PUBLIC_BASE_URL'),
    },
    image: {
      provider: optional(values, 'HUIYU_IMAGE_PROVIDER', 'openai-images'),
      baseUrl: required(values, 'HUIYU_IMAGE_BASE_URL'),
      model: required(values, 'HUIYU_IMAGE_MODEL'),
      apiKey: required(values, 'HUIYU_IMAGE_API_KEY'),
    },
  }
}

/**
 * 从群组 env.conf 加载绘语的配置。
 *
 * 默认位置交给 common 的 `agentResource` 解析：源码被打进群组 dist 后，代码与资源的相对位置
 * 在开发与发布两种形态下不同，写死 `../` 层数会静默错位。
 *
 * @param source 覆盖默认位置（测试用）
 * @returns 校验通过的运行配置
 * @throws {EnvConfError} 配置缺失；文件读不到时抛出带路径的错误
 */
export async function loadEnvConf(source?: string | URL): Promise<HuiyuEnvironment> {
  const target = source ?? groupEnvConfPath(import.meta.url)
  let text: string
  try {
    text = await readFile(target, 'utf8')
  } catch (cause: unknown) {
    const path = typeof target === 'string' ? target : fileURLToPath(target)
    throw new Error(`绘语读不到群组 env.conf（${path}）：请确认它存在且包含 HUIYU_ 段`, { cause })
  }
  return parseEnvConf(text)
}

/**
 * 群组 env.conf 的位置：插件根下的 `env.conf`。
 *
 * ⚠️ **不能用 common 的 `agentResource`**：它固定拼 `agents/<id>/`，指向的是子包目录；
 * 而群组统一配置在**插件根**（`agents/<id>/` 的上一层）。所以这里自己向上找插件根。
 *
 * 与 `agent-resources.ts` 用同一个结构判据（同时含 `package.json` 与 `agents/`），
 * 而不是写死层数：源码被打进群组 `dist/` 后，代码到插件根的距离在开发与发布两种形态下不同。
 *
 * @returns 插件根下 `env.conf` 的路径
 * @throws 找不到插件根时
 */
function groupEnvConfPath(moduleUrl: string): string {
  let current = new URL(moduleUrl)
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = new URL('../', current)
    if (candidate.href === current.href) break
    if (existsSync(fileURLToPath(new URL('agents/', candidate)))
      && existsSync(fileURLToPath(new URL('package.json', candidate)))) {
      return fileURLToPath(new URL('env.conf', candidate))
    }
    current = candidate
  }
  throw new Error(`绘语找不到插件根：从 ${moduleUrl} 向上都没有同时含 agents/ 与 package.json 的目录`)
}
