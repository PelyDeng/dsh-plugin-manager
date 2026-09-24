/**
 * 批 1a（closedoff 数据层与主骨架）浏览器真实验证（Edge CDP 9223，verify-hello.mjs
 * 同形态；方案 §5 批 1 DoD 的浏览器段）。
 *
 * 断言面：
 * 1. 发送→流式渲染：thinking 节流（MutationObserver 统计思考正文更新次数，必须
 *    少于 mock 的密集快照数）、delta 正文落全、tool chip 出现且相位收口、cards
 *    渲染、轨迹/围栏/媒体引用行、done 后回到就绪态且回合操作区（用量/用时/评分）
 *    在场；
 * 2. 切会话（restore）：conv-mock-1 的五类复原上屏，chips 相位、summary/data/error
 *    卡、引用块、评分态、URL 同步；
 * 3. console 零错误；截图两份（流式后 + restore 后）。
 *
 * 用法：node tests/mock/verify-closedoff-1a.mjs
 * （需 npm run build 于 agents/closedoff；mock 8791（tests/mock/page-server.mjs）
 *  与 Edge --remote-debugging-port=9223 已启动）
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CDP = 'http://127.0.0.1:9223'
const MOCK = 'http://127.0.0.1:8791'
// 截图落仓库根 .local/dsh-agents-group/docs/验收/（上溯五级是仓库根）。
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
  await send('Page.navigate', { url: `${MOCK}/closedoff-qa` })
  await new Promise(done => setTimeout(done, 1500))

  const evaluate = async expression => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply.result?.exceptionDetails) return { __exception: reply.result.exceptionDetails.text ?? 'exception' }
    return reply.result?.result?.value
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

  // 草稿注入走原生 setter + input 事件（React 受控 textarea 的标准驱动方式；
  // CDP 逐字 keyEvent 对受控组件的 onChange 不稳定），发送按钮走真实鼠标点击。
  const typeAndSend = async text => {
    await evaluate(`(() => {
      const textarea = document.querySelector('.co-input-box textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(text)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await new Promise(done => setTimeout(done, 120))
    const draftOk = await evaluate(`document.querySelector('.co-input-box textarea').value.length > 0`)
    if (draftOk !== true) throw new Error('草稿未进入输入框')
    const coords = await evaluate(`(() => {
      const button = document.querySelector('.co-send')
      const rect = button.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
  }

  // ── 1. 挂载与发送 ────────────────────────────────────────────────────
  const mounted = await evaluate(`(() => ({
    react: document.querySelector('#root .co-workbench') !== null,
    config: window.CLOSEDOFF_CONFIG?.routePrefix ?? null,
    status: document.querySelector('.co-pill span:last-child')?.textContent ?? null,
    composer: document.querySelector('.co-input-box textarea') !== null,
  }))()`)
  console.log('[1] 挂载:', JSON.stringify(mounted))
  if (mounted.__exception !== undefined || mounted.react !== true || mounted.composer !== true) {
    console.error('[verify-1a] 页面挂载失败', mounted)
    process.exit(1)
  }

  // 发送前挂 MutationObserver：统计思考正文的实际更新次数（节流断言素材）。
  await evaluate(`(() => {
    window.__coThinkingUpdates = 0
    window.__coThinkingSeen = new Set()
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        const body = m.target instanceof Element ? m.target.closest('.co-thinking-body') : m.target.parentElement?.closest?.('.co-thinking-body')
        if (body === null) continue
        const text = body.textContent ?? ''
        if (!window.__coThinkingSeen.has(text)) { window.__coThinkingSeen.add(text); window.__coThinkingUpdates++ }
      }
    })
    observer.observe(document.querySelector('#root'), { subtree: true, childList: true, characterData: true })
  })()`)

  await typeAndSend('园区现在整体情况怎么样？')

  // 流式进行中：等 thinking 区出现。
  let streamingSeen = null
  for (let i = 0; i < 20; i++) {
    await new Promise(done => setTimeout(done, 200))
    streamingSeen = await evaluate(`(() => ({
      thinkingVisible: document.querySelector('.co-thinking') !== null,
      running: document.querySelector('.co-pill span:last-child')?.textContent ?? '',
      chips: document.querySelectorAll('.co-tool-chip').length,
    }))()`)
    if (streamingSeen.thinkingVisible) break
  }
  console.log('[2] 流式中观察:', JSON.stringify(streamingSeen))

  // 等 done（状态回就绪、操作区出现；mock 全脚本约 2.4s）。
  let afterTurn = null
  for (let i = 0; i < 25; i++) {
    await new Promise(done => setTimeout(done, 300))
    afterTurn = await evaluate(`(() => ({
      status: document.querySelector('.co-pill span:last-child')?.textContent ?? '',
      userMsg: document.querySelectorAll('.co-msg--user').length,
      assistantMsg: document.querySelectorAll('.co-msg--assistant').length,
      bodyText: (document.querySelector('.co-analysis-heading + .co-md')?.textContent ?? ''),
      chipsDone: document.querySelectorAll('.co-tool-chip--done').length,
      chipsError: document.querySelectorAll('.co-tool-chip--error').length,
      riskCards: document.querySelectorAll('.co-result-section--risk .co-mini-card').length,
      refs: {
        track: document.querySelectorAll('.co-enclave-ref[data-enclave="track"]').length,
        fences: document.querySelectorAll('.co-enclave-ref[data-enclave="fences"]').length,
        media: document.querySelectorAll('.co-enclave-ref[data-enclave="media"]').length,
      },
      actions: {
        clock: document.querySelector('.co-action-clock') !== null,
        usage: [...document.querySelectorAll('.co-stat-label')].some(node => node.textContent?.includes('用量')),
        likeActive: document.querySelector('.co-action--active') !== null,
        branch: [...document.querySelectorAll('.co-action')].some(node => node.getAttribute('aria-label') === '从这里创建新对话'),
      },
      thinkingUpdates: window.__coThinkingUpdates,
      cursorGone: document.querySelector('.co-cursor') === null,
    }))()`)
    if (afterTurn.status === '智能体就绪' && afterTurn.actions.clock) break
  }
  console.log('[3] done 后:', JSON.stringify(afterTurn))
  const shotStreaming = await shot('closedoff-1a-stream.png')

  // ── 2. 切会话（restore 五类复原）─────────────────────────────────────
  const openHistory = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.co-history-title')]
    return rows.length
  })()`)
  // 历史面板默认收起：点「历史对话」展开，再点 conv-mock-1。
  await evaluate(`[...document.querySelectorAll('.co-header-btn')].find(node => node.textContent?.includes('历史对话'))?.click()`)
  await new Promise(done => setTimeout(done, 300))
  const historyPanel = await evaluate(`(() => ({
    panel: document.querySelector('.co-history') !== null,
    pinnedGroup: [...document.querySelectorAll('.co-history-group')].some(node => node.textContent === '置顶'),
    titles: [...document.querySelectorAll('.co-history-title')].map(node => node.textContent),
  }))()`)
  console.log('[4] 历史面板:', JSON.stringify(historyPanel))
  await evaluate(`[...document.querySelectorAll('.co-history-title')].find(node => node.textContent?.includes('演示会话'))?.click()`)
  // 复原上屏。
  let restored = null
  for (let i = 0; i < 15; i++) {
    await new Promise(done => setTimeout(done, 300))
    restored = await evaluate(`(() => ({
      url: location.search,
      userMsg: document.querySelectorAll('.co-msg--user').length,
      assistantMsg: document.querySelectorAll('.co-msg--assistant').length,
      chipsDone: document.querySelectorAll('.co-tool-chip--done').length,
      chipsError: document.querySelectorAll('.co-tool-chip--error').length,
      summaryCards: document.querySelectorAll('.co-summary-card').length,
      miniCards: document.querySelectorAll('.co-mini-card').length,
      errorCards: document.querySelectorAll('.co-result-section--infrastructure .co-mini-card, .co-result-section--infrastructure .co-cards-empty').length,
      refs: {
        track: document.querySelectorAll('.co-enclave-ref[data-enclave="track"]').length,
        fences: document.querySelectorAll('.co-enclave-ref[data-enclave="fences"]').length,
        media: document.querySelectorAll('.co-enclave-ref[data-enclave="media"]').length,
      },
      likeActive: document.querySelector('.co-action--active') !== null,
      usage: [...document.querySelectorAll('.co-stat-label')].some(node => node.textContent?.includes('用量')),
      tableStripped: !(document.querySelector('.co-md table') !== null) && ((document.querySelector('.co-md')?.textContent ?? '').includes('园区整体运行平稳')),
      thinkingBody: (document.querySelector('.co-thinking-body')?.textContent ?? '').includes('联动附近设备组'),
    }))()`)
    if ((restored.assistantMsg ?? 0) > 0 && (restored.refs.track ?? 0) > 0) break
  }
  console.log('[5] restore 复原:', JSON.stringify(restored))
  console.log('[4.5] conv 计数（展开前）:', openHistory)
  const shotRestore = await shot('closedoff-1a-restore.png')
  ws.close()

  // ── 3. 断言汇总 ──────────────────────────────────────────────────────
  const failures = []
  if (mounted.config !== '/closedoff-qa') failures.push('CLOSEDOFF_CONFIG 注入异常')
  if (streamingSeen?.thinkingVisible !== true) failures.push('流式中思考区未出现')
  if ((streamingSeen?.running ?? '') !== '智能体回答中…') failures.push('流式中状态未进入回答中')
  if (afterTurn === null || afterTurn.__exception !== undefined) failures.push('done 后取态异常')
  else {
    if (afterTurn.status !== '智能体就绪') failures.push('done 后状态未回就绪')
    if (afterTurn.userMsg < 1 || afterTurn.assistantMsg < 1) failures.push('归档消息数不足')
    if (!afterTurn.bodyText.includes('园区整体平稳') || !afterTurn.bodyText.includes('北门设备组抓拍')) failures.push('正文不完整')
    if (afterTurn.chipsDone < 1 || afterTurn.chipsError < 1) failures.push('工具 chips 相位不完整')
    if (afterTurn.riskCards < 2) failures.push('风险组卡片未渲染')
    if (afterTurn.refs.track < 1 || afterTurn.refs.fences < 1 || afterTurn.refs.media < 1) failures.push('结构化引用块缺失')
    if (!afterTurn.actions.clock || !afterTurn.actions.usage || !afterTurn.actions.branch) failures.push('回合操作区不完整')
    if (afterTurn.cursorGone !== true) failures.push('光标未消失')
    // 节流：mock 发 6 个密集快照，客户端合并后 DOM 更新必须少于快照数。
    if (afterTurn.thinkingUpdates >= 6) failures.push(`thinking 未节流（更新 ${afterTurn.thinkingUpdates} 次 ≥ 快照数）`)
  }
  if (historyPanel.panel !== true || historyPanel.pinnedGroup !== true) failures.push('历史面板/置顶分组异常')
  if (restored === null || restored.__exception !== undefined) failures.push('restore 取态异常')
  else {
    if (!restored.url.includes('conversationId=conv-mock-1')) failures.push('URL 未同步会话 id')
    if (restored.userMsg < 1 || restored.assistantMsg < 1) failures.push('复原消息缺失')
    if (restored.chipsDone < 3 || restored.chipsError < 1) failures.push('复原 chips 相位不完整')
    if (restored.summaryCards < 1 || restored.miniCards < 2) failures.push('复原卡片缺失（summary/records）')
    if (restored.refs.track < 1 || restored.refs.fences < 1 || restored.refs.media < 1) failures.push('复原引用块缺失')
    if (restored.likeActive !== true) failures.push('复原评分态未生效')
    if (restored.usage !== true) failures.push('复原用量标签缺失')
    if (restored.thinkingBody !== true) failures.push('复原思考正文缺失')
  }
  if (consoleErrors.length > 0) failures.push(`console 错误 ${consoleErrors.length} 条: ${consoleErrors[0] ?? ''}`)

  console.log(JSON.stringify({
    mounted, streamingSeen, afterTurn, historyPanel, restored,
    consoleErrors, shots: { stream: shotStreaming, restore: shotRestore },
  }, null, 2))
  if (failures.length > 0) {
    console.error('[verify-closedoff-1a] 失败断言：')
    for (const failure of failures) console.error(` - ${failure}`)
    process.exit(1)
  }
  console.log('[verify-closedoff-1a] 全部断言通过')
}

main().catch(error => {
  console.error('[verify-closedoff-1a] 运行异常:', error)
  process.exit(1)
})
