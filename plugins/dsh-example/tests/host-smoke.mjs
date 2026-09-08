/** Opt-in real DSH/auth/tgz integration. Only the model HTTP endpoint is a local fixture. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { readEvents } from '../web/stream.js'
import { hash } from '../../../packages/plugin-manager/src/state.mjs'
import { loadRelease } from '../../../packages/plugin-manager/src/release.mjs'
import { verificationIdentity, verificationSubjects, writeVerificationReport } from '../../../packages/plugin-manager/src/verification.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const release = resolve(root, process.argv[2] ?? '.local/artifacts/release/plugins')
const manifest = JSON.parse(readFileSync(join(release, 'manifest.json'), 'utf8'))
const archive = id => {
  const plugin = manifest.plugins.find(plugin => plugin.id === id)
  assert.ok(plugin, `Release must include ${id}`)
  return join(release, plugin.archive)
}
const outputRoot = join(root, '.local/data/acceptance')
mkdirSync(outputRoot, { recursive: true })
const operation = mkdtempSync(join(outputRoot, 'example-host-'))
const home = join(operation, 'home')
const cli = process.env.DSH_TEST_CLI ?? join(root, 'deepseek-harness/apps/cli/lib/bin.js')
const reportIndex = process.argv.indexOf('--report')
const reportPath = reportIndex < 0 ? undefined : process.argv[reportIndex + 1]
if (reportIndex >= 0 && (!reportPath || reportPath.startsWith('--'))) throw new Error('--report requires a new output file')
const testedRelease = loadRelease(join(release, 'manifest.json'))
const suiteRevision = hash(readFileSync(fileURLToPath(import.meta.url)))
const stages = []
let suiteFailure
function recordStage(ids, scenarioId) {
  const plugins = ids.map(id => testedRelease.plugins.find(plugin => plugin.id === id))
  for (const plugin of plugins) assert.equal(hash(readFileSync(plugin.archivePath)), plugin.sha256)
  const identity = verificationIdentity({ command: process.execPath, prefix: [cli], cwd: operation }, { home })
  for (const plugin of plugins) for (const scope of ['archive-consumption', 'real-host', 'model-double']) stages.push({
    pluginId: plugin.id, archiveSha256: plugin.sha256, subjects: verificationSubjects(plugins), scenarioId,
    suiteId: 'example-host-smoke', suiteRevision, scope, source: 'runner', ...identity,
  })
}
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
  const lastUser = value.messages.findLastIndex(message => message.role === 'user')
  if (JSON.stringify(value.messages[lastUser]).includes('源码工具验收')) {
    const toolResults = value.messages.slice(lastUser + 1).filter(message => message.role === 'tool')
    if (toolResults.length < 2) {
      const name = toolResults.length ? 'example_read_framework' : 'example_search_framework'
      const args = toolResults.length ? { path: 'packages/plugin-manager/src/verification.mjs', startLine: 1, lines: 40 } : { query: 'verificationSubjects' }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `reference_${toolResults.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
      res.end('data: [DONE]\n\n'); return
    }
  }
  const count = value.messages.filter(m => m.role === 'user').length
  for (const text of ['先理解问题。', '再组织回答。']) {
    if (res.destroyed) return
    await delay(180)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`)
  }
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
  return result.stdout.trim()
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
  assert.ok(events.filter(e => e.type === 'reasoning').length > 1, 'must stream reasoning before completion')
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
  run('plugin', '--profile', 'web', 'add', `file:${archive('example')}`)
  await start('standalone')
  const shared = await chat('独立模式问题')
  recordStage(['example'], 'example-standalone')
  await stop()
  run('plugin', '--profile', 'web', 'add', `file:${archive('auth')}`)
  await start('authenticated')
  const initial = await fetch(origin + '/auth/api/login', { method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-dsh-csrf': 'login' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })
  assert.equal(initial.status, 200)
  const initialBody = await initial.json()
  assert.equal(initialBody.user.mustChangePassword, true)
  const initialSession = { cookie: initial.headers.get('set-cookie').split(';')[0], csrf: initialBody.csrf }
  assert.equal((await request('/auth/api/password', { currentPassword: '123456', newPassword: password }, initialSession)).status, 200)
  assert.equal((await request('/example')).status, 303)
  const admin = await login('admin')
  for (const username of ['alice', 'bob']) assert.equal((await request('/auth/api/users', { username, password, role: 'user', grants: ['example'] }, admin)).status, 200)
  let alice = await login('alice')
  const bob = await login('bob')
  assert.deepEqual(await list(alice), [])
  assert.equal((await request('/example/history?id=' + shared, undefined, alice)).status, 404)
  const personal = await chat('个人模式问题', alice)
  const toolRequestStart = requests.length
  await chat('源码工具验收：检索并读取验证模块', alice, personal)
  const toolMessages = requests.slice(toolRequestStart).flatMap(request => request.messages).filter(message => message.role === 'tool')
  assert.ok(toolMessages.some(message => JSON.stringify(message).includes('packages/plugin-manager/src/verification.mjs')), 'real Agent must receive source search results')
  assert.ok(toolMessages.some(message => JSON.stringify(message).includes('verificationSubjects')), 'real Agent must receive source content')
  assert.deepEqual(await list(bob), [])
  assert.equal((await request('/example/history?id=' + personal, undefined, bob)).status, 404)
  const catalog = await (await request('/auth/api/plugins', undefined, alice)).json()
  assert.deepEqual(catalog.plugins.find(p => p.id === 'example').tools.map(tool => tool.name).sort(), ['example_read_framework', 'example_search_framework'])
  const live = await request('/example/chat', { message: '退出时停止', conversationId: personal }, alice)
  let signalDelta
  const firstDelta = new Promise(resolve => { signalDelta = resolve })
  const interrupted = []
  const streamed = readEvents(live, event => { interrupted.push(event); if (event.type === 'delta') signalDelta() }).catch(error => error)
  await Promise.race([firstDelta, streamed.then(() => { throw new Error('Stream ended before its first delta') })])
  assert.equal((await request('/auth/api/logout', {}, alice)).status, 200)
  await streamed
  assert.ok(!interrupted.some(event => event.type === 'done'), 'logout must interrupt the stream')
  // HTTP history waits for the revoked Agent's disposal and durable flush before host termination.
  alice = await login('alice')
  const beforeRestart = await request('/example/history?id=' + personal, undefined, alice)
  assert.equal(beforeRestart.status, 200)
  const durableBeforeRestart = await beforeRestart.json()
  const interruptedQuestion = durableBeforeRestart.messages.findIndex(message => message.role === 'user' && message.text === '退出时停止')
  assert.ok(interruptedQuestion >= 0, 'interrupted turn user message must be durable')
  assert.ok(durableBeforeRestart.messages.slice(interruptedQuestion + 1).some(message => message.role === 'assistant' && (message.text || message.reasoning)), 'interrupted turn must retain durable assistant content')
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
  const partial = await (await request('/example/history?id=' + personal, undefined, alice)).json()
  assert.equal(partial.messages.at(-1).role, 'assistant')
  assert.deepEqual(partial.messages, durableBeforeRestart.messages, 'durable history must survive restart without loss')
  assert.ok(partial.messages.some(message => message.text.startsWith('你好！')), 'completed answer must survive restart')
  await chat('重新登录后继续追问', alice, personal)
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('个人模式问题'), 'resumed model request must contain previous personal question')
  const modelInput = JSON.stringify(requests.at(-1).messages)
  for (const text of ['你是 DSH Plugin Manager 开发者接入助手', '第二个应用到底少写什么', 'compose-release', '可复制的开发提示词', '会话管理', 'registerConversations']) {
    assert.ok(modelInput.includes(text), `Real DSH model request must contain shipped knowledge: ${text}`)
  }
  const managementPath = '/auth/api/conversations?pluginId=example'
  assert.equal((await request(managementPath, undefined, alice)).status, 200)
  assert.ok((await (await request(managementPath, undefined, alice)).json()).items.some(item => item.id === personal))
  assert.equal((await (await request(managementPath, undefined, bob)).json()).total, 0)
  assert.equal((await request('/auth/api/conversations/preview?pluginId=example&id=' + personal, undefined, bob)).status, 404)
  const callsBeforePreview = requests.length, summariesBefore = await list(alice)
  const preview = await (await request('/auth/api/conversations/preview?pluginId=example&id=' + personal, undefined, alice)).json()
  assert.ok(preview.messages.some(message => message.text.includes('个人模式问题')))
  assert.equal(requests.length, callsBeforePreview, 'preview must not call the model')
  assert.deepEqual(await list(alice), summariesBefore, 'preview must not touch plugin history')
  const removed = await (await request('/auth/api/conversations/remove', { pluginId: 'example', ids: [personal] }, alice)).json()
  assert.deepEqual(removed.results.map(item => item.status), ['removed'], JSON.stringify(removed))
  assert.equal((await (await request(managementPath, undefined, alice)).json()).total, 0)
  assert.equal((await request('/example/history?id=' + personal, undefined, alice)).status, 404)
  assert.equal((await request('/example/chat', { message: '已移除会话不能复活', conversationId: personal }, alice)).status, 404)
  assert.equal((await (await request('/auth/api/conversations/remove', { pluginId: 'example', ids: [personal] }, alice)).json()).results[0].status, 'alreadyRemoved')
  await stop(); await start('authenticated'); alice = await login('alice')
  assert.equal((await (await request(managementPath, undefined, alice)).json()).total, 0)
  assert.equal((await (await request('/auth/api/conversations/remove', { pluginId: 'example', ids: [personal] }, alice)).json()).results[0].status, 'alreadyRemoved')
  recordStage(['example', 'auth'], 'conversation-management-preview-archive-restart')
  recordStage(['example', 'auth'], 'example-authenticated')
  const result = { host: verificationIdentity({ command: process.execPath, prefix: [cli], cwd: operation }, { home }).host, hostVersion: run('--version'), realTgz: true, realAuth: true,
    stream: true, standaloneWithoutAuth: true, modeSwitch: 'off-on-off-on', crossUserDenied: true,
    logoutStopsStream: true, interruptedHistory: true, persistentResume: true, knowledgeInModelRequest: true, sourceToolsExecuted: true, model: 'local HTTP fixture; no paid API call' }
  writeFileSync(join(operation, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ ...result, operation }))
  if (process.argv.includes('--serve')) {
    await stop(); await start(process.argv.includes('--serve-auth') ? 'authenticated' : 'standalone')
    const token = hostLog.match(/\?token=([A-Za-z0-9_-]{43})/u)?.[1]
    if (token) writeFileSync(join(operation, 'console-url.txt'), `${origin}/?token=${token}\n`, { mode: 0o600 })
    console.log('Browser acceptance: ' + origin + '/example')
    let stopping = false
    process.once('SIGINT', () => { stopping = true }); process.once('SIGTERM', () => { stopping = true })
    while (!stopping && !existsSync(join(operation, 'stop'))) await delay(100)
  }
} catch (error) { suiteFailure = error } finally {
  try { await stop() } catch (error) { suiteFailure ??= error }
  try { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)) } catch (error) { suiteFailure ??= error }
}
if (reportPath) writeVerificationReport(resolve(reportPath), stages.map(stage => ({ ...stage, finishedAt: new Date().toISOString(), outcome: suiteFailure ? 'failed' : 'passed' })))
if (suiteFailure) throw suiteFailure
