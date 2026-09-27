/**
 * 本地浏览器验收（不进入发布包）：对 Chromium / Edge 无头浏览器跑端到端断言——
 * 第一切片：页面装载、office 地图与角色渲染、任务本读取并跟随管家 SSE、
 * 键盘与点击移动的格子位移（直接读 data-player-cell，不靠截图差异）、
 * 首包静态请求与 gzip 门槛、请求同源。
 * 第二切片：派活→SSE 状态推进→等待回复→回复完成→同一历史；响应未知后用同一份
 * 提交重试；停止本轮收敛以管家事件为准；external_pending 不显示成发布成功；
 * run_busy/version_conflict/run_result_unknown/403 只提示且不自动重试（断言请求次数）。
 * 第三切片：office↔street↔cafe 往返与防连跳、触摸与键盘共用碰撞（格子永不进墙）、
 * 输入法组词不带动人物、旋转保留位置与当前界面、首包门槛在「出生地图就绪」处结算
 * （street/cafe 资产切图时才加载，不计入首包），三图全量 gzip 合计另有一条门槛断言。
 * 第四切片：坐姿角色按作者座位到位（data-seats 读得到）、员工表现跟随权威状态
 * （派单中离开工位去会合点、终态后交回并回工位，data-staff 读得到）、走近普通 NPC
 * 打开**作者预写对白**且全程 0 次写请求（不调用模型或业务工具）。
 * 第四切片修复轮（逐格走动）：走帧图集不进首包（首包边界上没有任何 office-walk 请求）、
 * 玩家操作之后才由 load.multiatlas 懒加载、员工真的按格走过（data-actor-cells 采到
 * 至少两个中间格，逐格四邻相接，用时与速度一致——不是瞬移）。
 * 第五切片（故障恢复与竞争场景）：断流（离线提示 + 重试入口 + 有界重连续订 + 不重发写请求）、
 * 事件窗口滚出（reset → 重读快照 → 先如实提示可能不完整、结束后按权威快照补齐且不重复）、
 * 权限失效（未登录横幅 + 清空旧数据 + 写入口停用并写明原因）、后台→回前台
 * （visibilitychange：后台暂停渲染并落盘位置、回前台恢复渲染并重读权威状态、可见状态正确）、
 * 双入口并发（另一个入口回复 → 本入口跟着换轮）、迟到 stop 与迟到回复（幂等空操作 /
 * not_waiting 提示且不重试）、响应未知后的手动重试（两次请求一次执行）、正文不落盘。
 * 第六切片（发布候选与整体验收）：**HAR**（`recordHar`，上下文关闭时落
 * `.artifacts/<engine>-browser-check.har`，只记请求/响应元数据不嵌正文）、**设备与环境记录**
 * （浏览器版本、UA、viewport、DPR、GPU 渲染器、机器摘要，写进同一份检查产物 JSON），以及
 * **重场景帧预算**：出生地图重新装载全量名册（办公楼 10 人；连同咖啡店 1 位共 11 位角色，
 * 但单场景同屏最多 10 人——口径见报告），采样前用探针确认键盘能带动人物（探针只试作者碰撞
 * 网格上当前格真的可走的方向，撞墙不动是正常行为；尝试方向与可走性写进产物），
 * 走帧图集就绪后老板持续走动（走动帧 + 镜头跟随），
 * 采样期间用包装过的 `fetch` 直接数管家 SSE 事件、并按帧读 `data-actor-cells` 记录主动走动的
 * 角色与姿态；桌面 1440×1000 采样 ≥600 帧，断言 ≥60FPS 且 p95≤20ms；移动视口 390×844
 * （模拟，非真机）采样 ≥300 帧，断言 ≥30FPS 且 p95≤33ms。管线里没有粒子/补间 VFX 层，
 * 所以「环境特效」一项按 0 如实记录（第四阶段的 48 个特效属于技术验证原型夹具）。
 * 桩控制口与场景标记（#cut/#trim/#done/#late_stop/#late_reply）见 scripts/local-butler.mjs 头注释。
 * 截图与结果写 .artifacts/，供人工复核。
 *
 * 用法：node scripts/browser-check.mjs [edge|chromium]
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { startVerifyServer } from './local-verify.mjs'

const require = createRequire(resolve('node_modules', 'playwright/package.json'))
const { chromium } = require('playwright')

const engineName = process.argv[2] ?? 'chromium'
assert(['edge', 'chromium'].includes(engineName), '本切片基线只跑 edge / chromium')
// 基线浏览器与第四阶段记录一致：Chromium 148.0.7778.96（本机缓存 chromium-1223），
// Edge 走系统 msedge 渠道；可用 NIUMA_CHROMIUM_EXECUTABLE 覆盖。
const chromiumExecutable = process.env.NIUMA_CHROMIUM_EXECUTABLE
  ?? process.env.LOCALAPPDATA + '\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe'
const directory = resolve('.artifacts')
await mkdir(directory, { recursive: true })

// 实施计划的首包门槛：首次静态请求 ≤10 个，gzip 合计 ≤640KiB。
const FIRST_LOAD_MAX_REQUESTS = 10
const FIRST_LOAD_MAX_GZIP_BYTES = 640 * 1024

const fixture = await startVerifyServer()
const browser = await chromium.launch({
  headless: true, timeout: 30_000,
  ...(engineName === 'edge'
    ? { channel: 'msedge' }
    : { executablePath: chromiumExecutable }),
})

const report = { engine: engineName, version: browser.version(), headless: true, origin: fixture.origin, cases: [], requests: [] }
const errors = []
const origins = new Set()
/** 管家写请求的路径序列（含失败的那些——response 事件看不到断开的请求）。 */
const butlerPosts = []
const countPosts = path => butlerPosts.filter(entry => entry === path).length
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  // HAR：只记请求/响应元数据（含体积与耗时），不嵌正文，避免把 1.5MB 的 JS 与图集塞进证据。
  recordHar: { path: resolve(directory, engineName + '-browser-check.har'), content: 'omit', mode: 'full' },
})
/**
 * SSE 观测（只在页面里计数，不改变任何语义）：包装 `fetch`，对 `text/event-stream`
 * 响应取一路 `clone()` 旁路统计——收到多少块、多少字节、解析出多少个带 `type` 的事件。
 * 重场景采样据此证明「采样期间管家事件确实在推」，而不是靠界面文本间接推断。
 * 这里必须用 `clone()`：`body.tee()` 会把响应体锁住，页面自己的读者会直接失败（实测
 * 连接异常并反复重连），clone 出来的第二路才与页面各读各的、互不影响。
 */
await context.addInitScript(() => {
  const original = globalThis.fetch
  if (typeof original !== 'function') return
  const state = globalThis.__NIUMA_SSE__ = { chunks: 0, bytes: 0, events: 0, types: {} }
  globalThis.fetch = async function (input, init) {
    const response = await original.call(this, input, init)
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream') || response.body === null) return response
    const observed = response.clone()
    void (async () => {
      const reader = observed.body.getReader()
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          state.chunks++
          state.bytes += value.byteLength
          for (const line of decoder.decode(value, { stream: true }).split('\n')) {
            if (!line.startsWith('data:')) continue
            try {
              const event = JSON.parse(line.slice(5).trim())
              if (event !== null && typeof event === 'object' && typeof event.type === 'string') {
                state.events++
                state.types[event.type] = (state.types[event.type] ?? 0) + 1
              }
            } catch { /* 跨块残片或 [DONE]：不计入事件数。 */ }
          }
        }
      } catch { /* 订阅被取消属于正常断流。 */ }
    })()
    return response
  }
})
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
// 「Failed to load resource」是浏览器对非 2xx/断开 fetch 的固定诊断：写链路的
// 错误路径（409/403/断连）按用例故意触发并由页面处理，不算页面错误；其余照记。
page.on('console', message => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push('console: ' + message.text())
})
page.on('request', request => {
  if (request.method() !== 'POST') return
  const url = new URL(request.url())
  if (url.pathname.startsWith('/butler/')) butlerPosts.push(url.pathname)
})
page.on('response', response => {
  if (!response.url().startsWith('http')) return
  const url = new URL(response.url())
  origins.add(url.origin)
  report.requests.push({ path: url.pathname, status: response.status() })
})

const check = async (name, run) => {
  try { await run(); report.cases.push({ name, ok: true }) } catch (error) { report.cases.push({ name, ok: false, error: String(error) }) }
}

const playerCell = () => page.evaluate(() => document.querySelector('[data-player-cell]')?.getAttribute('data-player-cell') ?? '')
const playerFacing = () => page.evaluate(() => document.querySelector('[data-player-facing]')?.getAttribute('data-player-facing') ?? '')
/** 当前前台地图：挂载点上的 data-scene，切图后跟着变。 */
const scene = () => page.evaluate(() => document.querySelector('[data-scene]')?.getAttribute('data-scene') ?? '')
const cellNow = async () => (await playerCell()).split(',').map(Number)
/** 出生地图的运行时（含碰撞）：断言人物格子永不落进阻挡格时用它，避免凭截图判断。 */
const runtimeOf = async (map) => JSON.parse(await readFile(resolve('web', 'generated', map + '.runtime.json'), 'utf8'))
const walkable = (runtime, cell) => runtime.collision[cell[1] * runtime.width + cell[0]] === 0
/** 人物表现诊断：坐着的角色与员工当前动作（表现层按变化写入挂载点）。 */
const seatsNow = () => page.evaluate(() => document.querySelector('[data-seats]')?.getAttribute('data-seats') ?? '')
const staffNow = () => page.evaluate(() => document.querySelector('[data-staff]')?.getAttribute('data-staff') ?? '')
/**
 * 员工条目：`id=动作+走动状态`。走动状态是表现事实（walking/arrived/instant/
 * walk_failed/walk_timeout），断动作时只比 `+` 前面的部分。
 */
const staffEntries = async () => Object.fromEntries((await staffNow()).split(',')
  .filter(entry => entry.includes('='))
  .map(entry => {
    const [id, value] = entry.split('=')
    const [action, phase = ''] = (value ?? '').split('+')
    return [id, { action, phase }]
  }))
