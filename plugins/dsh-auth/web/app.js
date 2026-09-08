/** Independent account UI; server authorization remains authoritative. */
import { pageTools, pageUsers, highlightParts, localEntry, toolDisplayName } from './catalog-view.js'

const $ = selector => document.querySelector(selector)
let session = null
let catalog = []
let accessTargets = []
let users = []
let userPage = 1
let createChecks = []
let page = 'plugins'
let identityEpoch = 0
let pageEpoch = 0
let dialogPlugin = null
let dialogPage = 1
let dialogTrigger = null
const modelCards = [...document.querySelectorAll('[data-model]')].map(element => ({ element, kind: element.dataset.model, epoch: 0, pending: false, status: null }))

function identityChanged() {
  try { localStorage.setItem('dsh_auth_changed', crypto.randomUUID()) }
  catch { /* Private browser storage may be disabled; server authorization still applies. */ }
}

function node(tag, text, className) {
  const element = document.createElement(tag)
  if (text !== undefined) element.textContent = text
  if (className) element.className = className
  return element
}

function highlight(element, text, query) {
  for (const part of highlightParts(text, query)) element.append(part.match ? node('mark', part.text) : document.createTextNode(part.text))
  return element
}

function message(text, error = false) {
  $('#message').textContent = text
  $('#message').classList.toggle('error', error)
}

function closeTools() {
  if ($('#tool-dialog').open) $('#tool-dialog').close()
  dialogPlugin = null
  $('#tool-list').replaceChildren()
  $('#tool-search').value = ''
}

function loggedOut() {
  identityEpoch++
  pageEpoch++
  session = null
  users = []
  userPage = 1
  if ($('#initial-password-dialog').open) $('#initial-password-dialog').close()
  catalog = []
  accessTargets = []
  dialogTrigger = null
  closeTools()
  $('#workspace').hidden = true
  $('#login').hidden = false
  $('#identity').replaceChildren()
  for (const id of ['#users', '#plugins', '#access-targets']) $(id).replaceChildren()
  for (const id of ['#login-form', '#password-form', '#create-form', '#initial-password-form']) $(id).reset()
  for (const id of ['#account-name', '#account-role', '#greeting']) $(id).textContent = ''
  $('#user-search').value = ''
  $('#plugin-search').value = ''
  clearModel()
}

async function api(path, data, login = false) {
  const identity = identityEpoch
  const response = await fetch(`/auth/api/${path}`, {
    credentials: 'same-origin', cache: 'no-store',
    ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-csrf': login ? 'login' : session?.csrf ?? '' }, body: JSON.stringify(data) }),
  })
  const result = await response.json()
  if (identity !== identityEpoch) throw new DOMException('账号已变化', 'AbortError')
  if (!response.ok) {
    if (response.status === 401 && !login) loggedOut()
    throw new Error(result.error ?? '请求失败')
  }
  return result
}

async function perform(action, button) {
  if (button) button.disabled = true
  try { await action() } catch (error) { if (error.name !== 'AbortError') message(error.message ?? '请求失败', true) }
  finally { if (button) button.disabled = false }
}

function toolButton(text, plugin) {
  const button = node('button', text, 'text-button')
  button.addEventListener('click', () => openTools(plugin, button))
  return button
}

function pluginCard(plugin) {
  const card = node('article', undefined, 'card plugin-card')
  const toolbar = node('div', undefined, 'card-toolbar')
  toolbar.append(node('span', `${plugin.tools.length} 个工具`, 'badge'), toolButton('查看插件工具', plugin))
  card.append(toolbar, node('h2', plugin.displayName), node('p', plugin.description, 'muted plugin-description'))
  const meta = node('p', `${plugin.packageName} · v${plugin.version}`, 'plugin-meta')
  meta.title = `${plugin.packageName} · v${plugin.version}`
  card.append(meta)
  const preview = node('div', undefined, 'tool-preview')
  for (const tool of plugin.tools.slice(0, 3)) {
    const row = node('div', undefined, 'preview-row')
    row.append(node('strong', toolDisplayName(tool))); row.title = tool.description
    preview.append(row)
  }
  if (!plugin.tools.length) preview.append(node('p', '此插件未注册工具。', 'muted small'))
  card.append(preview)
  const footer = node('div', undefined, 'card-footer')
  const entry = localEntry(plugin.entryPath)
  if (entry === '/auth') footer.append(node('span', '当前页面', 'muted small'))
  else if (entry && session.user.grants.includes(plugin.id)) {
    const link = node('a', '打开插件', 'button'); link.href = entry; footer.append(link)
  } else footer.append(node('span', '未获访问授权', 'muted small'))
  footer.append(toolButton('查看工具详情', plugin))
  card.append(footer)
  return card
}

