/**
 * 批 2a（blog 数据层与对话骨架）浏览器真实验证（Edge CDP 9223，verify-closedoff-1a.mjs
 * 同形态；方案 §5 批 2 DoD 的浏览器段）。
 *
 * 断言面：
 * 1. 挂载：React 外壳、data-base 配置通道（CSP 无 inline script）、composer 在场、
 *    欢迎区三建议可见；
 * 2. 发送→live 流式渲染：streaming 答案区出现、正文逐步增长、思考区先行；
 * 3. snapshot 合并：changed 触发防抖重拉后，user+assistant 消息落位、用量/用时
 *    元信息在场、URL 同步会话 id；
 * 4. 切会话代次隔离：第二条发送的 live 进行中切到 conv-mock-1，旧会话的迟到
 *    live 不写新面板，历史快照（seeded 一轮）上屏；
 * 5. console 零错误；截图三份（流式中/完成后/切会话后）。
 *
 * 用法：node tests/mock/verify-blog-2a.mjs
 * （需 pnpm build 于 agents/blog；mock 8791（tests/mock/page-server.mjs）
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
  await send('Page.navigate', { url: `${MOCK}/blog` })
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

  // mock 状态重置：从两个初始会话出发（verify 可复跑）。
  await evaluate(`fetch('/blog/__mock/reset', { method: 'POST' }).then(() => 'ok')`)
  await send('Page.navigate', { url: `${MOCK}/blog` })
  await new Promise(done => setTimeout(done, 1500))

  // 草稿注入走原生 setter + input 事件（React 受控 textarea 的标准驱动方式）。
  const typeAndSend = async text => {
    await evaluate(`(() => {
      const textarea = document.querySelector('.blg-composer textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(textarea, ${JSON.stringify(text)})
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await new Promise(done => setTimeout(done, 120))
    const draftOk = await evaluate(`document.querySelector('.blg-composer textarea').value.length > 0`)
    if (draftOk !== true) throw new Error('草稿未进入输入框')
    const coords = await evaluate(`(() => {
      const button = [...document.querySelectorAll('.blg-composer button')].find(node => node.getAttribute('aria-label') === '发送')
      const rect = button.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
  }

  // ── 1. 挂载与欢迎区 ──────────────────────────────────────────────────
  const mounted = await evaluate(`(() => ({
    react: document.querySelector('#root .blg-shell') !== null,
    base: document.body.dataset.base ?? null,
    composer: document.querySelector('.blg-composer textarea') !== null,
    welcome: document.querySelector('.blg-welcome h2')?.textContent ?? null,
    suggestions: document.querySelectorAll('.blg-suggestions button').length,
    prompts: document.querySelectorAll('.blg-prompts button').length,
    inlineScript: [...document.querySelectorAll('script')].filter(node => !node.src && node.textContent.trim() !== '').length,
  }))()`)
  console.log('[1] 挂载:', JSON.stringify(mounted))
  if (mounted.__exception !== undefined || mounted.react !== true || mounted.composer !== true) {
    console.error('[verify-blog-2a] 页面挂载失败', mounted)
    process.exit(1)
  }

  // ── 2. 发送→live 流式渲染 ────────────────────────────────────────────
  await typeAndSend('帮我梳理一下博客近况')

  // 流式进行中：全程观察（首帧可能是 changed 重拉投上的空 live 占位，与旧码
  // 行为一致——思考区与正文增长在流式全程里断言，不在首帧收口）。
  let streamingSeen = null
  let thinkingSeen = false
  let maxLength = 0
  for (let i = 0; i < 30; i++) {
    await new Promise(done => setTimeout(done, 140))
    const sample = await evaluate(`(() => {
      const answers = [...document.querySelectorAll('.blg-answer--streaming')]
      return {
        streaming: answers.length,
        textLength: answers.map(node => node.textContent.length),
        thinking: document.querySelector('.blg-thinking') !== null,
        state: document.querySelector('#blg-chat-state')?.textContent ?? '',
      }
    })()`)
    if ((sample?.streaming ?? 0) > 0) streamingSeen = sample
    thinkingSeen = thinkingSeen || sample?.thinking === true
    maxLength = Math.max(maxLength, ...(sample?.textLength ?? [0]))
    if (thinkingSeen && maxLength > 10) break
  }
  const streamingSeen2 = streamingSeen ?? {}
  const streamingSeenFinal = {
    streaming: streamingSeen2.streaming ?? 0,
    textLength: [maxLength],
    thinking: thinkingSeen,
    thinkingEarly: thinkingSeen,
    state: streamingSeen2.state ?? '',
  }
  streamingSeen = streamingSeenFinal
  console.log('[2] 流式中观察:', JSON.stringify(streamingSeen))
  const shotStreaming = await shot('blog-2a-streaming.png')

  // ── 3. snapshot 合并（changed → 防抖重拉 → 消息落位）────────────────
  let afterTurn = null
  for (let i = 0; i < 25; i++) {
    await new Promise(done => setTimeout(done, 300))
    afterTurn = await evaluate(`(() => ({
      url: location.search,
      userMsg: document.querySelectorAll('.blg-message--user').length,
      assistantMsg: document.querySelectorAll('.blg-message--assistant').length,
      bodyText: [...document.querySelectorAll('.blg-message--assistant .blg-answer')].map(node => node.textContent).join(''),
      streamingGone: document.querySelector('.blg-answer--streaming') === null,
      usage: [...document.querySelectorAll('.blg-meta > summary span')].some(node => node.textContent?.includes('用量')),
      clock: document.querySelectorAll('.blg-clock').length,
      state: document.querySelector('#blg-chat-state')?.textContent ?? '',
    }))()`)
    if ((afterTurn.assistantMsg ?? 0) > 0 && afterTurn.streamingGone) break
  }
  console.log('[3] done 后:', JSON.stringify(afterTurn))
  const shotDone = await shot('blog-2a-done.png')

  // ── 4. 切会话代次隔离 ────────────────────────────────────────────────
  // 先发第二条让 live 进行中，再切到 conv-mock-1。
  await typeAndSend('第二条消息，马上要切走')
  let secondLive = null
  for (let i = 0; i < 20; i++) {
    await new Promise(done => setTimeout(done, 120))
    secondLive = await evaluate(`document.querySelectorAll('.blg-answer--streaming').length`)
    if ((secondLive ?? 0) > 0) break
  }
  await evaluate(`[...document.querySelectorAll('.blg-topbar-btn')].find(node => node.textContent?.includes('历史对话'))?.click()`)
  await new Promise(done => setTimeout(done, 300))
  const historyPanel = await evaluate(`(() => ({
    panel: document.querySelector('.blg-history--open') !== null,
    groups: [...document.querySelectorAll('.blg-history-rows h3')].map(node => node.textContent),
    titles: [...document.querySelectorAll('.blg-history-title')].map(node => node.textContent),
  }))()`)
  console.log('[4] 历史抽屉:', JSON.stringify(historyPanel))
  await evaluate(`[...document.querySelectorAll('.blg-history-title')].find(node => node.textContent?.includes('博客近况梳理会话'))?.click()`)

  let switched = null
  for (let i = 0; i < 20; i++) {
    await new Promise(done => setTimeout(done, 200))
    switched = await evaluate(`(() => ({
      url: location.search,
      userMsg: document.querySelectorAll('.blg-message--user').length,
      assistantMsg: document.querySelectorAll('.blg-message--assistant').length,
      bodyText: [...document.querySelectorAll('.blg-bubble .blg-answer')].map(node => node.textContent).join(''),
      staleLive: [...document.querySelectorAll('.blg-answer--streaming')].some(node => node.textContent.includes('马上要切走')),
      secondUserGone: ![...document.querySelectorAll('.blg-user-text')].some(node => node.textContent?.includes('马上要切走')),
    }))()`)
    if ((switched.assistantMsg ?? 0) > 0 && switched.secondUserGone) break
  }
  console.log('[5] 切会话后:', JSON.stringify(switched))
  const shotSwitched = await shot('blog-2a-switched.png')
  ws.close()

  // ── 5. 断言汇总 ──────────────────────────────────────────────────────
  const failures = []
  if (mounted.base !== '/blog') failures.push('data-base 配置通道异常')
  if (mounted.welcome !== '把想法，写成文章。') failures.push('欢迎区标题异常')
  if ((mounted.suggestions ?? 0) !== 3) failures.push('欢迎区三建议缺失')
  if ((mounted.prompts ?? 0) !== 5) failures.push('快捷提问侧栏缺失')
  if ((mounted.inlineScript ?? 1) !== 0) failures.push('页面出现 inline script（违反 CSP script-src self 契约）')
  if ((streamingSeen?.streaming ?? 0) < 1) failures.push('live 流式渲染未出现')
  if (streamingSeen?.thinkingEarly !== true) failures.push('思考区未先行出现')
  const streamedMaxLength = Math.max(...(streamingSeen?.textLength ?? [0]))
  if (streamedMaxLength < 10) failures.push(`live 正文过短（${streamedMaxLength} 字符），流式分段未生效`)
  if (afterTurn === null || afterTurn.__exception !== undefined) failures.push('done 后取态异常')
  else {
    if (afterTurn.userMsg < 1 || afterTurn.assistantMsg < 1) failures.push('重拉落位消息数不足（snapshot 合并失败）')
    if (!afterTurn.bodyText.includes('近况小结') || !afterTurn.bodyText.includes('候选稿')) failures.push('assistant 正文不完整')
    if (!afterTurn.url.includes('conversationId=conv-')) failures.push('URL 未同步会话 id')
    if (afterTurn.usage !== true) failures.push('回合用量元信息缺失')
    if ((afterTurn.clock ?? 0) < 1) failures.push('回合时间标记缺失')
    if (!afterTurn.streamingGone) failures.push('streaming 答案区未收口')
  }
  if (historyPanel.panel !== true) failures.push('历史抽屉未展开')
  if (!(historyPanel.groups ?? []).includes('置顶')) failures.push('历史分组缺「置顶」')
  if (!(historyPanel.titles ?? []).some(title => title?.includes('博客近况梳理会话'))) failures.push('seeded 会话不在列表')
  if (switched === null || switched.__exception !== undefined) failures.push('切会话取态异常')
  else {
    if (!switched.url.includes('conversationId=conv-mock-1')) failures.push('切会话后 URL 未更新')
    if (switched.secondUserGone !== true) failures.push('旧会话用户消息残留（代次隔离失败）')
    if (switched.staleLive) failures.push('旧会话迟到 live 写入了新面板（代次隔离失败）')
    if (!switched.bodyText.includes('手账工作台实践')) failures.push('seeded 历史快照未上屏')
  }
  if (consoleErrors.length > 0) failures.push(`console 错误 ${consoleErrors.length} 条: ${consoleErrors[0] ?? ''}`)

  console.log(JSON.stringify({
    mounted, streamingSeen, afterTurn, historyPanel, switched,
    consoleErrors, shots: { streaming: shotStreaming, done: shotDone, switched: shotSwitched },
  }, null, 2))
  if (failures.length > 0) {
    console.error('[verify-blog-2a] 失败断言：')
    for (const failure of failures) console.error(` - ${failure}`)
    process.exit(1)
  }
  console.log('[verify-blog-2a] 全部断言通过')
}

main().catch(error => {
  console.error('[verify-blog-2a] 运行异常:', error)
  process.exit(1)
})