/** 非老板角色的格与姿态：`id:x,y:pose`（逐格走动的轨迹读它）。 */
const actorCells = async () => Object.fromEntries((await page.evaluate(() =>
  document.querySelector('[data-actor-cells]')?.getAttribute('data-actor-cells') ?? ''))
  .split(';').filter(entry => entry.includes(':'))
  .map(entry => {
    const [id, cell, pose] = entry.split(':')
    return [id, { cell: (cell ?? '').split(',').map(Number), pose: pose ?? '' }]
  }))
const staffPhase = async (id) => (await staffEntries())[id]?.phase ?? ''
const waitScene = (name, timeout = 5_000) =>
  page.waitForFunction(expected => document.querySelector('[data-scene]')?.getAttribute('data-scene') === expected, name, { timeout }).catch(async error => {
    const cell = await cellNow().catch(() => 'cell?')
    const toast = await page.locator('.toast').textContent().catch(() => 'toast?')
    const portal = await page.evaluate(() => document.querySelector('[data-portal]')?.getAttribute('data-portal') ?? 'none').catch(() => '?')
    console.error('[waitScene FAIL]', name, JSON.stringify({ cell, toast, portal }))
    throw error
  })
/** 短促点按方向键：像真人按键一样按下再抬起，位移交给场景自己的 update。 */
const nudge = async (key, ms = 240) => {
  await page.keyboard.down(key)
  await delay(ms)
  await page.keyboard.up(key)
  await delay(220)
}
/** 任务本开合：只在状态与预期不符时点，避免依赖上一条用例的收尾。 */
const openBook = async () => {
  if (await page.locator('.task-book').count() === 0) await page.click('.book-toggle')
  await page.waitForSelector('.task-book', { timeout: 5_000 })
}
const closeBook = async () => {
  if (await page.locator('.task-book').count() > 0) {
    await page.click('.task-book header button')
    await page.waitForSelector('.task-book', { state: 'detached', timeout: 5_000 })
  }
}
/** 等人物站定：连续两次采样格子不变才算停住（上一条用例的点击寻路可能还在走）。 */
const settle = async (quiet = 400, timeout = 5_000) => {
  const started = Date.now()
  let last = await playerCell()
  while (Date.now() - started < timeout) {
    await delay(quiet)
    const now = await playerCell()
    if (now === last) return now
    last = now
  }
  return last
}

/** 试着让键盘产生位移：三个方向各按一下，只要有一次格子变了就算能动。 */
const movedByKeyboard = async () => {
  const before = await playerCell()
  for (const key of ['s', 'd', 'w']) {
    await nudge(key, 350)
    if (await playerCell() !== before) return true
  }
  return false
}
/** 逐次微调朝目标格走：每次按一下方向键再读格，避免依赖固定时长。 */
const walkToward = async (target, budget = 40) => {
  for (let step = 0; step < budget; step++) {
    const [x, y] = await cellNow()
    if (x === target[0] && y === target[1]) return true
    const key = x !== target[0] ? (x < target[0] ? 'd' : 'a') : (y < target[1] ? 's' : 'w')
    await nudge(key, 240)
  }
  const [x, y] = await cellNow()
  return x === target[0] && y === target[1]
}

/**
 * 在作者碰撞网格上按四向找路并逐格走过去（与游戏共用同一份 collision，不猜几何）。
 * 键盘每次只推进一格，格子真的变了再走下一步：比固定时长稳，也不依赖镜头位置。
 */
const routeTo = (runtime, from, to, blocked) => {
  const key = (cell) => cell[0] + ',' + cell[1]
  const queue = [from]
  const previous = new Map([[key(from), null]])
  while (queue.length > 0) {
    const current = queue.shift()
    if (key(current) === key(to)) break
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = [current[0] + dx, current[1] + dy]
      if (previous.has(key(next))) continue
      if (next[0] < 0 || next[1] < 0 || next[0] >= runtime.width || next[1] >= runtime.height) continue
      if (!walkable(runtime, next)) continue
      if (blocked && blocked.has(key(next)) && key(next) !== key(to)) continue
      previous.set(key(next), key(current))
      queue.push(next)
    }
  }
  if (!previous.has(key(to))) return null
  const path = []
  for (let cursor = key(to); cursor !== null && cursor !== key(from); cursor = previous.get(cursor)) {
    path.push(cursor.split(',').map(Number))
  }
  return path.reverse()
}
const keyToward = (from, to) => to[0] !== from[0] ? (to[0] > from[0] ? 'd' : 'a') : (to[1] > from[1] ? 's' : 'w')
const walkRoute = async (target, budget = 120) => {
  const startScene = await scene()
  let stalled = 0
  for (let step = 0; step < budget; step++) {
    // 目标是入口触发格时踩上即切图：场景变了就视为到达，不再把玩家往新图的坐标上带。
    if (await scene() !== startScene) return true
    const current = await cellNow()
    if (current[0] === target[0] && current[1] === target[1]) return true
    const runtime = await runtimeOf(await scene())
    // F6 软阻挡后游戏内 NPC 站定格不可入：用例寻路与游戏同语义（行走中的不算占格）。
    const actors = await actorCells()
    const blocked = new Set(Object.values(actors).filter(a => a.pose !== 'walking').map(a => a.cell.join(',')))
    const path = routeTo(runtime, current, target, blocked)
    if (path === null || path.length === 0) return false
    const before = current.join(',')
    await nudge(keyToward(current, path[0]), 220)
    // 终点被占（NPC 恰好在终点）等短暂阻挡：连续原地三次就放弃，交给上层按距离判定。
    if ((await cellNow()).join(',') === before) { stalled++; if (stalled >= 3) return false } else stalled = 0
  }
  const current = await cellNow()
  return current[0] === target[0] && current[1] === target[1]
}
/**
 * 走近一个会自己走动的角色（普通职员的自主活动）：每轮读一次它的当前格再寻路，
 * 直到老板与它的欧氏距离进了交互半径（1.5 格）。活动域很小，几轮就能靠近。
 */
const approachActor = async (id, rounds = 8) => {
  for (let round = 0; round < rounds; round++) {
    const where = (await actorCells())[id]
    if (where === undefined) return false
    await walkRoute(where.cell)
    const [x, y] = await cellNow()
    const now = (await actorCells())[id]
    if (now && Math.hypot(now.cell[0] - x, now.cell[1] - y) <= 1) return true
  }
  return false
}

await page.goto(fixture.origin + '/niuma-boss', { waitUntil: 'domcontentloaded' })

await check('页面装载并渲染 office 场景', async () => {
  await page.waitForSelector('canvas', { timeout: 20_000 })
  await page.waitForSelector('[data-scene="office"]', { timeout: 5_000 })
  // 「地图装载中」徽标消失说明运行时资源（地图+老板+NPC 图集）加载完成。
  await page.waitForSelector('.hud button[disabled]', { state: 'detached', timeout: 20_000 })
})

await check('NPC 合并图集被请求且成功', async () => {
  await delay(300)
  const atlas = report.requests.filter(r => r.path === '/niuma-boss/generated/office-npcs.json')
  assert.ok(atlas.length >= 1 && atlas.every(r => r.status === 200), 'office-npcs 图集未成功加载')
})

await check('管家链路连接成功', async () => {
  await page.waitForFunction(() => document.querySelector('.hud .badge')?.textContent?.includes('已连接'), undefined, { timeout: 15_000 })
})

/**
 * 首包结算点：出生地图（office）就绪、管家链路接通为止的静态请求与 gzip 量。
 * street / cafe 的运行时与图集在第一次切图时才加载，按设计不进首包；这里定下边界，
 * 后面再出现 /niuma-boss/* 请求也不会把首包口径撑大。
 */
const settleFirstLoad = async () => {
  const staticPaths = [...new Set(report.requests
    .filter(r => r.path === '/niuma-boss' || r.path.startsWith('/niuma-boss/'))
    .map(r => r.path))]
  let gzipTotal = 0
  for (const path of staticPaths) {
    const file = path === '/niuma-boss' ? resolve('web', 'index.html') : resolve('web', path.replace('/niuma-boss/', ''))
    gzipTotal += gzipSync(await readFile(file)).length
  }
  report.firstLoad = { requests: staticPaths.length, gzipBytes: gzipTotal, paths: staticPaths, boundary: '出生地图就绪（office 场景 + 管家链路）' }
  return report.firstLoad
}

await check('首包（出生地图就绪）静态请求与 gzip 量满足计划门槛', async () => {
  const first = await settleFirstLoad()
  assert.ok(first.requests <= FIRST_LOAD_MAX_REQUESTS, `首次静态请求 ${first.requests} 个，超过门槛 ${FIRST_LOAD_MAX_REQUESTS}`)
  assert.ok(first.gzipBytes <= FIRST_LOAD_MAX_GZIP_BYTES, `静态 gzip 合计 ${first.gzipBytes} 字节，超过门槛 ${FIRST_LOAD_MAX_GZIP_BYTES}`)
  // 切图才会加载的资产不能混进首包：出生边界上不应出现 street/cafe。
  assert.ok(!first.paths.some(path => path.includes('street') || path.includes('cafe')), '首包里出现了 street/cafe 资源：' + first.paths.join(', '))
  // 走帧图集不进首包：出生就绪这条边界上一个 office-walk 请求都不许有。
  assert.ok(!first.paths.some(path => path.includes('walk')), '首包里出现了走帧图集：' + first.paths.join(', '))
})

