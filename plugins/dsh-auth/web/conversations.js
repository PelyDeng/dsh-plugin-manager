/** Owner-scoped maintenance UI. All transcript content is text, never executable HTML. */
export function createConversationPage(api) {
  const $ = id => document.getElementById(id)
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el }
  const labels = { ready: '可清理', busy: '运行中', legacy: '仅插件已移除', pending: '移除中', failed: '移除未完成' }
  const form = $('conversation-filters'), drawer = $('conversation-preview'), confirm = $('conversation-confirm')
  let plugins = [], pluginId = '', rows = [], selected = new Set(), offset = 0, total = 0, nextOffset = null
  let epoch = 0, previewEpoch = 0, active = false, fresh = false, pending = false, preview = null, before = null, trigger = null
  const limit = () => Number($('conversation-limit').value)
  const notice = (text = '', error = false) => { $('conversation-notice').textContent = text; $('conversation-notice').classList.toggle('error', error) }
  const plugin = () => plugins.find(p => p.id === pluginId)
  function closePreview() { previewEpoch++; preview = null; if (drawer.open) drawer.close(); $('conversation-messages').replaceChildren(); if (trigger?.isConnected) trigger.focus(); trigger = null }
  function controls() {
    const eligible = rows.filter(row => row.canRemove)
    $('conversation-selected').textContent = `已选择 ${selected.size} 条`
    $('conversation-remove').textContent = `删除所选（${selected.size}）`
    $('conversation-remove').disabled = !fresh || pending || !selected.size
    $('conversation-clear').disabled = pending || !selected.size
    const all = $('conversation-select-page')
    all.disabled = !fresh || pending || !eligible.length
    all.checked = eligible.length > 0 && eligible.every(row => selected.has(row.id))
    all.indeterminate = selected.size > 0 && !all.checked
    $('conversation-prev').disabled = pending || !fresh || !offset
    $('conversation-next').disabled = pending || !fresh || nextOffset === null
    $('conversation-limit').disabled = pending
    for (const el of form.elements) el.disabled = pending
    for (const el of $('conversation-plugins').querySelectorAll('button')) el.disabled = pending
    for (const el of $('conversation-rows').querySelectorAll('input')) el.disabled = !fresh || pending || !rows.find(row => row.id === el.dataset.id)?.canRemove
    $('conversation-preview-select').disabled = !fresh || pending || !preview?.canRemove
    $('conversation-preview-select').textContent = selected.has(preview?.id) ? '取消选中' : '选中待删除'
  }
  function select(id, value) { if (value) selected.add(id); else selected.delete(id); for (const el of $('conversation-rows').querySelectorAll('input')) { el.checked = selected.has(el.dataset.id); el.closest('tr').classList.toggle('is-selected', el.checked) } controls() }
  function render() {
    $('conversation-count').textContent = `共 ${total} 条会话`
    $('conversation-rows').replaceChildren(...rows.map(row => {
      const tr = node('tr'), check = node('input'); check.type = 'checkbox'; check.dataset.id = row.id; check.setAttribute('aria-label', `选择 ${row.title || '无标题会话'}`)
      check.addEventListener('change', () => select(row.id, check.checked)); const cell = node('td'); cell.append(check)
      const title = node('td'), open = node('button', row.title || '无标题会话', 'conversation-title')
      open.addEventListener('click', () => openPreview(row, open))
      const id = node('button', row.id, 'conversation-id'); id.title = '复制完整会话 ID'; id.addEventListener('click', async () => { try { await navigator.clipboard.writeText(row.id); notice('会话 ID 已复制。') } catch { notice('复制失败，请手动复制会话 ID。', true) } })
      title.append(open, id)
      title.append(node('span', row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '更新时间未知', 'conversation-mobile-time'))
      const state = node('td'), badge = node('span', labels[row.state] ?? '状态未知', `conversation-state ${row.state}`)
      state.append(badge); if (row.blockedReason) state.append(node('small', row.blockedReason, 'muted'))
      const action = node('td'), button = node('button', '预览', 'text-button'); button.addEventListener('click', () => openPreview(row, button)); action.append(button)
      tr.append(cell, title, node('td', row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '未知', 'conversation-time'), state, action); return tr
    }))
    $('conversation-empty').hidden = rows.length > 0
    $('conversation-empty').textContent = plugin()?.error ?? (!plugin()?.supported ? '该插件暂不支持会话管理。' : '没有匹配的会话。')
    $('conversation-range').textContent = total ? `第 ${offset + 1}–${offset + rows.length} 条，共 ${total} 条` : '共 0 条'
    $('conversation-page').textContent = String(Math.floor(offset / limit()) + 1)
    controls()
  }
  function renderPlugins() {
    $('conversation-plugins').replaceChildren(...plugins.map(p => { const button = node('button', `${p.displayName} ${p.error ? '· 暂不可用' : p.supported ? ` ${p.total ?? '—'}` : '· 未接入'}`); button.classList.toggle('selected', p.id === pluginId); button.setAttribute('aria-pressed', String(p.id === pluginId)); button.addEventListener('click', () => { if (pending) return; pluginId = p.id; offset = 0; renderPlugins(); void loadRows() }); return button }))
  }
  function failure(error) { if (error.status === 401 || error.status === 403) reset(); notice(error.message ?? '读取失败，请重试。', true) }
  async function loadRows() {
    const current = ++epoch; fresh = false; selected.clear(); closePreview(); controls(); notice('正在读取会话…')
    if (!plugin()?.supported || plugin()?.error) { rows = []; total = 0; nextOffset = null; render(); notice(plugin()?.error ?? '暂无可管理会话。'); return }
    try {
      const params = new URLSearchParams({ pluginId, offset: String(offset), limit: String(limit()), q: form.elements.q.value, state: form.elements.state.value })
      for (const key of ['from', 'to']) { const value = form.elements[key].value; if (value) { const date = new Date(`${value}T00:00:00`); if (key === 'to') date.setDate(date.getDate() + 1); params.set(key, String(date.getTime())) } }
      const result = await api(`conversations?${params}`)
      if (current !== epoch || !active) return
      if (offset && offset >= result.total) { offset = Math.max(0, Math.ceil(result.total / limit()) - 1) * limit(); return loadRows() }
      rows = result.items; total = result.total; nextOffset = result.nextOffset; fresh = true; render(); notice()
    } catch (error) { if (current === epoch && active) { controls(); failure(error); if (rows.length) notice('读取失败，数据可能已过期；请刷新后操作。', true) } }
  }
  async function enter() {
    active = true; fresh = false; selected.clear(); const current = ++epoch; controls(); notice('正在读取插件…')
    try {
      const result = await api('conversation-plugins')
      if (current !== epoch || !active) return
      plugins = result.plugins
      if (!plugins.some(p => p.id === pluginId)) pluginId = (plugins.find(p => p.total > 0 && !p.error) ?? plugins.find(p => p.supported) ?? plugins[0])?.id ?? ''
      renderPlugins(); await loadRows()
    } catch (error) { if (current === epoch && active) failure(error) }
  }
  function messageElement(message) {
    const entry = node('article', undefined, `preview-message ${message.role}`)
    entry.append(node('strong', message.role === 'user' ? '我' : message.role === 'tool' ? '工具调用' : '助手'))
    if (message.time) entry.append(node('time', new Date(message.time).toLocaleString('zh-CN'), 'muted small'))
    if (message.role === 'tool') { const details = node('details'); details.append(node('summary', '查看工具信息'), node('p', message.text)); entry.append(details) }
    else { if (message.reasoning) { const details = node('details'); details.append(node('summary', '思考过程'), node('p', message.reasoning)); entry.append(details) } entry.append(node('p', message.text)) }
    if (message.truncated) entry.append(node('p', '此条消息过长，预览已截断。', 'muted small'))
    return entry
  }
  async function loadPreview(older = false) {
    const current = ++previewEpoch, id = preview.id, ownerPlugin = pluginId
    $('conversation-older').disabled = true; $('conversation-preview-status').textContent = '正在读取…'; $('conversation-preview-select').disabled = true
    try {
      const query = new URLSearchParams({ pluginId: ownerPlugin, id }); if (older && before !== null) query.set('before', String(before))
      const result = await api(`conversations/preview?${query}`)
      if (current !== previewEpoch || !active || !drawer.open) return
      const body = $('conversation-preview-body'), height = body.scrollHeight
      if (older) $('conversation-messages').prepend(...result.messages.map(messageElement)); else $('conversation-messages').replaceChildren(...result.messages.map(messageElement))
      before = result.previousBefore; $('conversation-older').hidden = before === null
      $('conversation-preview-status').textContent = result.total ? '' : '此会话暂无可预览的消息。'
      body.scrollTop = older ? body.scrollHeight - height : body.scrollHeight
      controls()
    } catch (error) { if (current === previewEpoch) { $('conversation-preview-status').textContent = error.message ?? '预览读取失败，请关闭后重试'; if (error.status === 401 || error.status === 403) failure(error) } }
    finally { if (current === previewEpoch) $('conversation-older').disabled = false }
  }
  function openPreview(row, opener) {
    if (pending) return
    closePreview(); preview = row; trigger = opener; before = null
    $('conversation-preview-title').textContent = row.title || '无标题会话'; $('conversation-preview-meta').textContent = `${plugin()?.displayName ?? ''} · ${row.id}`
    $('conversation-messages').replaceChildren(); $('conversation-older').hidden = true
    drawer.showModal(); void loadPreview()
  }
  $('conversation-preview-close').addEventListener('click', closePreview)
  $('conversation-preview-dismiss').addEventListener('click', closePreview)
  drawer.addEventListener('cancel', event => { event.preventDefault(); closePreview() })
  $('conversation-preview-select').addEventListener('click', () => { if (preview?.canRemove && fresh) select(preview.id, !selected.has(preview.id)) })
  $('conversation-older').addEventListener('click', () => void loadPreview(true))
  $('conversation-clear').addEventListener('click', () => { selected.clear(); select('', false) })
  $('conversation-select-page').addEventListener('change', event => { const checked = event.target.checked; for (const row of rows.filter(r => r.canRemove)) select(row.id, checked) })
  $('conversation-prev').addEventListener('click', () => { offset = Math.max(0, offset - limit()); void loadRows() })
  $('conversation-next').addEventListener('click', () => { offset = nextOffset ?? offset; void loadRows() })
  $('conversation-limit').addEventListener('change', () => { offset = 0; void loadRows() })
  form.addEventListener('submit', event => { event.preventDefault(); if (!pending) { offset = 0; void loadRows() } })
  form.addEventListener('input', () => { if (!pending) { fresh = false; selected.clear(); select('', false) } })
  $('conversation-refresh').addEventListener('click', () => { if (!pending) void enter() })
  let removalTargets = []
  $('conversation-remove').addEventListener('click', () => {
    removalTargets = rows.filter(row => selected.has(row.id))
    $('conversation-confirm-title').textContent = `删除 ${removalTargets.length} 条会话？`
    $('conversation-confirm-plugin').textContent = plugin()?.displayName ?? ''
    $('conversation-confirm-items').replaceChildren(...removalTargets.map(row => node('li', row.title || row.id)))
    $('conversation-remove-status').textContent = ''; $('conversation-confirm-remove').textContent = `确认删除 ${removalTargets.length} 条`
    confirm.showModal(); $('conversation-cancel').focus()
  })
  $('conversation-cancel').addEventListener('click', () => { if (!pending) confirm.close() })
  confirm.addEventListener('cancel', event => { if (pending) event.preventDefault() })
  $('conversation-confirm-remove').addEventListener('click', async () => {
    if (pending || !fresh || !removalTargets.length) return
    pending = true; controls(); $('conversation-confirm-remove').disabled = true; $('conversation-cancel').disabled = true
    const current = epoch, ids = removalTargets.map(row => row.id)
    $('conversation-remove-status').textContent = `正在处理 ${ids.length} 条会话…`
    try {
      const result = await api('conversations/remove', { pluginId, ids })
      if (current !== epoch || !active) return
      const failures = result.results.filter(row => !['removed', 'alreadyRemoved'].includes(row.status))
      confirm.close(); pending = false; await enter()
      notice(`已移除 ${ids.length - failures.length} 条，未完成 ${failures.length} 条。${failures.map(row => `${removalTargets.find(r => r.id === row.id)?.title ?? row.id}：${row.message}`).join('；')}`, failures.length > 0)
    } catch (error) {
      if (current === epoch && active) { confirm.close(); selected.clear(); fresh = false; failure(error); notice('结果待核实，请刷新后查看会话状态；未完成项可以重试。', true) }
    } finally { pending = false; $('conversation-confirm-remove').disabled = false; $('conversation-cancel').disabled = false; controls() }
  })
  function leave() { active = false; epoch++; selected.clear(); fresh = false; closePreview(); if (confirm.open) confirm.close() }
  function reset() { leave(); rows = []; plugins = []; pluginId = ''; total = 0; offset = 0; nextOffset = null; removalTargets = []; form.reset(); $('conversation-plugins').replaceChildren(); $('conversation-rows').replaceChildren(); $('conversation-confirm-items').replaceChildren(); $('conversation-preview-title').textContent = ''; $('conversation-preview-meta').textContent = ''; notice() }
  return { enter, leave, reset }
}
