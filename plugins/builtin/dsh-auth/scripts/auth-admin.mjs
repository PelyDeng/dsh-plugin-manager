/** Restricted stdin-only account bootstrap; uses the plugin installed in the Web profile. */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Reject unintended fields and bound input before loading the installed plugin. */
export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-input')
  const fields = value.action === 'bootstrap' ? ['action', 'username', 'password', 'grants'] : ['action', 'grants']
  if (!['bootstrap', 'migrate'].includes(value.action) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('invalid-input')
  if (!Array.isArray(value.grants) || value.grants.length > 1000
    || !value.grants.every(id => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id))
    || new Set(value.grants).size !== value.grants.length) throw new Error('invalid-grants')
  if (value.action === 'bootstrap' && (typeof value.username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value.username)
    || typeof value.password !== 'string' || value.password.length < 8 || value.password.length > 256)) throw new Error('invalid-input')
  return value
}

/** Initialize only an empty database. Account and explicit grants are created atomically. */
export async function initialize(value) {
  const request = validateRequest(value)
  const home = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const resolver = createRequire(join(home, 'profiles', 'web', 'package.json'))
  const entry = resolver.resolve('dsh-auth/admin')
  const admin = await import(pathToFileURL(entry).href)
  const stateDir = process.env.DSH_AUTH_STATE_DIR
  if (stateDir && !isAbsolute(stateDir)) throw new Error('state-directory-must-be-absolute')
  const directory = stateDir || join(home, 'auth')
  const user = request.action === 'bootstrap'
    ? await admin.bootstrap(request.username, request.password, directory, request.grants)
    : admin.migrateLegacy(directory, request.grants)
  return { ok: true, userId: user.id, username: user.username, role: user.role, grants: user.grants }
}

async function main() {
  if (process.argv.length !== 2 || process.stdin.isTTY) throw new Error('stdin-required')
  let size = 0
  const chunks = []
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 16384) throw new Error('input-too-large')
    chunks.push(chunk)
  }
  let request
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')) } finally {
    for (const chunk of chunks) chunk.fill(0)
  }
  const result = await initialize(request)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    // JSON parser and imported-module errors can contain supplied credentials or file contents.
    process.stderr.write('认证初始化失败：请核对输入、已安装插件及数据库状态；未输出输入内容。\n')
    process.exitCode = 1
  })
}