await check('三图往返：office→street→cafe→street→office，落点固定', async () => {
  await closeBook()
  const visited = []
  const shots = []
  /** 记一格并给当前场景留一张画面指纹：三图都渲染出内容，且三张画面互不相同。 */
  const record = async (map) => {
    const cell = await cellNow()
    const runtime = await runtimeOf(map)
    assert.ok(walkable(runtime, cell), `${map} 上的人物落在阻挡格 ${cell.join(',')}`)
    visited.push(map + ':' + cell.join(','))
    console.error('[roundtrip]', visited.at(-1))
    const shot = await page.locator('.game canvas').screenshot()
    assert.ok(shot.length > 30_000, `${map} 场景画面只有 ${shot.length} 字节，可能是空白`)
    shots.push({ map, bytes: shot.length, token: createHash('sha256').update(shot).digest('hex').slice(0, 12) })
    return cell
  }
  // 出生点在办公楼前台，门口触发格就在南边一格。
  assert.equal(await scene(), 'office')
  assert.deepEqual(await record('office'), [34, 26])
  await nudge('s', 500)
  await waitScene('street')
  assert.deepEqual(await record('street'), [5, 12], '进入街道的落点不是 street_to_office 的到达格')
  // 沿人行道走到咖啡店门口：y=12 这一行整排可走，再往北一格踩触发格。
  assert.ok(await walkToward([13, 12]), '没能在街道上走到咖啡店门前')
  await record('street')
  await nudge('w', 500)
  await waitScene('cafe')
  assert.deepEqual(await record('cafe'), [6, 11], '进入咖啡店的落点不是 cafe_to_street 的到达格')
  // 原路返回：咖啡店门口往南踩触发格回街道，再回办公楼。
  await nudge('s', 500)
  await waitScene('street')
  assert.deepEqual(await record('street'), [13, 13], '退回街道的落点不是 street_to_cafe 的到达格')
  assert.ok(await walkToward([13, 12]), '没能回到人行道')
  assert.deepEqual(await cellNow(), [13, 12])
  assert.ok(await walkToward([5, 12]), '没能在街道上走回办公楼门前')
  await nudge('w', 500)
  await waitScene('office')
  assert.deepEqual(await record('office'), [34, 26], '回到办公楼的落点不是 office_to_street 的到达格')
  report.roundTrip = visited
  report.sceneShots = shots
  assert.equal(new Set(shots.map(shot => shot.token)).size, shots.length, '三图画面出现重复，可能没有真正换图：' + JSON.stringify(shots))
  assert.deepEqual(shots.map(shot => shot.map), ['office', 'street', 'street', 'cafe', 'street', 'office'])
  await page.screenshot({ path: resolve(directory, engineName + '-roundtrip.png') })
})

await check('防连跳：刚穿过的入口在离开触发格前不再触发', async () => {
  // 上一步刚回到办公楼 [34,26]（到达格 ≠ 触发格），站着不动不应再次穿门。
  await delay(600)
  assert.equal(await scene(), 'office')
  assert.deepEqual(await cellNow(), [34, 26])
  // 踩上触发格穿到街道后，立刻停住：落点是到达格，不会被弹回办公楼。
  await nudge('s', 500)
  await waitScene('street')
  const landed = await cellNow()
  await delay(700)
  assert.equal(await scene(), 'street', '落到街道后被立即弹回')
  assert.deepEqual(await cellNow(), landed, '落地后位置自行漂移')
  await page.screenshot({ path: resolve(directory, engineName + '-portal-safe.png') })
  // 收拾现场：走回办公楼出生点，后续用例按原来的起点继续。
  await nudge('w', 400)
  await waitScene('office')
  assert.deepEqual(await cellNow(), [34, 26], '回到办公楼的落点不对')
})

await check('任务本读取同一用户的权威任务并跟随 SSE', async () => {
  await openBook()
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('园区安全博客'), undefined, { timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('起草博客'), undefined, { timeout: 10_000 })
  // SSE 增量持续追加：正文随时间变长。
  const length = async () => (await page.locator('.task-book').innerText()).length
  const before = await length()
  await delay(2_600)
  const after = await length()
  assert.ok(after > before, `SSE 增量未推进任务正文（${before} → ${after}）`)
  await page.screenshot({ path: resolve(directory, engineName + '-taskbook.png') })
})

await check('切换会话读取另一份权威快照', async () => {
  await page.click('.conversations button:nth-child(2)')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('会议纪要'), undefined, { timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('已完成'), undefined, { timeout: 10_000 })
  // 回到活跃会话继续观察。
  await page.click('.conversations button:nth-child(1)')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('园区安全博客'), undefined, { timeout: 10_000 })
})

await check('键盘移动改变所在格（W 向上）', async () => {
  await closeBook()
  await page.waitForFunction(() => document.querySelector('[data-player-cell]') !== null, undefined, { timeout: 10_000 })
  const before = await playerCell()
  await page.screenshot({ path: resolve(directory, engineName + '-move-before.png') })
  await page.keyboard.down('w')
  await delay(800)
  await page.keyboard.up('w')
  await delay(400)
  const after = await playerCell()
  const [bx, by] = before.split(',').map(Number)
  const [ax, ay] = after.split(',').map(Number)
  assert.ok(Number.isInteger(ay) && ay < by, `向上移动未生效（${before} → ${after}）`)
  assert.ok(Math.abs(ax - bx) <= 1, `向上移动出现横向漂移（${before} → ${after}）`)
  await page.screenshot({ path: resolve(directory, engineName + '-move-after.png') })
})

await check('点击地面寻路到目标格', async () => {
  const before = await playerCell()
  assert.ok(before !== '', '缺少位置诊断属性')
  await page.screenshot({ path: resolve(directory, engineName + '-clickmove-before.png') })
  // 视口 (360, 400) 在默认镜头下是可通行区域；点击后人物应离开原格。
  await page.mouse.click(360, 400)
  await delay(2_000)
  const after = await playerCell()
  assert.ok(after !== '' && after !== before, `点击寻路未产生位移（${before} → ${after}）`)
  await page.screenshot({ path: resolve(directory, engineName + '-clickmove.png') })
})

await check('触摸与键盘共用碰撞：格子永不进入阻挡格', async () => {
  const current = await scene()
  const collision = await runtimeOf(current)
  // 键盘方向：朝东一直走，墙前必须停住。
  await page.keyboard.down('d')
  await delay(2_400)
  await page.keyboard.up('d')
  await delay(300)
  const pushed = await cellNow()
  assert.ok(walkable(collision, pushed), `${current} 上键盘把人物推进了阻挡格 ${pushed.join(',')}`)
  assert.ok(pushed[0] < collision.width - 1, `人物走进了外围墙 ${pushed.join(',')}`)
  // 触摸（点击地面）走的是同一份碰撞：连续点几处，任何一处都不许落进阻挡格。
  for (const [x, y] of [[420, 520], [900, 300], [700, 760], [1180, 620]]) {
    await page.mouse.click(x, y)
    await delay(1_400)
    const cell = await cellNow()
    assert.ok(walkable(collision, cell), `点击寻路把人物放进阻挡格 ${cell.join(',')}`)
  }
  report.touchCells = await playerCell()
})

await check('输入法组词不带动人物（真机输入法未验证）', async () => {
  // 任务本关着：组词中的按键事件（isComposing / keyCode 229）不进移动意图。
  const before = await settle()
  await page.evaluate(() => {
    window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', bubbles: true }))
  })
  await delay(700)
  assert.equal(await playerCell(), before, '组词中人物被方向键带走')
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp', keyCode: 229, bubbles: true }))
  })
  await delay(700)
  assert.equal(await playerCell(), before, 'keyCode 229（输入法确认）带动了人物')
  await page.evaluate(() => window.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  // 焦点在输入框里时，键盘属于输入：打开任务本、聚焦派活框后按键不移动人物。
  await page.click('.book-toggle')
  await page.waitForSelector('.assign textarea', { timeout: 5_000 })
  await page.click('.assign textarea')
  await nudge('w', 400)
  assert.equal(await playerCell(), before, '聚焦输入框时方向键带动了人物')
  // 组词结束并关掉任务本之后恢复移动：证明前面的「不动」是输入边界而不是卡死。
  await closeBook()
  assert.ok(await movedByKeyboard(), '关掉输入界面后键盘仍不能移动')
})

