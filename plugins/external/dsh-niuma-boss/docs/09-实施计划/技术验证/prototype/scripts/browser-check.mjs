import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startServer } from './server.mjs'

const require = createRequire(resolve(process.env.VALIDATION_NODE_MODULES ?? 'node_modules', 'playwright/package.json'))
const { chromium, firefox } = require('playwright')
const directory = resolve('../evidence')
await mkdir(directory, { recursive: true })
const selected = process.argv[2] ?? 'edge'
assert(['edge', 'chromium', 'firefox'].includes(selected), '不支持的验证浏览器：' + selected)
const engine = selected === 'firefox' ? firefox : chromium
const fixture = await startServer({ streamFailures: 0 })
const browser = await engine.launch({ headless: true, timeout: 15000,
  ...(selected === 'edge' ? { channel: 'msedge' } : process.env.VALIDATION_BROWSER_EXECUTABLE ? { executablePath: process.env.VALIDATION_BROWSER_EXECUTABLE } : {}),
})
const contexts = [], errors = [], responses = [], report = { engine: selected, version: browser.version(), headless: true, cases: [] }
const values = async page => JSON.parse(await page.locator('[data-testid=protocol]').textContent())
async function open(options, suffix) {
  const context = await browser.newContext({ ...options, recordHar: { path: resolve(directory, selected + '-' + suffix + '.har'), content: 'omit' } })
  contexts.push(context)
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.url().startsWith('http')) responses.push({ mode: suffix, path: new URL(response.url()).pathname, status: response.status() }) })
  await page.goto(fixture.origin + '/niuma-boss')
  await page.waitForFunction(() => { const el = document.querySelector('[data-testid=protocol]'); return el && JSON.parse(el.textContent).loaded }, undefined, { timeout: 15000 })
  await delay(400)
  return page
}
async function key(page, key, ms) { await page.keyboard.down(key); await delay(ms); await page.keyboard.up(key); await delay(350) }
async function target(page, cell, touch = false) {
  const { view } = await values(page)
  const x = view.x + ((cell[0] + .5) * 32 - view.worldX) * view.zoom
  const y = view.y + ((cell[1] + .5) * 32 - view.worldY) * view.zoom
  if (touch) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y)
  await page.waitForFunction(([x, y]) => {
    const m = JSON.parse(document.querySelector('[data-testid=protocol]').textContent)
    return Math.hypot(m.x - x, m.y - y) < 1
  }, [(cell[0] + .5) * 32, (cell[1] + .5) * 32], { timeout: 7000 })
}
async function stress(page, samples) {
  await page.getByRole('button', { name: '加载 11 人与 48 个动画特效' }).click()
  await page.waitForFunction(() => { const m = JSON.parse(document.querySelector('[data-testid=protocol]').textContent); return m.characters === 11 && m.effects === 48 })
  await delay(1000)
  const before = await values(page)
  const performance = await page.evaluate(samples => new Promise(resolve => {
    const deltas = [], started = performance.now()
    let previous
    const collect = now => {
      if (previous !== undefined) deltas.push(now - previous)
      previous = now
      if (deltas.length < samples) { requestAnimationFrame(collect); return }
      const sorted = [...deltas].sort((a, b) => a - b)
      const canvas = document.querySelector('canvas')
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      const debug = gl?.getExtension('WEBGL_debug_renderer_info')
      resolve({ samples, elapsedMs: now - started, fps: 1000 / (deltas.reduce((a, b) => a + b, 0) / samples),
        p95Ms: sorted[Math.floor(samples * .95)], maxMs: sorted.at(-1),
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unavailable',
        viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, canvas: [canvas.width, canvas.height],
      })
    }
    requestAnimationFrame(collect)
  }), samples)
  const after = await values(page)
  assert(after.sequence > before.sequence, '采样期间SSE必须仍在更新')
  assert(!after.error, after.error)
  return { ...performance, phaserFps: after.fps, phaserP95Ms: after.frameP95Ms, pathMaxTickMs: after.pathMaxFrameMs, characters: after.characters, effects: after.effects, sseDelta: after.sequence - before.sequence }
}
try {
  const desktop = await open({ viewport: { width: 1440, height: 1000 } }, 'desktop')
  const initial = await values(desktop)
  assert.equal(initial.characters, 1)
  assert.equal(responses.filter(r => r.mode === 'desktop' && r.path.startsWith('/niuma-boss')).length, 8)
  await key(desktop, 'ArrowUp', 350)
  assert((await values(desktop)).y < initial.y - 10)
  const input = desktop.locator('[data-testid=ime-input]')
  await input.focus()
  const focused = await values(desktop)
  await key(desktop, 'ArrowLeft', 350)
  assert.deepEqual([(await values(desktop)).x, (await values(desktop)).y], [focused.x, focused.y])
  await input.dispatchEvent('compositionstart', { data: 'niuma' })
  await input.evaluate(el => el.blur())
  await key(desktop, 'd', 350)
  assert.deepEqual([(await values(desktop)).x, (await values(desktop)).y], [focused.x, focused.y])
  await input.fill('牛马老板组合输入验证')
  await input.dispatchEvent('compositionend', { data: '牛马老板组合输入验证' })
  await input.evaluate(el => el.blur())
  assert((await desktop.locator('[data-testid=input-state]').textContent()).includes('游戏键盘可用'))
  await key(desktop, 'ArrowDown', 1800)
  assert((await values(desktop)).collisionStops > 0)
  assert((await values(desktop)).y < 928)
  await target(desktop, [33, 26])
  assert((await values(desktop)).pointerPaths > 0)
  await desktop.screenshot({ path: resolve(directory, selected + '-desktop.png') })
  report.cases.push({ name: '桌面键盘/碰撞/点击/焦点/组合事件', pass: true, ime: 'composition事件模拟，不是真实输入法候选窗' })
  report.desktop = await stress(desktop, 600)
  await desktop.screenshot({ path: resolve(directory, selected + '-stress.png') })
  report.cases.push({ name: '桌面重场景p95≤20ms', pass: report.desktop.p95Ms <= 20 && report.desktop.phaserP95Ms <= 20 && report.desktop.phaserFps >= 60 && report.desktop.pathMaxTickMs <= 2, ...report.desktop })

  if (selected !== 'firefox') {
    const mobile = await open({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }, 'mobile-emulated')
    await target(mobile, [33, 26], true)
    assert((await values(mobile)).pointerPaths > 0)
    await mobile.locator('[data-testid=ime-input]').fill('旋转保留内容')
    await mobile.locator('[data-testid=ime-input]').evaluate(el => el.blur())
    const beforeRotate = await values(mobile)
    await mobile.setViewportSize({ width: 390, height: 844 })
    await delay(500)
    const afterRotate = await values(mobile)
    assert.deepEqual([afterRotate.x, afterRotate.y], [beforeRotate.x, beforeRotate.y])
    assert.equal(await mobile.locator('[data-testid=ime-input]').inputValue(), '旋转保留内容')
    assert.equal(await mobile.locator('[data-testid=orientation]').textContent(), '竖屏')
    await target(mobile, [34, 26], true)
    await mobile.screenshot({ path: resolve(directory, selected + '-portrait.png') })
    await mobile.setViewportSize({ width: 844, height: 390 })
    await delay(500)
    assert.equal(await mobile.locator('[data-testid=orientation]').textContent(), '横屏')
    report.mobile = await stress(mobile, 300)
    await mobile.screenshot({ path: resolve(directory, selected + '-landscape.png') })
    report.cases.push({ name: '模拟触摸与横竖屏往返', pass: true, device: '桌面主机模拟，不是真机' })
    report.cases.push({ name: '移动视口重场景p95≤33ms', pass: report.mobile.p95Ms <= 33 && report.mobile.phaserP95Ms <= 33 && report.mobile.phaserFps >= 30 && report.mobile.pathMaxTickMs <= 2, ...report.mobile })
  }
  assert.equal(errors.length, 0, errors.join('; '))
  assert(responses.every(r => r.status === 200), JSON.stringify(responses.filter(r => r.status !== 200)))
  report.pass = report.cases.every(c => c.pass)
} catch (error) {
  report.pass = false
  report.failure = error.message
  console.error(error.message)
} finally {
  report.generatedAt = new Date().toISOString()
  report.errors = errors
  report.responses = responses
  await Promise.all(contexts.map(context => context.close()))
  await browser.close()
  await fixture.close()
  await writeFile(resolve(directory, selected + '-browser-check.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ engine: selected, version: report.version, pass: report.pass, cases: report.cases, failure: report.failure }))
  if (!report.pass) process.exitCode = 1
}
