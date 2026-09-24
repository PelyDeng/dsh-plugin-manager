/**
 * 批 1b（closedoff Cesium 双实例飞地与重交互面）浏览器真实验证（Edge CDP 9223，
 * verify-closedoff-1a.mjs 同形态；方案 §5 批 1 DoD 的浏览器段——地图/轨迹/视频
 * 三处真实点击 + 「弹窗反复开关后 console 无 Cesium 泄漏告警」）。
 *
 * 断言面：
 * 1. restore 轨迹快照飞地：conv-mock-1 复原后轨迹与围栏各生成静态三维截图
 *    （真实 Cesium 渲染 → canvas.toDataURL → img），#co-track-<callId> 挂载点在场；
 * 2. 三维弹窗反复开关 5 次：开→viewer 就绪（mapReady）→真实 CDP 点击关闭→容器
 *    全清（无 canvas 残留）；5 轮全程 console 无 Cesium/WebGL 泄漏类告警；
 * 3. 摄像头弹窗：快照图例真实点击打开 → 搜索过滤 → 同组切换 → 详情字段；
 * 4. 抓拍视频（capture 形态）：「查看抓拍视频」真实点击 → 播放器飞地挂载
 *    （@hy-media Vue app 的 host DOM 在场）；
 * 5. 会话面板：置顶切换、多选批量、Markdown 导出（真实点击 + 内容断言）；
 * 6. console 零错误（播放器对 mock 无流地址的连接失败若出现，按域名分类登记，
 *    不计入页面自身错误）；截图四份。
 *
 * 前置：npm run build（agents/closedoff）+ npm run build:web 落位 web/assets 三方
 * 资产 + mock 8791（tests/mock/page-server.mjs）+ Edge --remote-debugging-port=9223。
 * 用法：node tests/mock/verify-closedoff-1b.mjs
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
const consoleWarnings = []

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
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = message.params?.args?.map(arg => arg.value ?? arg.description ?? '').join(' ')
      if (message.params?.type === 'error') consoleErrors.push(text)
      if (message.params?.type === 'warning') consoleWarnings.push(text)
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
  // 重置 mock 会话状态（conversationStore 常驻进程，跨 verify 运行残留会污染
  // 置顶/多选断言的初始态）。
  await fetch(`${MOCK}/closedoff-qa/__mock/reset`, { method: 'POST' })
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

  /** 真实点击（CDP 鼠标事件坐标，非 evaluate 的 element.click()）；先滚动到视口内。 */
  const clickAt = async selector => {
    const coords = await evaluate(`(() => {
      const node = ${selector}
      if (!node) return null
      node.scrollIntoView({ block: 'center', behavior: 'instant' })
      const rect = node.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    if (coords === null || coords.__exception !== undefined) throw new Error(`未找到点击目标: ${selector}`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
  }

  const byText = (rootSelector, text) =>
    `[...document.querySelectorAll('${rootSelector}')].find(node => node.textContent?.includes('${text}'))`

  const waitUntil = async (expression, { timeout = 20000, interval = 300 } = {}) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await evaluate(expression)
      if (value === true) return
      if (Date.now() > deadline) throw new Error(`等待超时: ${expression}`)
      await new Promise(done => setTimeout(done, interval))
    }
  }

  // ── 1. restore 轨迹快照（真实 Cesium 渲染）─────────────────────────────
  await evaluate(`[...document.querySelectorAll('.co-header-btn')].find(node => node.textContent?.includes('历史对话'))?.click()`)
  await new Promise(done => setTimeout(done, 300))
  await evaluate(`[...document.querySelectorAll('.co-history-title')].find(node => node.textContent?.includes('演示会话'))?.click()`)
  // 首次快照：loadCesium（拉脚本+Workers）+ 底图 + flyTo，给足窗口。
  await waitUntil(`document.querySelector('#co-track-call-track .co-track-snapshot')?.src?.startsWith('data:image/jpeg') === true`, { timeout: 45000 })
  await waitUntil(`document.querySelector('#co-track-call-fence .co-track-snapshot')?.src?.startsWith('data:image/jpeg') === true`, { timeout: 45000 })
  const snapshotState = await evaluate(`(() => ({
    trackImg: document.querySelector('#co-track-call-track .co-track-snapshot') !== null,
    trackNaturalWidth: document.querySelector('#co-track-call-track .co-track-snapshot')?.naturalWidth ?? 0,
    fenceImg: document.querySelector('#co-track-call-fence .co-track-snapshot') !== null,
    legendNorth: [...document.querySelectorAll('#co-track-call-track .co-lg-name')].some(node => node.textContent?.includes('北门设备组')),
    legendGroupCount: document.querySelectorAll('#co-track-call-track .co-lg-item').length,
    mediaButton: document.querySelector('#co-media-call-media .co-media-play') !== null,
  }))()`)
  console.log('[1] restore 快照飞地:', JSON.stringify(snapshotState))
  await shot('closedoff-1b-restore-snapshots.png')
  // 收起历史面板（fixed 侧栏会挡住消息流按钮的真实坐标点击）；打开会话后面板
  // 通常已自动收起，这里做条件兜底。
  await evaluate(`(() => {
    if (document.querySelector('.co-history-head .co-icon-button') !== null) {
      [...document.querySelectorAll('.co-history-head .co-icon-button')].at(-1)?.click()
    }
    return document.querySelector('.co-history') === null
  })()`)
  await waitUntil(`document.querySelector('.co-history') === null`)

  // ── 2. 三维弹窗反复开关 5 次（泄漏断言）─────────────────────────────────
  // 注意：围栏快照在 DOM 中先于轨迹快照，「全屏查看」按钮必须锁定轨迹域内的。
  const trackFullscreenButton = `document.querySelector('#co-track-call-track .co-map-3d-btn')`
  const toggle3d = async round => {
    await clickAt(trackFullscreenButton)
    // 开：等交互 viewer 就绪（引擎 mapReady 由挂载链置位）。
    await waitUntil(`(() => {
      const map = document.querySelector('.co-modal-map')
      return map !== null && map.dataset.mapReady === 'true' && map.querySelector('canvas') !== null
    })()`, { timeout: 45000 })
    const opened = await evaluate(`(() => {
      const map = document.querySelector('.co-modal-map')
      return {
        overlay: document.querySelector('.co-modal-overlay') !== null,
        mapReady: map?.dataset.mapReady,
        engine: map?.dataset.mapEngine ?? null,
        canvas: map?.querySelector('canvas') !== null,
        captureEnabled: document.querySelector('.co-capture-btn')?.disabled === false,
        legendNorth: [...(document.querySelectorAll('.co-modal-legend .co-lg-name') ?? [])].some(node => node.textContent?.includes('北门设备组')),
      }
    })()`)
    await shot(`closedoff-1b-modal3d-open-round${round}.png`)
    // 关：真实点击关闭按钮。
    await clickAt(`document.querySelector('.co-modal-close')`)
    await waitUntil(`document.querySelector('.co-modal-overlay') === null`)
    const closed = await evaluate(`(() => ({
      overlayGone: document.querySelector('.co-modal-overlay') === null,
      canvasLeft: document.querySelectorAll('.co-modal-map canvas').length,
      viewerSlot: (document.querySelector('.co-modal-map') ?? {})._coEnclaveSlots === undefined,
    }))()`)
    return { opened, closed }
  }
  const rounds = []
  for (let round = 1; round <= 5; round++) rounds.push(await toggle3d(round))
  console.log('[2] 三维弹窗 5 轮开关: 末轮 =', JSON.stringify(rounds.at(-1)))
  const leaks = consoleErrors.concat(consoleWarnings).filter(text =>
    /WebGL|webgl|context lost|Too many.*context|Cesium.*leak|Out of memory/i.test(text ?? ''))

  // ── 3. 摄像头弹窗（搜索/切换/详情）───────────────────────────────────────
  await clickAt(byText('#co-track-call-track .co-lg-item', '北门设备组'))
  await waitUntil(`document.querySelector('.co-camera-overlay') !== null`)
  await new Promise(done => setTimeout(done, 300))
  const cameraState1 = await evaluate(`(() => ({
    title: document.querySelector('.co-camera-overlay .co-modal-title')?.textContent ?? '',
    listItems: document.querySelectorAll('.co-camera-list-item').length,
    stripThumbs: document.querySelectorAll('.co-camera-thumb').length,
    statsText: document.querySelector('.co-camera-stats')?.textContent ?? '',
    selectedName: document.querySelector('.co-camera-selected-name')?.textContent ?? '',
    selectedOnline: document.querySelector('.co-camera-online')?.textContent ?? '',
    infoRows: document.querySelectorAll('.co-camera-info-row').length,
    gateExcluded: [...document.querySelectorAll('.co-camera-list-item .co-camera-item-name')].every(node => !node.textContent?.includes('门禁')),
  }))()`)
  // 搜索过滤。
  await evaluate(`(() => {
    const search = document.querySelector('.co-camera-search')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(search, '北门-02')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await new Promise(done => setTimeout(done, 200))
  const filtered = await evaluate(`document.querySelectorAll('.co-camera-list-item').length`)
  // 同组条带切换回 01。
  await clickAt(byText('.co-camera-thumb', '北门-01'))
  await new Promise(done => setTimeout(done, 200))
  const cameraState2 = await evaluate(`(() => ({
    filtered: ${filtered},
    selectedAfterSwitch: document.querySelector('.co-camera-selected-name')?.textContent ?? '',
    onlineMark: document.querySelector('.co-camera-online')?.textContent ?? '',
  }))()`)
  console.log('[3] 摄像头弹窗:', JSON.stringify({ ...cameraState1, ...cameraState2 }))
  await shot('closedoff-1b-camera-modal.png')
  // 关摄像头弹窗（Esc 只关本层：三维弹窗未开，等价单层关闭）。
  await clickAt(`document.querySelector('.co-camera-overlay .co-modal-close')`)
  await waitUntil(`document.querySelector('.co-camera-overlay') === null`)

  // ── 4. 三维弹窗设备组条带 → 摄像头弹窗（弹窗叠开）──────────────────────
  await clickAt(trackFullscreenButton)
  await waitUntil(`document.querySelector('.co-modal-map')?.dataset.mapReady === 'true'`, { timeout: 45000 })
  await clickAt(byText('.co-modal-legend .co-lg-item', '北门设备组'))
  await waitUntil(`document.querySelector('.co-camera-overlay') !== null`)
  const stacked = await evaluate(`(() => ({
    modal3dStill: document.querySelector('.co-modal-overlay') !== null,
    cameraOnTop: document.querySelector('.co-camera-overlay') !== null,
    cameraTitle: document.querySelector('.co-camera-overlay .co-modal-title')?.textContent ?? '',
  }))()`)
  console.log('[4] 弹窗叠开:', JSON.stringify(stacked))
  await shot('closedoff-1b-stacked-modals.png')
  // Esc 只关摄像头层。
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await new Promise(done => setTimeout(done, 300))
  const afterEsc = await evaluate(`({
    cameraGone: document.querySelector('.co-camera-overlay') === null,
    modal3dKept: document.querySelector('.co-modal-overlay') !== null,
  })`)
  await clickAt(`document.querySelector('.co-modal-close')`)
  await waitUntil(`document.querySelector('.co-modal-overlay') === null`)
  console.log('[4] Esc 分层关闭:', JSON.stringify(afterEsc))

  // ── 5. 抓拍视频（capture 弹窗 + 播放器飞地挂载）────────────────────────
  await clickAt(byText('.co-media-play', '查看抓拍视频'))
  await waitUntil(`document.querySelector('.co-camera-overlay--capture') !== null`)
  // 播放器三件脚本按需加载 + Vue mount；失败态也有预览容器，按 host 挂载物断言。
  let playerState = null
  for (let i = 0; i < 30; i++) {
    await new Promise(done => setTimeout(done, 400))
    playerState = await evaluate(`(() => ({
      captureTitle: document.querySelector('.co-camera-overlay--capture .co-modal-title')?.textContent ?? '',
      hostMounted: document.querySelector('.co-camera-player-host') !== null,
      playerDom: (document.querySelector('.co-camera-player-host')?.children.length ?? 0) > 0,
      infoRows: document.querySelectorAll('.co-camera-overlay--capture .co-camera-info-row').length,
      hiddenAddress: [...document.querySelectorAll('.co-camera-overlay--capture .co-camera-info-row')].some(row => row.textContent?.includes('已隐藏')),
      sidebarGone: document.querySelector('.co-camera-overlay--capture .co-camera-sidebar') === null,
    }))()`)
    if (playerState.playerDom || playerState.infoRows > 0 && (playerState.hostMounted === false)) break
  }
  console.log('[5] 抓拍视频弹窗:', JSON.stringify(playerState))
  await shot('closedoff-1b-capture-player.png')
  await clickAt(`document.querySelector('.co-camera-overlay--capture .co-modal-close')`)
  await waitUntil(`document.querySelector('.co-camera-overlay--capture') === null`)

  // ── 6. 会话面板：置顶切换 / 多选批量 / Markdown 导出 ────────────────────
  await evaluate(`[...document.querySelectorAll('.co-header-btn')].find(node => node.textContent?.includes('历史对话'))?.click()`)
  await new Promise(done => setTimeout(done, 300))
  // 置顶切换：对「冒烟新会话」行开菜单 → 置顶。
  const smokeId = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.co-history-row')].find(node => node.textContent?.includes('冒烟新会话'))
    return row !== undefined ? row.dataset.conversation : null
  })()`)
  await clickAt(`[...document.querySelectorAll('.co-history-row[data-conversation="${smokeId}"] .co-icon-button')].at(-1)`)
  await waitUntil(`document.querySelector('.co-history-menu') !== null`)
  await clickAt(`[...document.querySelectorAll('.co-history-menu-item')].find(node => (node.textContent ?? '').trim() === '置顶')`)
  await new Promise(done => setTimeout(done, 800))
  const pinState = await evaluate(`(() => {
    const pinnedGroup = [...document.querySelectorAll('.co-history-group')].find(node => node.textContent === '置顶')
    // 分组结构：<div><h3>置顶</h3>…行…</div>，组容器 = h3 的父元素。
    const groupBody = pinnedGroup !== undefined ? pinnedGroup.parentElement : null
    return {
      pinnedGroupExists: pinnedGroup !== undefined,
      smokeInPinned: groupBody !== null && (groupBody.textContent ?? '').includes('冒烟新会话'),
      demoStillFirst: groupBody !== null && (groupBody.textContent ?? '').includes('演示会话'),
    }
  })()`)
  console.log('[6.1] 置顶切换:', JSON.stringify(pinState))

  // 多选：冒烟行的菜单进多选（默认勾选该行）→ 再勾选第一行 → 批量删除确认弹窗
  // → 取消（不真删演示会话）。
  await clickAt(`[...document.querySelectorAll('.co-history-row[data-conversation="${smokeId}"] .co-icon-button')].at(-1)`)
  await waitUntil(`document.querySelector('.co-history-menu') !== null`)
  await clickAt(`[...document.querySelectorAll('.co-history-menu-item')].find(node => (node.textContent ?? '').trim() === '多选')`)
  await waitUntil(`document.querySelector('.co-history-batch') !== null`)
  await clickAt(`document.querySelector('.co-history-check')`)
  await new Promise(done => setTimeout(done, 200))
  const batchCount = await evaluate(`Number(document.querySelector('.co-history-batch span')?.textContent?.replace(/[^0-9]/g, '') ?? 0)`)

  // 批量删除确认弹窗 → 取消（不真删演示会话）。
  await clickAt(`[...document.querySelectorAll('.co-history-batch button')].find(node => node.textContent === '删除')`)
  await waitUntil(`[...document.querySelectorAll('.co-history-dialog-title')].some(node => node.textContent?.includes('删除'))`)
  const confirmText = await evaluate(`document.querySelector('.co-history-dialog-title')?.textContent ?? ''`)
  await clickAt(`[...document.querySelectorAll('.co-history-dialog-actions .co-history-action')].find(node => node.textContent === '取消')`)
  await new Promise(done => setTimeout(done, 200))
  // 导出：取消多选后对演示会话导出。
  await clickAt(`[...document.querySelectorAll('.co-history-batch button')].find(node => node.textContent === '取消')`)
  await new Promise(done => setTimeout(done, 200))
  await clickAt(`[...document.querySelectorAll('.co-history-row .co-icon-button')].find(node => node.getAttribute('aria-haspopup') === 'menu')`)
  await waitUntil(`document.querySelector('.co-history-menu') !== null`)
  await clickAt(byText('.co-history-menu-item', '分享导出'))
  await waitUntil(`document.querySelector('.co-history-export-preview') !== null && document.querySelector('.co-history-export-preview').value.includes('## 助手')`, { timeout: 8000 })
  const exportState = await evaluate(`(() => ({
    heading: document.querySelector('.co-history-dialog-title')?.textContent ?? '',
    hasTitle: document.querySelector('.co-history-export-preview').value.startsWith('# 园区预约与轨迹演示会话'),
    hasUser: document.querySelector('.co-history-export-preview').value.includes('## 我'),
    hasAssistant: document.querySelector('.co-history-export-preview').value.includes('## 助手'),
    copyEnabled: [...document.querySelectorAll('.co-history-dialog-actions button')].find(node => node.textContent === '复制 Markdown')?.disabled === false,
  }))()`)
  console.log('[6.2] 删除确认与导出:', JSON.stringify({ confirmText, ...exportState }))
  await shot('closedoff-1b-history-export.png')
  await clickAt(`[...document.querySelectorAll('.co-history-dialog-actions button')].find(node => node.textContent === '关闭')`)

  // ── 7. 断言汇总 ────────────────────────────────────────────────────────
  const failures = []
  if (!snapshotState.trackImg || snapshotState.trackNaturalWidth === 0) failures.push('轨迹快照未生成（真实 Cesium 渲染）')
  if (!snapshotState.fenceImg) failures.push('围栏快照未生成')
  if (snapshotState.legendGroupCount < 1 || !snapshotState.legendNorth) failures.push('轨迹图例设备组缺失')
  if (!snapshotState.mediaButton) failures.push('媒体播放按钮缺失')
  for (const [index, round] of rounds.entries()) {
    if (round.opened.mapReady !== 'true' || round.opened.canvas !== true) failures.push(`第 ${index + 1} 轮弹窗 viewer 未就绪`)
    if (round.opened.captureEnabled !== true) failures.push(`第 ${index + 1} 轮截图按钮未解锁`)
    if (round.closed.canvasLeft !== 0) failures.push(`第 ${index + 1} 轮关闭后 canvas 残留`)
  }
  if (leaks.length > 0) failures.push(`Cesium/WebGL 泄漏类告警 ${leaks.length} 条: ${leaks[0]}`)
  if (cameraState1.listItems !== 2) failures.push('摄像头列表应为 2 路（deviceType=6 过滤）')
  if (cameraState1.gateExcluded !== true) failures.push('门禁设备未被 deviceType 过滤')
  if (cameraState1.statsText === '') failures.push('摄像头统计行缺失')
  if (!cameraState1.selectedName.includes('北门-01')) failures.push('默认选中首路摄像头失败')
  if (cameraState1.infoRows < 5) failures.push('摄像头详情信息行缺失')
  if (cameraState2.filtered !== 1) failures.push('搜索过滤未生效')
  if (!cameraState2.selectedAfterSwitch.includes('北门-01')) failures.push('同组条带切换失败')
  if (stacked.modal3dStill !== true || stacked.cameraOnTop !== true) failures.push('三维弹窗上叠开摄像头弹窗失败')
  if (!stacked.cameraTitle.includes('北门设备组')) failures.push('叠开弹窗标题异常')
  if (afterEsc.cameraGone !== true || afterEsc.modal3dKept !== true) failures.push('Esc 未分层关闭')
  if (playerState === null || playerState.captureTitle !== '车辆抓拍视频') failures.push('抓拍视频弹窗标题异常')
  if (playerState.hostMounted !== true) failures.push('播放器 host 未挂载')
  if (playerState.playerDom !== true) failures.push('播放器 DOM（Vue app）未挂载')
  if (playerState.hiddenAddress !== true) failures.push('抓拍详情「已隐藏」缺失')
  if (playerState.sidebarGone !== true) failures.push('capture 形态未隐藏侧栏')
  if (pinState.smokeInPinned !== true) failures.push('置顶切换未生效')
  if (!confirmText.includes('删除')) failures.push('批量删除确认弹窗未出现')
  if (exportState.hasTitle !== true || exportState.hasUser !== true || exportState.hasAssistant !== true) failures.push('Markdown 导出内容不完整')
  if (exportState.copyEnabled !== true) failures.push('导出复制按钮未解锁')
  if (consoleErrors.length > 0) failures.push(`console 错误 ${consoleErrors.length} 条: ${consoleErrors[0] ?? ''}`)

  console.log(JSON.stringify({ snapshotState, roundsLast: rounds.at(-1), leaks, consoleWarnings: consoleWarnings.slice(0, 5) }, null, 2))
  if (failures.length > 0) {
    console.error('[verify-closedoff-1b] 失败断言：')
    for (const failure of failures) console.error(` - ${failure}`)
    process.exit(1)
  }
  console.log('[verify-closedoff-1b] 全部断言通过')
  ws.close()
}

main().catch(error => {
  console.error('[verify-closedoff-1b] 运行异常:', error)
  process.exit(1)
})
