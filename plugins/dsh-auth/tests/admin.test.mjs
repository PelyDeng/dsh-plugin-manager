/** Real SQLite through the packaged admin export; no user database or credentials are used. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { scryptSync } from 'node:crypto'
import { validateRequest } from '../scripts/auth-admin.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const script = join(root, 'plugins/dsh-auth/scripts/auth-admin.mjs')

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-auth-admin-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const home = join(directory, 'home with spaces')
  const profile = join(home, 'profiles/web')
  const plugin = join(profile, 'node_modules/dsh-auth')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ type: 'module', dependencies: { 'dsh-auth': '0.5.0' } }))
  await cp(join(root, 'plugins/dsh-auth/dist'), join(plugin, 'dist'), { recursive: true })
  await cp(join(root, 'plugins/dsh-auth/package.json'), join(plugin, 'package.json'))
  const run = (input, args = []) => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: tmpdir(),
      env: { ...process.env, DSH_HOME: home, DSH_AUTH_STATE_DIR: '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolveResult({ code, stdout, stderr }))
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error) })
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
  return { home, plugin, run }
}

test('stdin bootstrap resolves the installed profile, preserves explicit grants and rejects reset', async t => {
  const f = await fixture(t)
  const password = 'test-only-password-123'
  const input = { action: 'bootstrap', username: 'Owner', password, grants: ['demo'] }
  const result = await f.run(input)
  assert.equal(result.code, 0, result.stderr)
  assert.equal((result.stdout + result.stderr).includes(password), false)
  assert.deepEqual(JSON.parse(result.stdout).grants, ['demo'])
  const { AuthStore } = await import(pathToFileURL(join(f.plugin, 'dist/store.mjs')).href)
  const store = new AuthStore(join(f.home, 'auth'))
  try {
    assert.equal(store.users()[0].username, 'owner')
    assert.deepEqual(store.users()[0].grants, ['demo'])
    assert.equal((await readFile(join(f.home, 'auth/auth.sqlite'))).includes(Buffer.from(password)), false)
  } finally { store.close() }
  assert.equal((await f.run(input)).code, 1)
  assert.equal((await f.run(input, ['--password', password])).code, 1)
})

test('explicit legacy migration retains password hash and source file without IP bypass', async t => {
  const f = await fixture(t)
  const password = 'test-only-legacy-password'
  const salt = Buffer.alloc(16, 1)
  const legacy = { version: 1, username: 'legacy', password: { algorithm: 'scrypt', salt: salt.toString('base64url'),
    hash: scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('base64url'), cost: 32768, blockSize: 8, parallelization: 1 }, whitelist: ['0.0.0.0/0'] }
  const file = join(f.home, 'auth/state.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(legacy))
  const result = await f.run({ action: 'migrate', grants: ['demo'] })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).grants, ['demo'])
  const { AuthStore } = await import(pathToFileURL(join(f.plugin, 'dist/store.mjs')).href)
  const store = new AuthStore(join(f.home, 'auth'))
  try { assert.deepEqual(store.credentials('legacy').password, legacy.password) } finally { store.close() }
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), legacy)
})

test('invalid input is bounded, does not initialize and never echoes supplied content', async t => {
  const f = await fixture(t)
  for (const input of ['{"password":"SENSITIVE', 'SENSITIVE'.repeat(4096), { action: 'bootstrap', username: 'owner', password: 'SENSITIVE', grants: ['../bad'] }]) {
    const result = await f.run(input)
    assert.equal(result.code, 1)
    assert.equal((result.stdout + result.stderr).includes('SENSITIVE'), false)
  }
  assert.throws(() => validateRequest({ action: 'migrate', grants: ['demo', 'demo'] }))
})
