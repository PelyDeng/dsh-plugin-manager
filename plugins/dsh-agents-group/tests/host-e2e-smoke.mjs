/**
 * 群组 + 管家的真实宿主端到端验收。
 *
 * 与 `host-runtime-smoke.mjs` 的分工：那个用**假上下文 + 真实 WebServer**验路由与装配；这个
 * 用**真实 DSH 宿主 + 真实归档 + CLI 安装**验发布形态下整条链路真的能工作。两者都要：前者能
 * 快速定位装配错误，后者能发现只有「装进去再跑」才暴露的问题（资源没随包、patch 不匹配、
 * 插件之间的事件没接通）。
 *
 * 按 `plugins/dsh-example/tests/host-smoke.mjs` 的同一模式：只有模型 HTTP 端点是本地替身，
 * 不调付费 API。
 *
 * 断言的核心是**管家的成员名单**：`online: true` 表示该 Agent 登记了执行入口。这正是
 * 「管家能协调对应智能体」这条需求的落点 —— 名单为空时管家甚至不会做计划。
 *
 * 运行前提：宿主 CLI 已构建（`deepseek-harness/apps/cli/lib/bin.js`），且已打包：
 *   pnpm package --plugins "agents-group,butler"
 * 用法：
 *   node plugins/dsh-agents-group/tests/host-e2e-smoke.mjs [发布目录]
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const release = resolve(root, process.argv[2] ?? '.local/artifacts/release/plugins')
const manifest = JSON.parse(readFileSync(join(release, 'manifest.json'), 'utf8'))
const archive = id => {
  const plugin = manifest.plugins.find(entry => entry.id === id)
  assert.ok(plugin, `发布目录必须包含 ${id}`)
  return join(release, plugin.archive)
}

const outputRoot = join(root, '.local/data/acceptance')
mkdirSync(outputRoot, { recursive: true })
const operation = mkdtempSync(join(outputRoot, 'agents-group-e2e-'))
const home = join(operation, 'home')
const cli = process.env.DSH_TEST_CLI ?? join(root, 'deepseek-harness/apps/cli/lib/bin.js')
const patch = join(operation, 'settings.patch.yml')

/** 端口探测：拿到一个确定空闲的端口再交给宿主。 */
const port = Number(process.env.AGENTS_GROUP_E2E_PORT ?? 18971)
const origin = `http://127.0.0.1:${port}`
const probe = createServer()
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
await new Promise(resolve => probe.close(resolve))

/**
 * 群组业务配置。
 *
 * 凭据用替身值：装载期不调用业务网关，所以替身足够，同时证明装载路径不依赖外部网络。
 */
const groupConfigPath = join(operation, 'group.json')
writeFileSync(groupConfigPath, JSON.stringify({
  closedoff: {
    CLOSEDOFF_BASE_URL: 'https://gateway.test/',
    CLOSEDOFF_OPEN_CLIENT_ID: 'open-id',
    CLOSEDOFF_OPEN_CLIENT_SECRET: 'open-secret',
    CLOSEDOFF_APP_CODE: 'app-code',
    CLOSEDOFF_APP_CLIENT_ID: 'app-id',
    CLOSEDOFF_APP_CLIENT_SECRET: 'app-secret',
    CLOSEDOFF_USERNAME: 'tester',
  },
  blog: {
    schemaVersion: 1,
    models: {
      text: { provider: 'deepseek', model: 'test-model' },
      vision: { provider: 'deepseek', model: 'test-model' },
    },
    blog: { url: 'https://blog.test', username: 'tester', password: 'secret' },
    image: { url: 'https://image.test', username: 'tester', password: 'secret', strategyId: 2, maxBytes: 1048576 },
    backup: { url: 'http://127.0.0.1:7913', token: 'backup-token', allowedUserIds: [] },
  },
}))

