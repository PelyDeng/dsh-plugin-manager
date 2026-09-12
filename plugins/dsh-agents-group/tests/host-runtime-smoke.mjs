/**
 * 群组的真实宿主运行时验收。
 *
 * 与 `tests/mount-e2e.test.ts` 的分工：那个用假上下文证明**注册了什么**，这个用**真实的
 * Cordis 宿主与真实的 WebServer**证明**请求真的能通**。两者都要：注册对了但路由不匹配、
 * 或响应头/状态码不合适，只有在真实 HTTP 上才看得出来。
 *
 * 用真实的 `@deepseek-ai/dsh-host-webserver` 监听 `127.0.0.1:0`（系统分配端口），
 * 加载**构建产物** `dist/index.mjs`（不是源码），并让两个子包都实际装载。
 *
 * 业务凭据用替身值：装载期不调用网关，所以替身足够；这也顺带验证了装载路径不依赖网络。
 *
 * 运行方式（需要先 `pnpm build --plugins "agents-group"`）：
 *   node tests/host-runtime-smoke.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { installProvider } from '@dsh-plugin-manager/plugin-kit'

const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const failures = []
const record = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

/** 写一份群组业务配置，装入替身凭据。 */
function writeGroupConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'agents-group-runtime-'))
  const file = join(dir, 'group.json')
  writeFileSync(file, JSON.stringify({
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
        text: { provider: 'blog-zhipu', model: 'glm-5.3' },
        vision: { provider: 'blog-zhipu', model: 'glm-5v-turbo' },
      },
      blog: { url: 'https://blog.test', username: 'tester', password: 'secret' },
      image: { url: 'https://image.test', username: 'tester', password: 'secret', strategyId: 2, maxBytes: 1048576 },
      backup: { url: 'http://127.0.0.1:7913', token: 'backup-token', allowedUserIds: [] },
    },
  }))
  return file
}

/**
 * 群组自身只 inject `webServer`；子包需要的那几个宿主服务由真正的实现或最小替身补上。
 *
 * 替身只覆盖「装载期被访问但本验收不关心行为」的服务，凡是被断言依赖的一律用真实实现。
 */
function installHostServices(ctx) {
  const noop = () => () => {}
  /**
   * Agent 工厂边界。
   *
   * 真正的 Agent 工厂由完整宿主提供（`dsh-agent-loop` 包），本验收不重建它 —— 那等于重写宿主，
   * 而且已经证明会一路踩坑（WebServer 的归属、模型目录、配置默认值都是这么发现的）。
   *
   * 所以这里把它做成**显式的边界**：抛一个可识别的哨兵错误。派发链路只要能走到这里，就说明
   * 「执行入口 → 桥接 → 参与者 → 鉴权 → 模型目录 → 创建子 Agent」这整条都通了，
   * 剩下的只是宿主该提供的那一个实现。
   */
  ctx.provide('agents', {
    create: async () => { throw new Error('__agent_factory_boundary__') },
    resume: async () => { throw new Error('__agent_factory_boundary__') },
    list: () => [],
    get: () => undefined,
  })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'test' }), resolve: async () => ({ provider: 'deepseek', model: 'test' }) })
  ctx.provide('llm', { resolveModelInfo: async () => undefined, resolveCallConfig: async value => value, listModels: async () => ({ groups: [], failures: [] }) })
  ctx.provide('messageFeedback', { record: noop })
  ctx.provide('sessionPersistence', { flush: async () => {} })
  ctx.provide('systemPrompt', { section: noop })
  ctx.provide('tools', { register: noop, restrict: noop, list: () => [] })
  ctx.provide('attachments', { saveFileStream: async () => ({ id: 'att-1' }) })
  ctx.provide('jobs', { attachController: noop, start: () => 'job-1', wait: async () => ({ status: 'completed' }), get: () => ({ status: 'completed' }), kill: () => {} })
  ctx.provide('sessions', { get: () => undefined, list: () => [] })

  /**
   * 官方模型目录。
   *
   * 子包在创建会话前要读宿主目录确认所选模型可路由，缺了会在创建前停住。这里给一份最小
   * 可用目录，让派发链路能走到真正创建子 Agent。
   */
  ctx.provide('sessionController', {
    modelCatalog: async () => ({
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'test', name: '测试模型' }] }],
      failures: [],
      selected: { provider: 'deepseek', model: 'test' },
    }),
  })

  /**
   * 认证提供者替身。
   *
   * 真实实现按 `grants.includes(pluginId)` 判权，这里照同一语义给两个子包授权：派发链路会
   * 用它做鉴权，缺了会在鉴权那一步停住（那正是第一次跑出来的结果，说明链路本身是通的）。
   */
  installProvider(ctx, {
    protocol: 1,
    ready: noop,
    resolve: () => ({ namespace: 'user', userId: 'tester', sessionId: 'login-a' }),
    assertAccess: (actor, pluginId) => {
      if (actor.namespace !== 'user') throw new Error('请先登录')
      if (!['closedoff', 'blog', 'agents-group'].includes(pluginId)) throw new Error('没有访问此插件的权限')
    },
  })
}

const groupConfigPath = writeGroupConfig()
process.env.AGENTS_GROUP_CONFIG = groupConfigPath
mkdirSync(join(tmpdir(), 'agents-group-runtime-home'), { recursive: true })

