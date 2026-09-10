/** Actual page and shared sidebar, with isolated HTTP fixtures; no model or business API. */
import assert from 'node:assert/strict'
import { readFile, mkdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const runtime = await import(process.env.DSH_TEST_PLAYWRIGHT ? pathToFileURL(process.env.DSH_TEST_PLAYWRIGHT).href : 'playwright')
const { chromium } = runtime.default ?? runtime
const output = process.env.DSH_TEST_OUTPUT
const browser = await chromium.launch({ headless: true, ...(process.env.DSH_TEST_BROWSER ? { channel: process.env.DSH_TEST_BROWSER } : {}) })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', e => errors.push(e.message))
const base = 'http://127.0.0.1:18957', now = Date.now()
let authorized = true, items = [
  { id: 'first', title: '园区概览', updatedAt: now, pinned: 0 },
  { id: 'second', title: '昨天的预约', updatedAt: now - 86400000, pinned: 0 },
], delayed
await page.route('**/*', async route => {
  const u = new URL(route.request().url()), path = u.pathname
  const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) })
  if (path === '/closedoff-qa/identity') return route.fulfill({ status: authorized ? 200 : 403, contentType: 'application/json', body: JSON.stringify(authorized ? { key: 'user:test', label: '测试账号', mode: 'standalone' } : { error: '无权限' }) })
  if (path === '/closedoff-qa/models') return json({ groups: [], selected: null, default: null })
  if (path === '/closedoff-qa/conversations') {
    const query = u.searchParams.get('q') ?? ''
    return json({ items: items.filter(i => i.title.includes(query)).sort((a,b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt), nextOffset: null })
  }
  if (path === '/closedoff-qa/conversation-action') {
    const input = route.request().postDataJSON()
    if (input.operation === 'rename') items.find(i => i.id === input.ids[0]).title = input.title
    if (input.operation === 'pin') items.find(i => i.id === input.ids[0]).pinned = Number(input.pinned)
    if (input.operation === 'delete') items = items.filter(i => !input.ids.includes(i.id))
    return json({ ok: true })
  }
  if (path === '/closedoff-qa/history') {
    if (delayed) await delayed
    return json({ history: [{ role: 'user', text: '园区情况？' }, { role: 'assistant', text: '园区运行正常。', thinking: '私有思考不导出', tools: [], cards: {} }] })
  }
  if (path === '/closedoff-qa') {
    const html = (await readFile(new URL('../web/index.html', import.meta.url), 'utf8')).replace('__WEB_CONFIG__', JSON.stringify({ routePrefix: '/closedoff-qa', map: {} }))
    return route.fulfill({ contentType: 'text/html', body: html })
  }
  if (path.startsWith('/closedoff-qa/assets/')) {
    const file = path.slice('/closedoff-qa/assets/'.length)
    if (file.includes('/') || file.endsWith('.svg')) return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'image/svg+xml', body: '' })
    return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL('../web/' + file, import.meta.url)) })
  }
  return route.fulfill({ status: 404, body: '' })
})
try {
  await page.goto(base + '/closedoff-qa')
  const panel = page.getByRole('dialog', { name: '历史对话', exact: true })
  await panel.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '园区概览', exact: true }).click()
  await page.getByText('园区运行正常。', { exact: true }).waitFor()
  assert.equal(await page.locator('.qh-row.current').getAttribute('data-conversation'), 'first')
  const box = await panel.boundingBox(), chat = await page.locator('.chat-col').boundingBox()
  assert.ok(box.width > 250 && box.width < 270 && chat.x >= box.x + box.width)
  if (output) { await mkdir(output, { recursive: true }); await page.screenshot({ path: output + '/history-desktop.png' }) }
  await page.getByRole('button', { name: '操作 园区概览', exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  await page.getByRole('textbox', { name: '对话标题' }).fill('园区运行概览')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '园区运行概览', exact: true }).waitFor()
  await page.getByRole('button', { name: '操作 园区运行概览', exact: true }).click()
  await page.getByRole('menuitem', { name: '置顶', exact: true }).click()
  await page.getByRole('heading', { name: '置顶', exact: true }).waitFor()
  await page.getByRole('button', { name: '搜索对话', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索对话标题' }).fill('不存在')
  await page.getByText('没有匹配的对话', { exact: true }).waitFor()
  await page.getByRole('searchbox', { name: '搜索对话标题' }).fill('')
  await page.getByRole('button', { name: '园区运行概览', exact: true }).waitFor()
  await page.getByRole('button', { name: '操作 园区运行概览', exact: true }).click()
  await page.getByRole('menuitem', { name: '分享 / 导出', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="导出内容预览"]')?.value.includes('园区运行正常'))
  assert.ok(!(await page.getByRole('textbox', { name: '导出内容预览' }).inputValue()).includes('私有思考'))
  await page.getByRole('dialog', { name: '分享对话', exact: true }).getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.waitFor({ state: 'hidden' })
  await page.locator('#historyBtn').click()
  await panel.waitFor({ state: 'visible' })
  assert.equal(await panel.evaluate(e => e.matches(':modal')), true)
  if (output) await page.screenshot({ path: output + '/history-mobile.png' })
  await page.getByRole('button', { name: '园区运行概览', exact: true }).click()
  await panel.waitFor({ state: 'hidden' })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.setViewportSize({ width: 1600, height: 1000 })
  await panel.waitFor({ state: 'visible' })
  await page.getByRole('button', { name: '操作 园区运行概览', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await page.getByRole('dialog', { name: '删除 1 条对话？', exact: true }).getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '园区运行概览', exact: true }).waitFor({ state: 'detached' })
  assert.equal(await page.locator('.qh-row.current').count(), 0)
  // Revocation must remove both the sidebar and an open export, including a late response.
  let release
  delayed = new Promise(resolve => { release = resolve })
  await page.getByRole('button', { name: '操作 昨天的预约', exact: true }).click()
  await page.getByRole('menuitem', { name: '分享 / 导出', exact: true }).click()
  await page.getByRole('dialog', { name: '分享对话', exact: true }).waitFor()
  authorized = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await panel.waitFor({ state: 'detached' })
  release()
  await page.getByRole('dialog', { name: '分享对话', exact: true }).waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', checks: ['desktop sidebar', 'restore', 'rename', 'pin', 'search', 'export', 'mobile dialog', 'delete', 'account revocation'], http: 'fixture', model: 'not invoked' }))
} finally { await browser.close() }