await check('旋转保留位置与当前界面，可见区域跟随', async () => {
  const cell = await settle()
  const map = await scene()
  await openBook()
  await page.fill('.assign textarea', '旋转前后都要留着的草稿')
  await page.setViewportSize({ width: 390, height: 844 })
  await delay(700)
  assert.equal(await playerCell(), cell, '旋转后位置变了')
  assert.equal(await scene(), map, '旋转后换了地图')
  assert.ok(await page.isVisible('.task-book'), '旋转后任务本被关掉')
  assert.equal(await page.inputValue('.assign textarea'), '旋转前后都要留着的草稿', '旋转后草稿丢了')
  const portrait = await page.evaluate(() => ({
    vvh: getComputedStyle(document.documentElement).getPropertyValue('--vvh').trim(),
    inner: window.innerHeight,
    width: document.querySelector('.task-book')?.getBoundingClientRect().width ?? 0,
  }))
  assert.equal(portrait.vvh, portrait.inner + 'px', '可见高度没有跟随窗口')
  assert.ok(portrait.width >= 380, '竖屏下任务本没有占满宽度')
  await page.screenshot({ path: resolve(directory, engineName + '-portrait.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await delay(700)
  assert.equal(await playerCell(), cell, '转回横屏后位置变了')
  assert.ok(await page.isVisible('.task-book'), '转回横屏后任务本被关掉')
  await page.fill('.assign textarea', '')
  await closeBook()
  await page.screenshot({ path: resolve(directory, engineName + '-landscape.png') })
})

await check('位置快照按用户只写四项，刷新后按用户恢复', async () => {
  const settled = await settle()
  const cell = settled.split(',').map(Number)
  const map = await scene()
  const stored = await page.evaluate(() => Object.entries(localStorage).map(([key, value]) => ({ key, value })))
  const snapshot = stored.find(entry => entry.key.startsWith('niuma-boss:world:') && entry.key !== 'niuma-boss:world:last')
  assert.ok(snapshot, '没有按用户写位置快照')
  assert.equal(snapshot.key.length, 'niuma-boss:world:'.length + 8, '作用域不是身份短哈希：' + snapshot.key)
  const parsed = JSON.parse(snapshot.value)
  assert.deepEqual(Object.keys(parsed), ['map', 'cell', 'facing', 'preferences'])
  assert.deepEqual(parsed.cell, cell, '快照里的格子与当前位置不一致')
  assert.equal(parsed.map, map)
  // 不存任务正文与凭据：任务本里的权威正文、登录身份原文、授权链接都不落盘。
  const joined = stored.map(entry => entry.key + '=' + entry.value).join(String.fromCharCode(10))
  for (const forbidden of ['写博客', '草稿写到一半', '园区安全博客', 'user:local-verify', '/auth', 'token', 'Bearer', 'requestId']) {
    assert.ok(!joined.includes(forbidden), '位置快照里出现了不该存的内容：' + forbidden)
  }
  report.storage = { keys: stored.map(entry => entry.key), snapshot: parsed }
  // 刷新页面：按同一位用户的快照回到同一张地图的同一格。
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas', { timeout: 20_000 })
  await page.waitForFunction(expected => document.querySelector('[data-scene]')?.getAttribute('data-scene') === expected, map, { timeout: 20_000 })
  await page.waitForFunction(() => document.querySelector('[data-player-cell]') !== null, undefined, { timeout: 10_000 })
  assert.deepEqual(await cellNow(), cell, '刷新后没有恢复到原来的格子')
  assert.equal(await scene(), map, '刷新后没有恢复到原来的地图')
  await page.screenshot({ path: resolve(directory, engineName + '-reload-restore.png') })
})

// ---- 第四切片：人物表现（作者座位与站坐）、普通 NPC 预写对白 ----

await check('人物表现：坐姿角色按作者座位到位，员工按权威状态离开工位去会合点', async () => {
  // 页面刚按用户快照重载过，当前是种子活跃轮（会话一，blog 在跑）。
  const seats = (await seatsNow()).split(',').filter(Boolean)
  const staff = await staffNow()
  const entries = await staffEntries()
  assert.ok(seats.length > 0 && staff !== '', '缺少人物表现诊断属性（data-seats / data-staff）')
  // 派单中的员工离开自己的座位去会合点；其余员工留在工位待命。
  assert.deepEqual(Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.action])),
    { example: 'at_post', closedoff: 'at_post', blog: 'start_work' }, '员工表现命令与权威状态不符：' + staff)
  // 出生装载时走帧还没就绪：按到位处理，并且**如实标注**（不是「走过了」）。
  assert.equal(entries.blog.phase, 'instant', '出生装载期间的员工走动没有如实标注：' + staff)
  assert.ok(!seats.includes('blog'), '派单中的员工还在座位上：' + seats)
  for (const id of ['example', 'closedoff']) {
    assert.ok(seats.includes(id), `员工 ${id} 没有按作者座位就位：${seats}`)
  }
  // 构建产物里带着作者座位与遮挡层（椅背只画在坐姿角色之上，按作者深度）。
  const office = await runtimeOf('office')
  const seated = office.characters.filter(character => character.seat)
  assert.equal(seated.length, 7, '运行时座位数量与作者工位不符：' + seated.length)
  const back = seated.filter(character => character.seat.occlusion)
  assert.equal(back.length, 6, '椅背遮挡层数量与作者声明不符：' + back.length)
  assert.ok(seated.every(character => character.seat.occlusion === null
    || character.seat.occlusion.depth > character.seat.depth), '椅背遮挡没有画在坐姿角色之上')
  assert.ok(seated.every(character => character.seat.direction === character.seat.sit.direction), '坐姿帧方向与作者座位方向不一致')
  // 普通职员按 npc_rules.yaml#preview.autonomy 在作者活动域里自主走动：不在座位上也算合格，
  // 但所在格必须落在**本人**的活动域里（不越界、不到阻挡格）。
  const cells = await actorCells()
  for (const character of office.characters.filter(entry => entry.activity)) {
    const allowed = new Set(character.activity.cells.map(cell => cell.join(',')))
    const where = cells[character.id]
    assert.ok(where !== undefined, `缺少普通职员 ${character.id} 的位置诊断`)
    const home = character.seat ? character.seat.cell.join(',') : character.cell.join(',')
    assert.ok(where.pose === 'sit' ? where.cell.join(',') === home : allowed.has(where.cell.join(',')),
      `普通职员 ${character.id} 走到了活动域外：${where.cell.join(',')}（域：${[...allowed].join('|')}）`)
  }
  report.seats = { seatedIds: seats, staff }
  await page.screenshot({ path: resolve(directory, engineName + '-seated.png') })
})

/**
 * 第五阶段切片 4 修复轮：走帧独立图集 + 逐格走动。
 * 首包边界已在上面的用例断言过（没有 office-walk 请求）；这里验证玩家操作之后的
 * 懒加载，以及员工**真的按格走过**：抓取至少两个中间位置，逐格四邻相接，用时与
 * 作者给的速度一致——不是瞬移。
 */
await check('员工逐格走动：走帧懒加载在首包之后，位移逐格且用时可测', async () => {
  // 走帧图集是玩家操作之后才拉的：json 与 png 都拿到 200。
  const walkRequests = report.requests.filter(entry => entry.path.includes('office-walk'))
  assert.ok(walkRequests.some(entry => entry.path.endsWith('office-walk.json') && entry.status === 200),
    '玩家操作之后没有请求走帧图集：' + JSON.stringify(walkRequests))
  assert.ok(walkRequests.some(entry => entry.path.endsWith('office-walk.png') && entry.status === 200),
    '走帧图集图片没有成功加载：' + JSON.stringify(walkRequests))
  const office = await runtimeOf('office')
  const blogSeat = office.characters.find(character => character.id === 'blog')?.seat
  assert.ok(blogSeat, '运行时缺少 blog 的作者座位')
  // 刷新之后走帧图集要重新拉：先由玩家操作触发懒加载（任务本开着时按键只热身、不移动老板）。
  await openBook()
  assert.notEqual(await page.evaluate(() => document.querySelector('[data-walk]')?.getAttribute('data-walk') ?? ''), 'ready',
    '刷新后还没操作就把走帧算成已就绪')
  await page.keyboard.press('w')
  await page.waitForFunction(() => document.querySelector('[data-walk]')?.getAttribute('data-walk') === 'ready', undefined, { timeout: 15_000 })
  // 切到已完结的会话：blog 的命令变成回工位（at_post），从会合点逐格走回自己的座位。
  await page.click('.conversations button:nth-child(2)')
  await page.waitForFunction(() => (document.querySelector('[data-staff]')?.getAttribute('data-staff') ?? '').includes('blog=at_post'), undefined, { timeout: 10_000 })
  const samples = []
  const started = Date.now()
  while (Date.now() - started < 20_000) {
    const where = (await actorCells()).blog
    if (where === undefined) break
    samples.push({ at: Date.now(), cell: where.cell.join(','), pose: where.pose, phase: await staffPhase('blog') })
    if (samples[samples.length - 1].phase === 'arrived' && where.pose === 'sit' && where.cell.join(',') === blogSeat.cell.join(',')) break
    await delay(120)
  }
  const steps = samples.filter((sample, index) => index === 0 || sample.cell !== samples[index - 1].cell)
  const phases = new Set(samples.map(sample => sample.phase))
  report.walk = {
    seat: blogSeat.cell, steps: steps.map(sample => sample.cell), phases: [...phases],
    ms: samples.length > 1 ? samples[samples.length - 1].at - samples[0].at : 0,
  }
  // 真的走过：至少两个中间位置（起止之外），而且每一段都是四邻相接的一格。
  assert.ok(steps.length >= 4, '没抓到足够的中间位置：' + JSON.stringify(steps.map(step => step.cell)))
  assert.ok(steps.some(sample => sample.phase === 'walking'), '员工没有进入逐格走动状态：' + [...phases].join(','))
  for (let index = 1; index < steps.length; index++) {
    const [x, y] = steps[index].cell.split(',').map(Number)
    const [px, py] = steps[index - 1].cell.split(',').map(Number)
    assert.equal(Math.abs(x - px) + Math.abs(y - py), 1, `位移跳格：${steps[index - 1].cell} → ${steps[index].cell}`)
  }
  // 逐格位移不是瞬移：走过的格数 × 单格用时（回工位 2.5 格/秒）与实际用时可比。
  const elapsed = samples[samples.length - 1].at - samples[0].at
  assert.ok(elapsed >= (steps.length - 1) / 3.0 * 1000 * 0.6, `位移用时过短，疑似瞬移：${steps.length - 1} 格 / ${elapsed}ms`)
  assert.equal(samples[samples.length - 1].cell, blogSeat.cell.join(','), '员工没有走回自己的作者座位')
  assert.equal(samples[samples.length - 1].pose, 'sit', '走回工位后没有坐下')
  await page.screenshot({ path: resolve(directory, engineName + '-walk.png') })
  // 收拾现场：切回活跃会话，blog 再走去会合点，后续用例按原来的会话继续。
  await page.click('.conversations button:nth-child(1)')
  await page.waitForFunction(() => (document.querySelector('[data-staff]')?.getAttribute('data-staff') ?? '').includes('blog=start_work'), undefined, { timeout: 10_000 })
  await closeBook()
})

// ---- 第二切片：一条真实任务的双入口写链路（会话二承接动态轮，不影响种子活跃轮） ----
await check('写链路：派活→SSE 推进→等待回复→回复完成→同一历史', async () => {
  await openBook()
  await page.click('.conversations button:nth-child(2)')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('会议纪要'), undefined, { timeout: 10_000 })
  const chatsBefore = countPosts('/butler/chat')
  const repliesBefore = countPosts('/butler/reply')
  await page.fill('.assign textarea', '整理一份茶水间补给清单')
  await page.click('.assign button[type="submit"]')
  // SSE 状态推进：任务先跑起来，再到等你回话，出现就地回复入口。
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('等你回话'), undefined, { timeout: 20_000 })
  await page.waitForSelector('.reply input', { timeout: 5_000 })
  await page.screenshot({ path: resolve(directory, engineName + '-waiting-user.png') })
  await page.fill('.reply input', '加两箱气泡水')
  await page.click('.reply button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已完成'), undefined, { timeout: 20_000 })
  // 终态后补读历史：任务本与管家入口读取的是同一份权威记录。
  await page.waitForFunction(() => {
    const items = [...document.querySelectorAll('.history li .goal')]
    return items.some(item => item.textContent?.includes('茶水间补给清单'))
  }, undefined, { timeout: 10_000 })
  assert.equal(countPosts('/butler/chat'), chatsBefore + 1, '派活请求次数不符')
  assert.equal(countPosts('/butler/reply'), repliesBefore + 1, '回复请求次数不符')
  await page.screenshot({ path: resolve(directory, engineName + '-round-completed.png') })
})

await check('写链路：响应未知→同一份提交重试→闭环', async () => {
  await page.fill('.assign textarea', '#network 修订茶水间补给清单')
  await page.click('.assign button[type="submit"]')
  // 连接被断开：结果不明，提示且不自动重试；重试入口出现。
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('无法确认'), undefined, { timeout: 10_000 })
  await page.waitForSelector('.assign-actions .retry-submit', { timeout: 5_000 })
  await delay(800)
  const chatsAfterGlitch = countPosts('/butler/chat')
  await page.click('.assign-actions .retry-submit')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('等你回话'), undefined, { timeout: 20_000 })
  // 手动重试只多发一次（同一 requestId，管家幂等不重复执行）。
  assert.equal(countPosts('/butler/chat'), chatsAfterGlitch + 1, '重试后请求次数不符')
  await page.fill('.reply input', '照第二版办')
  await page.click('.reply button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已完成'), undefined, { timeout: 20_000 })
})