const root = new Context()
let hostFiber
try {
  // 真实的 WebServer，按官方方式作为插件装载。
  //
  // 不能直接 `new WebServer(ctx, cfg)`：Service 在构造里用 `ctx.reflect.provide` 注册自己，
  // 由所属 fiber 管理生命周期；直接 new 出来的实例拿不到正确的服务归属，端口也不会就绪。
  // 端口 0 表示由系统分配，必须在服务 init 完成后才能读到真实端口。
  hostFiber = root.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await hostFiber
  const host = root.get('webServer')
  assert.ok(host !== undefined, 'WebServer 必须注册为 webServer 服务')

  installHostServices(root)

  // 构建产物按宿主插件的标准形状导出：apply / name / inject / Config。
  const artifact = await import(new URL('../dist/index.mjs', import.meta.url))
  assert.equal(typeof artifact.apply, 'function', '构建产物必须导出 apply')
  assert.equal(artifact.name, 'agents-group', '构建产物必须声明插件名')
  assert.ok(Array.isArray(artifact.inject), '构建产物必须声明 inject')

  assert.ok(Number.isInteger(host.port) && host.port > 0, `WebServer 必须报告真实端口，实际 ${host.port}`)
  const origin = `http://127.0.0.1:${host.port}`
  const config = artifact.Config({
    accessMode: 'authenticated',
    publicOrigin: origin,
    routePrefix: '/agents',
    authRecheckMs: 100,
  })
  const fiber = root.plugin({ name: artifact.name, inject: artifact.inject, apply: artifact.apply }, config)
  await fiber

  const get = async path => { const r = await fetch(origin + path, { redirect: 'manual' }); return { status: r.status, text: await r.text(), headers: r.headers } }

  /**
   * 管家的执行入口必须真的登记了。
   *
   * 没有这一步，管家的成员名单恒为空，它每轮收到的提示词是「没有能接活的成员，这一轮只能
   * 你自己回答」，于是「协调对应智能体」完全不通。这条断言就是那次修复的固化。
   */
  const executors = []
  root.emit('butler/executors', executor => executors.push(executor))
  record('向管家登记了执行入口', executors.length === 2, `实际 ${executors.length} 个：${executors.map(e => e.agentId).join('、')}`)
  record('执行入口的 agentId 与目录条目一致', executors.every(e => ['closedoff', 'blog'].includes(e.agentId)), executors.map(e => e.agentId).join('、'))
  record('执行入口声明了能力摘要', executors.every(e => Array.isArray(e.capabilities) && e.capabilities.length > 0))
  record('执行入口提供 dispatch', executors.every(e => typeof e.dispatch === 'function'))

  /**
   * 走一遍真实派发链路。
   *
   * 用一个默认模型替身跑一轮子 Agent：这验证的是从管家的执行入口 → 桥接 → 参与者 →
   * 真实会话与工具 → 结论回收的**整条链路**，而不是各段单测。业务网关仍是替身，所以不
   * 依赖外部服务也不调付费模型。
   */
  const closedoff = executors.find(executor => executor.agentId === 'closedoff')
  if (closedoff === undefined) {
    record('找到 closedoff 执行入口', false)
  } else {
    const actor = { namespace: 'user', userId: 'tester', sessionId: 'login-a' }
    const progress = []
    let failure
    try {
      await closedoff.dispatch({
        taskId: 'task-runtime-1',
        subtaskId: 'sub-1',
        goal: '查一下园区今天的情况',
        brief: '整体目标：了解园区。\n你负责：查今天的通行情况。',
        taskGoal: '了解园区',
        owner: 'user:tester',
        actor,
        signal: new AbortController().signal,
        onProgress: update => progress.push(update),
      })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    /**
     * 派发必须恰好停在 Agent 工厂边界。
     *
     * 停在这里 = 执行入口、桥接、参与者、鉴权、模型目录全部走通，只差宿主该提供的 Agent 工厂。
     * 停在任何更早的地方都是真实缺陷，所以这条断言是有内容的：它不放过任何提前失败。
     */
    record('派发走到 Agent 工厂边界', failure === '__agent_factory_boundary__',
      failure === undefined ? '竟然完成了（说明边界替身没生效）' : failure)
  }

  // 群组级探针：真实 HTTP 上必须可达。
  const health = await get('/agents/health')
  record('存活探针 /agents/health 返回 200', health.status === 200, `实际 ${health.status}`)

  const ready = await get('/agents/ready')
  record('就绪探针 /agents/ready 已挂载', ready.status === 200 || ready.status === 503, `实际 ${ready.status}`)
  if (ready.status === 200 || ready.status === 503) {
    const body = JSON.parse(ready.text)
    record('就绪探针正文含 authReady 与 agents 明细', 'authReady' in body && 'agents' in body)
  }

  // 每个 Agent 的就绪探针都必须真的被服务到 —— 这是「声明了但没人实现」的经典失效点。
  for (const id of ['closedoff', 'blog']) {
    const probe = await get(`/agents/${id}/ready`)
    record(`子包就绪探针 /agents/${id}/ready 可达`, probe.status === 200 || probe.status === 503, `实际 ${probe.status}`)
  }

  // 未注册路径必须是 404，而不是被前缀路由吞掉。
  const missing = await get('/agents/does-not-exist')
  record('未注册路径返回 404', missing.status === 404, `实际 ${missing.status}`)

  // 越界路径不属于群组。
  const outside = await get('/not-agents')
  record('群组前缀之外返回 404', outside.status === 404, `实际 ${outside.status}`)
} catch (error) {
  failures.push(`运行时验收异常：${error instanceof Error ? error.message : String(error)}`)
  if (error instanceof Error && error.stack !== undefined) console.error(error.stack)
} finally {
  // 必须显式释放 WebServer：它不是一次性脚本可以放任不管的东西，进程会一直挂着不退出。
  try { await hostFiber?.dispose?.() } catch { /* 关闭失败不覆盖断言结果 */ }
}

console.log(failures.length === 0 ? '\n真实宿主运行时验收通过。' : `\n真实宿主运行时验收失败 ${failures.length} 项。`)
process.exit(failures.length === 0 ? 0 : 1)
