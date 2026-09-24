/**
 * 0.14.6 聊天区三处 Lucide 替换截图（❤ composer 落款 / ✋ ask 举手 / ✓ 派工对勾）。
 * 用法：node tests/browser/shot-0146-chat.mjs（mock 8790 + CDP 9223；截图存 .local/ui-review-0146/）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
const CDP = 'http://127.0.0.1:9223'
const PAGE = 'http://127.0.0.1:8790/butler'
const SHOT_DIR = 'E:/A_Git_CodeSource/dsh-plugin-manager-gitee/.local/ui-review-0146'
mkdirSync(SHOT_DIR, { recursive: true })

const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(), { once: true }); ws.addEventListener('error', reject) })
let seq = 0
const pending = new Map()
ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } })
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails !== undefined) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300))
  return r.result?.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.result.data, 'base64'))
  console.log('截图:', name)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: PAGE })
await sleep(2500)

// ① composer 落款红心（默认聊天页页脚）
const heart = await evaluate(`(() => {
  const el = document.querySelector('.composer__hint-heart')
  if (el === null) return { found: false }
  const r = el.getBoundingClientRect()
  return { found: true, size: [r.width, r.height], fill: getComputedStyle(el).fill, color: getComputedStyle(el).color }
})()`)
console.log('❤ composer 红心:', JSON.stringify(heart))
await shot('composer-落款红心')

// ② ask 卡举手（打开 waiting_user 会话 conv-101）
const opened = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[class*=conversation], [class*=conv-], li, a')].filter(el => (el.textContent || '').includes('生成图片'))
  const target2 = rows.at(-1)
  if (target2 === undefined) return 'not-found'
  target2.click()
  return 'clicked'
})()`)
console.log('打开会话:', opened)
await sleep(1500)
const hand = await evaluate(`(() => {
  const el = document.querySelector('.ask__hand')
  if (el === null) return { found: false, askCard: document.querySelector('.ask') !== null }
  const r = el.getBoundingClientRect()
  return { found: true, size: [r.width, r.height], transform: getComputedStyle(el).transform }
})()`)
console.log('✋ ask 举手:', JSON.stringify(hand))
await shot('ask-举手贴纸')

// ③ 派工卡对勾（找带派工卡的会话：task-103 多成员）
await evaluate(`(() => {
  const rows = [...document.querySelectorAll('[class*=conversation], [class*=conv-], li, a')].filter(el => (el.textContent || '').includes('投稿'))
  rows.at(-1)?.click()
})()`)
await sleep(1500)
const check2 = await evaluate(`(() => {
  const el = document.querySelector('.dcard__cell-check')
  if (el === null) return { found: false, cells: document.querySelectorAll('.dcard__cell').length }
  const r = el.getBoundingClientRect()
  return { found: true, size: [r.width, r.height], color: getComputedStyle(el).color }
})()`)
console.log('✓ 派工对勾:', JSON.stringify(check2))
await shot('dcard-选中对勾')

await fetch(`${CDP}/json/close/${target.id}`, { method: 'PUT' })
process.exit(0)