await check('写链路：停止本轮受理即提示，收敛以管家事件为准', async () => {
  await page.fill('.assign textarea', '再排一次消防演练')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('等你回话'), undefined, { timeout: 20_000 })
  const stopsBefore = countPosts('/butler/stop')
  await page.click('.task .stop')
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('已请求停止本轮'), undefined, { timeout: 10_000 })
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已取消'), undefined, { timeout: 20_000 })
  await delay(800)
  assert.equal(countPosts('/butler/stop'), stopsBefore + 1, 'stop 出现自动重试')
  await page.screenshot({ path: resolve(directory, engineName + '-round-cancelled.png') })
})

await check('写链路：external_pending 显示待外部处理而非发布成功', async () => {
  await page.fill('.assign textarea', '#external 发布园区安全通告')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('待外部处理'), undefined, { timeout: 20_000 })
  const badge = await page.locator('.task .state .badge').innerText()
  assert.ok(!badge.includes('已完成'), 'external_pending 被显示成发布成功')
  assert.ok((await page.locator('.task-book').innerText()).includes('待办'), '待办理由未展示')
  await page.screenshot({ path: resolve(directory, engineName + '-external-pending.png') })
})

// ---- 第五切片：故障恢复与竞争场景 ----
// 断流（离线提示 + 有界重连 + 不重发写请求）、事件窗口滚出（reset → 重读快照 → 结束后补齐）、
// 权限失效（可见原因 + 写入口停用 + 清空旧数据）、双入口并发（另一个入口回复 → 本入口跟着换轮）、
// 迟到回复与迟到 stop、重试不重复执行（两次请求一次执行）、正文不落盘。

/** 桩控制口（仅本地桩）：驱动「另一个入口」、断流与权限撤换；形状见 local-butler.mjs 头注释。 */
const fixturePost = async payload => {
  const response = await fetch(fixture.origin + '/butler/__fixture', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  assert.equal(response.status, 200, '桩控制口调用失败：' + response.status)
  return await response.json()
}

/** 连续性采样：状态徽标与任务本头部按钮（断线/重连是瞬时提示，只在时间窗里才看得到）。 */
const sampleStatus = async (ms = 4_000, step = 120) => {
  const badges = new Set()
  const buttons = new Set()
  const started = Date.now()
  while (Date.now() - started < ms) {
    const snapshot = await page.evaluate(() => ({
      badge: document.querySelector('.hud .badge')?.textContent ?? '',
      buttons: [...document.querySelectorAll('.task-book > header button')].map(button => button.textContent?.trim() ?? '').join('|'),
    }))
    badges.add(snapshot.badge)
    buttons.add(snapshot.buttons)
    await delay(step)
  }
  return { badges: [...badges], buttons: [...buttons] }
}

const bookText = () => page.locator('.task-book').innerText()
/** 片段出现次数：用来断言正文既不重复也不丢。 */
const occurrences = (text, part) => text.split(part).length - 1

await check('断流：离线提示与重试入口出现，有界重连续订后继续，全程不重发写请求（#cut + 断事件流）', async () => {
  await openBook()
  await page.click('.conversations button:nth-child(2)')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('会议纪要'), undefined, { timeout: 10_000 })
  const chatsBefore = countPosts('/butler/chat')
  await page.fill('.assign textarea', '#cut 断流重连验证清单')
  await page.click('.assign button[type="submit"]')
  // 受理之后写响应在 500ms 被切断：这一轮在服务端继续跑，客户端应转只读订阅从最后序号续上。
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('断流重连验证清单'), undefined, { timeout: 15_000 })
  // 等客户端确实切到只读订阅（写流断开后立刻续订），再断开它并让下一次续订失败一次
  // （真实断网/服务端 5xx 的形态）：状态应落到断线并给出重试入口。
  let broke = { ok: false, dropped: 0 }
  for (let attempt = 0; attempt < 8 && broke.dropped === 0; attempt++) {
    await delay(400)
    broke = await fixturePost({ action: 'breakEvents', conversationIndex: 1 })
  }
  assert.ok(broke.ok === true && broke.dropped >= 1, '没能在会话上断开观察连接：' + JSON.stringify(broke))
  const statusWindow = await sampleStatus(5_000)
  assert.ok(statusWindow.badges.some(text => text.includes('中断') || text.includes('重连') || text.includes('异常')), '断流后没有出现断线提示：' + statusWindow.badges.join(' | '))
  assert.ok(statusWindow.buttons.some(text => text.includes('重试')), '断线时任务本没有给出重试入口：' + statusWindow.buttons.join(' | '))
  // 有界重连自己接上：等待事件照常到达，正文没有因为断流掉字。
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('等你回话'), undefined, { timeout: 25_000 })
  await page.waitForFunction(() => document.querySelector('.hud .badge')?.textContent?.includes('已连接'), undefined, { timeout: 20_000 })
  const text = await bookText()
  assert.equal(occurrences(text, '（草稿第 1 段：先列要点）'), 1, '断流后正文出现重复或丢字：' + text)
  assert.ok(text.includes('（草稿第 2 段：补齐说明）'), '断流后错过的增量没有续上')
  assert.equal(countPosts('/butler/chat'), chatsBefore + 1, '断流后出现了重新提交')
  report.cut = { badges: statusWindow.badges, buttons: statusWindow.buttons }
  await page.screenshot({ path: resolve(directory, engineName + '-cut-reconnect.png') })
  // 收拾现场：让这一轮正常收尾（回复后完成），后续用例从干净状态继续。
  await page.fill('.reply input', '照第一版办')
  await page.click('.reply button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已完成'), undefined, { timeout: 20_000 })
})

await check('事件窗口滚出：reset 后重读快照续表，先如实提示可能不完整，结束后按权威快照补齐且不重复（#trim #done）', async () => {
  const before = countPosts('/butler/chat')
  await page.fill('.assign textarea', '#trim #done 窗口滚出恢复验证清单')
  await page.click('.assign button[type="submit"]')
  // 窗口左边缘右移、连接被回收：续订游标落在窗口之外，客户端拿到 reset（不是错误）并重读快照。
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('正文可能不完整'), undefined, { timeout: 25_000 })
  const mid = await bookText()
  assert.ok(mid.includes('（草稿第 1 段：先列要点）'), '窗口滚出前已收到的正文被丢掉：' + mid)
  await page.screenshot({ path: resolve(directory, engineName + '-trim-incomplete.png') })
  // 结束：权威快照里这一轮已经落库（含滚出窗口的那一段），重读后补齐并清掉提示。
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已完成'), undefined, { timeout: 25_000 })
  await page.waitForFunction(() => !(document.querySelector('.task-book')?.textContent ?? '').includes('正文可能不完整'), undefined, { timeout: 20_000 })
  const text = await bookText()
  for (const part of ['（草稿第 1 段：先列要点）', '（草稿第 3 段：窗口滚出后继续写）', '（草稿第 4 段：补齐说明）', '（草稿第 5 段：收尾）']) {
    assert.equal(occurrences(text, part), 1, `补齐后的正文里「${part}」出现 ${occurrences(text, part)} 次（应为 1 次）：` + text)
  }
  assert.equal(countPosts('/butler/chat'), before + 1, '窗口滚出后出现了重新提交')
  report.trim = { mid: mid.slice(0, 200), final: text.slice(0, 400) }
  await page.screenshot({ path: resolve(directory, engineName + '-trim-recovered.png') })
})

await check('权限失效：撤换登录后按未登录提示、清空旧数据、写入口停用并写明原因', async () => {
  await openBook()
  assert.equal(await fixturePost({ identity: 401 }).then(body => body.identity), 401)
  // 下一次读取（切换会话）按 401 失败：身份不可信，旧数据一起清空。
  await page.click('.conversations button:nth-child(1)')
  await page.waitForSelector('.banner a[href*="/auth"]', { timeout: 10_000 })
  const banner = await page.locator('.banner').innerText()
  assert.ok(banner.includes('需要登录'), '未登录横幅文案不符：' + banner)
  await page.waitForFunction(() => document.querySelector('.assign textarea')?.disabled === true, undefined, { timeout: 10_000 })
  const reason = await page.locator('[data-write-blocked]').innerText()
  assert.ok(reason.includes('需要登录'), '写入口停用没有写明原因：' + reason)
  assert.equal(await page.locator('.assign-actions button[type="submit"]').isDisabled(), true, '未登录时派活按钮仍可用')
  assert.equal(await page.locator('.conversations button').count(), 0, '权限失效后旧会话列表没有清空')
  report.authRevoked = { banner, reason }
  await page.screenshot({ path: resolve(directory, engineName + '-auth-revoked.png') })
  // 恢复登录：刷新页面重新发现身份（存在本地位置快照，恢复同一位用户的落点）。
  assert.equal(await fixturePost({ identity: 200 }).then(body => body.identity), 200)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas', { timeout: 20_000 })
  await page.waitForFunction(() => document.querySelector('.hud .badge')?.textContent?.includes('已连接'), undefined, { timeout: 20_000 })
  await closeBook()
})

