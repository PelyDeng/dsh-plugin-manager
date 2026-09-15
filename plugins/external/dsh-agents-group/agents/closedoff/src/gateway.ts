/** Authenticated read-only access to the closed-off business gateway. */

import type { Config } from './config.ts'
import type { ClosedoffEnvironment } from './env.ts'
import type { ToolSpec } from './specs.ts'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

interface TokenState {
  value: string
  expiresAt: number
}

const EXPIRED_CODES = new Set([1001, 1003])

/** Whether a value is a plain JSON object. */
export function isJsonObject(value: JsonValue | unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel()
    throw new Error(`gateway response exceeds ${String(limit)} bytes`)
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new Error(`gateway response exceeds ${String(limit)} bytes`)
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseJson(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch (error: unknown) {
    throw new Error('gateway returned a non-JSON response', { cause: error })
  }
}

function formatDate(value: Date): string {
  const part = (number: number) => String(number).padStart(2, '0')
  return `${String(value.getFullYear())}-${part(value.getMonth() + 1)}-${part(value.getDate())} ${part(value.getHours())}:${part(value.getMinutes())}:${part(value.getSeconds())}`
}

function hasDateValue(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

function parseDate(value: JsonValue | undefined, key: string): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim())
  if (match === null) throw new Error(`${key} must use yyyy-MM-dd HH:mm:ss`)
  const parts = match.slice(1).map(Number)
  const [year, month, day, hour, minute, second] = parts as [number, number, number, number, number, number]
  const parsed = new Date(0)
  parsed.setFullYear(year, month - 1, day)
  parsed.setHours(hour, minute, second, 0)
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
    || parsed.getHours() !== hour
    || parsed.getMinutes() !== minute
    || parsed.getSeconds() !== second
  ) throw new Error(`${key} is not a valid date and time`)
  return parsed
}

function resolveTimeRange(
  spec: ToolSpec,
  args: Readonly<JsonObject>,
  maxDays: number,
): { args: JsonObject; note?: string } {
  const resolved: JsonObject = { ...args }
  const ranges = spec.timeRanges ?? []
  if (ranges.length === 0) return { args: resolved }
  const suppliedRanges = ranges.filter(range => hasDateValue(args[range.startKey]) || hasDateValue(args[range.endKey]))
  const activeRanges = suppliedRanges.length > 0 ? suppliedRanges : ranges.slice(0, 1)
  const notes = new Set<string>()
  const now = new Date()
  const maxDurationMs = maxDays * 24 * 60 * 60 * 1000

  for (const range of activeRanges) {
    const suppliedEnd = parseDate(args[range.endKey], range.endKey)
    const end = suppliedEnd === undefined || suppliedEnd > now ? now : suppliedEnd
    const earliest = new Date(end.getTime() - maxDurationMs)
    const suppliedStart = parseDate(args[range.startKey], range.startKey)
    let start = suppliedStart
    if (start === undefined) {
      start = earliest
      notes.add(`未指定开始时间，默认最近 ${String(maxDays)} 天`)
    } else if (start < earliest) {
      start = earliest
      notes.add(`时间范围超过上限，已按最近 ${String(maxDays)} 天`)
    } else if (start > end) {
      start = earliest
      notes.add(`时间范围无效，已按最近 ${String(maxDays)} 天`)
    }
    resolved[range.startKey] = formatDate(start)
    resolved[range.endKey] = formatDate(end)
  }
  const note = [...notes].join('；')
  return { args: resolved, ...(note === '' ? {} : { note }) }
}

/** Gateway result returned to the model as canonical JSON. */
export interface GatewayResult extends JsonObject {
  api: string
  ok: boolean
  elapsedMs: number
}

/** Owns credentials, token refresh, request limits, and remote response validation. */
export class ClosedoffGateway {
  private token: TokenState | undefined
  private loginPromise: Promise<string> | undefined

  constructor(
    private readonly config: Config,
    private readonly environment: ClosedoffEnvironment,
  ) {}

