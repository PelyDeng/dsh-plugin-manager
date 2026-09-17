/**
 * blog 业务存储的错误类型与稳定错误码（复制管家 butler-console 的 errors.ts 模式，
 * 不跨插件 import——群组插件保持自己的副本）。
 *
 * 调用方按稳定码做 503/409 映射，不感知底层驱动细节：
 *
 * - `storage_unreachable`：连不上（连接被拒、域名解析失败、连接中断、取连接超时、连接数耗尽）；
 * - `storage_auth`：认证或权限失败（口令错、库不存在、权限不足）；
 * - `storage_schema_missing`：结构缺失（表不存在）—— 由显式迁移工具补齐，不自动建表；
 * - `storage_schema_version`：结构版本不符 —— 未就绪即不服务；
 * - `storage_unconfigured`：没有提供连接配置（B2-2b 接线新增）—— blog 以未就绪口径 503，
 *   消息说明两条配置路径；与其他可用性故障一样不触发群组级失败；
 * - `storage_timeout`：语句超时或锁等待超时（事务已中止，可安全重试）；
 * - `storage_constraint`：唯一等约束冲突（携带约束名），按业务语义映射；
 * - `storage_transaction`：可重试事务错误（序列化失败/死锁），调用方有限重试；
 * - `storage_closed`：存储已关闭（`close()` 之后拒绝继续读写），与未知故障区分；
 * - `storage_unknown`：其余未知故障。
 *
 * 业务拒绝（归属不存在、版本冲突、终态后写入）不属于这里：它们以 settings.ts 的
 * `BlogError`（DSH_ACCESS_ERROR）原样穿透，本模块不包装、不降级。
 */

import { BlogError } from '../settings.ts'

/** 存储层稳定错误码。 */
export const STORAGE_ERROR_CODES = [
  'storage_unreachable', 'storage_auth', 'storage_schema_missing', 'storage_schema_version',
  'storage_unconfigured', 'storage_timeout', 'storage_constraint', 'storage_transaction', 'storage_closed', 'storage_unknown',
]

/** 稳定错误码的联合类型（与上面的清单逐项对应；`storage_unconfigured` 是 blog 这一份特有的）。 */
export type StorageErrorCode =
  | 'storage_unreachable'
  | 'storage_auth'
  | 'storage_schema_missing'
  | 'storage_schema_version'
  | 'storage_unconfigured'
  | 'storage_timeout'
  | 'storage_constraint'
  | 'storage_transaction'
  | 'storage_closed'
  | 'storage_unknown'

/**
 * `StorageError` 的可选构造参数。
 *
 * `constraint` 写成 `?: string | undefined`（与 `packages/runtime/src/storage/errors.ts` 同一写法）：
 * `exactOptionalPropertyTypes` 下"键不存在"与"键存在但值为 undefined"是两回事，而映射表里
 * `constraint` 本来就可能取不到（`pgField()` 返回 `string | undefined`）。
 */
export interface StorageErrorOptions {
  readonly cause?: unknown
  /** `storage_constraint` 时携带约束名。 */
  readonly constraint?: string | undefined
  /** 语句超时与可重试事务错误为 true，调用方可以做有限重试。 */
  readonly retryable?: boolean
}

/** 存储层故障；`code` 是跨实现的稳定码。 */
export class StorageError extends Error {
  readonly code: StorageErrorCode
  readonly retryable: boolean
  readonly constraint: string | undefined
  constructor(code: StorageErrorCode, message: string, options: StorageErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'StorageError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.constraint = options.constraint
  }
}

/** `pg` / `node:net` 之类的底层错误里本模块会读的那几个字段（其余一概不碰）。 */
interface PgErrorLike {
  readonly code?: unknown
  readonly constraint?: unknown
  readonly table?: unknown
  readonly message?: unknown
}

/**
 * **结构识别**一份存储故障——**不是 `instanceof`**。
 *
 * 为什么必须有它：同一个协议在本仓有**至少三份独立实现**（本模块、
 * `packages/runtime/src/storage/errors.ts`、`dsh-butler-console/src/storage/errors.ts`，
 * 后者自己的注释就写明"这是私有运行时的自有实现，不是从别处复制"）。
 * 而 blog 的 HTTP 边界（`index.ts` 的 `blogStorageErrorHandler`）要处理的错误**来自两侧**：
 * 未配置占位抛的是**本模块**的类，而配好之后索引侧的一切故障都由**运行时那一份**抛出。
 * `instanceof` 认不出对方那一份 ⇒ 本该是 **503 + 稳定码** 的存储故障会掉进"未知错误"分支变成
 * **500「请求处理失败」**，把 runbook 第 5 步要运维去看的那个稳定码**整条抹掉**。
 *
 * kit 为同一个问题早就做过同样的选择：`isAccessError`（`packages/plugin-kit/src/access.ts:112-117`）
 * 的注释就是 "Recognize errors emitted by another independently bundled copy of this protocol"。
 * 这里与它逐条对齐：认 `name` + `code` + `message` 三个**稳定字段**，不认原型链。
 *
 * 判据刻意**不要求 `code` 在 `STORAGE_ERROR_CODES` 里**：未知码在映射表里本来就有归宿
 * （`storage_unknown` → 500 + 带上原码），提前拒掉会让它反而失去那个归宿。
 */
