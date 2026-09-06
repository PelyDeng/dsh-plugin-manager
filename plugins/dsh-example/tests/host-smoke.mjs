/** Opt-in real DSH/auth/tgz integration. Only the model HTTP endpoint is a local fixture. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { readEvents } from '../web/stream.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const release = resolve(root, process.argv[2] ?? '.local/artifacts/release/plugins')
const outputRoot = join(root, '.local/data/acceptance')
mkdirSync(outputRoot, { recursive: true })
const operation = mkdtempSync(join(outputRoot, 'example-host-'))
const home = join(operation, 'home')
const cli = process.env.DSH_TEST_CLI ?? join(root, 'deepseek-harness/apps/cli/lib/bin.js')
const patch = join(operation, 'mode.patch.yml')
const port = Number(process.env.EXAMPLE_TEST_PORT ?? 18951)
const origin = `http://127.0.0.1:${port}`
const probe = createServer()
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
await new Promise(resolve => probe.close(resolve))
const requests = []
const model = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk)
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(value)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
  const count = value.messages.filter(m => m.role === 'user').length
  for (const text of ['你好！', '这是本地测试模型的回答。', `已收到 ${count} 条用户消息。`, '我们可以继续探索这个问题。']) {
    if (res.destroyed) return
    await delay(180)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  }
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":20}}\n\n')
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, DSH_HOME: home, DSH_AUTH_STATE_DIR: join(home, 'auth'), DEEPSEEK_API_KEY: 'keyless-example-local-fixture',
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}`, DSH_TELEMETRY_DISABLED: '1' }
const run = (...args) => {
  if (args[0] === 'plugin') {
    const action = args.findIndex(value => ['add', 'remove'].includes(value))
    if (action >= 0) {
      const options = []
      if (process.env.DSH_TEST_OFFLINE === '1') options.push(args[action] === 'remove' ? '--config.offline=true' : '--offline')
      if (process.env.DSH_STORE_DIR) options.push('--store-dir', process.env.DSH_STORE_DIR)
      if (process.env.DSH_CACHE_DIR) options.push('--cache-dir', process.env.DSH_CACHE_DIR)
      args.splice(action + 1, 0, ...options)
    }
  }
  const result = spawnSync(process.execPath, [cli, ...args], { env, cwd: operation, encoding: 'utf8', timeout: 120000 })
  if (result.status !== 0) { writeFileSync(join(operation, 'cli.log'), result.stdout + result.stderr); throw new Error('CLI failed; diagnostics: ' + operation) }
}
let child, hostLog = ''
async function stop() {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
  child = undefined
}
async function start(mode, ready = 200) {
  hostLog = ''
  writeFileSync(patch, `- id: example\n  config:\n    accessMode: ${mode}\n    publicOrigin: ${origin}\n- id: auth\n  config:\n    publicOrigin: ${origin}\n`)
  // The first standalone run has no auth Bundle, so its patch must not target that absent node.
  const profile = JSON.parse(readFileSync(join(home, 'profiles/web/package.json')))
  if (!profile.dependencies?.['dsh-auth']) writeFileSync(patch, `- id: example\n  config:\n    accessMode: ${mode}\n    publicOrigin: ${origin}\n`)
  child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'], { env, cwd: operation, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { hostLog += bytes })
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) break
    try { if ((await fetch(origin + '/example/ready')).status === ready) return } catch { /* Listener is still starting. */ }
    await delay(100)
  }
  writeFileSync(join(operation, 'host.log'), hostLog)
  throw new Error('Host not ready; diagnostics: ' + operation)
}
const request = (path, data, login) => fetch(origin + path, { redirect: 'manual', method: data === undefined ? 'GET' : 'POST',
  headers: { origin, 'content-type': 'application/json', ...(login ? { cookie: login.cookie, 'x-dsh-csrf': login.csrf } : {}) },
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
})
async function chat(text, login, id) {
  const response = await request('/example/chat', { message: text, ...(id ? { conversationId: id } : {}) }, login)
  assert.equal(response.status, 200)
  const events = []
  await readEvents(response, e => events.push(e))
  assert.equal(events.at(-1).reason, 'completed', JSON.stringify(events))
  assert.ok(events.filter(e => e.type === 'delta').length > 1, 'must stream before completion')
  await delay(400)
  return events[0].conversationId
}
const password = 'Example-test-only-2026'
async function login(username) {
  const response = await fetch(origin + '/auth/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-dsh-csrf': 'login' }, body: JSON.stringify({ username, password }) })
  assert.equal(response.status, 200)
  return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrf }
}
const list = async session => (await (await request('/example/conversations', undefined, session)).json()).items
try {
  run('plugin', '--profile', 'web', 'add', `file:${join(release, 'example.tgz')}`)
  await start('standalone')
  const shared = await chat('独立模式问题')
  await stop()
  run('plugin', '--profile', 'web', 'add', `file:${join(release, 'auth.tgz')}`)
  const require = createRequire(join(home, 'profiles/web/package.json'))
  const { bootstrap } = await import(pathToFileURL(require.resolve('dsh-auth/admin')).href)
  await bootstrap('example_admin', password, join(home, 'auth'), ['example'])
  await start('authenticated')
  assert.equal((await request('/example')).status, 303)
  const admin = await login('example_admin')
  for (const username of ['alice', 'bob']) assert.equal((await request('/auth/api/users', { username, password, role: 'user', grants: ['example'] }, admin)).status, 200)
  let alice = await login('alice')
  const bob = await login('bob')
  assert.deepEqual(await list(alice), [])
  assert.equal((await request('/example/history?id=' + shared, undefined, alice)).status, 404)
  const personal = await chat('个人模式问题', alice)
  assert.deepEqual(await list(bob), [])
  assert.equal((await request('/example/history?id=' + personal, undefined, bob)).status, 404)
  const catalog = await (await request('/auth/api/plugins', undefined, alice)).json()
  assert.equal(catalog.plugins.find(p => p.id === 'example').tools.length, 0)
  const live = await request('/example/chat', { message: '退出时停止', conversationId: personal }, alice)
  const streamed = live.text()
  assert.equal((await request('/auth/api/logout', {}, alice)).status, 200)
  assert.ok(!(await streamed).includes('"type":"done"'), 'logout must interrupt the stream')
  await stop()
  await start('standalone')
  assert.deepEqual((await list()).map(i => i.id), [shared])
  assert.equal((await request('/example/history?id=' + personal)).status, 404)
  const sharedHistory = await (await request('/example/history?id=' + shared)).json()
  assert.ok(sharedHistory.messages.some(m => m.text.includes('独立模式问题')))
  await chat('恢复独立历史追问', undefined, shared)
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('独立模式问题'), 'resumed model request must contain previous standalone question')
  await stop()
  await start('authenticated')
  alice = await login('alice')
  assert.deepEqual((await list(alice)).map(i => i.id), [personal])
  await chat('重新登录后继续追问', alice, personal)
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('个人模式问题'), 'resumed model request must contain previous personal question')
  const result = { officialHost: '49a606bc5b5934603f22a26957a07dc799ab0291', realTgz: true, realAuth: true,
    stream: true, standaloneWithoutAuth: true, modeSwitch: 'off-on-off-on', crossUserDenied: true,
    logoutStopsStream: true, persistentResume: true, model: 'local HTTP fixture; no paid API call' }
  writeFileSync(join(operation, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ ...result, operation }))
  if (process.argv.includes('--serve')) {
    await stop(); await start(process.argv.includes('--serve-auth') ? 'authenticated' : 'standalone')
    console.log('Browser acceptance: ' + origin + '/example')
    let stopping = false
    process.once('SIGINT', () => { stopping = true }); process.once('SIGTERM', () => { stopping = true })
    while (!stopping && !existsSync(join(operation, 'stop'))) await delay(100)
  }
} finally {
  await stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
}