function renderPlugins() {
  const query = $('#plugin-search').value.trim().toLocaleLowerCase()
  const visible = catalog.filter(plugin => `${plugin.displayName}\n${plugin.description}\n${plugin.packageName}`.toLocaleLowerCase().includes(query))
  $('#plugin-count').textContent = String(catalog.length)
  $('#plugins').replaceChildren(...visible.map(pluginCard))
  if (!visible.length) $('#plugins').append(node('p', query ? '没有匹配的插件，请尝试其他关键词。' : '尚未获得插件授权，请联系管理员。', 'empty'))
}

function renderTargets() {
  const available = (session.accessTargets ?? []).filter(target => localEntry(target.entryPath))
  $('#access-targets').hidden = !available.length
  $('#access-targets').replaceChildren(...available.map(target => {
    const row = node('div', undefined, 'access-target')
    const text = node('div'); text.append(node('h3', target.displayName), node('p', target.description, 'muted'))
    const link = node('a', '打开控制台', 'button'); link.href = target.entryPath
    row.append(text, link); return row
  }))
}

function openTools(plugin, trigger) {
  dialogPlugin = plugin
  dialogPage = 1
  dialogTrigger = trigger
  $('#tool-search').value = ''
  $('#tool-dialog-title').textContent = `${plugin.displayName} · 工具`
  $('#tool-dialog-description').textContent = `${plugin.tools.length} 个已注册工具 · ${plugin.packageName}`
  renderTools()
  $('#tool-dialog').showModal()
  $('#tool-search').focus()
}

function renderTools() {
  if (!dialogPlugin) return
  const query = $('#tool-search').value
  const result = pageTools(dialogPlugin.tools, query, dialogPage)
  dialogPage = result.page
  $('#tool-results').textContent = query.trim() ? `找到 ${result.total} 个匹配工具` : `共 ${result.total} 个工具，每页 15 个`
  $('#tool-list').replaceChildren(...result.items.map(tool => {
    const details = node('details', undefined, 'tool-row')
    details.open = !!query.trim()
    const summary = node('summary')
    const status = node('span', undefined, 'tool-status')
    status.append(node('span', undefined, 'status-dot enabled'), node('span', '已启用', 'enabled-label'))
    summary.append(highlight(node('strong', undefined, 'tool-name'), toolDisplayName(tool), query), status, node('span', '⌄', 'tool-chevron'))
    details.append(summary)
    const body = node('div', undefined, 'tool-body')
    body.append(highlight(node('p', undefined, 'muted'), `工具编码：${tool.name}`, query), highlight(node('p', undefined, 'muted'), tool.description, query), node('p', `执行权限：${tool.permission}`, 'muted'), node('div', '参数定义', 'parameter-heading'), highlight(node('pre'), JSON.stringify(tool.parameters, null, 2), query))
    details.append(body); return details
  }))
  if (!result.items.length) $('#tool-list').append(node('p', query.trim() ? '没有匹配的工具。试试工具名称、中文说明或参数名。' : '此插件未注册工具。', 'empty'))
  $('#tool-page').textContent = result.pages ? `第 ${result.page} / ${result.pages} 页` : '第 0 / 0 页'
  $('#tool-prev').disabled = result.page <= 1
  $('#tool-next').disabled = !result.pages || result.page >= result.pages
  $('#tool-list').scrollTop = 0
  // Parameter matches may be below the internal code viewport; reveal the first one without moving the page.
  const match = $('#tool-list pre mark')
  if (match) {
    const pre = match.closest('pre')
    pre.scrollTop = match.offsetTop - pre.offsetTop - 12
    pre.scrollLeft = Math.max(0, match.offsetLeft - pre.offsetLeft - 12)
  }
}

