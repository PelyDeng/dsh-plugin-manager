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
 * 截图与结果写 .artifacts/，供人工复核。
 *
 * 用法：node scripts/browser-check.mjs [edge|chromium]
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
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
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
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
  page.waitForFunction(expected => document.querySelector('[data-scene]')?.getAttribute('data-scene') === expected, name, { timeout })
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
const routeTo = (runtime, from, to) => {
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
  for (let step = 0; step < budget; step++) {
    const current = await cellNow()
    if (current[0] === target[0] && current[1] === target[1]) return true
    const runtime = await runtimeOf(await scene())
    const path = routeTo(runtime, current, target)
    if (path === null || path.length === 0) return false
    await nudge(keyToward(current, path[0]), 220)
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

report.pageErrors = errors
report.sameOriginOnly = origins.size === 1 && [...origins][0] === fixture.origin
report.butlerPosts = butlerPosts.reduce((counts, path) => { counts[path] = (counts[path] ?? 0) + 1; return counts }, {})
await writeFile(resolve(directory, engineName + '-browser-check.json'), JSON.stringify(report, null, 2))
await browser.close()
await fixture.close()

const failed = report.cases.filter(c => !c.ok)
console.log(JSON.stringify({ engine: engineName, version: report.version, firstLoad: report.firstLoad, cases: report.cases.map(c => c.name + (c.ok ? ' ✓' : ' ✗ ' + c.error)), pageErrors: errors }, null, 2))
if (failed.length > 0 || errors.length > 0) process.exit(1)
