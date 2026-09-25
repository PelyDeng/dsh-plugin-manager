/**
 * 批 2c（生产反馈修复：左侧会话记录栏回归）浏览器真实验证（Edge CDP 9223，
 * verify-blog-2b.mjs 同形态）。
 *
 * 断言面（对照旧 web/conversation-history.js 逐项）：
 * 1. 桌面默认展开：左栏可见、位于最左（主区让位），localStorage 无记录也展开；
 * 2. 时间分组标题（置顶/今天/昨天/7 天内/30 天内/更早）；
 * 3. 加载更多：首页 5 行（mock 页长）→ 点击追加到 10 行 → 按钮消失；
 * 4. 搜索标题过滤（防抖后只剩匹配行；清空恢复）；
 * 5. 行菜单：五项齐全（重命名/置顶/分享 / 导出/多选/删除）+ Escape 关闭；
 * 6. 重命名：行内编辑保存后列表标题更新；
 * 7. 置顶：行进入「置顶」组；取消置顶回时间组；
 * 8. 删除：确认弹窗（旧文案）→ 确认后行消失；
 * 9. 多选批量栏：已选计数/选择已加载/批量导出（多段合并）；
 * 10. 单条导出：预览含问答分段（## 我 / ## 助手）；
 * 11. busy：回答进行中历史行**不**禁用（旧 blog 从不调 sidebar.setBusy，可切换），
 *     切换后当前会话行随之变化；
 * 12. 收起 → localStorage（blog-history:mock-user='collapsed'）→ 刷新保持 →
 *     顶栏按钮展开恢复（aria-expanded/aria-label 同步）；
 * 13. 移动端视口（375 宽）：默认不展开 → 顶栏开浮层（fixed+遮罩）→ 点行关闭；
 * 14. console 零错误；截图按段落落盘 .local/dsh-agents-group/docs/验收/。
 *
 * 用法：node tests/mock/verify-blog-2c.mjs
 * （需 pnpm build 于 agents/blog；mock 8791 与 Edge --remote-debugging-port=9223 已启动）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CDP = 'http://127.0.0.1:9223'
const MOCK = 'http://127.0.0.1:8791'
const SHOT_DIR = resolve(fileURLToPath(new URL('../../../../../.local/dsh-agents-group/docs/验收', import.meta.url)))

let seq = 0
const pending = new Map()
const consoleErrors = []

async function connect() {
  const target = await (await fetch(`${CDP}/json/new`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    ws.addEventListener('open', done, { once: true })
    ws.addEventListener('error', fail, { once: true })
  })
  ws.addEventListener('message', raw => {
    const message = JSON.parse(raw.data.toString())
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      consoleErrors.push(message.params.args?.map(arg => arg.value ?? arg.description ?? '').join(' '))
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      consoleErrors.push(`${message.params.entry.source}: ${message.params.entry.text}`)
    }
  })
  const send = (method, params = {}) => new Promise(done => {
    const id = ++seq
    pending.set(id, done)
    ws.send(JSON.stringify({ id, method, params }))
  })
  return { ws, send }
}

async function main() {
  const { ws, send } = await connect()
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${MOCK}/blog` })
  await new Promise(done => setTimeout(done, 1200))

  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply.result?.exceptionDetails) return { __exception: reply.result.exceptionDetails.text ?? 'exception' }
    return reply.result?.result?.value
  }
  const clickAt = async selectorJs => {
    const coords = await evaluate(`(() => {
      const node = (${selectorJs})
      if (!node) return null
      node.scrollIntoView({ block: "center" })
      const rect = node.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    if (coords === null || coords.__exception !== undefined) throw new Error('点击目标未找到: ' + selectorJs)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
  }
  /** 键盘按键（windowsVirtualKeyCode 必须给真实值，否则浏览器不产生文本动作）。 */
  const pressKey = async (key, code, keyCode, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
  }
  const insertText = async text => {
    await send('Input.insertText', { text })
  }
  /** 输入框写入（原生 value setter + input 事件；React 的 onChange 同样被触发，
   * headless 下比按键注入稳定——真实键盘输入路径由第 6/11 步 insertText 覆盖）。 */
  const typeInto = async (selectorJs, text) => {
    await evaluate(`(() => {
      const node = (${selectorJs})
      node.focus?.()
      const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
      setter.call(node, ${JSON.stringify(text)})
      node.dispatchEvent(new Event('input', { bubbles: true }))
      return node.value
    })()`)
  }
  /** 全选 + 覆盖输入（输入走真实 insertText；用于行内重命名等替换场景）。 */
  const replaceText = async (selectorJs, text) => {
    await clickAt(selectorJs)
    await evaluate(`(() => {
      const node = (${selectorJs})
      node.select?.()
      node.setSelectionRange?.(0, node.value.length)
      return true
    })()`)
    if (text !== '') {
      await insertText(text)
    } else {
      await evaluate(`(() => {
        const node = (${selectorJs})
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(node, '')
        node.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
    }
  }
  const waitUntil = async (expression, { timeout = 8000, interval = 200 } = {}) => {
    for (let i = 0; i < timeout / interval; i++) {
      const value = await evaluate(expression)
      if (value === true) return true
      await new Promise(done => setTimeout(done, interval))
    }
    return false
  }
  const shot = async name => {
    const capture = await send('Page.captureScreenshot', { format: 'png' })
    if (capture.result?.data !== undefined) {
      await mkdir(SHOT_DIR, { recursive: true })
      await writeFile(resolve(SHOT_DIR, name), Buffer.from(capture.result.data, 'base64'))
      return `docs/验收/${name}`
    }
    return null
  }

  const failures = []

  // mock 状态重置后清掉侧栏存储，从「首次访问」出发（验证默认展开）。
  await evaluate(`fetch('/blog/__mock/reset', { method: 'POST' }).then(() => 'ok')`)
  await evaluate(`localStorage.removeItem('blog-history:mock-user')`)
  await send('Page.navigate', { url: `${MOCK}/blog` })
  // 面板就绪以侧栏出现会话行为准（identity → effect 展开 → 列表加载）。
  const rowsReady = await waitUntil(`document.querySelectorAll('.blg-history--open .blg-history-row').length > 0`, { timeout: 12000 })
  await new Promise(done => setTimeout(done, 400))

  // ── 1. 桌面默认展开：左栏在场、位于最左、主区让位 ──────────────────────
  const layout = await evaluate(`(() => {
    const aside = document.querySelector('.blg-history--open')
    if (!aside) return { open: false }
    const rect = aside.getBoundingClientRect()
    const main = document.querySelector('.blg-chat-col')?.getBoundingClientRect()
    return {
      open: true,
      x: Math.round(rect.x), width: Math.round(rect.width),
      borderRight: getComputedStyle(aside).borderRightWidth,
      position: getComputedStyle(aside).position,
      mainX: main ? Math.round(main.x) : null,
      storage: localStorage.getItem('blog-history:mock-user'),
      toggleExpanded: document.querySelector('.blg-topbar-actions button[aria-expanded]')?.getAttribute('aria-expanded') ?? null,
      toggleLabel: document.querySelector('.blg-topbar-actions button[aria-expanded]')?.getAttribute('aria-label') ?? null,
    }
  })()`)
  console.log('[1] 默认展开:', JSON.stringify(layout))
  if (layout.open !== true) failures.push('桌面首访左栏未默认展开')
  if (layout.x !== 0 || layout.mainX < layout.width) failures.push(`左栏不在最左或主区未让位（aside.x=${layout.x} main.x=${layout.mainX} width=${layout.width}）`)
  if (layout.position !== 'relative') failures.push(`桌面左栏应为静态 flex 子项（position=${layout.position}）`)
  if (layout.storage !== null) failures.push(`无记录时不应预写存储（实际=${layout.storage}）`)
  if (layout.toggleExpanded !== 'true' || layout.toggleLabel !== '收起历史对话') failures.push('顶栏按钮 aria 状态与展开态不同步')
  await shot('blog-2c-sidebar-default.png')

  // ── 2. 时间分组标题（首页可见组）───────────────────────────────────────
  const groupsFirstPage = await evaluate(`[...document.querySelectorAll('.blg-history-rows h3')].map(node => node.textContent)`)
  console.log('[2] 首页分组:', JSON.stringify(groupsFirstPage))
  for (const expected of ['置顶', '今天', '昨天', '7 天内']) {
    if (!groupsFirstPage.includes(expected)) failures.push(`首页缺分组「${expected}」`)
  }

  // ── 3. 加载更多：5 行 → 10 行 → 按钮消失 + 全部分组 ────────────────────
  const before = await evaluate(`document.querySelectorAll('.blg-history-row').length`)
  await clickAt(`document.querySelector('.blg-history-more')`)
  const afterMore = await waitUntil(`document.querySelectorAll('.blg-history-row').length === 10 && document.querySelector('.blg-history-more') === null`)
  const groupsAll = await evaluate(`(() => ({
    rows: document.querySelectorAll('.blg-history-row').length,
    groups: [...document.querySelectorAll('.blg-history-rows h3')].map(node => node.textContent),
  }))()`)
  console.log('[3] 加载更多:', JSON.stringify({ before, ...groupsAll }))
  if (before !== 5) failures.push(`首页行数应为 5（实际 ${before}）`)
  if (!afterMore) failures.push('加载更多后未到 10 行或按钮未消失')
  for (const expected of ['置顶', '今天', '昨天', '7 天内', '30 天内', '更早']) {
    if (!(groupsAll.groups ?? []).includes(expected)) failures.push(`全量分组缺「${expected}」`)
  }

  // ── 4. 搜索标题过滤（搜索把分页重置回第一页——与旧码 refresh 同语义）───
  await clickAt(`document.querySelector('.blg-history-icon[aria-label="搜索对话"]')`)
  await typeInto(`document.querySelector('.blg-history-search')`, '归档')
  const filtered = await waitUntil(`(() => {
    const titles = [...document.querySelectorAll('.blg-history-title')].map(node => node.textContent)
    return titles.length === 1 && titles[0] === '归档目录整理'
  })()`, { timeout: 6000 })
  console.log('[4] 搜索过滤:', JSON.stringify({ filtered, titles: await evaluate(`[...document.querySelectorAll('.blg-history-title')].map(node => node.textContent)`) }))
  if (!filtered) failures.push('搜索「归档」未过滤到唯一匹配行')
  // 清空搜索恢复全量（回到第一页 5 行）。
  await typeInto(`document.querySelector('.blg-history-search')`, '')
  const restored = await waitUntil(`document.querySelectorAll('.blg-history-row').length === 5 && [...document.querySelectorAll('.blg-history-title')].some(node => node.textContent === '清晨灵感速记')`, { timeout: 6000 })
  console.log('[4] 搜索恢复:', JSON.stringify({ restored }))
  if (!restored) failures.push('清空搜索后列表未恢复第一页')

  // ── 5. 行菜单：五项齐全 + Escape 关闭 ──────────────────────────────────
  const menuAnchor = `[...document.querySelectorAll('.blg-history-title')].find(node => node.textContent === '清晨灵感速记')?.closest('.blg-history-row')?.querySelector('button[aria-haspopup="menu"]')`
  await clickAt(menuAnchor)
  await new Promise(done => setTimeout(done, 300))
  const menuSeen = await evaluate(`(() => ({
    open: document.querySelector('.blg-history-menu') !== null,
    items: [...document.querySelectorAll('.blg-history-menu button')].map(node => node.textContent.trim()),
    focused: document.activeElement?.getAttribute('role') ?? null,
  }))()`)
  console.log('[5] 行菜单:', JSON.stringify(menuSeen))
  if (menuSeen.open !== true) failures.push('行菜单未打开')
  for (const expected of ['重命名', '置顶', '分享 / 导出', '多选', '删除']) {
    if (!(menuSeen.items ?? []).includes(expected)) failures.push(`行菜单缺「${expected}」`)
  }
  if (menuSeen.focused !== 'menuitem') failures.push('菜单打开后焦点未落首项（键盘不可达）')
  await pressKey('Escape', 'Escape', 27)
  await new Promise(done => setTimeout(done, 200))
  const menuClosed = await evaluate(`document.querySelector('.blg-history-menu') === null`)
  console.log('[5] Escape 关闭:', JSON.stringify({ menuClosed }))
  if (!menuClosed) failures.push('Escape 未关闭行菜单')

  // ── 6. 重命名（行内编辑）───────────────────────────────────────────────
  await clickAt(menuAnchor)
  await new Promise(done => setTimeout(done, 200))
  await clickAt(`[...document.querySelectorAll('.blg-history-menu button')].find(node => node.textContent.trim() === '重命名')`)
  await new Promise(done => setTimeout(done, 200))
  await replaceText(`document.querySelector('.blg-history-inline input')`, '清晨灵感速记（改）')
  await clickAt(`[...document.querySelectorAll('.blg-history-inline button')].find(node => node.textContent === '保存')`)
  const renamed = await waitUntil(`[...document.querySelectorAll('.blg-history-title')].some(node => node.textContent === '清晨灵感速记（改）')`, { timeout: 6000 })
  console.log('[6] 重命名:', JSON.stringify({ renamed }))
  if (!renamed) failures.push('重命名后列表标题未更新')

  // ── 7. 置顶 → 行进入「置顶」组；取消置顶回时间组 ───────────────────────
  const topicAnchor = `[...document.querySelectorAll('.blg-history-title')].find(node => node.textContent === '写作选题头脑风暴')?.closest('.blg-history-row')?.querySelector('button[aria-haspopup="menu"]')`
  // 行内分组查询（置顶前后行数不变，等待必须盯分组本身而非行数——否则轮询在
  // 刷新落地前就通过，读到旧分组）。
  const topicGroupExpr = `(() => {
    const title = [...document.querySelectorAll('.blg-history-title')].find(node => node.textContent === '写作选题头脑风暴')
    const group = title?.closest('div')?.parentElement?.querySelector(':scope > h3')
    return group?.textContent ?? null
  })()`
  await clickAt(topicAnchor)
  await new Promise(done => setTimeout(done, 200))
  await clickAt(`[...document.querySelectorAll('.blg-history-menu button')].find(node => node.textContent.trim() === '置顶')`)
  await waitUntil(`${topicGroupExpr} === '置顶'`, { timeout: 6000 })
  const topicGroup = await evaluate(topicGroupExpr)
  console.log('[7] 置顶:', JSON.stringify({ topicGroup }))
  if (topicGroup !== '置顶') failures.push(`置顶后行未进入「置顶」组（在 ${topicGroup}）`)
  // 取消置顶（菜单文案切换）。
  await clickAt(topicAnchor)
  await new Promise(done => setTimeout(done, 200))
  const pinLabel = await evaluate(`[...document.querySelectorAll('.blg-history-menu button')].map(node => node.textContent.trim()).find(text => text.includes('置顶'))`)
  await clickAt(`[...document.querySelectorAll('.blg-history-menu button')].find(node => node.textContent.trim() === '取消置顶')`)
  await waitUntil(`${topicGroupExpr} !== '置顶'`, { timeout: 6000 })
  const unpinnedGroup = await evaluate(topicGroupExpr)
  console.log('[7] 取消置顶:', JSON.stringify({ pinLabel, unpinnedGroup }))
  if (pinLabel !== '取消置顶') failures.push(`已置顶行的菜单文案应为「取消置顶」（实际 ${pinLabel}）`)
  if (unpinnedGroup === '置顶') failures.push('取消置顶后行仍在「置顶」组')

  // ── 8. 删除：确认弹窗（旧文案）→ 行消失 ────────────────────────────────
  const deleteAnchor = `[...document.querySelectorAll('.blg-history-title')].find(node => node.textContent === '归档目录整理')?.closest('.blg-history-row')?.querySelector('button[aria-haspopup="menu"]')`
  await clickAt(deleteAnchor)
  await new Promise(done => setTimeout(done, 200))
  await clickAt(`[...document.querySelectorAll('.blg-history-menu button')].find(node => node.textContent.trim() === '删除')`)
  await new Promise(done => setTimeout(done, 300))
  const confirmSeen = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('dialog[open]')].find(node => node.querySelector('h2')?.textContent === '删除 1 条对话？')
    return {
      open: dialog !== null,
      note: dialog?.textContent.includes('业务数据、附件文件和官方留存日志不会被删除') ?? false,
      hasCancel: [...(dialog?.querySelectorAll('button') ?? [])].some(node => node.textContent === '取消'),
    }
  })()`)
  console.log('[8] 删除确认:', JSON.stringify(confirmSeen))
  if (confirmSeen.open !== true || !confirmSeen.note || !confirmSeen.hasCancel) failures.push('删除确认弹窗缺失或文案不符（旧 qh-dialog 口径）')
  await shot('blog-2c-delete-confirm.png')
  await clickAt(`[...document.querySelectorAll('dialog[open] button')].find(node => node.textContent === '删除')`)
  const deleted = await waitUntil(`![...document.querySelectorAll('.blg-history-title')].some(node => node.textContent === '归档目录整理')`, { timeout: 6000 })
  console.log('[8] 删除结果:', JSON.stringify({ deleted }))
  if (!deleted) failures.push('确认删除后行未消失')

  // ── 9. 多选批量栏 + 批量导出（先加载更多补全 9 行）─────────────────────
  if (await evaluate(`document.querySelector('.blg-history-more') !== null`)) {
    await clickAt(`document.querySelector('.blg-history-more')`)
  }
  const loadedAll = await waitUntil(`document.querySelectorAll('.blg-history-row').length === 9 && document.querySelector('.blg-history-more') === null`, { timeout: 6000 })
  console.log('[9] 加载全量:', JSON.stringify({ loadedAll }))
  if (!loadedAll) failures.push('加载更多后未到 9 行')
  const seedAnchor = `[...document.querySelectorAll('.blg-history-title')].find(node => node.textContent === '站点迁移备忘')?.closest('.blg-history-row')?.querySelector('button[aria-haspopup="menu"]')`
  await clickAt(seedAnchor)
  await new Promise(done => setTimeout(done, 200))
  await clickAt(`[...document.querySelectorAll('.blg-history-menu button')].find(node => node.textContent.trim() === '多选')`)
  await new Promise(done => setTimeout(done, 200))
  const batchEnter = await evaluate(`(() => ({
    batch: document.querySelector('.blg-history-batch') !== null,
    count: document.querySelector('.blg-history-batch span')?.textContent ?? '',
    checkbox: document.querySelectorAll('.blg-history-row input[type="checkbox"]').length,
  }))()`)
  console.log('[9] 多选进入:', JSON.stringify(batchEnter))
  if (batchEnter.batch !== true || batchEnter.count !== '已选 1 条') failures.push('多选后批量栏/计数不符')
  if (batchEnter.checkbox < 9) failures.push('多选勾选框未在全部行上出现')
  await clickAt(`[...document.querySelectorAll('.blg-history-batch button')].find(node => node.textContent === '选择已加载')`)
  await new Promise(done => setTimeout(done, 200))
  const batchCount = await evaluate(`document.querySelector('.blg-history-batch span')?.textContent ?? ''`)
  if (batchCount !== '已选 9 条') failures.push(`「选择已加载」后计数不符（${batchCount}）`)
  await clickAt(`[...document.querySelectorAll('.blg-history-batch button')].find(node => node.textContent === '导出')`)
  await waitUntil(`[...document.querySelectorAll('dialog[open] h2')].some(node => node.textContent === '分享对话')`)
  await new Promise(done => setTimeout(done, 500))
  const batchExport = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('dialog[open]')].find(node => node.querySelector('h2')?.textContent === '分享对话')
    const text = dialog?.querySelector('textarea')?.value ?? ''
    return { headings: (text.match(/^# /gm) ?? []).length, splits: (text.match(/\\n\\n---\\n\\n/g) ?? []).length, disabled: [...(dialog?.querySelectorAll('button') ?? [])].filter(node => node.textContent.includes('复制') || node.textContent.includes('下载')).every(node => node.disabled) }
  })()`)
  console.log('[9] 批量导出:', JSON.stringify(batchExport))
  if (batchExport.headings < 9) failures.push(`批量导出应合并多份（# 标题 ${batchExport.headings} 份）`)
  if (batchExport.disabled === true) failures.push('导出读取完成后复制/下载按钮仍禁用')
  await shot('blog-2c-batch-export.png')
  await clickAt(`[...document.querySelectorAll('dialog[open] .blg-dialog-close')].at(0)`)
  await new Promise(done => setTimeout(done, 300))
  await clickAt(`[...document.querySelectorAll('.blg-history-batch button')].find(node => node.textContent === '取消')`)
  await new Promise(done => setTimeout(done, 200))
  const batchGone = await evaluate(`document.querySelector('.blg-history-batch') === null && document.querySelector('.blg-history-row input[type="checkbox"]') === null`)
  if (!batchGone) failures.push('取消多选后批量栏/勾选框未收起')

  // ── 10. 单条导出（conv-mock-1 带完整历史）──────────────────────────────
  const mockAnchor = `[...document.querySelectorAll('.blg-history-title')].find(node => node.textContent === '博客近况梳理会话')?.closest('.blg-history-row')?.querySelector('button[aria-haspopup="menu"]')`
  await clickAt(mockAnchor)
  await new Promise(done => setTimeout(done, 200))
  await clickAt(`[...document.querySelectorAll('.blg-history-menu button')].find(node => node.textContent.trim() === '分享 / 导出')`)
  await waitUntil(`[...document.querySelectorAll('dialog[open] h2')].some(node => node.textContent === '分享对话')`)
  await new Promise(done => setTimeout(done, 600))
  const singleExport = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('dialog[open]')].find(node => node.querySelector('h2')?.textContent === '分享对话')
    const text = dialog?.querySelector('textarea')?.value ?? ''
    return { h1: text.startsWith('# 博客近况梳理会话'), me: text.includes('## 我'), assistant: text.includes('## 助手') }
  })()`)
  console.log('[10] 单条导出:', JSON.stringify(singleExport))
  if (singleExport.h1 !== true || singleExport.me !== true || singleExport.assistant !== true) failures.push('单条导出预览缺问答分段（# 标题 / ## 我 / ## 助手）')
  await clickAt(`[...document.querySelectorAll('dialog[open] .blg-dialog-close')].at(0)`)
  await new Promise(done => setTimeout(done, 300))

  // ── 11. busy：回答进行中历史行不禁用、可切换（B1③：旧 blog 从不调 setBusy）──
  await clickAt(`document.querySelector('#blg-chat-input')`)
  await insertText('帮我把这篇速记扩写成草稿')
  await clickAt(`document.querySelector('.blg-compose-actions button[aria-label="发送"]')`)
  await new Promise(done => setTimeout(done, 500))
  const busyState = await evaluate(`(() => {
    const first = document.querySelector('.blg-history-title')
    return { disabled: first?.disabled ?? null, title: first?.textContent ?? '' }
  })()`)
  console.log('[11] 回答中历史行状态:', JSON.stringify(busyState))
  if (busyState.disabled !== false) failures.push('回答进行中历史行被禁用（旧 blog 无此语义）')
  // 回答进行中点击另一行：应成功切换（当前会话行高亮变化）。
  const switchState = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.blg-history-title')]
    // React 对 aria-current={false} 也输出属性 "false"——按值判断而非按属性存在性。
    const target = rows.find(node => node.getAttribute('aria-current') !== 'true')
    if (!target) return { ok: false }
    target.click()
    return { ok: true, target: target.textContent }
  })()`)
  await new Promise(done => setTimeout(done, 800))
  const switched = await evaluate(`(() => {
    const current = document.querySelector('.blg-history-title[aria-current="true"]')
    return { current: current?.textContent ?? null, input: document.querySelector('#blg-chat-input')?.value ?? '' }
  })()`)
  console.log('[11] 回答中切换:', JSON.stringify({ switchState, switched }))
  if (switchState.ok !== true || switched.current !== switchState.target) failures.push('回答进行中切换会话失败（行被禁用或未切换）')
  // 回到原会话继续后续步骤（等待流式收尾由 waitUntil 保证）。
  await waitUntil(`[...document.querySelectorAll('.blg-history-title')].some(node => !node.disabled)`, { timeout: 12000 })
  await shot('blog-2c-answer-done.png')

  // ── 12. 收起 → 持久化 → 刷新保持 → 顶栏恢复 ───────────────────────────
  await clickAt(`document.querySelector('.blg-history-icon[aria-label="收起历史对话"]')`)
  await new Promise(done => setTimeout(done, 300))
  const collapsed = await evaluate(`(() => ({
    open: document.querySelector('.blg-history--open') !== null,
    storage: localStorage.getItem('blog-history:mock-user'),
    ariaExpanded: document.querySelector('.blg-topbar-actions button[aria-expanded]')?.getAttribute('aria-expanded') ?? null,
    ariaLabel: document.querySelector('.blg-topbar-actions button[aria-expanded]')?.getAttribute('aria-label') ?? null,
  }))()`)
  console.log('[12] 收起:', JSON.stringify(collapsed))
  if (collapsed.open !== false || collapsed.storage !== 'collapsed') failures.push(`收起后状态未持久化（storage=${collapsed.storage}）`)
  if (collapsed.ariaExpanded !== 'false' || collapsed.ariaLabel !== '展开历史对话') failures.push('收起后顶栏按钮 aria 未同步')
  await send('Page.navigate', { url: `${MOCK}/blog` })
  await new Promise(done => setTimeout(done, 1500))
  // 收起保持：--open 类不出现，且 aside 实际不可见（display:none → offsetParent 为 null）。
  const keptCollapsed = await waitUntil(`document.querySelector('.blg-history--open') === null && document.querySelector('.blg-history')?.offsetParent === null`, { timeout: 12000 })
  console.log('[12] 刷新保持:', JSON.stringify({ keptCollapsed }))
  if (!keptCollapsed) failures.push('刷新后收起状态未保持')
  await shot('blog-2c-collapsed.png')
  // 顶栏按钮展开恢复。
  await clickAt(`document.querySelector('.blg-topbar-actions button[aria-expanded="false"]')`)
  const reopened = await waitUntil(`document.querySelector('.blg-history--open .blg-history-row') !== null`, { timeout: 6000 })
  const expandedStorage = await evaluate(`(() => ({ storage: localStorage.getItem('blog-history:mock-user'), ariaExpanded: document.querySelector('.blg-topbar-actions button[aria-expanded]')?.getAttribute('aria-expanded') ?? null }))()`)
  console.log('[12] 顶栏恢复:', JSON.stringify({ reopened, ...expandedStorage }))
  if (!reopened || expandedStorage.storage !== 'expanded' || expandedStorage.ariaExpanded !== 'true') failures.push('顶栏按钮展开后存储/aria 未同步')

  // ── 13. 移动端视口：默认收起 → 顶栏开浮层 → 点行关闭 ───────────────────
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 720, deviceScaleFactor: 2, mobile: true })
  await send('Page.navigate', { url: `${MOCK}/blog` })
  await waitUntil(`document.querySelector('.blg-history') !== null`, { timeout: 12000 })
  await new Promise(done => setTimeout(done, 800))
  const mobileInitial = await evaluate(`(() => ({
    open: document.querySelector('.blg-history--open') !== null,
    storage: localStorage.getItem('blog-history:mock-user'),
  }))()`)
  console.log('[13] 移动端默认:', JSON.stringify(mobileInitial))
  if (mobileInitial.open !== false) failures.push('移动端首屏左栏不应默认展开')
  await clickAt(`document.querySelector('.blg-topbar-actions button[aria-expanded="false"]')`)
  await new Promise(done => setTimeout(done, 400))
  const mobileOpen = await evaluate(`(() => {
    const aside = document.querySelector('.blg-history--open')
    if (!aside) return { open: false }
    const style = getComputedStyle(aside)
    return {
      open: true,
      position: style.position,
      width: Math.round(aside.getBoundingClientRect().width),
      backdrop: getComputedStyle(document.querySelector('.blg-history-backdrop')).display,
      storage: localStorage.getItem('blog-history:mock-user'),
    }
  })()`)
  console.log('[13] 移动端浮层:', JSON.stringify(mobileOpen))
  if (mobileOpen.open !== true || mobileOpen.position !== 'fixed') failures.push('移动端左栏未以浮层（fixed）打开')
  if (mobileOpen.width < 300 || mobileOpen.width > 320) failures.push(`移动端浮层宽度不符（${mobileOpen.width}）`)
  if (mobileOpen.backdrop !== 'block') failures.push('移动端浮层遮罩未显示')
  // 窄屏开合不写存储（旧 remember 只在桌面分支）。
  if (mobileOpen.storage !== 'expanded') failures.push(`移动端开合不应改写存储（实际=${mobileOpen.storage}）`)
  await shot('blog-2c-mobile-drawer.png')
  await clickAt(`[...document.querySelectorAll('.blg-history-title')].find(node => node.textContent === '清晨灵感速记（改）')`)
  const mobileSwitched = await waitUntil(`document.querySelector('.blg-history--open') === null && location.search.includes('conversationId=conv-seed-1')`, { timeout: 8000 })
  console.log('[13] 移动端点行:', JSON.stringify({ mobileSwitched }))
  if (!mobileSwitched) failures.push('移动端点会话后浮层未关闭或会话未切换')

  // ── 14. 备份与恢复（backupAdmin 入口 → 计划/校验/恢复确认链路）──────────
  const backupButton = `[...document.querySelectorAll('.blg-management-links-bar button')].find(node => node.textContent === '备份与恢复')`
  const verifyButton = `[...document.querySelectorAll('.blg-backup-row button')].find(node => node.textContent === '校验')`
  const restoreDrillButton = `[...document.querySelectorAll('.blg-backup-row button')].find(node => node.textContent === '隔离恢复演练')`
  const confirmButton = `[...document.querySelectorAll('dialog[open] button')].find(node => node.textContent === '确认恢复')`
  const checkInput = `document.querySelector('dialog[open] input[aria-label="完整备份标识"]')`
  const backupCloseButton = `[...document.querySelectorAll('dialog[open]')].find(node => node.querySelector('h2')?.textContent === '备份与恢复')?.querySelector('.blg-dialog-close')`
  await clickAt(backupButton)
  await new Promise(done => setTimeout(done, 500))
  const backupOpen = await evaluate(`(() => ({
    dialog: [...document.querySelectorAll('dialog[open] h2')].some(node => node.textContent === '备份与恢复'),
    schedule: document.querySelector('.blg-backup-schedule input[type="time"]')?.value ?? '',
    statusLine: document.querySelector('.blg-backup-status')?.textContent ?? '',
    rows: document.querySelectorAll('.blg-backup-row').length,
    failedDisabled: [...document.querySelectorAll('.blg-backup-row')].filter(row => row.textContent.includes('失败')).every(row => [...row.querySelectorAll('button')].find(node => node.textContent === '恢复到生产')?.disabled === true),
  }))()`)
  console.log('[14] 备份弹窗:', JSON.stringify(backupOpen))
  if (backupOpen.dialog !== true) failures.push('备份弹窗未打开（backupAdmin 入口）')
  if (backupOpen.schedule === '') failures.push('备份计划表单未回填')
  if (!backupOpen.statusLine.includes('下次计划：')) failures.push('备份状态行缺「下次计划」段')
  if (backupOpen.rows < 3) failures.push('备份列表行数不足')
  if (backupOpen.failedDisabled !== true) failures.push('非完整备份的恢复入口未禁用')
  await clickAt(verifyButton)
  await new Promise(done => setTimeout(done, 400))
  const verified = await evaluate(`document.querySelector('.blg-backup-status')?.textContent.includes('个组件校验通过')`)
  console.log('[14] 校验:', JSON.stringify({ verified }))
  if (verified !== true) failures.push('备份校验后状态行未出现组件数文案')
  await clickAt(restoreDrillButton)
  await new Promise(done => setTimeout(done, 400))
  const restoreSeen = await evaluate(`(() => ({
    open: [...document.querySelectorAll('dialog[open] h2')].some(node => node.textContent === '隔离恢复演练'),
    backupId: [...document.querySelectorAll('dialog[open] strong')].map(node => node.textContent).at(0) ?? '',
  }))()`)
  console.log('[14] 恢复确认:', JSON.stringify(restoreSeen))
  if (restoreSeen.open !== true || restoreSeen.backupId === '') failures.push('恢复确认弹窗未回填备份标识')
  await clickAt(checkInput)
  await insertText('backup-wrong-id')
  await clickAt(confirmButton)
  await new Promise(done => setTimeout(done, 400))
  const wrongId = await evaluate(`[...document.querySelectorAll('dialog[open] [role=alert]')].some(node => node.textContent.includes('请输入与所选版本一致的完整备份标识'))`)
  console.log('[14] 错误标识:', JSON.stringify({ wrongId }))
  if (wrongId !== true) failures.push('错误备份标识未报核对错误')
  // 清空错误输入再输入完整标识（insertText 是光标处插入，先清空）。
  await evaluate(`(() => {
    const node = document.querySelector('dialog[open] input[aria-label="完整备份标识"]')
    if (!node) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(node, '')
    node.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await new Promise(done => setTimeout(done, 200))
  await clickAt(checkInput)
  await insertText(restoreSeen.backupId)
  await new Promise(done => setTimeout(done, 200))
  await clickAt(confirmButton)
  const submitted = await waitUntil(`document.querySelector('.blg-backup-status')?.textContent.includes('恢复任务已提交')`, { timeout: 6000 })
  console.log('[14] 恢复提交:', JSON.stringify({ submitted }))
  if (!submitted) failures.push('恢复确认后状态行未出现提交提示')
  await shot('blog-2c-backup.png')
  await clickAt(backupCloseButton)
  await new Promise(done => setTimeout(done, 300))

  if (consoleErrors.length > 0) failures.push(`console 错误 ${consoleErrors.length} 条: ${consoleErrors[0] ?? ''}`)

  console.log(JSON.stringify({ failures, consoleErrors }, null, 2))
  if (failures.length > 0) {
    console.error('[verify-blog-2c] 失败断言：')
    for (const failure of failures) console.error(` - ${failure}`)
    process.exit(1)
  }
  console.log('[verify-blog-2c] 全部断言通过')
  ws.close()
}

main().catch(error => {
  console.error('[verify-blog-2c] 运行异常:', error)
  process.exit(1)
})