  private async requestJson(
    url: URL,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs)
    const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, timeout]) })
    const text = await readLimitedText(response, this.config.maxResponseBodyBytes)
    if (!response.ok) throw new Error(`gateway HTTP ${String(response.status)}`)
    return parseJson(text)
  }

  private async login(signal: AbortSignal): Promise<string> {
    const credentials = this.environment.credentials
    const firstUrl = new URL('system/openApi/public/getAccessToken', `${this.environment.baseUrl.replace(/\/$/, '')}/`)
    const first = await this.requestJson(firstUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: credentials.openClientId, clientSecret: credentials.openClientSecret }),
    }, signal)
    if (!isJsonObject(first) || first.success === false || typeof first.data !== 'string' || first.data === '') {
      throw new Error('closed-off gateway rejected first-stage authentication')
    }

    const secondUrl = new URL('openApi/oauth2/obtainAccessTokenWithClientInfo', `${this.environment.baseUrl.replace(/\/$/, '')}/`)
    secondUrl.searchParams.set('accessToken', first.data)
    const second = await this.requestJson(secondUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appCode: credentials.appCode,
        clientId: credentials.appClientId,
        clientSecret: credentials.appClientSecret,
        username: credentials.username,
      }),
    }, signal)
    if (!isJsonObject(second) || second.success === false || !isJsonObject(second.data)) {
      throw new Error('closed-off gateway rejected second-stage authentication')
    }
    const value = second.data.tokenValue
    const timeoutSeconds = second.data.tokenTimeout
    if (typeof value !== 'string' || value === '' || typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds)) {
      throw new Error('closed-off gateway returned an invalid token response')
    }
    this.token = {
      value,
      expiresAt: Date.now() + Math.max(1, timeoutSeconds - 120) * 1000,
    }
    return value
  }

  private async getToken(signal: AbortSignal): Promise<string> {
    if (this.token !== undefined && Date.now() < this.token.expiresAt) return this.token.value
    this.loginPromise ??= this.login(signal).finally(() => { this.loginPromise = undefined })
    return this.loginPromise
  }

  private requestUrl(spec: ToolSpec, args: Readonly<JsonObject>): URL {
    let path: string = spec.path
    if (spec.pathParamKey !== undefined) {
      const value = args[spec.pathParamKey]
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new Error(`missing path parameter "${spec.pathParamKey}"`)
      }
      path = path.replace(`{${spec.pathParamKey}}`, encodeURIComponent(String(value)))
    }
    const url = new URL(path.replace(/^\//, ''), `${this.environment.baseUrl.replace(/\/$/, '')}/`)
    if (spec.method === 'GET') {
      for (const param of spec.params) {
        if (param.key === spec.pathParamKey) continue
        const value = args[param.key]
        if (value === undefined || value === null || value === '') continue
        url.searchParams.set(param.key, Array.isArray(value) ? value.join(',') : String(value))
      }
    }
    return url
  }

  private requestBody(spec: ToolSpec, args: Readonly<JsonObject>): string | undefined {
    if (spec.method !== 'POST') return undefined
    const body: JsonObject = {}
    for (const param of spec.params) {
      const value = args[param.key]
      if (value !== undefined && value !== null && value !== '') body[param.key] = value
    }
    return JSON.stringify(body)
  }

  /** Execute one approved query and return a lossless model-facing result. */
  async call(spec: ToolSpec, input: Readonly<JsonObject>, signal: AbortSignal): Promise<GatewayResult> {
    const started = Date.now()
    try {
      const pageSize = input.pageSize
      if (typeof pageSize === 'number' && pageSize > this.config.maxPageSize) {
        throw new Error(`pageSize cannot exceed ${String(this.config.maxPageSize)}`)
      }
      const resolved = resolveTimeRange(spec, input, Math.min(spec.maxDays ?? this.config.maxQueryRangeDays, this.config.maxQueryRangeDays))
      return await this.callOnce(spec, resolved.args, signal, started, resolved.note, false)
    } catch (error: unknown) {
      return { api: spec.path, ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: Date.now() - started }
    }
  }

  private async callOnce(
    spec: ToolSpec,
    args: Readonly<JsonObject>,
    signal: AbortSignal,
    started: number,
    note: string | undefined,
    retried: boolean,
  ): Promise<GatewayResult> {
    const token = await this.getToken(signal)
    const requestBody = this.requestBody(spec, args)
    const parsed = await this.requestJson(this.requestUrl(spec, args), {
      method: spec.method,
      headers: { authorization: `Bearer ${token}`, ...(spec.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(requestBody === undefined ? {} : { body: requestBody }),
    }, signal)
    if (!isJsonObject(parsed)) throw new Error('gateway response root must be a JSON object')
    if (parsed.success === false) {
      if (!retried && typeof parsed.errCode === 'number' && EXPIRED_CODES.has(parsed.errCode)) {
        this.token = undefined
        return this.callOnce(spec, args, signal, started, note, true)
      }
      return {
        api: spec.path,
        ok: false,
        errCode: parsed.errCode ?? null,
        message: typeof parsed.message === 'string' ? parsed.message : '业务接口返回失败',
        elapsedMs: Date.now() - started,
      }
    }
    return {
      api: spec.path,
      ok: true,
      success: parsed.success ?? true,
      data: parsed.data ?? null,
      ...(parsed.totalCount === undefined ? {} : { totalCount: parsed.totalCount }),
      ...(parsed.pageIndex === undefined ? {} : { pageIndex: parsed.pageIndex }),
      ...(parsed.pageSize === undefined ? {} : { pageSize: parsed.pageSize }),
      ...(note === undefined ? {} : { note }),
      elapsedMs: Date.now() - started,
    }
  }
}