await check('后台→回前台（visibilitychange）：后台暂停渲染并落盘位置，回前台恢复渲染、重读权威状态且可见状态正确', async () => {
  // 上一条用例刚刷新过页面：链路已连接、会话一已在观察（种子活跃轮一直在推增量）。
  await closeBook()
  await page.waitForFunction(() => document.querySelector('.hud .badge')?.textContent?.includes('已连接'), undefined, { timeout: 15_000 })
  const cell = await settle()
  const map = await scene()
  const postsBefore = butlerPosts.length
  // 后台：走页面真实的可见性回调（document.hidden 置位 + visibilitychange）。
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  // 后台暂停渲染：方向键不再带动人物（暂停的事件与画面都不再推进）。
  await page.keyboard.down('w')
  await delay(700)
  await page.keyboard.up('w')
  await delay(200)
  assert.equal(await playerCell(), cell, '后台期间场景没有暂停：方向键仍带动了人物')
  assert.equal(await scene(), map, '后台期间换了地图')
  // 后台期间另一个入口在同一站开了一个新会话：本页面观察的是别的会话，看不到它，
  // 只能靠回前台的重读拿到——这条会话就是「回前台真的重读了权威状态」的证据。
  const behindConversationId = 'butler-web-' + crypto.randomUUID()
  const opened = await fetch(fixture.origin + '/butler/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: behindConversationId, message: '后台期间另一个入口开的会话' }),
  })
  assert.equal(opened.status, 200, '后台期间的另一个入口提交未被受理：' + opened.status)
  await opened.body?.cancel().catch(() => {}) // 断开读端：这一轮在服务端继续留着
  // 回前台：恢复渲染并重读权威快照。
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await openBook()
  await page.waitForFunction(() => (document.querySelector('.task-book')?.textContent ?? '').includes('后台期间另一个入口开的会话'), undefined, { timeout: 15_000 })
  // 可见状态正确：链路显示已连接、没有断线重试入口、当前会话与任务正文都还在。
  const badge = await page.locator('.hud .badge').first().innerText()
  assert.ok(badge.includes('已连接'), '回前台后链路状态不是已连接：' + badge)
  const headerButtons = await page.locator('.task-book > header button').allInnerTexts()
  assert.ok(!headerButtons.some(text => text.includes('重试')), '回前台后仍显示断线重试入口：' + headerButtons.join('|'))
  assert.equal(await scene(), map, '回前台换了地图')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('园区安全博客'), undefined, { timeout: 10_000 })
  // 恢复渲染：人物又能走动（证明前面的「不动」是后台暂停，而不是卡死）。
  await closeBook()
  assert.ok(await movedByKeyboard(), '回前台后键盘不能移动人物')
  // 重读是只读的：后台与回前台全程没有产生写请求。
  assert.equal(butlerPosts.length, postsBefore, '后台/回前台产生了写请求：' + butlerPosts.slice(postsBefore).join(', '))
  report.visibility = { badge, headerButtons, behindConversationId, posts: butlerPosts.length - postsBefore }
  await page.screenshot({ path: resolve(directory, engineName + '-visibility-resume.png') })
})

await check('双入口并发：另一个入口回复后本入口跟着换轮，两边读同一份任务且不重复正文', async () => {
  await openBook()
  await page.click('.conversations button:nth-child(2)')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('会议纪要'), undefined, { timeout: 10_000 })
  const postsBefore = butlerPosts.length
  await page.fill('.assign textarea', '双入口并发验证清单')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('等你回话'), undefined, { timeout: 20_000 })
  // 另一个入口（管家入口）替这位等待中的成员作答：同任务换执行轮，事件日志被新轮替换。
  const replied = await fixturePost({ otherEntry: 'reply', conversationIndex: 1 })
  assert.equal(replied.ok, true, '另一个入口没能回复：' + JSON.stringify(replied))
  // 本入口没有任何写请求，却跟着看到新轮的结果：换轮按 probe 重读快照并从 0 重放当前轮。
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已完成'), undefined, { timeout: 25_000 })
  assert.equal(butlerPosts.length, postsBefore + 1, '另一个入口回复期间本入口产生了额外写请求：' + butlerPosts.slice(postsBefore).join(', '))
  const text = await bookText()
  assert.ok(text.includes('（按你的选择定稿）'), '换轮后的新正文没有跟上：' + text)
  assert.equal(occurrences(text, '（草稿第 1 段：先列要点）'), 1, '换轮把上一轮的正文重复或丢了：' + text)
  assert.equal(occurrences(text, '（草稿第 2 段：补齐说明）'), 1, '换轮把上一轮的正文重复或丢了：' + text)
  report.dualEntry = { runId: replied.runId, text: text.slice(0, 300) }
  await page.screenshot({ path: resolve(directory, engineName + '-dual-entry.png') })
})

await check('迟到 stop：另一个入口先停掉 → 幂等空操作提示，不重试、不谎称正在收尾（#late_stop）', async () => {
  const stopsBefore = countPosts('/butler/stop')
  await page.fill('.assign textarea', '#late_stop 迟到停止验证清单')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('等你回话'), undefined, { timeout: 20_000 })
  await page.click('.task .stop')
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('本轮无需停止'), undefined, { timeout: 15_000 })
  const toast = await page.locator('.toast').innerText()
  assert.ok(toast.includes('已经不在执行了') || toast.includes('不需要'), '迟到 stop 的提示没有说明原因：' + toast)
  // 收敛以管家事件为准：这一轮按取消收尾，界面上不显示「正在收尾」。
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已取消'), undefined, { timeout: 20_000 })
  assert.equal(await page.locator('.task .stop').count(), 0, '本轮已结束后仍显示停止按钮')
  await delay(800)
  assert.equal(countPosts('/butler/stop'), stopsBefore + 1, 'stop 出现自动重试')
  report.lateStop = { toast }
  await page.screenshot({ path: resolve(directory, engineName + '-late-stop.png') })
})

await check('迟到回复：等待已被别的入口结束 → 按 not_waiting 提示，不重试也不改成本地推断（#late_reply）', async () => {
  const repliesBefore = countPosts('/butler/reply')
  await page.fill('.assign textarea', '#late_reply 迟到回复验证清单')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('等你回话'), undefined, { timeout: 20_000 })
  await page.fill('.reply input', '#late_reply 采用第二版')
  await page.click('.reply button[type="submit"]')
  // 回复到达时这次等待已经被另一个入口结束：管家按稳定码拒绝，界面按码给出提示。
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('没有在等你回话'), undefined, { timeout: 15_000 })
  const toast = await page.locator('.toast').innerText()
  await delay(800)
  assert.equal(countPosts('/butler/reply'), repliesBefore + 1, '回复出现自动重试')
  // 终态仍然以管家为准（这一轮已被取消），不因为点过回复就显示成功。
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已取消'), undefined, { timeout: 20_000 })
  report.lateReply = { toast }
  await page.screenshot({ path: resolve(directory, engineName + '-late-reply.png') })
})

await check('响应未知→手动重试：两次请求一次执行（同 runId 回放），正文不落盘', async () => {
  const statsBefore = await fixturePost({ query: 'stats' })
  const chatsBefore = countPosts('/butler/chat')
  await page.fill('.assign textarea', '#network 幂等重试验证清单')
  await page.click('.assign button[type="submit"]')
  // 受理已成立但响应丢失：结果不明，不自动重试，保留冻结正文等待手动重试。
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('无法确认'), undefined, { timeout: 15_000 })
  await page.waitForSelector('.assign-actions .retry-submit', { timeout: 5_000 })
  await delay(600)
  const chatsAfterGlitch = countPosts('/butler/chat')
  await page.click('.assign-actions .retry-submit')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('等你回话'), undefined, { timeout: 20_000 })
  await delay(600)
  // 两次请求、一次执行：第二次带同一个 requestId，管家回放首次那一轮，不重新执行。
  assert.equal(countPosts('/butler/chat'), chatsAfterGlitch + 1, '重试后请求次数不符')
  assert.equal(countPosts('/butler/chat'), chatsBefore + 2, '提交与重试各一次')
  const statsAfter = await fixturePost({ query: 'stats' })
  assert.equal(statsAfter.chatExecutions, statsBefore.chatExecutions + 1, `管家执行了 ${statsAfter.chatExecutions - statsBefore.chatExecutions} 次（应为 1 次）`)
  assert.equal(statsAfter.duplicateSubmits, statsBefore.duplicateSubmits + 1, '重试没有被识别成同一次提交')
  // 正文不落盘：位置与偏好之外的任何内容都不进浏览器存储。
  const stored = await page.evaluate(() => Object.entries(localStorage).map(([key, value]) => key + '=' + value).join(String.fromCharCode(10)))
  for (const forbidden of ['幂等重试验证清单', '窗口滚出恢复验证清单', '断流重连验证清单', '就按第二版来', 'requestId', '无法确认']) {
    assert.ok(!stored.includes(forbidden), '浏览器存储里出现了不该存的内容：' + forbidden)
  }
  // 冻结的 requestId（`niuma-<uuid>`）同样不落盘：键名里的 `niuma-boss:world:` 不匹配这条形状。
  assert.ok(!/niuma-[0-9a-f]{8}-/.test(stored), '浏览器存储里出现了 requestId：' + stored)
  const keys = await page.evaluate(() => Object.keys(localStorage))
  assert.ok(keys.every(key => key.startsWith('niuma-boss:world:')), '存储里出现了位置快照之外的键：' + keys.join(', '))
  report.idempotency = { chatExecutions: statsAfter.chatExecutions - statsBefore.chatExecutions, duplicateSubmits: statsAfter.duplicateSubmits - statsBefore.duplicateSubmits, keys }
  await page.screenshot({ path: resolve(directory, engineName + '-idempotent-retry.png') })
  // 收拾现场：回复并等这一轮收尾，回到正常状态。
  await page.fill('.reply input', '照第二版办')
  await page.click('.reply button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.task .state .badge')?.textContent?.includes('已完成'), undefined, { timeout: 20_000 })
})

await check('写链路：run_busy/version_conflict/run_result_unknown 提示且不自动重试', async () => {
  await page.click('.conversations button:nth-child(1)')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('园区安全博客'), undefined, { timeout: 10_000 })
  const chats = () => countPosts('/butler/chat')
  let before = chats()
  await page.fill('.assign textarea', '#run_busy 再写一篇')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('正在处理上一条消息'), undefined, { timeout: 10_000 })
  await delay(800)
  assert.equal(chats(), before + 1, 'run_busy 后出现自动重试')
  before = chats()
  await page.fill('.assign textarea', '#version_conflict 改个范围')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('已被另一入口更新'), undefined, { timeout: 10_000 })
  await delay(800)
  assert.equal(chats(), before + 1, 'version_conflict 后出现自动重试')
  before = chats()
  await page.fill('.assign textarea', '#result_unknown 之前那次的结果')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent?.includes('不会重新执行'), undefined, { timeout: 10_000 })
  await delay(800)
  assert.equal(chats(), before + 1, 'run_result_unknown 后出现自动重试')
})