export function isStorageError(error: unknown): error is StorageError {
  // 断言只为了让下面读 `name`/`code`/`message`；`typeof` 那一关仍然先跑（取值顺序与原来逐字相同）。
  const candidate = error as PgErrorLike & { readonly name?: unknown }
  return typeof error === 'object' && error !== null
    && candidate.name === 'StorageError'
    && typeof candidate.code === 'string'
    && typeof candidate.message === 'string'
}

function pgField(error: unknown, field: keyof PgErrorLike): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as PgErrorLike)[field]
  return typeof value === 'string' ? value : undefined
}

/** 连接层错误码（libpq 连接状态、连接数耗尽，以及后端消失的 57P01/57P02）。 */
const UNREACHABLE_CODES = new Set(['08000', '08001', '08003', '08004', '08006', '53300', '57P01', '57P02'])
/** 操作系统级网络错误（node:net 产出，pg 原样透传）。 */
const UNREACHABLE_SYSTEM_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
])
/** 序列化失败与死锁：事务已回滚，整事务重试是安全的。 */
const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01'])
/** 语句超时（57014）与锁等待超时（55P03）：事务已中止，可安全重试。 */
const TIMEOUT_CODES = new Set(['57014', '55P03'])
/** 认证失败、库不存在、权限不足。 */
const AUTH_CODES = new Set(['28P01', '3D000', '42501'])

/**
 * 把底层错误归一为 StorageError；已是 StorageError / BlogError 的原样返回。
 * 只用于 `throw mapStorageError(error)` 边界，不参与正常类型流。
 *
 * 返回类型就是这两支：`instanceof` 命中时原样返回，其余一律 `new StorageError(...)`。
 */
export function mapStorageError(error: unknown): StorageError | BlogError {
  if (error instanceof StorageError) return error
  if (error instanceof BlogError) return error
  const code = pgField(error, 'code')
  const constraint = pgField(error, 'constraint')
  if (code === '23505') {
    return new StorageError('storage_constraint', `存储约束冲突：${constraint ?? pgField(error, 'table') ?? '未知约束'}`, { cause: error, constraint })
  }
  if (RETRYABLE_TRANSACTION_CODES.has(code ?? '')) {
    return new StorageError('storage_transaction', '存储事务冲突（序列化失败或死锁），可整事务重试', { cause: error, retryable: true })
  }
  if (TIMEOUT_CODES.has(code ?? '')) {
    return new StorageError('storage_timeout', '存储语句超时或锁等待超时', { cause: error, retryable: true })
  }
  if (AUTH_CODES.has(code ?? '')) {
    return new StorageError('storage_auth', '存储认证或权限失败', { cause: error })
  }
  if (code === '42P01') {
    return new StorageError('storage_schema_missing', '存储结构缺失（表不存在），需要先执行迁移', { cause: error })
  }
  if (code !== undefined && (UNREACHABLE_CODES.has(code) || UNREACHABLE_SYSTEM_CODES.has(code))) {
    return new StorageError('storage_unreachable', '存储连接失败', { cause: error })
  }
  // pg Pool 取连接超时（connectionTimeoutMillis 耗尽）：连接拿不到，等同后端不可达。
  const message = pgField(error, 'message') ?? (error instanceof Error ? error.message : '')
  if (message.includes('timeout exceeded when trying to connect')) {
    return new StorageError('storage_unreachable', '存储连接超时（取连接失败）', { cause: error })
  }
  return new StorageError('storage_unknown', '存储未知故障', { cause: error })
}

/**
 * 判断一个错误是否是指定表（或任意表）上的唯一约束冲突，供调用方做 409 语义映射。
 * @param table 传入表名时同时核对冲突所在表，避免把别的约束误判成目标冲突。
 * @returns 命中时返回约束名；未命中返回 undefined。
 */
export function uniqueViolation(error: unknown, table?: string): string | undefined {
  if (pgField(error, 'code') !== '23505') return undefined
  const constraint = pgField(error, 'constraint') ?? ''
  const errorTable = pgField(error, 'table') ?? ''
  if (table !== undefined && errorTable !== table) return undefined
  return constraint || errorTable || 'unknown'
}
