/**
 * 本地浏览器验收（不进入发布包）：对 Chromium / Edge 无头浏览器跑第一切片的
 * 端到端断言——页面装载、office 地图与角色渲染、任务本读取并跟随管家 SSE、
 * 键盘与点击移动的格子位移（直接读 data-player-cell，不靠截图差异）、
 * 首包静态请求与 gzip 门槛、请求同源。截图与结果写 .artifacts/，供人工复核。
 *
 * 用法：node scripts/browser-check.mjs [edge|chromium]
 */
import assert from 'node:assert/strict'
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
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.on('pageerror', error => errors.push('pageerror: ' + error.message))
page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()) })
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

await check('任务本读取同一用户的权威任务并跟随 SSE', async () => {
  await page.click('.book-toggle')
  await page.waitForSelector('.task-book', { timeout: 5_000 })
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
  await page.click('.task-book header button') // 关闭任务本，解除输入锁
  await page.waitForSelector('.task-book', { state: 'detached', timeout: 5_000 })
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

await check('首包静态请求与 gzip 量满足计划门槛', async () => {
  // 完整口径：入口 /niuma-boss（即 web/index.html）也计入首包。
  const staticPaths = [...new Set(report.requests
    .filter(r => r.path === '/niuma-boss' || r.path.startsWith('/niuma-boss/'))
    .map(r => r.path))]
  assert.ok(staticPaths.length <= FIRST_LOAD_MAX_REQUESTS, `首次静态请求 ${staticPaths.length} 个，超过门槛 ${FIRST_LOAD_MAX_REQUESTS}`)
  let gzipTotal = 0
  for (const path of staticPaths) {
    const file = path === '/niuma-boss' ? resolve('web', 'index.html') : resolve('web', path.replace('/niuma-boss/', ''))
    const content = await readFile(file)
    gzipTotal += gzipSync(content).length
  }
  report.firstLoad = { requests: staticPaths.length, gzipBytes: gzipTotal }
  assert.ok(gzipTotal <= FIRST_LOAD_MAX_GZIP_BYTES, `静态 gzip 合计 ${gzipTotal} 字节，超过门槛 ${FIRST_LOAD_MAX_GZIP_BYTES}`)
})

await check('所有请求同源', async () => {
  assert.ok(origins.size === 1 && [...origins][0] === fixture.origin, '出现非同源请求：' + [...origins].join(', '))
})

report.pageErrors = errors
report.sameOriginOnly = origins.size === 1 && [...origins][0] === fixture.origin
await writeFile(resolve(directory, engineName + '-browser-check.json'), JSON.stringify(report, null, 2))
await browser.close()
await fixture.close()

const failed = report.cases.filter(c => !c.ok)
console.log(JSON.stringify({ engine: engineName, version: report.version, firstLoad: report.firstLoad, cases: report.cases.map(c => c.name + (c.ok ? ' ✓' : ' ✗ ' + c.error)), pageErrors: errors }, null, 2))
if (failed.length > 0 || errors.length > 0) process.exit(1)