await check('人物表现：权威终态一到就交回并回工位（不等任何演出）', async () => {
  // 切到已完结的会话：权威快照里 example 的子任务已 succeeded。
  await page.click('.conversations button:nth-child(2)')
  await page.waitForFunction(() => document.querySelector('.task-book')?.textContent?.includes('会议纪要'), undefined, { timeout: 10_000 })
  await page.waitForFunction(() => {
    const staff = document.querySelector('[data-staff]')?.getAttribute('data-staff') ?? ''
    return staff.includes('example=hand_back') && staff.includes('blog=at_post')
  }, undefined, { timeout: 10_000 })
  // 走回工位需要时间（逐格位移，不瞬移）：等三位员工都落位坐下再断言座位。
  await page.waitForFunction(() => {
    const seats = document.querySelector('[data-seats]')?.getAttribute('data-seats') ?? ''
    return ['example', 'closedoff', 'blog'].every(id => seats.split(',').includes(id))
  }, undefined, { timeout: 25_000 })
  const staff = await staffNow()
  const entries = await staffEntries()
  const seats = (await seatsNow()).split(',').filter(Boolean)
  assert.equal(entries.example.action, 'hand_back')
  assert.equal(entries.blog.action, 'at_post')
  // 交回的员工回到自己的作者座位（椅子遮挡层随之显示）。
  for (const id of ['example', 'closedoff', 'blog']) {
    assert.ok(seats.includes(id), `空闲的员工 ${id} 没有回到座位：${seats}`)
    // 走动收口：走了就是 arrived，走帧没就绪时是 instant（同样是「已到位」的如实标注）。
    assert.ok(['arrived', 'instant'].includes(entries[id].phase), `${id} 的走动没有收口：${staff}`)
  }
  report.handBack = { staff, seats }
  await page.screenshot({ path: resolve(directory, engineName + '-handback.png') })
})

await check('普通 NPC 预写对白：走近交谈，零模型与业务工具调用', async () => {
  await closeBook()
  // 走到前台唐可旁边：她会在作者活动域里自主走动，所以每轮都按她的**当前格**重新寻路，
  // 而不是钉死在一个坐标上（活动域很小，几轮之内就能靠近）。
  assert.ok(await approachActor('npc_reception'), '没能走到前台唐可的交互范围内')
  await page.waitForSelector('[data-prompt="npc_talk_hint"]', { timeout: 8_000 })
  const prompt = await page.locator('[data-prompt="npc_talk_hint"]').innerText()
  assert.ok(prompt.includes('交谈'), '就近提示文案不是作者给的「交谈」：' + prompt)
  // 打开面板前记一笔写请求数：普通对白通路一次请求都不该产生。
  const postsBefore = butlerPosts.length
  await page.click('[data-prompt="npc_talk_hint"]')
  await page.waitForSelector('.dialogue[data-dialogue="npc"]', { timeout: 5_000 })
  const text = await page.locator('.dialogue').innerText()
  assert.ok(text.includes('唐可'), '对白面板没有显示普通 NPC 名字：' + text)
  assert.ok(text.includes('看中文牌子就能找到'), '没有播放作者预写台词：' + text)
  assert.ok(text.includes('要交代工作直接找牛马大总管'), '作者预写台词不完整：' + text)
  assert.ok(text.includes('不是模型回答'), '预写对白没有如实标注来源：' + text)
  assert.equal(await page.locator('.dialogue input, .dialogue textarea').count(), 0, '预写对白面板出现了自由输入框')
  await delay(600)
  assert.equal(butlerPosts.length, postsBefore, '普通 NPC 对白产生了写请求：' + butlerPosts.slice(postsBefore).join(', '))
  report.npcDialogue = { prompt, text: text.slice(0, 200), writeRequests: butlerPosts.length - postsBefore }
  await page.screenshot({ path: resolve(directory, engineName + '-npc-dialogue.png') })
  await page.click('.dialogue header button')
  await page.waitForSelector('.dialogue', { state: 'detached', timeout: 5_000 })
  // 关掉面板后人物可以继续走：证明前面的「不动」是面板锁输入，而不是卡死。
  assert.ok(await movedByKeyboard(), '关掉对白面板后键盘仍不能移动')
  await openBook()
await check('写链路：403 按无权限提示且不重试', async () => {
  const before = countPosts('/butler/chat')
  await page.fill('.assign textarea', '#forbidden 越权提交')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.banner')?.textContent?.includes('没有访问权限'), undefined, { timeout: 10_000 })
  await delay(800)
  assert.equal(countPosts('/butler/chat'), before + 1, '403 后出现自动重试')
})
})

await check('首包口径复核：结算点与三图全量 gzip 均满足门槛', async () => {
  const first = report.firstLoad ?? await settleFirstLoad()
  assert.ok(first.requests <= FIRST_LOAD_MAX_REQUESTS, `首次静态请求 ${first.requests} 个，超过门槛 ${FIRST_LOAD_MAX_REQUESTS}`)
  assert.ok(first.gzipBytes <= FIRST_LOAD_MAX_GZIP_BYTES, `静态 gzip 合计 ${first.gzipBytes} 字节，超过门槛 ${FIRST_LOAD_MAX_GZIP_BYTES}`)
  // 三图全部资源（运行时 + 图集 + 地图图集）的合计同样受首包门槛约束：随用随取不等于可以无限大。
  let total = 0
  const maps = {}
  for (const map of ['office', 'street', 'cafe']) {
    const files = ['runtime.json', '.json', '.png']
    let bytes = 0
    for (const suffix of files) {
      const file = resolve('web', 'generated', suffix === 'runtime.json' ? map + '.runtime.json' : map + suffix)
      bytes += gzipSync(await readFile(file)).length
    }
    maps[map] = bytes
    total += bytes
  }
  report.threeMapGzipBytes = { perMap: maps, total }
  assert.ok(total <= FIRST_LOAD_MAX_GZIP_BYTES, `三图全量 gzip 合计 ${total} 字节，超过门槛 ${FIRST_LOAD_MAX_GZIP_BYTES}`)
})

await check('所有请求同源', async () => {
  assert.ok(origins.size === 1 && [...origins][0] === fixture.origin, '出现非同源请求：' + [...origins].join(', '))
})

// ---- 第六切片：发布候选——设备与环境记录、重场景帧预算（HAR 已在上下文创建时开启） ----

/**
 * 帧预算采样：在页面里按 `requestAnimationFrame` 取帧间隔；顺手每帧读一次
 * `data-actor-cells`（表现层的按格诊断），统计这段时间里**真正动过**的角色与出现过的姿态。
 */
const sampleFrames = (frames) => page.evaluate(frames => new Promise(resolve => {
  const deltas = []
  const moves = new Map()
  const poses = new Set()
  const read = () => {
    for (const entry of (document.querySelector('[data-actor-cells]')?.getAttribute('data-actor-cells') ?? '').split(';')) {
      const [id, cell, pose] = entry.split(':')
      if (id === undefined || cell === undefined || id === '') continue
      poses.add(pose ?? '')
      const seen = moves.get(id) ?? new Set()
      seen.add(cell)
      moves.set(id, seen)
    }
  }
  let last = performance.now()
  const tick = (now) => {
    deltas.push(now - last)
    last = now
    read()
    if (deltas.length >= frames) {
      resolve({
        deltas,
        poses: [...poses].filter(pose => pose !== ''),
        movedActors: [...moves.entries()].filter(([, cells]) => cells.size > 1).map(([id, cells]) => id + '×' + cells.size),
        actors: moves.size,
      })
      return
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}), frames)

/** 帧间隔 → 报告口径：FPS 取样本数/总时长，p95 取第 95 百分位（与第四阶段记录口径一致）。 */
const frameStats = (sample) => {
  const sorted = [...sample.deltas].sort((a, b) => a - b)
  const elapsed = sample.deltas.reduce((total, delta) => total + delta, 0)
  return {
    samples: sample.deltas.length,
    elapsedMs: elapsed,
    fps: elapsed === 0 ? 0 : sample.deltas.length / (elapsed / 1000),
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    maxMs: sorted[sorted.length - 1],
    poses: sample.poses,
    movedActors: sample.movedActors,
    actors: sample.actors,
  }
}

/** 页面里的 SSE 计数（由 addInitScript 包装 fetch 维护）。 */
const sseStats = () => page.evaluate(() => ({ ...globalThis.__NIUMA_SSE__ }))
const sseDelta = (before, after) => {
  const types = Object.fromEntries(Object.entries(after.types)
    .map(([type, count]) => [type, count - (before.types[type] ?? 0)])
    .filter(([, count]) => count > 0))
  return { chunks: after.chunks - before.chunks, bytes: after.bytes - before.bytes, events: after.events - before.events, types }
}

/** 重场景共同前置：清位置快照回出生地图（办公楼）→ 全量名册与走帧图集就绪 → 管家链路已连接。 */
const reloadHeavyScene = async () => {
  await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('niuma-boss:world:')) localStorage.removeItem(key) })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('canvas', { timeout: 20_000 })
  await page.waitForSelector('[data-scene="office"]', { timeout: 20_000 })
  await page.waitForFunction(() => document.querySelector('.hud .badge')?.textContent?.includes('已连接'), undefined, { timeout: 20_000 })
  // 走帧图集是玩家操作之后懒加载的：任务本开着时按键只热身、不移动老板（见第四切片用例）。
  await openBook()
  await page.keyboard.press('w')
  await page.waitForFunction(() => document.querySelector('[data-walk]')?.getAttribute('data-walk') === 'ready', undefined, { timeout: 20_000 })
  await closeBook()
  return await runtimeOf('office')
}

/** 界面状态快照：人物能不能被键盘带动只取决于这些界面事实，采样失败时按它定位。 */
const uiState = () => page.evaluate(() => ({
  book: document.querySelector('.task-book') !== null,
  dialogue: document.querySelector('.dialogue') !== null,
  active: document.activeElement?.tagName ?? '',
  badge: document.querySelector('.hud .badge')?.textContent ?? '',
  walk: document.querySelector('[data-walk]')?.getAttribute('data-walk') ?? '',
}))

/** 方向键 → 位移（与游戏共用的坐标约定：d 东 x+1、a 西 x−1、w 北 y−1、s 南 y+1）。 */
const DIRECTION_DELTA = { d: [1, 0], a: [-1, 0], w: [0, -1], s: [0, 1] }
/**
 * 按作者碰撞网格挑出**当前格真的能走**的方向（`walkable` 与游戏共用同一份 collision）。
 * 「朝墙按方向键不动」是游戏的正常行为，不能算按键失灵，所以探针只从这些方向里选。
 * 默认不选 `s`：出生点南边一格是去商业街的触发格，踩上去会换图。
 */
