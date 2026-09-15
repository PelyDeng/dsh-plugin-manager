/** Private deployment configuration loaded from env.conf. */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { agentResource } from '@dsh-agents-group/common'

/** Credentials for the gateway's two authentication stages. */
export interface CredentialPayload {
  readonly openClientId: string
  readonly openClientSecret: string
  readonly appCode: string
  readonly appClientId: string
  readonly appClientSecret: string
  readonly username: string
}

/** Validated private values used by the business gateway. */
export interface ClosedoffEnvironment {
  readonly baseUrl: string
  readonly credentials: CredentialPayload
}

function required(values: Record<string, string | undefined>, key: string): string {
  const value = values[key]?.trim()
  if (value === undefined || value === '' || value === 'REPLACE_ME') {
    throw new Error(`closedoff-assistant env.conf requires configured "${key}"`)
  }
  return value
}

/** Parse and validate the private plugin configuration without exposing values. */
export function parseEnvConf(content: string): ClosedoffEnvironment {
  const values = parseEnv(content)
  const baseUrl = required(values, 'CLOSEDOFF_BASE_URL')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch (cause: unknown) {
    throw new Error('closedoff-assistant env.conf requires a valid CLOSEDOFF_BASE_URL', { cause })
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('closedoff-assistant env.conf requires an HTTPS CLOSEDOFF_BASE_URL')
  }
  if (parsedUrl.hostname.endsWith('.example')) {
    throw new Error('closedoff-assistant env.conf requires a configured CLOSEDOFF_BASE_URL')
  }
  return {
    baseUrl,
    credentials: {
      openClientId: required(values, 'CLOSEDOFF_OPEN_CLIENT_ID'),
      openClientSecret: required(values, 'CLOSEDOFF_OPEN_CLIENT_SECRET'),
      appCode: required(values, 'CLOSEDOFF_APP_CODE'),
      appClientId: required(values, 'CLOSEDOFF_APP_CLIENT_ID'),
      appClientSecret: required(values, 'CLOSEDOFF_APP_CLIENT_SECRET'),
      username: required(values, 'CLOSEDOFF_USERNAME'),
    },
  }
}

/**
 * Load env.conf beside the plugin, or from the path supplied by the start script.
 *
 * 默认路径交给 common 的 `agentResource` 解析：源码被打进群组 dist 后，代码与资源的相对
 * 位置在开发与发布两种形态下不同，写死 `../` 层数会静默错位。
 */
export async function loadEnvConf(
  source: string | URL = process.env.CLOSEDOFF_ENV_CONF ?? agentResource(import.meta.url, 'closedoff', 'env.conf'),
): Promise<ClosedoffEnvironment> {
  try {
    return parseEnvConf(await readFile(source, 'utf8'))
  } catch (cause: unknown) {
    if (cause instanceof Error && cause.message.startsWith('closedoff-assistant env.conf')) throw cause
    const path = typeof source === 'string' ? source : fileURLToPath(source)
    throw new Error(`closedoff-assistant cannot load env.conf from "${path}"`, { cause })
  }
}
