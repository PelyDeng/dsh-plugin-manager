/**
 * 群组 + 牛马大总管的真实宿主端到端验收。
 *
 * 与 `host-runtime-smoke.mjs` 的分工：那个用**假上下文 + 真实 WebServer**验路由与装配；这个
 * 用**真实 DSH 宿主 + 真实归档 + CLI 安装**验发布形态下整条链路真的能工作。两者都要：前者能
 * 快速定位装配错误，后者能发现只有「装进去再跑」才暴露的问题（资源没随包、patch 不匹配、
 * 插件之间的事件没接通）。
 *
 * 按 `plugins/dsh-example/tests/host-smoke.mjs` 的同一模式：只有模型 HTTP 端点是本地替身，
 * 不调付费 API。
 *
 * 断言的核心是**牛马大总管的成员名单**：`online: true` 表示该 Agent 登记了执行入口。这正是
 * 「牛马大总管能协调对应智能体」这条需求的落点 —— 名单为空时牛马大总管甚至不会做计划。
 *
 * 运行前提：宿主 CLI 已构建（`deepseek-harness/apps/cli/lib/bin.js`），且已打包：
 *   pnpm package --plugins "agents-group,butler"
 * 用法：
 *   node plugins/external/dsh-agents-group/tests/host-e2e-smoke.mjs [发布目录]
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
  let payload
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    modelRequests.push(payload)
  } catch { /* 非 JSON 请求不记录 */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')

  /**
   * 第一次调用先要一个通用工具，之后才给最终答复。
   *
   * 这样这一轮真的会走完「模型要工具 → 宿主执行 → 结果回模型 → 出答复」。只要牛马大总管拿得到
   * `common_weather`，它就会出现在工具清单里，替身才可能提出这个调用 —— 断言因此验的是
   * **工具真的可用**，而不只是「清单里出现过这个名字」。
   */
  const toolResults = (payload?.messages ?? []).filter(message => message?.role === 'tool')
  if (toolResults.length === 0) {
    res.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: 'weather_1',
            type: 'function',
            function: { name: 'common_weather', arguments: JSON.stringify({ location: '重庆', days: 1 }) },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })}\n\n`)
    res.end('data: [DONE]\n\n')
    return
  }

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
    ['牛马大总管存活探针', '/butler/health'],
    ['牛马大总管就绪探针', '/butler/ready'],
  ]) {
    const response = await fetch(origin + path, { redirect: 'manual' })
    // 就绪探针在没有 auth 提供者时返回 503 是正确行为；这里只要求它可达。
    record(`${label} ${path} 可达`, [200, 503].includes(response.status), `实际 ${response.status}`)
  }

  // ---- 关键断言：牛马大总管的成员名单真的接上了派活链路 ----
  const membersResponse = await fetch(`${origin}/butler/members`, { redirect: 'manual' })
  record('牛马大总管成员端点可读', membersResponse.status === 200, `实际 ${membersResponse.status}`)
  const members = membersResponse.status === 200 ? (await membersResponse.json()).items ?? [] : []
  const byId = new Map(members.map(member => [member.agentId, member]))
  record('成员名单含 closedoff 与 blog', byId.has('closedoff') && byId.has('blog'), `实际 ${members.map(m => m.agentId).join('、') || '（空）'}`)
  // online 即 card.dispatchable：为 true 说明该 Agent 登记了执行入口，牛马大总管才敢派活。
  record('closedoff 在线（登记了执行入口）', byId.get('closedoff')?.online === true, `online=${String(byId.get('closedoff')?.online)}`)
  record('blog 在线（登记了执行入口）', byId.get('blog')?.online === true, `online=${String(byId.get('blog')?.online)}`)
  record('成员带能力摘要，供牛马大总管选人', (byId.get('closedoff')?.capabilities ?? []).length > 0,
    JSON.stringify(byId.get('closedoff')?.capabilities ?? []))

  // ---- 关键断言：牛马大总管能调用通用工具 ----
  //
  // 牛马大总管按分类标签从插件目录筛选通用工具（`UNIVERSAL_TOOL_CATEGORY`），不写死工具名。验证它
  // 真的拿得到，最权威的地方是**模型请求里的工具清单** —— 那正是牛马大总管这一轮实际能用什么。
  // `/butler/agents` 只给 toolCount，看不到工具名，所以这里驱动一轮真实对话再读替身收到的请求。
  const chatResponse = await fetch(`${origin}/butler/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    // 会话 id 由客户端生成，格式是 butler-web-<uuid v4>；牛马大总管按正则校验，空串会被 400 拒绝。
    body: JSON.stringify({ conversationId: `butler-web-${randomUUID()}`, message: '重庆今天天气怎么样？' }),
  })
  record('牛马大总管 /chat 接受一轮对话', chatResponse.status === 200, `实际 ${chatResponse.status}`)
  if (chatResponse.status === 200) {
    // 把 SSE 读完，确认这一轮真的跑到了模型调用。
    const streamText = await chatResponse.text()
    // 流里出现 error 事件就说明这一轮没跑完，直接把它显示出来，不要只看状态码。
    const streamError = /"type":"error","message":"([^"]*)"/u.exec(streamText)?.[1]
    record('这一轮没有报错', streamError === undefined, streamError ?? '无 error 事件')
    for (let i = 0; i < 100 && modelRequests.length === 0; i += 1) await delay(100)

    const request = modelRequests.at(-1)
    /**
     * 整轮模型调用确实跑起来了：宿主、群组、牛马大总管、模型替身四段连上了。
     *
     * 工具清单的核查取决于**替身是否主动发起工具调用**（它的脚本分支决定）。要求工具调用是
     * 更强的验证，等替身的分支落实后再把它改成硬断言；在那之前先记录事实，不用一条永远红的
     * 断言掩盖真实信号。
     */
    record('整轮对话跑到了模型调用', request !== undefined, `替身收到 ${modelRequests.length} 次请求`)
    if (request !== undefined) {
      // OpenAI 兼容格式：tools[].function.name。
      const names = (request.tools ?? []).map(tool => tool?.function?.name ?? tool?.name).filter(name => typeof name === 'string')
      record('模型请求里带上了工具清单', names.length > 0, names.length > 0 ? names.join('、') : '（本轮替身未要求工具调用）')
      record('工具清单里有 common_weather（通用工具）', names.includes('common_weather'), names.join('、'))
      record('工具清单里有 butler_plan（派活工具）', names.includes('butler_plan'), names.join('、'))
      // 成员名单进系统提示词：牛马大总管据此知道能派给谁。
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
// 宿主日志始终落盘：挂载期或请求期的错误只出现在宿主输出里，不留下来就只能靠猜。
writeFileSync(join(operation, 'host.log'), hostLog)
console.log(`  宿主日志与诊断：${operation}`)
if (failure !== undefined || failed.length > 0) process.exit(1)
console.log('  群组 + 牛马大总管真实宿主端到端验收通过。')