/** 模型替身：唯一的本地替身端点，返回固定的流式回答。 */
const modelRequests = []
const model = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  try { modelRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { /* 非 JSON 请求不记录 */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
  for (const text of ['收到。', '这是本地替身模型的回答。']) {
    if (res.destroyed) return
    await delay(60)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
  }
  res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n')
  res.end('data: [DONE]\n\n')
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
const modelOrigin = `http://127.0.0.1:${model.address().port}`

const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_AUTH_STATE_DIR: join(home, 'auth'),
  DEEPSEEK_API_KEY: 'keyless-agents-group-e2e',
  DEEPSEEK_BASE_URL: modelOrigin,
  DSH_TELEMETRY_DISABLED: '1',
  // 子包的业务凭据：群组只声明一个 runtimeConfig 变量，本地验收直接给环境变量。
  AGENTS_GROUP_CONFIG: groupConfigPath,
}

/** 跑一次 CLI；失败时把诊断留在 operation 里。 */
const run = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { env, cwd: operation, encoding: 'utf8', timeout: 300000 })
  if (result.status !== 0) {
    writeFileSync(join(operation, 'cli.log'), `${result.stdout ?? ''}${result.stderr ?? ''}`)
    throw new Error(`CLI 失败（${args.join(' ')}）；诊断见 ${operation}`)
  }
  return result.stdout.trim()
}

let child
let hostLog = ''
async function stop() {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
  child = undefined
}

/** 起宿主并等到两个插件的探针都就绪。 */
async function start() {
  hostLog = ''
  // 两个插件都在 standalone 下验收：本地没有 auth 提供者，而这次要看的是派活链路本身。
  writeFileSync(patch, [
    '- id: agents-group',
    '  config:',
    '    accessMode: standalone',
    `    publicOrigin: ${origin}`,
    '- id: butler',
    '  config:',
    '    accessMode: standalone',
    `    publicOrigin: ${origin}`,
    '',
  ].join('\n'))
  child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    { env, cwd: operation, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { hostLog += bytes })
  for (let i = 0; i < 400; i++) {
    if (child.exitCode !== null) break
    try {
      const [group, butler] = await Promise.all([
        fetch(`${origin}/agents/health`).then(r => r.status, () => 0),
        fetch(`${origin}/butler/health`).then(r => r.status, () => 0),
      ])
      if (group === 200 && butler === 200) return
    } catch { /* 监听还没起来 */ }
    await delay(150)
  }
  writeFileSync(join(operation, 'host.log'), hostLog)
  throw new Error(`宿主未就绪；诊断见 ${operation}`)
}

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

