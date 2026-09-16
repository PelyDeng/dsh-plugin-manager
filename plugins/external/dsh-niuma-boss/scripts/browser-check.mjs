/**
 * 本地浏览器验收（不进入发布包）：对 Chromium / Edge 无头浏览器跑端到端断言——
 * 第一切片：页面装载、office 地图与角色渲染、任务本读取并跟随管家 SSE、
 * 键盘与点击移动的格子位移（直接读 data-player-cell，不靠截图差异）、
 * 首包静态请求与 gzip 门槛、请求同源。
 * 第二切片：派活→SSE 状态推进→等待回复→回复完成→同一历史；响应未知后用同一份
 * 提交重试；停止本轮收敛以管家事件为准；external_pending 不显示成发布成功；
 * run_busy/version_conflict/run_result_unknown/403 只提示且不自动重试（断言请求次数）。
 * 截图与结果写 .artifacts/，供人工复核。
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

// ---- 第二切片：一条真实任务的双入口写链路（会话二承接动态轮，不影响种子活跃轮） ----

await check('写链路：派活→SSE 推进→等待回复→回复完成→同一历史', async () => {
  await page.click('.book-toggle')
  await page.waitForSelector('.task-book', { timeout: 5_000 })
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

await check('写链路：403 按无权限提示且不重试', async () => {
  const before = countPosts('/butler/chat')
  await page.fill('.assign textarea', '#forbidden 越权提交')
  await page.click('.assign button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.banner')?.textContent?.includes('没有访问权限'), undefined, { timeout: 10_000 })
  await delay(800)
  assert.equal(countPosts('/butler/chat'), before + 1, '403 后出现自动重试')
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
report.butlerPosts = butlerPosts.reduce((counts, path) => { counts[path] = (counts[path] ?? 0) + 1; return counts }, {})
await writeFile(resolve(directory, engineName + '-browser-check.json'), JSON.stringify(report, null, 2))
await browser.close()
await fixture.close()

const failed = report.cases.filter(c => !c.ok)
console.log(JSON.stringify({ engine: engineName, version: report.version, firstLoad: report.firstLoad, cases: report.cases.map(c => c.name + (c.ok ? ' ✓' : ' ✗ ' + c.error)), pageErrors: errors }, null, 2))
if (failed.length > 0 || errors.length > 0) process.exit(1)
