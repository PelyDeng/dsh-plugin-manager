/**
 * 批 2b（blog 剩余功能面）浏览器真实验证（Edge CDP 9223，verify-blog-2a.mjs 同形态）。
 *
 * 断言面：
 * 1. 操作卡确认/取消：prepared 发布卡在场 → 确认发布 → 状态落定「已发布」+ 外链；
 * 2. 评价与分支：点赞 aria-pressed；更多菜单 → 评价备注弹窗保存；分支开新会话；
 * 3. thinking 翻译：英文推理 →「中文译文」徽章与译文面板（含原文折叠）；
 * 4. 文件预览：附件「查看」→ 资料内容弹窗（解析单元 + 范围 + 下载）；
 * 5. 渲染器三能力：外链 a.md-link / 代码块复制按钮 / 表格横滚容器；
 * 6. 文章视图：列表 → 编辑器（标题/正文/预览）→ 发布确认链路（对照+提交+成功）；
 * 7. 候选稿对照：chat 结果卡「打开文章」→ 对照视图 + 修改对比（红绿行）；
 * 8. 管理弹窗：分类表/面包屑/标签云/评论分页/编辑 → 预览修改 → 确认执行；
 * 9. console 零错误；截图按段落落盘。
 *
 * 用法：node tests/mock/verify-blog-2b.mjs
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
  await new Promise(done => setTimeout(done, 1500))

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
    if (coords === null || coords.__exception !== undefined) throw new Error('点击目标未找到')
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 })
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

  // mock 状态重置后重新进入（conv-mock-1 自带完整历史）。
  await evaluate(`fetch('/blog/__mock/reset', { method: 'POST' }).then(() => 'ok')`)
  await send('Page.navigate', { url: `${MOCK}/blog?conversationId=conv-mock-1` })
  // 面板就绪以历史消息上屏为准（冷启动时序抖动兜底）。
  await waitUntil(`document.querySelectorAll('.blg-message').length > 0`, { timeout: 12000 })
  await new Promise(done => setTimeout(done, 600))

  // ── 1. 操作卡（prepared 发布卡）确认 ────────────────────────────────────
  const opCard = await evaluate(`(() => ({
    card: document.querySelector('.blg-operation') !== null,
    title: document.querySelector('.blg-operation h3')?.textContent ?? '',
    status: document.querySelector('.blg-operation-status')?.textContent ?? '',
    confirm: [...document.querySelectorAll('.blg-operation-actions .btn--primary')].some(node => node.textContent === '确认发布'),
    cancel: [...document.querySelectorAll('.blg-operation-actions .btn')].some(node => node.textContent === '取消'),
  }))()`)
  console.log('[1] 操作卡:', JSON.stringify(opCard))
  if (opCard.confirm !== true) failures.push('操作卡确认发布按钮缺失')

  await clickAt(`[...document.querySelectorAll('.blg-operation-actions .btn--primary')].find(node => node.textContent === '确认发布')`)
  const confirmed = await waitUntil(`(() => {
    const status = document.querySelector('.blg-operation-status')?.textContent ?? ''
    const link = [...document.querySelectorAll('.blg-operation a')].some(node => node.textContent.includes('查看博客文章'))
    return status.includes('已发布') && link
  })()`)
  const opAfter = await evaluate(`(() => ({
    status: document.querySelector('.blg-operation-status')?.textContent ?? '',
    link: document.querySelector('.blg-operation a[href*="blog.example.invalid"]')?.textContent ?? null,
  }))()`)
  console.log('[1] 确认后:', JSON.stringify({ confirmed, ...opAfter }))
  if (!confirmed) failures.push('操作卡确认后未落定「已发布」+ 外链')
  await shot('blog-2b-operation-confirmed.png')

  // ── 2. 评价：点赞 aria-pressed → 更多菜单 → 评价备注 ───────────────────
  const likeBefore = await evaluate(`document.querySelector('.blg-action[aria-label="有帮助"]')?.getAttribute('aria-pressed') ?? null`)
  await clickAt(`document.querySelector('.blg-action[aria-label="有帮助"]')`)
  await new Promise(done => setTimeout(done, 500))
  const likeAfter = await evaluate(`document.querySelector('.blg-action[aria-label="有帮助"]')?.getAttribute('aria-pressed') ?? null`)
  console.log('[2] 点赞:', JSON.stringify({ likeBefore, likeAfter }))
  if (likeBefore !== 'false' || likeAfter !== 'true') failures.push(`点赞状态未切换（${likeBefore}→${likeAfter}）`)

  await clickAt(`document.querySelector('.blg-more summary')`)
  await new Promise(done => setTimeout(done, 300))
  const menuSeen = await evaluate(`(() => ({ open: document.querySelector('.blg-more[open]') !== null, items: [...document.querySelectorAll('.blg-more-menu button')].map(node => node.textContent) }))()`)
  console.log('[2] 更多菜单:', JSON.stringify(menuSeen))
  if (!(menuSeen.items ?? []).includes('评价备注')) failures.push('更多菜单缺「评价备注」')
  if (!(menuSeen.items ?? []).includes('重新生成')) failures.push('更多菜单缺「重新生成」')

  await clickAt(`[...document.querySelectorAll('.blg-more-menu button')].find(node => node.textContent === '评价备注')`)
  await new Promise(done => setTimeout(done, 300))
  const feedbackDialog = await evaluate(`(() => ({
    open: document.querySelector('dialog[aria-label="评价这条回答"][open]') !== null,
    rating: document.querySelector('dialog[aria-label="评价这条回答"] select')?.value ?? '',
  }))()`)
  await clickAt(`[...document.querySelectorAll('dialog[aria-label="评价这条回答"] button')].find(node => node.textContent === '保存评价')`)
  const feedbackClosed = await waitUntil(`document.querySelector('dialog[aria-label="评价这条回答"][open]') === null`)
  console.log('[2] 评价弹窗:', JSON.stringify({ ...feedbackDialog, feedbackClosed }))
  if (feedbackDialog.open !== true || feedbackDialog.rating !== 'positive') failures.push('评价弹窗未按既有评价回填')
  if (!feedbackClosed) failures.push('评价保存后弹窗未关闭')
  await shot('blog-2b-feedback.png')

  // ── 3. thinking 翻译（英文推理 → 中文译文面板）─────────────────────────
  const translated = await waitUntil(`(() => {
    const badge = document.querySelector('.blg-translation-badge')
    const body = document.querySelector('.blg-thinking-body')?.textContent ?? ''
    return badge !== null && body.includes('中文译文')
  })()`, { timeout: 10000 })
  const translation = await evaluate(`(() => ({
    badge: document.querySelector('.blg-translation-badge')?.textContent ?? null,
    body: document.querySelector('.blg-thinking-body')?.textContent.slice(0, 30) ?? '',
    original: document.querySelector('.blg-thinking-original summary')?.textContent ?? null,
    note: document.querySelector('.blg-translation-note')?.textContent.slice(0, 20) ?? '',
  }))()`)
  console.log('[3] 译文:', JSON.stringify({ translated, ...translation }))
  if (!translated) failures.push('推理译文未出现（徽章+译文正文）')
  if (translation.original !== '查看模型原文') failures.push('译文面板缺「查看模型原文」折叠')

  // ── 4. 渲染器三能力（外链/代码复制/表格横滚）───────────────────────────
  const rich = await evaluate(`(() => {
    const answer = document.querySelector('.blg-bubble .blg-answer')
    return {
      codeBlock: answer?.querySelector('.code-block') !== null,
      copyButton: answer?.querySelector('.copy-code')?.textContent ?? null,
      tableScroll: answer?.querySelector('.table-scroll[role="region"]') !== null,
      linkCount: answer?.querySelectorAll('a.md-link').length ?? 0,
    }
  })()`)
  console.log('[4] 渲染器:', JSON.stringify(rich))
  if (rich.codeBlock !== true || rich.copyButton !== '复制代码') failures.push('代码块复制工具栏缺失')
  if (rich.tableScroll !== true) failures.push('表格横滚容器缺失')

  // ── 5. 文件预览（附件「查看」）─────────────────────────────────────────
  await clickAt(`[...document.querySelectorAll('.blg-files .btn--tiny')].find(node => node.textContent === '查看')`)
  await new Promise(done => setTimeout(done, 500))
  const preview = await evaluate(`(() => ({
    open: document.querySelector('dialog[aria-label="资料内容"][open]') !== null,
    text: document.querySelector('.blg-file-text')?.textContent.slice(0, 30) ?? '',
    range: document.querySelector('.blg-file-range') !== null,
    download: document.querySelector('.blg-file-download') !== null,
  }))()`)
  console.log('[5] 文件预览:', JSON.stringify(preview))
  if (preview.open !== true || !preview.text.includes('周一')) failures.push('资料内容弹窗未呈现解析单元')
  if (preview.range !== true || preview.download !== true) failures.push('资料内容弹窗缺范围选定/下载')
  await shot('blog-2b-file-preview.png')
  await clickAt(`document.querySelector('dialog[aria-label="资料内容"] .blg-dialog-close')`)
  await new Promise(done => setTimeout(done, 300))

  // ── 6. 候选稿对照：结果卡「打开文章」→ 对照视图 + 修改对比 ─────────────
  await clickAt(`[...document.querySelectorAll('.blg-result-head .btn--tiny')].find(node => node.textContent === '打开文章')`)
  await new Promise(done => setTimeout(done, 800))
  const review = await evaluate(`(() => ({
    view: document.querySelector('.blg-review') !== null,
    badge: document.querySelector('.blg-review-badge')?.textContent ?? '',
    title: document.querySelector('.blg-review-heading h1')?.textContent ?? '',
    articleTab: [...document.querySelectorAll('.blg-review .blg-tabs button')].some(node => node.textContent === '修改后全文'),
    diffTab: [...document.querySelectorAll('.blg-review .blg-tabs button')].some(node => node.textContent === '修改对比'),
    publishEnabled: [...document.querySelectorAll('.blg-review-actions .btn--primary')].some(node => node.textContent === '预览并发布' && !node.disabled),
  }))()`)
  console.log('[6] 候选稿对照:', JSON.stringify(review))
  if (review.view !== true) failures.push('候选稿对照视图未打开')
  if (review.badge !== '本次修改 · 尚未发布') failures.push('对照徽标文案不符：' + review.badge)
  if (review.publishEnabled !== true) failures.push('当前稿的「预览并发布」应可用')
  await clickAt(`[...document.querySelectorAll('.blg-review .blg-tabs button')].find(node => node.textContent === '修改对比')`)
  await new Promise(done => setTimeout(done, 300))
  const diffView = await evaluate(`(() => ({
    added: document.querySelectorAll('.blg-review-diff--added').length,
    removed: document.querySelectorAll('.blg-review-diff--removed').length,
    summary: [...document.querySelectorAll('.blg-review-changes p')].some(node => node.textContent.includes('绿色为新增')),
  }))()`)
  console.log('[6] 修改对比:', JSON.stringify(diffView))
  if (diffView.added < 1 || diffView.removed < 1 || !diffView.summary) failures.push('修改对比缺红绿行或图例')
  await shot('blog-2b-review-diff.png')
  // 返回编辑稿（旧 review-back → showCandidate(null)）。
  await clickAt(`[...document.querySelectorAll('.blg-review-actions .btn')].find(node => node.textContent === '返回编辑稿')`)
  await new Promise(done => setTimeout(done, 400))

  // ── 7. 编辑器：标题/正文/预览 → 发布确认链路 ───────────────────────────
  const editor = await evaluate(`(() => ({
    open: document.querySelector('#blg-editor') !== null,
    title: document.querySelector('.blg-title-input')?.value ?? '',
    textarea: document.querySelector('.blg-document textarea')?.value.slice(0, 20) ?? '',
    previewHtml: document.querySelector('.blg-prose h1, .blg-prose h2') !== null,
    saveState: document.querySelector('.blg-editor-top span[role=status]')?.textContent ?? '',
  }))()`)
  console.log('[7] 编辑器:', JSON.stringify(editor))
  if (editor.open !== true) failures.push('编辑器未打开（返回编辑稿失败）')
  if (editor.title === '' || editor.textarea === '') failures.push('编辑器标题/正文未回填')

  await clickAt(`[...document.querySelectorAll('.blg-editor-footer .btn--primary')].find(node => node.textContent === '预览并发布')`)
  await new Promise(done => setTimeout(done, 800))
  const publishDialog = await evaluate(`(() => ({
    open: [...document.querySelectorAll('dialog[open] h2')].some(node => node.textContent.includes('确认')),
    heading: [...document.querySelectorAll('dialog[open] h2')].map(node => node.textContent).join('|'),
    compare: [...document.querySelectorAll('dialog[open] h3')].some(node => node.textContent === '发布前版本'),
    confirm: [...document.querySelectorAll('dialog[open] button')].some(node => node.textContent === '确认提交'),
  }))()`)
  console.log('[7] 发布确认:', JSON.stringify(publishDialog))
  if (publishDialog.open !== true || !publishDialog.compare || !publishDialog.confirm) failures.push('发布确认弹窗（版本对照+确认提交）缺失')
  await shot('blog-2b-publish-confirm.png')
  await clickAt(`[...document.querySelectorAll('dialog[open] button')].find(node => node.textContent === '确认提交')`)
  const publishDone = await waitUntil(`(() => {
    const status = [...document.querySelectorAll('.blg-publish-status')].some(node => node.textContent.includes('发布成功'))
    const link = [...document.querySelectorAll('dialog[open] a')].some(node => node.textContent.includes('查看博客文章'))
    return status && link
  })()`)
  console.log('[7] 发布结果:', JSON.stringify({ publishDone }))
  if (!publishDone) failures.push('发布确认后未出现成功状态与外链')
  await clickAt(`[...document.querySelectorAll('dialog[open] button')].find(node => node.textContent === '完成')`)
  await new Promise(done => setTimeout(done, 300))

  // ── 8. 管理弹窗：分类 → 标签 → 评论 → 编辑确认 ─────────────────────────
  await clickAt(`document.querySelector('.blg-view-nav button[aria-haspopup="dialog"]')`)
  await new Promise(done => setTimeout(done, 600))
  const manage = await evaluate(`(() => ({
    open: document.querySelector('.blg-management-dialog[open]') !== null,
    rows: document.querySelectorAll('.blg-management-table tbody tr').length,
    crumbs: [...document.querySelectorAll('.blg-management-crumbs button')].map(node => node.textContent),
  }))()`)
  console.log('[8] 管理弹窗:', JSON.stringify(manage))
  if (manage.open !== true || manage.rows < 2) failures.push('管理弹窗分类表格缺失或行数不足')
  if (!(manage.crumbs ?? []).includes('全部分类')) failures.push('分类面包屑缺失')

  // 进入子分类（前端行）。
  await clickAt(`[...document.querySelectorAll('.blg-management-category-name')].find(node => node.textContent === '技术')`)
  await new Promise(done => setTimeout(done, 400))
  const subCategory = await evaluate(`(() => ({
    crumb: [...document.querySelectorAll('.blg-management-crumbs button')].map(node => node.textContent).join('>'),
    rows: document.querySelectorAll('.blg-management-table tbody tr').length,
  }))()`)
  console.log('[8] 子分类:', JSON.stringify(subCategory))
  if (!subCategory.crumb.includes('技术')) failures.push('面包屑未进入子分类')

  // 标签页签：标签云。
  await clickAt(`[...document.querySelectorAll('.blg-management-tabs button')].find(node => node.textContent === '管理标签')`)
  await new Promise(done => setTimeout(done, 500))
  const tags = await evaluate(`document.querySelectorAll('.blg-management-tag').length`)
  console.log('[8] 标签云:', tags)
  if (tags < 2) failures.push('标签云缺失')

  // 评论页签：分页行 + 编辑。
  await clickAt(`[...document.querySelectorAll('.blg-management-tabs button')].find(node => node.textContent === '管理评论')`)
  await new Promise(done => setTimeout(done, 500))
  const comments = await evaluate(`(() => ({ rows: document.querySelectorAll('.blg-management-row').length, pager: document.querySelector('.blg-management-pager') !== null }))()`)
  console.log('[8] 评论:', JSON.stringify(comments))
  if (comments.rows < 2 || !comments.pager) failures.push('评论列表/分页缺失')

  // 分类编辑 → 预览修改 → 确认执行（回到分类域，编辑「技术」）。
  await clickAt(`[...document.querySelectorAll('.blg-management-tabs button')].find(node => node.textContent === '管理分类')`)
  await new Promise(done => setTimeout(done, 500))
  await clickAt(`[...document.querySelectorAll('.blg-management-table .blg-management-link')].find(node => node.getAttribute('aria-label')?.startsWith('编辑分类'))`)
  await new Promise(done => setTimeout(done, 500))
  const editorForm = await evaluate(`(() => ({
    form: document.querySelector('.blg-management-editor form') !== null,
    eyebrow: document.querySelector('.blg-management-eyebrow')?.textContent ?? '',
    name: document.querySelector('.blg-management-editor input')?.value ?? '',
  }))()`)
  console.log('[8] 编辑表单:', JSON.stringify(editorForm))
  if (editorForm.form !== true || editorForm.name !== '技术') failures.push('分类编辑表单未回填')
  await clickAt(`[...document.querySelectorAll('.blg-management-editor button')].find(node => node.textContent.includes('预览修改'))`)
  await new Promise(done => setTimeout(done, 500))
  const confirmDialog = await evaluate(`(() => ({
    open: document.querySelector('dialog[aria-label="确认博客管理操作"][open]') !== null,
    summary: document.querySelector('.blg-operation-summary')?.textContent.split('\\n').slice(0, 2).join('|') ?? '',
  }))()`)
  console.log('[8] 管理确认:', JSON.stringify(confirmDialog))
  if (confirmDialog.open !== true) failures.push('管理确认弹窗未打开')
  if (!confirmDialog.summary.includes('修改分类')) failures.push('管理确认摘要文案不符')
  await shot('blog-2b-manage-confirm.png')
  await clickAt(`[...document.querySelectorAll('dialog[aria-label="确认博客管理操作"] button')].find(node => node.textContent === '确认执行')`)
  await new Promise(done => setTimeout(done, 600))
  const manageDone = await evaluate(`[...document.querySelectorAll('dialog[open] [role=status]')].some(node => node.textContent.includes('已完成'))`)
  console.log('[8] 管理执行:', JSON.stringify({ manageDone }))
  if (!manageDone) failures.push('管理确认执行后未出现「已完成」')
  // 关闭管理确认弹窗（成功后保持打开显示结果态），再关管理弹窗（顶层 modal 顺序）。
  await clickAt(`[...document.querySelectorAll('dialog[aria-label="确认博客管理操作"] button')].find(node => node.textContent === '关闭')`)
  await new Promise(done => setTimeout(done, 300))
  await clickAt(`document.querySelector('.blg-management-dialog > .blg-dialog-head .blg-dialog-close')`)
  await new Promise(done => setTimeout(done, 300))
  const manageClosed = await waitUntil(`document.querySelector('.blg-management-dialog[open]') === null`)
  if (!manageClosed) failures.push('管理弹窗未关闭')

  // ── 9. 分支（重新生成 → 新会话）───────────────────────────────────────
  // 回到对话视图：点顶栏「对话」。
  await clickAt(`[...document.querySelectorAll('.blg-view-nav button')].find(node => node.textContent === '对话')`)
  await new Promise(done => setTimeout(done, 600))
  await clickAt(`document.querySelector('.blg-more summary')`)
  await new Promise(done => setTimeout(done, 300))
  await clickAt(`[...document.querySelectorAll('.blg-more-menu button')].find(node => node.textContent === '重新生成')`)
  const branched = await waitUntil(`location.search.includes('conversationId=conv-fork-')`, { timeout: 10000 })
  console.log('[9] 分支:', JSON.stringify({ branched, url: await evaluate('location.search') }))
  if (!branched) failures.push('分支未打开新会话（conv-fork-*）')

  // ── 10. 文章视图入口（文章库三行）────────────────────────────────────
  await clickAt(`[...document.querySelectorAll('.blg-view-nav button')].find(node => node.textContent === '文章')`)
  await new Promise(done => setTimeout(done, 800))
  const library = await evaluate(`(() => ({
    library: document.querySelector('.blg-library') !== null,
    rows: document.querySelectorAll('.blg-article-row').length,
    assistant: document.querySelector('.blg-assistant') !== null,
    presets: [...document.querySelectorAll('.blg-instruction-presets button')].map(node => node.textContent).join('|'),
  }))()`)
  console.log('[10] 文章库:', JSON.stringify(library))
  if (library.rows < 3) failures.push('文章库列表行数不足')
  if (library.assistant !== true) failures.push('AI 写作助手面板缺失')
  if (library.presets !== '提纲|润色|续写') failures.push('指令预设缺失')

  // 总截图。
  await clickAt(`[...document.querySelectorAll('.blg-view-nav button')].find(node => node.textContent === '对话')`)
  await new Promise(done => setTimeout(done, 400))
  await shot('blog-2b-final-chat.png')

  if (consoleErrors.length > 0) failures.push(`console 错误 ${consoleErrors.length} 条: ${consoleErrors[0] ?? ''}`)

  console.log(JSON.stringify({ failures, consoleErrors }, null, 2))
  if (failures.length > 0) {
    console.error('[verify-blog-2b] 失败断言：')
    for (const failure of failures) console.error(` - ${failure}`)
    process.exit(1)
  }
  console.log('[verify-blog-2b] 全部断言通过')
  ws.close()
}

main().catch(error => {
  console.error('[verify-blog-2b] 运行异常:', error)
  process.exit(1)
})