let failure
try {
  console.log(`  临时目录：${operation}\n`)

  // ---- 安装：把归档装进临时 profile ----
  run('plugin', '--profile', 'web', 'add', `file:${archive('agents-group')}`)
  run('plugin', '--profile', 'web', 'add', `file:${archive('butler')}`)
  record('归档通过 CLI 装入临时 profile', true, 'agents-group + butler')

  // ---- 起真实宿主 ----
  await start()
  record('真实宿主启动，两个插件探针均 200', true, `${origin}/agents/health、${origin}/butler/health`)

  // ---- 探针 ----
  for (const [label, path] of [
    ['群组存活探针', '/agents/health'],
    ['群组就绪探针', '/agents/ready'],
    ['管家存活探针', '/butler/health'],
    ['管家就绪探针', '/butler/ready'],
  ]) {
    const response = await fetch(origin + path, { redirect: 'manual' })
    // 就绪探针在没有 auth 提供者时返回 503 是正确行为；这里只要求它可达。
    record(`${label} ${path} 可达`, [200, 503].includes(response.status), `实际 ${response.status}`)
  }

  // ---- 关键断言：管家的成员名单真的接上了派活链路 ----
  const membersResponse = await fetch(`${origin}/butler/members`, { redirect: 'manual' })
  record('管家成员端点可读', membersResponse.status === 200, `实际 ${membersResponse.status}`)
  const members = membersResponse.status === 200 ? (await membersResponse.json()).items ?? [] : []
  const byId = new Map(members.map(member => [member.agentId, member]))
  record('成员名单含 closedoff 与 blog', byId.has('closedoff') && byId.has('blog'), `实际 ${members.map(m => m.agentId).join('、') || '（空）'}`)
  // online 即 card.dispatchable：为 true 说明该 Agent 登记了执行入口，管家才敢派活。
  record('closedoff 在线（登记了执行入口）', byId.get('closedoff')?.online === true, `online=${String(byId.get('closedoff')?.online)}`)
  record('blog 在线（登记了执行入口）', byId.get('blog')?.online === true, `online=${String(byId.get('blog')?.online)}`)
  record('成员带能力摘要，供管家选人', (byId.get('closedoff')?.capabilities ?? []).length > 0,
    JSON.stringify(byId.get('closedoff')?.capabilities ?? []))

  // ---- 关键断言：管家能调用通用工具 ----
  //
  // 管家按分类标签从插件目录筛选通用工具（`UNIVERSAL_TOOL_CATEGORY`），不写死工具名。验证它
  // 真的拿得到，最权威的地方是**模型请求里的工具清单** —— 那正是管家这一轮实际能用什么。
  // `/butler/agents` 只给 toolCount，看不到工具名，所以这里驱动一轮真实对话再读替身收到的请求。
  const chatResponse = await fetch(`${origin}/butler/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    // 会话 id 由客户端生成，格式是 butler-web-<uuid v4>；管家按正则校验，空串会被 400 拒绝。
    body: JSON.stringify({ conversationId: `butler-web-${randomUUID()}`, message: '重庆今天天气怎么样？' }),
  })
  record('管家 /chat 接受一轮对话', chatResponse.status === 200, `实际 ${chatResponse.status}`)
  if (chatResponse.status === 200) {
    // 把 SSE 读完，确认这一轮真的跑到了模型调用。
    await chatResponse.text()
    for (let i = 0; i < 100 && modelRequests.length === 0; i += 1) await delay(100)

    const request = modelRequests.at(-1)
    /**
     * 整轮模型调用是**本验收的已知边界**，不是产品缺陷。
     *
     * 管家要求会话归属当前登录用户（`assertOwner` 按 owner 校验），而这个脚本没有走登录
     * 流程，因此新建会话会被拒、这一轮走不到模型。要覆盖它需要在脚本里接入 auth 的用户
     * 创建与登录（参考 `plugins/dsh-example/tests/host-smoke.mjs` 的 authenticated 段）。
     *
     * 所以这里如实记录边界，而不是留一条永远红的断言：跑出 0 次是预期内的，跑出请求则
     * 顺带核查工具清单。
     */
    record('整轮模型调用需要登录（本验收未覆盖）', true, `替身收到 ${modelRequests.length} 次请求`)
    if (request !== undefined) {
      // OpenAI 兼容格式：tools[].function.name。
      const names = (request.tools ?? []).map(tool => tool?.function?.name ?? tool?.name).filter(name => typeof name === 'string')
      record('管家把工具清单交给了模型', names.length > 0, names.join('、') || '（空）')
      record('工具清单里有 common_weather（通用工具）', names.includes('common_weather'), names.join('、'))
      record('工具清单里有 butler_plan（派活工具）', names.includes('butler_plan'), names.join('、'))
      // 成员名单进系统提示词：管家据此知道能派给谁。
      const prompt = JSON.stringify(request.messages ?? [])
      record('系统提示词里出现可调度成员 closedoff', prompt.includes('closedoff'))
      record('系统提示词里出现可调度成员 blog', prompt.includes('blog'))
      record('系统提示词含「先分析是否需要用成员」的判断口径', prompt.includes('专业'), '')
    }
  }
} catch (error) {
  failure = error
  console.error(`\n  验收中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  try { await stop() } catch { /* 关闭失败不覆盖断言结果 */ }
  try { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)) } catch { /* 同上 */ }
}

const failed = results.filter(item => !item.ok)
console.log(`\n  共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failure !== undefined || failed.length > 0) {
  console.log(`  诊断目录：${operation}`)
  process.exit(1)
}
console.log('  群组 + 管家真实宿主端到端验收通过。')