const walkableDirections = (runtime, cell, prefer = ['a', 'w', 'd']) => prefer.flatMap(key => {
  const [dx, dy] = DIRECTION_DELTA[key]
  const target = [cell[0] + dx, cell[1] + dy]
  if (target[0] < 0 || target[1] < 0 || target[0] >= runtime.width || target[1] >= runtime.height) return []
  return walkable(runtime, target) ? [{ key, target: target.join(','), walkable: true }] : []
})

/**
 * 采样前确认键盘真的能带动人物：只按 runtime 碰撞挑出的可走方向试，最多两次。
 * 产物里记下尝试方向、目标格与该格是否可走——「可走方向仍没动」才是真实观测，
 * 撞墙不动不是。两次都不动就把 attempts 原样交给人工复核，不做因果推断。
 */
const movementProbe = async (runtime, prefer = ['a', 'w', 'd'], ms = 320) => {
  const cell = await playerCell()
  const candidates = walkableDirections(runtime, cell.split(',').map(Number), prefer)
  const attempts = []
  for (const candidate of candidates.slice(0, 2)) {
    const before = await playerCell()
    await page.keyboard.down(candidate.key)
    await delay(attempts.length === 0 ? ms : ms + 80)
    await page.keyboard.up(candidate.key)
    await delay(200)
    const after = await playerCell()
    attempts.push({ ...candidate, before, after, moved: before !== after })
    if (before !== after) break
  }
  const moved = attempts.some(attempt => attempt.moved)
  return {
    cell,
    candidates,
    attempts,
    moved,
    wake: attempts[0] ?? null,
    retry: attempts[1] ?? null,
  }
}

/**
 * 采样期间让老板一直走：走动帧 + 逐格位移 + 镜头跟随都进负载（按住一个方向会顶墙，来回换向）。
 * 只用 `a/w/d`：出生点南边一格是去商业街的触发格，踩上去会换图，采样的负载就不干净了。
 */
const driveWalking = async (keys, ms) => {
  for (const key of keys) {
    await page.keyboard.down(key)
    await delay(ms)
    await page.keyboard.up(key)
    await delay(120)
  }
}

/** 名册口径：办公楼 10 人（含老板）+ 咖啡店 1 位非老板角色 = 11 位角色定义；单场景同屏最多 10 人。 */
const rosterNote = async () => {
  const office = await runtimeOf('office')
  const cafe = await runtimeOf('cafe')
  const report_ = JSON.parse(await readFile(resolve('web', 'generated', 'asset-report.json'), 'utf8'))
  const officeAtlas = report_.maps.find(map => map.map === 'office')
  return {
    office: office.characters.map(character => character.id),
    cafe: cafe.characters.map(character => character.id),
    sameSceneMax: office.characters.length,
    definitions: new Set([...office.characters, ...cafe.characters].map(character => character.id)).size,
    walkers: officeAtlas?.walkers ?? [],
    atlasFrames: Object.fromEntries((officeAtlas?.atlases ?? []).map(atlas => [atlas.name, atlas.frames])),
    note: '办公楼 10 人（含老板）与咖啡店 1 位非老板角色分属两张地图，同一时刻只渲染当前场景的角色；第四阶段「11 人」是原型夹具的并发口径，本产物同屏最多 10 人。管线没有粒子/补间 VFX 层，环境特效按 0 记录。',
  }
}

await check('设备与环境记录（浏览器版本/视口/DPR/GPU/UA 摘要）', async () => {
  const environment = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl') ?? null
    const debug = gl?.getExtension('WEBGL_debug_renderer_info') ?? null
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform ?? '',
      languages: navigator.languages?.join(',') ?? '',
      hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
      devicePixelRatio: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      canvas: canvas === null ? null : [canvas.width, canvas.height],
      renderer: (debug === null ? gl?.getParameter(gl.RENDERER) : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) ?? '未知（Canvas 渲染或取不到 WebGL 上下文）',
      vendor: (debug === null ? gl?.getParameter(gl.VENDOR) : gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)) ?? '未知',
    }
  })
  report.device = {
    engine: engineName,
    browserVersion: report.version,
    headless: report.headless,
    ...environment,
    os: [platform(), release(), arch()].join(' '),
    cpu: cpus()[0]?.model ?? '未知',
    totalMemBytes: totalmem(),
  }
  assert.ok(report.device.browserVersion !== '' && report.device.userAgent !== '', '设备记录不完整：' + JSON.stringify(report.device))
  report.roster = await rosterNote()
})

await check('重场景帧预算（桌面 1440×1000）：全量名册 + 角色动画 + 持续 SSE，≥60FPS 且 p95≤20ms', async () => {
  const office = await reloadHeavyScene()
  // 采样前先确认键盘能带动人物：只试 runtime 碰撞给出的可走方向，不动就换一个再试一次。
  const wake = await movementProbe(office)
  assert.ok(wake.candidates.length > 0, '当前格四邻在作者碰撞网格里都是阻挡格，探针选不到可走方向：' + JSON.stringify(wake))
  const cellBefore = await playerCell()
  const sseBefore = await sseStats()
  const driving = driveWalking(['a', 'w', 'd', 'w', 'a', 'w', 'd', 'w'], 560)
  const stats = frameStats(await sampleFrames(640))
  await driving
  const posts = await sseDelta(sseBefore, await sseStats())
  const cellAfter = await playerCell()
  report.heavyDesktop = { ...stats, sse: posts, cellBefore, cellAfter, scene: await scene(), canvas: report.device.canvas, movementProbe: wake, ui: await uiState() }
  // 全量名册：办公楼 10 人 = 老板 + `data-actor-cells` 里的 9 位非老板角色。
  assert.equal(office.characters.length, 10, '出生地图名册不是 10 人：' + office.characters.length)
  assert.equal(await scene(), 'office', '采样期间离开了出生地图，重场景口径不成立')
  assert.equal(stats.actors, office.characters.length - 1, `同屏角色数 ${stats.actors} 与名册不符（应为 ${office.characters.length - 1} 位非老板角色）`)
  // 老板真的走过：走动帧、逐格位移与镜头跟随都进过这段采样。
  assert.notEqual(cellAfter, cellBefore, '采样期间老板没有走动，重场景不成立：' + cellBefore + ' → ' + cellAfter + '；探针 ' + JSON.stringify(wake))
  // 管家 SSE 真的在推（不是静止画面）：采样窗口里至少 2 个事件。
  assert.ok(posts.events >= 2, `采样期间管家 SSE 只推了 ${posts.events} 个事件`)
  assert.ok(stats.fps >= 60, `桌面重场景 ${stats.fps.toFixed(2)} FPS，低于 60`)
  assert.ok(stats.p95Ms <= 20, `桌面重场景 p95 ${stats.p95Ms.toFixed(2)}ms，超过 20ms`)
  await page.screenshot({ path: resolve(directory, engineName + '-heavy-desktop.png') })
})

await check('重场景帧预算（移动视口 390×844，模拟非真机）：≥30FPS 且 p95≤33ms', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await delay(800)
  const office = await runtimeOf('office')
  // 与桌面同口径：只试 runtime 碰撞给出的可走方向（本视口下 `d` 常常正对阻挡格）。
  const wake = await movementProbe(office)
  assert.ok(wake.candidates.length > 0, '当前格四邻在作者碰撞网格里都是阻挡格，探针选不到可走方向：' + JSON.stringify(wake))
  const cellBefore = await playerCell()
  const sseBefore = await sseStats()
  const driving = driveWalking(['d', 'a', 'w', 'a', 'd', 'a'], 560)
  const stats = frameStats(await sampleFrames(320))
  await driving
  const posts = await sseDelta(sseBefore, await sseStats())
  const cellAfter = await playerCell()
  report.heavyMobile = {
    ...stats, sse: posts, cellBefore, cellAfter, scene: await scene(), movementProbe: wake, ui: await uiState(),
    canvas: await page.evaluate(() => { const canvas = document.querySelector('canvas'); return canvas === null ? null : [canvas.width, canvas.height] }),
    devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
    note: '仅有视口与像素尺寸的近似，不是真机；DPR 为 1，真实 Android 机型通常为 2–3，GPU 与散热也不同。',
  }
  assert.notEqual(cellAfter, cellBefore, '移动视口采样期间老板没有走动：' + cellBefore + ' → ' + cellAfter + '；探针 ' + JSON.stringify(wake))
  assert.equal(report.heavyMobile.scene, 'office', '移动视口采样期间离开了出生地图')
  assert.equal(report.heavyMobile.actors, report.roster.sameSceneMax - 1, `移动视口同屏角色数 ${report.heavyMobile.actors} 与名册不符`)
  assert.ok(posts.events >= 2, `移动视口采样期间管家 SSE 只推了 ${posts.events} 个事件`)
  assert.ok(stats.fps >= 30, `移动视口重场景 ${stats.fps.toFixed(2)} FPS，低于 30`)
  assert.ok(stats.p95Ms <= 33, `移动视口重场景 p95 ${stats.p95Ms.toFixed(2)}ms，超过 33ms`)
  await page.screenshot({ path: resolve(directory, engineName + '-heavy-mobile.png') })
})

report.pageErrors = errors
report.sameOriginOnly = origins.size === 1 && [...origins][0] === fixture.origin
report.butlerPosts = butlerPosts.reduce((counts, path) => { counts[path] = (counts[path] ?? 0) + 1; return counts }, {})
report.har = { path: resolve(directory, engineName + '-browser-check.har'), content: 'omit', mode: 'full' }
await writeFile(resolve(directory, engineName + '-browser-check.json'), JSON.stringify(report, null, 2))
// HAR 在上下文关闭时落盘（顺序：先关上下文，再关浏览器）。
await context.close()
await browser.close()
await fixture.close()

const failed = report.cases.filter(c => !c.ok)
console.log(JSON.stringify({
  engine: engineName, version: report.version, firstLoad: report.firstLoad,
  device: report.device, roster: report.roster,
  heavyDesktop: report.heavyDesktop, heavyMobile: report.heavyMobile, har: report.har,
  cases: report.cases.map(c => c.name + (c.ok ? ' ✓' : ' ✗ ' + c.error)), pageErrors: errors,
}, null, 2))
if (failed.length > 0 || errors.length > 0) process.exit(1)
