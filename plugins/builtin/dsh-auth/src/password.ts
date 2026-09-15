/** Password hashing; persisted hashes include their scrypt parameters. */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

export interface PasswordHash {
  algorithm: 'scrypt'
  salt: string
  hash: string
  cost: number
  blockSize: number
  parallelization: number
}

/** Bound password work and reject short credentials. */
export function validatePassword(password: string): void {
  if (password.length < 8 || password.length > 256) throw new Error('密码长度必须为 8 至 256 个字符')
}

function derive(password: string, record: Omit<PasswordHash, 'hash'>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(record.salt, 'base64url'), 32, {
      N: record.cost, r: record.blockSize, p: record.parallelization, maxmem: 64 * 1024 * 1024,
    }, (error, value) => error ? reject(error) : resolve(value))
  })
}

/** Hash a new password with a random salt. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  validatePassword(password)
  return hashUnchecked(password)
}

/** Startup-only credential; the account must change it before accessing any resource. */
export function hashInitialPassword(): Promise<PasswordHash> {
  return hashUnchecked('123456')
}

async function hashUnchecked(password: string): Promise<PasswordHash> {
  const parameters = { algorithm: 'scrypt' as const, salt: randomBytes(16).toString('base64url'), cost: 32768, blockSize: 8, parallelization: 1 }
  return { ...parameters, hash: (await derive(password, parameters)).toString('base64url') }
}

/** Verify a password without comparing secret strings. */
export async function verifyPassword(record: PasswordHash, password: string): Promise<boolean> {
  if (password.length > 256) return false
  const actual = await derive(password, record)
  const expected = Buffer.from(record.hash, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Validate hashes read during migration or database recovery. */
export function parsePassword(value: unknown): PasswordHash {
  if (!value || typeof value !== 'object') throw new Error('认证密码记录损坏')
  const p = value as Partial<PasswordHash>
  if (p.algorithm !== 'scrypt' || p.cost !== 32768 || p.blockSize !== 8 || p.parallelization !== 1
    || typeof p.salt !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(p.salt)
    || typeof p.hash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(p.hash)) throw new Error('认证密码记录格式不受支持')
  return p as PasswordHash
}