async function showPage(next) {
  if (['users', 'models'].includes(next) && session?.user.role !== 'admin') next = 'plugins'
  const version = ++pageEpoch
  const identity = identityEpoch
  page = next
  closeTools()
  clearModel()
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== `page-${next}`
  for (const button of document.querySelectorAll('[data-page]')) {
    button.classList.toggle('selected', button.dataset.page === next)
    if (button.dataset.page === next) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  }
  if (next === 'models') {
    await Promise.all(modelCards.map(card => loadModel(card)))
  } else if (next === 'plugins' || next === 'users') {
    const result = await api('plugins')
    if (version !== pageEpoch || identity !== identityEpoch) return
    catalog = result.plugins
    accessTargets = result.accessTargets ?? []
    if (next === 'plugins') { renderPlugins(); renderTargets() }
    else {
      const result = await api('users')
      if (version === pageEpoch && identity === identityEpoch) { users = result.users; renderCreateGrants(); renderUsers() }
    }
  }
}

function modelField(card, name) { return card.element.querySelector(`[data-field="${name}"]`) }
function modelControls(card) {
  modelField(card, 'key').disabled = card.pending || !card.status?.writable
  modelField(card, 'save').disabled = card.pending || !card.status?.writable
  card.element.querySelector('[data-action="refresh"]').disabled = card.pending
  card.element.setAttribute('aria-busy', String(card.pending))
}
function clearModel() {
  for (const card of modelCards) {
    card.epoch++
    card.status = null
    modelField(card, 'key').value = ''
    modelField(card, 'fingerprint').textContent = ''
    modelField(card, 'fingerprint-row').hidden = true
    modelField(card, 'source').textContent = ''
    modelField(card, 'message').textContent = ''
    modelField(card, 'message').classList.remove('error')
    modelField(card, 'status').textContent = '正在读取…'
    modelField(card, 'status').className = 'model-status'
    card.element.querySelector('details').open = false
    modelControls(card)
  }
}
function renderModel(card, status) {
  card.status = status
  const label = modelField(card, 'status')
  label.textContent = !status.supported ? '凭据服务不可用' : status.configured ? '已配置 · 未验证' : '未配置'
  label.className = `model-status ${status.configured ? 'configured' : 'unconfigured'}`
  modelField(card, 'source').textContent = !status.supported ? '请检查官方宿主的凭据服务。' : !status.writable ? '外部环境配置 · 只读。请由服务管理者移除环境覆盖后再更换。' : status.source === 'file' ? '已保存到官方凭据存储' : status.configured ? '当前使用 .env 配置；保存后由官方凭据存储接管。' : '添加密钥后可供已接入该服务商的模型使用。'
  modelField(card, 'fingerprint-row').hidden = !status.fingerprint
  modelField(card, 'fingerprint').textContent = status.fingerprint?.replace(/^SHA-256:/, '') ?? ''
  modelField(card, 'save').textContent = status.configured ? '更换密钥' : '保存密钥'
  modelControls(card)
}
async function loadModel(card, key) {
  if (card.pending) return
  const identity = identityEpoch, version = pageEpoch, epoch = ++card.epoch
  const current = () => identity === identityEpoch && version === pageEpoch && epoch === card.epoch
  const saving = key !== undefined
  card.pending = true
  modelField(card, 'message').classList.remove('error')
  modelField(card, 'message').textContent = saving ? '正在保存…' : ''
  if (!saving) {
    card.status = null
    modelField(card, 'status').textContent = '正在读取…'
    modelField(card, 'status').className = 'model-status'
    modelField(card, 'fingerprint').textContent = ''
    modelField(card, 'fingerprint-row').hidden = true
    modelField(card, 'source').textContent = ''
  }
  modelControls(card)
  try {
    const status = await api(`model-key/${card.kind}`, saving ? { apiKey: key } : undefined)
    if (!current()) return
    renderModel(card, status)
    if (saving) modelField(card, 'message').textContent = '密钥已更新，后续请求生效；尚未验证模型可用性。'
  } catch (error) {
    if (current() && error.name !== 'AbortError') {
      modelField(card, 'message').textContent = error.message ?? '操作失败，请重试。'
      modelField(card, 'message').classList.add('error')
      if (!saving) { card.status = null; modelField(card, 'status').textContent = '状态读取失败' }
    }
  } finally {
    card.pending = false
    if (current()) modelControls(card)
    // A page may have reopened while its previous request was still settling.
    else if (page === 'models' && session?.user.role === 'admin') void loadModel(card)
  }
}
for (const card of modelCards) {
  card.element.querySelector('[data-action="refresh"]').addEventListener('click', () => loadModel(card))
  card.element.querySelector('form').addEventListener('submit', event => {
    event.preventDefault()
    if (card.pending || !card.status?.writable) return
    const input = modelField(card, 'key'), key = input.value
    input.value = ''
    void loadModel(card, key)
  })
}

