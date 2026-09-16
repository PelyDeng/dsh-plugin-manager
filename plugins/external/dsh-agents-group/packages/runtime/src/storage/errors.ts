/**
 * 存储层的稳定错误码与分类。
 *
 * ⚠️ 这是**私有运行时的自有实现**，不是从 `dsh-butler-console/src/storage/errors.ts`
 * import 的：管家与群组是**两个独立的发布单元**（各自有 package.json 与版本），跨单元
 * import 内部模块会把它们的发布绑死在一起，而本次重构的目标之一正是让它们各自演进。
 * 形状与语义刻意与那份保持一致（同一套稳定码、同一套 PG 错误码映射），这样调用方、
 * 日志与运维看到的是同一套分类。
 *
 * 分工：
 *
 * - `storage_unreachable`：连不上（连接被拒、域名解析失败、连接中断、取连接超时、连接数耗尽）；
 * - `storage_auth`：认证或权限失败（口令错、库不存在、权限不足）；
 * - `storage_schema_missing`：结构缺失（表不存在）—— 由建库脚本补齐，**不自动建表**；
 * - `storage_schema_version`：结构版本不符 —— 未就绪即不服务；
 * - `storage_timeout`：语句超时或锁等待超时（事务已中止，可安全重试）；
 * - `storage_constraint`：唯一等约束冲突（携带约束名），按业务语义映射（如 409）；
 * - `storage_transaction`：可重试事务错误（序列化失败/死锁），调用方有限重试；
 * - `storage_closed`：存储已关闭（`close()` 之后拒绝继续读写），与未知故障区分；
 * - `storage_unknown`：其余未知故障。
 *
 * **业务拒绝不属于这里**（归属不存在、版本冲突、终态后写入）：它们以 kit 的 `AccessError`
 * 原样穿透，本模块不包装、不降级——否则调用方就分不清"存储坏了"与"这次请求本来就不该做"。
 */
import { AccessError } from '@dsh-plugin-manager/plugin-kit'

/** 存储层稳定错误码。 */
export type StorageErrorCode =
  | 'storage_unreachable'
  | 'storage_auth'
  | 'storage_schema_missing'
  | 'storage_schema_version'
  | 'storage_timeout'
  | 'storage_constraint'
  | 'storage_transaction'
  | 'storage_closed'
  | 'storage_unknown'

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

interface PgErrorLike {
  readonly code?: unknown
  readonly constraint?: unknown
  readonly table?: unknown
  readonly message?: unknown
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
 * 把底层错误归一为 {@link StorageError}；已是 StorageError / AccessError 的原样返回。
 *
 * 返回类型刻意是 `unknown`：本函数只用于 `throw mapStorageError(error)` 边界。
 */
export function mapStorageError(error: unknown): unknown {
  if (error instanceof StorageError) return error
  if (error instanceof AccessError) return error
  const code = pgField(error, 'code')
  const constraint = pgField(error, 'constraint')
  if (code === '23505') {
    return new StorageError('storage_constraint', `存储约束冲突：${constraint ?? pgField(error, 'table') ?? '未知约束'}`, {
      cause: error, constraint,
    })
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
    return new StorageError('storage_schema_missing', '存储结构缺失（表不存在），需要先执行建库脚本', { cause: error })
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
 * 判断错误是否是指定表（或任意表）上的唯一约束冲突，供调用方做 409 语义映射。
 *
 * @param table 传入表名时同时核对冲突所在表，避免把别的约束误判成版本冲突。
 * @returns 命中时返回约束名；未命中返回 `undefined`。
 */
export function uniqueViolation(error: unknown, table?: string): string | undefined {
  if (pgField(error, 'code') !== '23505') return undefined
  const constraint = pgField(error, 'constraint') ?? ''
  const errorTable = pgField(error, 'table') ?? ''
  if (table !== undefined && errorTable !== table) return undefined
  return constraint || errorTable || 'unknown'
}

/** 读一个存储错误的稳定码；不是存储错误时返回 `undefined`。 */
export function storageCodeOf(error: unknown): StorageErrorCode | undefined {
  return error instanceof StorageError ? error.code : undefined
}