function field(label, input) { const element = node('label', label); element.append(input); return element }

function grantFields(role, selected) {
  const grants = node('fieldset'); grants.append(node('legend', '访问授权'))
  const grid = node('div', undefined, 'grant-grid')
  const checks = []
  for (const target of [...catalog, ...accessTargets]) {
    const input = node('input'); input.type = 'checkbox'; input.value = target.id
    const dot = node('span', undefined, 'status-dot'); dot.setAttribute('aria-hidden', 'true')
    const label = node('label', undefined, 'grant-option'); label.title = target.displayName
    label.append(dot, node('span', target.displayName, 'grant-name'), input)
    input.addEventListener('change', () => dot.classList.toggle('enabled', input.checked))
    grid.append(label); checks.push(input)
  }
  const sync = () => {
    for (const input of checks) {
      input.disabled = role.value === 'admin'
      input.checked = input.disabled || selected.includes(input.value)
      input.parentElement.querySelector('.status-dot').classList.toggle('enabled', input.checked)
    }
  }
  role.onchange = sync; sync()
  grants.append(grid, node('p', '管理员自动拥有全部插件和 DSH 控制台权限。', 'muted small grant-note'))
  return { grants, checks }
}

function renderCreateGrants() {
  const { grants, checks } = grantFields($('#create-form select'), [])
  $('#create-grants').replaceChildren(grants); createChecks = checks
}

function renderUsers() {
  $('#user-count').textContent = String(users.length)
  const result = pageUsers(users, $('#user-search').value, userPage)
  userPage = result.page
  $('#user-pages').textContent = `${result.total} 个用户 · ${result.total ? result.page : 0} / ${result.pages} 页`
  $('#user-prev').disabled = result.page <= 1
  $('#user-next').disabled = !result.pages || result.page >= result.pages
  $('#users').replaceChildren(...result.items.map(user => {
    const card = node('article', undefined, 'card user-card')
    card.append(node('h2', user.username), node('p', user.id, 'meta muted'))
    const form = node('form')
    const role = node('select')
    for (const [value, text] of [['user', '普通用户'], ['admin', '管理员']]) { const option = node('option', text); option.value = value; role.append(option) }
    role.value = user.role
    const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = user.enabled
    const enabledLabel = field('账号启用', enabled); enabledLabel.className = 'check'
    const { grants, checks } = grantFields(role, user.grants)
    const password = node('input'); password.type = 'password'; password.autocomplete = 'new-password'; password.placeholder = '留空则不更改'; password.minLength = 8; password.maxLength = 256
    const button = node('button', '保存账号与授权', 'primary')
    form.append(field('角色', role), enabledLabel, grants, field('重置密码', password), button)
    form.addEventListener('submit', event => {
      event.preventDefault()
      perform(async () => {
        const visible = new Set(checks.map(input => input.value))
        const selected = [...user.grants.filter(id => !visible.has(id)), ...checks.filter(input => input.checked).map(input => input.value)]
        await api('users', { id: user.id, role: role.value, enabled: enabled.checked, grants: selected, password: password.value })
        password.value = ''
        if (user.id === session.user.id) { identityChanged(); loggedOut(); message('账号已更新，请重新登录。') }
        else { message('账号与授权已更新，该用户需要重新登录。'); await showPage('users') }
      }, button)
    })
    card.append(form); return card
  }))
  if (!result.total) $('#users').append(node('p', '没有匹配的用户。', 'muted'))
}

async function load(redirect = false) {
  loggedOut()
  $('#login').hidden = true
  $('#loading').hidden = false
  const version = ++identityEpoch
  const requested = new URL(location.href).searchParams.get('returnTo') ?? ''
  const result = await api(`session?returnTo=${encodeURIComponent(requested)}`)
  if (version !== identityEpoch) return
  $('#loading').hidden = true
  if (!result.user) {
    loggedOut(); $('#uninitialized').hidden = result.initialized
    $('#login-form').hidden = !result.initialized
    return
  }
  session = result
  if (result.user.mustChangePassword) {
    $('#initial-password-error').textContent = ''
    $('#initial-password-dialog').showModal()
    return
  }
  $('#login').hidden = true; $('#workspace').hidden = false
  $('#greeting').textContent = `已登录为 ${result.user.username}`
  $('#account-name').textContent = result.user.username
  $('#account-role').textContent = result.user.role === 'admin' ? '管理员' : '普通用户'
  $('#plugin-description').textContent = result.user.role === 'admin' ? '查看当前已注册插件及其工具，管理访问授权。' : '查看已获授权的插件及其工具。'
  const exit = node('button', '退出登录')
  exit.addEventListener('click', () => perform(async () => { await api('logout', {}); identityChanged(); loggedOut(); message('已退出登录。') }, exit))
  $('#identity').replaceChildren(node('span', `${result.user.username} · ${result.user.role === 'admin' ? '管理员' : '普通用户'}`), exit)
  for (const button of document.querySelectorAll('[data-admin]')) button.hidden = result.user.role !== 'admin'
  if (redirect && result.returnTo !== '/auth') { location.assign(result.returnTo); return }
  await showPage(page)
}

$('#login-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget
  perform(async () => { await api('login', Object.fromEntries(new FormData(form)), true); identityChanged(); form.reset(); message(''); await load(true) }, form.querySelector('button'))
})
$('#password-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget
  perform(async () => { await api('password', Object.fromEntries(new FormData(form))); identityChanged(); form.reset(); loggedOut(); message('密码已更新，请重新登录。') }, form.querySelector('button'))
})
$('#create-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget
  perform(async () => { await api('users', { ...Object.fromEntries(new FormData(form)), grants: createChecks.filter(input => input.checked).map(input => input.value) }); form.reset(); message('用户已创建，请分配访问权限。'); await showPage('users') }, form.querySelector('button'))
})
$('#user-search').addEventListener('input', () => { userPage = 1; renderUsers() })
$('#user-prev').addEventListener('click', () => { userPage--; renderUsers() })
$('#user-next').addEventListener('click', () => { userPage++; renderUsers() })
$('#initial-password-dialog').addEventListener('cancel', event => event.preventDefault())
$('#initial-password-form').addEventListener('submit', async event => {
  event.preventDefault()
  const form = event.currentTarget
  const data = Object.fromEntries(new FormData(form))
  const error = $('#initial-password-error')
  if (data.newPassword !== data.confirmPassword) { error.textContent = '两次输入的新密码不一致。'; return }
  const button = form.querySelector('button'); button.disabled = true
  try {
    await api('password', { currentPassword: data.currentPassword, newPassword: data.newPassword })
    identityChanged(); loggedOut(); message('初始密码已修改，请使用新密码重新登录。')
  } catch (failure) { error.textContent = failure.message ?? '修改失败，请重试。' }
  finally { button.disabled = false }
})
$('#plugin-search').addEventListener('input', renderPlugins)
$('#tool-search').addEventListener('input', () => { dialogPage = 1; renderTools() })
$('#tool-prev').addEventListener('click', () => { dialogPage--; renderTools() })
$('#tool-next').addEventListener('click', () => { dialogPage++; renderTools() })
$('#tool-dialog-close').addEventListener('click', closeTools)
$('#tool-dialog').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeTools() }
})
$('#tool-dialog').addEventListener('close', () => {
  const trigger = dialogTrigger; dialogTrigger = null; dialogPlugin = null
  $('#tool-list').replaceChildren()
  if (trigger?.isConnected && !$('#workspace').hidden) trigger.focus()
})
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => perform(() => showPage(button.dataset.page), button))
window.addEventListener('pageshow', event => { if (event.persisted) perform(() => load()) })
window.addEventListener('storage', event => { if (event.key === 'dsh_auth_changed') { loggedOut(); perform(() => load()) } })
perform(() => load())
