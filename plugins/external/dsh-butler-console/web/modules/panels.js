/**
 * 右栏与设置（拆分设计 v2 批 1c）：花名册紧凑行、设置卡（改名/换头像）、概况与失败列表、
 * 会话列表与刷新。与 history 构成文档化环簇二（列表点击进详情、详情刷新列表）。
 */

import { openNewChat, renderMention } from './composer.js'
import { BUILTIN_AVATARS, PALETTE } from './config.js'
import { accentOf, announce, avatarNode, clear, declaredNameOf, displayNameOf, formatTime, make } from './dom.js'
import { el, state } from './state.js'
import { openConversation, openTask } from './history.js'
import { ApiError, ROUTE_PREFIX, api, chat, uploadAvatar } from '../api.js'

/* ── 右栏 ─────────────────────────────────────────────────────────────── */

/** 右栏的紧凑成员行：只看是谁；改名换脸去设置页。名单上的人都能接活，所以这里**没有状态**。 */
export function renderMembers() {
  clear(el.memberList)
  if (state.members.length === 0) {
    el.memberList.appendChild(make('p', 'empty', '还没有可分派的成员。'))
    return
  }
  for (const member of state.members) {
    const row = make('div', 'member member--compact')
    row.appendChild(avatarNode(member.agentId, 'sm'))
    const col = make('div', 'member__col')
    col.appendChild(make('div', 'member__name', member.displayName))
    col.appendChild(make('div', 'member__declared', member.declaredName))
    row.appendChild(col)
    row.title = `${member.displayName}（@${member.agentId}）：${member.declaredName}`
    el.memberList.appendChild(row)
  }
}

/* ── 设置页 ───────────────────────────────────────────────────────────── */

/**
 * 设置卡片的局部视图（方案 I14/I15/I16）：外号与配色是**草稿**，显式保存才提交；
 * 头像上传是独立动作。每张卡自带状态行（未保存 / 保存中 / 已保存 / 失败），保存或换脸
 * 只更新自己这张卡，不再整页重建——其他卡里没保存的输入不会被冲掉。
 */
export const settingsCards = new Map()

export function renderSettingsMembers() {
  clear(el.settingsMembers)
  settingsCards.clear()
  if (state.members.length === 0) {
    el.settingsMembers.appendChild(make('p', 'empty', '还没有可分派的成员。'))
    return
  }
  for (const member of state.members) el.settingsMembers.appendChild(buildSettingsCard(member))
}

/** 卡内状态行：kind 决定配色，文本给人看。 */
export function setCardStatus(view, kind, text) {
  view.status.dataset.kind = kind
  view.status.textContent = text
  view.status.hidden = text === ''
}

/**
 * 草稿变更：递增版本号（保存回包按它核对），状态行如实回落到「未保存」——
 * 包括刚显示「已保存/失败」之后再次编辑的情况（复核 1）；保存中不打断文案。
 */
export function markCardDirty(view) {
  view.draftVersion += 1
  view.dirty = true
  if (view.status.dataset.kind !== 'busy') setCardStatus(view, 'dirty', '未保存的改动')
}

/** 保存一张卡的外号与配色：按**提交时的草稿版本**确认（复核 1）。 */
export async function saveMemberCard(agentId) {
  const view = settingsCards.get(agentId)
  if (view === undefined || view.busy) return
  // 只提交发起那一刻的草稿；保存期间用户继续编辑不中断、也不会被回包吞掉。
  const submittedName = view.nameInput.value
  const submittedAccent = view.pendingAccent ?? accentOf(agentId)
  const submittedVersion = view.draftVersion
  view.busy = true
  view.save.disabled = true
  setCardStatus(view, 'busy', '保存中…可以先继续改')
  try {
    const result = await api.setAlias(agentId, submittedName, submittedAccent)
    state.members = result.items
    view.save.disabled = false
    // 基线更新到已提交的那版：标题跟提交值对齐。
    view.titles.replaceChildren(
      make('div', 'member__name', displayNameOf(agentId)),
      make('div', 'member__declared', `插件声明：${declaredNameOf(agentId)}`),
    )
    if (view.draftVersion === submittedVersion) {
      // 回包时草稿还停在提交版本：这次保存覆盖了全部改动，状态干净。
      view.pendingAccent = null
      view.dirty = false
      for (const [color, swatch] of view.swatches) swatch.setAttribute('aria-pressed', String(submittedAccent.toLowerCase() === color))
      setCardStatus(view, 'ok', '已保存')
      announce(`已保存 ${displayNameOf(agentId)} 的设置`)
    } else {
      // 保存期间又改了：刚提交的已存上，但新改动仍是未保存草稿（配色草稿保留）；
      // 色块选中态跟**当前草稿**对齐，不能被提交值覆盖（复核 1：选中态与草稿不一致）。
      view.dirty = true
      const draftAccent = view.pendingAccent ?? accentOf(agentId)
      for (const [color, swatch] of view.swatches) swatch.setAttribute('aria-pressed', String(draftAccent.toLowerCase() === color))
      setCardStatus(view, 'dirty', '刚提交的已存上；之后的新改动还没保存')
    }
    // 右栏与头像栏的公共投影照旧重画：它们不在设置页里，没有草稿可丢。
    renderMembers()
    renderCrew()
  } catch (error) {
    view.save.disabled = false
    setCardStatus(view, 'error', `没保存成功：${error instanceof Error && error.message ? error.message : '网络异常'}；改动还在，再试一次`)
  } finally {
    view.busy = false
  }
}

/** 头像上传/删除/内置换脸共用：卡内状态 + 本卡头像位刷新，不重建列表。 */
export async function runAvatarAction(agentId, action, doing, done) {
  const view = settingsCards.get(agentId)
  if (view !== undefined) setCardStatus(view, 'busy', doing)
  try {
    await action()
    if (view !== undefined) {
      view.avatarSlot.replaceChildren(avatarNode(agentId, 'lg'))
      setCardStatus(view, 'ok', done)
    }
    renderMembers()
    renderCrew()
    announce(done)
  } catch (error) {
    if (view !== undefined) {
      setCardStatus(view, 'error', `${done}没成：${error instanceof Error && error.message ? error.message : '再试一次'}`)
    }
  }
}

export function buildSettingsCard(member) {
  const agentId = member.agentId
  const card = make('div', 'set-card')
  card.dataset.agentId = agentId

  const head = make('div', 'set-card__head')
  const avatarWrap = make('div', 'member__avatar')
  const avatarSlot = make('div', 'member__avatar-slot')
  avatarSlot.appendChild(avatarNode(agentId, 'lg'))
  // 相机是按钮不是贴纸（方案 I16）：键盘可达、有名字。
  const camera = make('button', 'member__camera', '📷')
  camera.type = 'button'
  camera.title = '换头像'
  camera.setAttribute('aria-label', `给 ${displayNameOf(agentId)} 换头像`)
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.accept = 'image/png,image/jpeg,image/webp'
  picker.className = 'visually-hidden'
  picker.setAttribute('aria-hidden', 'true')
  picker.tabIndex = -1
  camera.addEventListener('click', () => picker.click())
  picker.addEventListener('change', () => {
    const file = picker.files?.[0]
    if (file) void runAvatarAction(agentId, async () => {
      await uploadAvatar(agentId, file)
      state.avatarStamps.set(agentId, Date.now())
    }, '上传中…', '头像已更新')
    picker.value = ''
  })
  avatarWrap.appendChild(avatarSlot)
  avatarWrap.appendChild(camera)
  avatarWrap.appendChild(picker)
  head.appendChild(avatarWrap)

  const titles = make('div', 'set-card__titles')
  titles.appendChild(make('div', 'member__name', member.displayName))
  titles.appendChild(make('div', 'member__declared', `插件声明：${member.declaredName}`))
  head.appendChild(titles)
  card.appendChild(head)

  // 外号输入与 label 关联（方案 I16）：读屏点「外号」就能落进输入框。
  const nameField = make('div', 'field')
  const nameLabel = make('label', null, '外号')
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.maxLength = 24
  nameInput.id = `alias-${agentId}`
  nameInput.value = member.displayName
  nameInput.placeholder = member.declaredName
  nameLabel.setAttribute('for', nameInput.id)
  nameField.appendChild(nameLabel)
  nameField.appendChild(nameInput)
  card.appendChild(nameField)

  // 配色只改草稿（方案 I15）：点选高亮未保存状态，与外号一起显式保存，
  // 不再携带未保存的外号立即提交。
  const colorField = make('div', 'field')
  const colorLabel = make('label', null, '配色')
  colorField.appendChild(colorLabel)
  const swatches = make('div', 'swatches')
  const swatchViews = new Map()
  for (const color of PALETTE) {
    const swatch = make('button', 'swatch')
    swatch.type = 'button'
    swatch.style.background = color
    swatch.setAttribute('aria-pressed', String(accentOf(agentId).toLowerCase() === color))
    swatch.title = color
    swatch.addEventListener('click', () => {
      view.pendingAccent = color
      for (const [each, node] of swatchViews) node.setAttribute('aria-pressed', String(each === color))
      markCardDirty(view)
    })
    swatchViews.set(color, swatch)
    swatches.appendChild(swatch)
  }
  colorField.appendChild(swatches)
  card.appendChild(colorField)

  const builtinField = make('div', 'field')
  const builtinLabel = make('label', null, '内置头像')
  builtinField.appendChild(builtinLabel)
  const strip = make('div', 'builtin-strip')
  for (const item of BUILTIN_AVATARS) {
    const pick = make('button', 'builtin-strip__item')
    pick.type = 'button'
    pick.title = item.label
    pick.setAttribute('aria-label', `换上${item.label}头像`)
    const thumb = document.createElement('img')
    thumb.alt = ''
    thumb.loading = 'lazy'
    thumb.src = `${ROUTE_PREFIX}/assets/media/avatars/builtin/${item.file}`
    pick.appendChild(thumb)
    pick.addEventListener('click', () => {
      void runAvatarAction(agentId, async () => {
        const response = await fetch(`${ROUTE_PREFIX}/assets/media/avatars/builtin/${item.file}`)
        if (!response.ok) throw new Error('内置头像读取失败')
        const blob = await response.blob()
        await uploadAvatar(agentId, new File([blob], item.file, { type: 'image/png' }))
        state.avatarStamps.set(agentId, Date.now())
      }, '换头像中…', '头像已更新')
    })
    strip.appendChild(pick)
  }
  builtinField.appendChild(strip)
  card.appendChild(builtinField)

  const actions = make('div', 'set-card__actions')
  const save = make('button', 'btn btn--tiny btn--primary', '保存')
  save.type = 'button'
  save.addEventListener('click', () => { void saveMemberCard(agentId) })
  actions.appendChild(save)
  if (state.avatarStamps.has(agentId)) {
    const reset = make('button', 'btn btn--tiny btn--ghost', '删除头像')
    reset.type = 'button'
    reset.addEventListener('click', () => { void runAvatarAction(agentId, async () => {
      await api.clearAvatar(agentId)
      state.avatarStamps.delete(agentId)
    }, '删除中…', '已删除头像，恢复默认') })
    actions.appendChild(reset)
  }
  card.appendChild(actions)

  const status = make('div', 'set-card__status')
  status.dataset.kind = ''
  card.appendChild(status)

  const view = { card, agentId, nameInput, titles, swatches: swatchViews, save, status, avatarSlot, pendingAccent: null, dirty: false, busy: false, draftVersion: 0 }
  nameInput.addEventListener('input', () => markCardDirty(view))
  settingsCards.set(agentId, view)
  return card
}

/**
 * 打开/关闭设置页（方案 I18）：页面切换，不是模态——焦点落到标题上（返回按钮也行，
 * 标题更稳），关闭时送回齿轮按钮，不误抢焦点到主输入。执行中进来时给出「回群聊」
 * 提示：停止入口在被隐藏的三栏里，这条路得留着。
 */
export function setOpenSettings(open) {
  state.settingsOpen = open
  document.body.dataset.settings = open ? 'open' : 'closed'
  el.settingsButton.setAttribute('aria-expanded', String(open))
  el.settings.hidden = !open
  el.settingsLive.hidden = !(open && state.streaming)
  el.settingsLive.textContent = open && state.streaming ? '有任务正在执行：回群聊可查看进度或喊停' : ''
  if (open) {
    renderSettingsMembers()
    el.settingsTitle.focus()
  } else {
    renderMembers()
    el.settingsButton.focus()
  }
}

export function renderCrew() {
  clear(el.crewFaces)
  for (const member of state.members) {
    // 「我的成员」用大头像（贴原型 C 的比例），带墨色描边圆框。
    const face = avatarNode(member.agentId)
    // 头像只说"这是谁"：**逐人本轮状态只在调度卡的格子上**（唯一来源）。这里再挂一份来自
    // `members[].busy` 快照的状态，会和卡片的事件流各说各话，用户看到两处不一致。
    face.title = `${member.displayName}（@${member.agentId}）`
    el.crewFaces.appendChild(face)
  }
  const busy = state.members.filter(member => member.busy !== null).length
  const total = state.members.length
  // ⚠️ 这里的计数是**页面级事实**（名单上此刻手上有活的人，跨任务，来自 `/members` 快照），
  // 与调度卡里"本次派活有几位进行中"（本轮事件流）不是同一件事，所以用词也不同：
  // 「手上有活」对名单，「进行中」对本次派活。混用会让用户在两处看到不同的数字。
  const working = busy > 0 ? ` · ${busy} 位手上有活` : ''
  el.crewLine.textContent = `${total} 个牛马${working}`
  el.crewNote.textContent = `共 ${total} 位${working}`
  el.groupSub.textContent = `${total} 位成员${working}`
}

export function renderMetrics(counts) {
  clear(el.metrics)
  const tiles = [
    { label: '在干活', value: counts.running },
    { label: '等你回话', value: counts.waitingUser },
    { label: '待外部处理', value: counts.externalPending },
    { label: '部分完成', value: counts.partial },
    { label: '失败', value: counts.failed },
    { label: '已完成', value: counts.completed },
  ]
  for (const tile of tiles) {
    const box = make('div', 'metric')
    box.appendChild(make('span', 'metric__value', tile.value))
    box.appendChild(make('span', 'metric__label', tile.label))
    el.metrics.appendChild(box)
  }
}

/**
 * 右栏「运行状态」**只有计数，没有逐人状态行**。
 *
 * 改造前这里还有一列"谁此刻在干什么"，与群里每位成员的一行状态、调度卡的格子重复了同一件事，
 * 而三处口径还各有可能不一致（一个来自 `members[].busy` 快照，两个来自本轮事件）。现在本次派活
 * 的事实只有一个来源：**调度卡的格子**；这里只留一眼能看完的计数（下面 `renderMetrics`）。
 * 成员名单那一栏本来就不带状态点（见 `renderMembers` 的说明），两栏合起来正好不重复。
 */
export function renderFailures(items) {
  clear(el.failureList)
  if (items.length === 0) {
    el.failureList.appendChild(make('p', 'empty', '暂无失败记录'))
    closeFailureMenu()
    return
  }
  for (const item of items) {
    // 0.12.4：行前复选框勾选、删除统一走标题行的操作图标（⋯），行内不再放 ×。
    const row = make('label', 'failure-row failure-row--pick')
    const check = make('input', 'failure-row__check')
    check.type = 'checkbox'
    check.checked = state.failurePicked.has(item.id)
    check.addEventListener('change', () => {
      if (check.checked) state.failurePicked.add(item.id)
      else state.failurePicked.delete(item.id)
      refreshOpenFailureMenu()
    })
    row.appendChild(check)
    // 头行=「时间 任务名」（原型 C 与 Figma 稿均为日期在前），正文=失败原因。点击文本仍可打开任务。
    const body = make('span', 'failure-row__body')
    body.appendChild(make('span', 'failure-row__goal', `${formatTime(item.updatedAt)}　${item.goal}`))
    body.appendChild(make('span', 'failure-row__meta', item.error || '没给原因'))
    body.addEventListener('click', () => { void openTask(item.id) })
    row.appendChild(body)
    el.failureList.appendChild(row)
  }
}

export function renderChatList(items, keyword) {
  clear(el.chatList)
  const filtered = keyword === ''
    ? items
    : items.filter(item =>
      (item.title ?? '').toLowerCase().includes(keyword) ||
      (item.preview ?? '').toLowerCase().includes(keyword))
  if (filtered.length === 0) {
    el.chatList.appendChild(make('p', 'empty', items.length === 0 ? '还没有任务记录' : '没有匹配结果'))
    return
  }
  for (const item of filtered) {
    // 0.12.5：复选框常驻（没有管理模式了）——行首勾选、正文点击打开会话，两不误。
    const row = make('div', 'chat-row chat-row--pickable')
    if (state.chatPicked.has(item.id)) row.classList.add('chat-row--picked')
    if (item.id === state.conversationId) row.setAttribute('aria-current', 'true')
    const check = make('input', 'chat-row__check')
    check.type = 'checkbox'
    check.checked = state.chatPicked.has(item.id)
    check.addEventListener('change', () => { pickConversation(item.id, check.checked, row) })
    row.appendChild(check)
    const body = make('span', 'chat-row__body')
    // 行内重命名（0.12.4）：正在改名的这条，标题位换成一个手账风输入框。
    if (state.renamingId === item.id) {
      const input = make('input', 'chat-row__rename')
      input.value = item.title || ''
      input.placeholder = '起个新名字'
      input.maxLength = 80
      row.classList.add('chat-row--renaming')
      body.appendChild(input)
      row.appendChild(body)
      el.chatList.appendChild(row)
      input.focus()
      input.select()
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); void submitRename(input.value) }
        else if (event.key === 'Escape') { event.preventDefault(); cancelRename() }
      })
      input.addEventListener('blur', () => { if (state.renamingId === item.id) void submitRename(input.value) })
      continue
    }
    const left = make('span')
    left.appendChild(make('span', 'chat-row__title', item.title || '（还没起名）'))
    if (item.preview) left.appendChild(make('span', 'chat-row__preview', item.preview))
    body.appendChild(left)
    body.appendChild(make('span', 'chat-row__time', formatTime(item.updatedAt)))
    body.addEventListener('click', () => { void openConversation(item.id) })
    row.appendChild(body)
    el.chatList.appendChild(row)
  }
}

/** 分页条（0.12.4）：只在多于一页时出现；按钮态随页码。 */
export function renderPager() {
  // 搜索态（0.12.5）：结果来自全量过滤，页码失去意义，收起分页条。
  const searching = el.chatSearch.value.trim() !== ''
  const pages = Math.max(1, Math.ceil(state.chatTotal / state.chatPageSize))
  el.chatPager.hidden = searching || pages <= 1
  el.chatPagerInfo.textContent = `${state.chatPage + 1} / ${pages}`
  el.chatPagerPrev.disabled = state.chatPage === 0
  el.chatPagerNext.disabled = state.chatPage >= pages - 1
}

/** 翻页（0.12.4）：切页清选中（跨页选中容易误删）、回到列表顶部重拉。 */
export function gotoChatPage(page) {
  const pages = Math.max(1, Math.ceil(state.chatTotal / state.chatPageSize))
  const next = Math.min(Math.max(0, page), pages - 1)
  if (next === state.chatPage) return
  state.chatPage = next
  state.chatPicked.clear()
  closeRecordsMenu()
  void refreshChatList()
}

/** 勾选变化：维护选中集并刷新计数、全选三态。 */
function pickConversation(id, picked, row) {
  if (picked) state.chatPicked.add(id)
  else state.chatPicked.delete(id)
  row.classList.toggle('chat-row--picked', picked)
  updateManageBar()
  refreshOpenMenu()
}

function updateManageBar() {
  const rows = [...el.chatList.querySelectorAll('.chat-row__check')]
  const checked = rows.filter(check => check.checked).length
  el.chatManageCount.textContent = `已选 ${state.chatPicked.size} 条`
  // 全选框三态：本页全选勾、部分半选、空不选。
  el.chatManageAll.checked = rows.length > 0 && checked === rows.length
  el.chatManageAll.indeterminate = checked > 0 && checked < rows.length
}

/** 菜单开着时勾选变了（删除/重命名的可用态取决于选中数），就地重建菜单项。
 *  ⚠️ 只在「菜单确实开着」时刷新，且不动 hidden 态——0.12.5 的竞态：真实点击 checkbox 的
 *  click 先冒泡到 document 级监听关掉菜单，随后 change 的 refreshOpenMenu 又把它重开，
 *  用户看到「菜单关不上/点 ⋯ 状态乱」。重建项时不改 hidden，关闭权只归 toggle 与外点。 */
function refreshOpenMenu() {
  if (el.recordsMenuPop.hidden) return
  const items = []
  const addItem = (text, options = {}) => {
    const item = make('button', `chat-manage-menu__item${options.danger === true ? ' chat-manage-menu__item--danger' : ''}`, text)
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    if (options.disabled === true) item.disabled = true
    item.addEventListener('click', () => { void options.run?.() })
    items.push(item)
  }
  addItem('删除所选', { danger: true, disabled: state.chatPicked.size === 0, run: () => { closeRecordsMenu(); void deletePickedConversations() } })
  addItem('重命名', { disabled: state.chatPicked.size !== 1, run: () => { closeRecordsMenu(); startRename() } })
  el.recordsMenuPop.replaceChildren(...items)
}

/** 全选框切换：同步当前页（或搜索结果）所有行——选中集只在可见行里维护。 */
export function togglePickAll(picked) {
  for (const check of el.chatList.querySelectorAll('.chat-row__check')) {
    if (check.checked !== picked) {
      check.checked = picked
      check.dispatchEvent(new Event('change'))
    }
  }
}

/**
 * ⋯ 菜单（0.12.5：没有管理模式了，菜单固定为「删除所选 / 重命名」）。
 * 再点 ⋯ 关闭（标准 toggle）；菜单项每次打开按当下选中数重建。
 */
export function toggleRecordsMenu(open = el.recordsMenuPop.hidden) {
  if (open) {
    clear(el.recordsMenuPop)
    const addItem = (text, options = {}) => {
      const item = make('button', `chat-manage-menu__item${options.danger === true ? ' chat-manage-menu__item--danger' : ''}`, text)
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      if (options.disabled === true) item.disabled = true
      item.addEventListener('click', () => { void options.run?.() })
      el.recordsMenuPop.appendChild(item)
      return item
    }
    addItem('删除所选', { danger: true, disabled: state.chatPicked.size === 0, run: () => { closeRecordsMenu(); void deletePickedConversations() } })
    // 重命名只在恰好选中一条时可用（多条没有一致的改名语义）。
    addItem('重命名', { disabled: state.chatPicked.size !== 1, run: () => { closeRecordsMenu(); startRename() } })
  }
  el.recordsMenuPop.hidden = !open
  el.recordsMenu.setAttribute('aria-expanded', String(open))
}

function closeRecordsMenu() {
  el.recordsMenuPop.hidden = true
  el.recordsMenu.setAttribute('aria-expanded', 'false')
}

/** 批量删除共用：调围栏接口、按结果提示、刷新列表；当前会话被删时另起新会话。 */
async function removeConversationsWithFeedback(ids) {
  let results
  try {
    results = (await api.removeConversations(ids)).results
  } catch (error) {
    announce(error instanceof ApiError ? error.message : '删除失败，稍后再试')
    return null
  }
  const removed = results.filter(result => result.status === 'removed')
  const blocked = results.filter(result => result.status === 'blocked')
  if (removed.length > 0) announce(`已删除 ${removed.length} 条任务记录`)
  if (blocked.length > 0) announce(blocked.length === 1 ? '有 1 条正在执行，先停止再删' : `有 ${blocked.length} 条正在执行，先停止再删`)
  closeRecordsMenu()
  if (removed.some(result => result.id === state.conversationId)) {
    // 当前打开的会话被删掉了：回新会话，别让中栏挂在已删除的对话上。
    state.chatPicked.clear()
    openNewChat()
    return results
  }
  state.chatPicked.clear()
  await refreshChatList()
  return results
}

/** 操作菜单的「删除所选」。 */
export async function deletePickedConversations() {
  const ids = [...state.chatPicked]
  if (ids.length === 0) return
  await removeConversationsWithFeedback(ids)
}

/** 操作菜单的「重命名」：把唯一选中项切进行内编辑态。 */
export function startRename() {
  if (state.chatPicked.size !== 1) return
  state.renamingId = [...state.chatPicked][0]
  closeRecordsMenu()
  void refreshChatList()
}

/** 行内改名提交：空值视为取消；成功后刷新列表（服务端返回新标题）。 */
async function submitRename(title) {
  const id = state.renamingId
  if (id === null) return
  state.renamingId = null
  const trimmed = title.trim()
  if (trimmed === '') { await refreshChatList(); return }
  try {
    await api.renameConversation(id, trimmed)
    announce('已改名')
  } catch (error) {
    announce(error instanceof ApiError ? error.message : '改名失败，稍后再试')
  }
  state.chatPicked.clear()
  await refreshChatList()
}

function cancelRename() {
  state.renamingId = null
  void refreshChatList()
}

/**
 * 失败记录的操作菜单（0.12.7 与任务记录同款交互）：⋯ 点开「删除所选」（未选禁用）、
 * 再点 ⋯ 关闭；勾选变化实时刷新可用态。菜单弹层复用 records-menu-pop？不——两个锚点
 * 各自持有独立弹层，避免「一个 hidden 管两处」的状态混乱。失败弹层挂在 failure-head。
 */
export function toggleFailureMenu(open = el.failureMenuPop.hidden) {
  if (open) {
    clear(el.failureMenuPop)
    const item = make('button', 'chat-manage-menu__item chat-manage-menu__item--danger', '删除所选')
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.disabled = state.failurePicked.size === 0
    item.addEventListener('click', () => {
      closeFailureMenu()
      void removePickedFailures()
    })
    el.failureMenuPop.appendChild(item)
  }
  el.failureMenuPop.hidden = !open
  el.failureMenuBtn.setAttribute('aria-expanded', String(open))
}

function closeFailureMenu() {
  el.failureMenuPop.hidden = true
  el.failureMenuBtn.setAttribute('aria-expanded', 'false')
}

/** 勾选变化时菜单开着 → 就地刷新可用态（不动 hidden，同任务记录的竞态防护）。 */
function refreshOpenFailureMenu() {
  if (el.failureMenuPop.hidden) return
  const item = el.failureMenuPop.querySelector('.chat-manage-menu__item')
  if (item) item.disabled = state.failurePicked.size === 0
}

async function removePickedFailures() {
  const ids = [...state.failurePicked]
  if (ids.length === 0) return
  let removed = 0
  for (const id of ids) {
    try {
      await api.removeTask(id)
      removed += 1
      state.failurePicked.delete(id)
    } catch (error) {
      announce(error instanceof ApiError ? error.message : '删除失败，稍后再试')
    }
  }
  if (removed > 0) announce(`已删除 ${removed} 条失败记录`)
  await refreshPanels()
}

/* ── 右栏操作 ─────────────────────────────────────────────────────────── */

/* 设置保存与头像操作在设置卡内局部处理（saveMemberCard / runAvatarAction），
 * 不再走整页重建；右栏常规刷新由 refreshPanels 负责。 */

/* ── 数据刷新 ─────────────────────────────────────────────────────────── */

export async function refreshPanels() {
  try {
    const [members, overview] = await Promise.all([api.members(), api.overview()])
    state.members = members.items
    for (const member of members.items) {
      if (!state.avatarStamps.has(member.agentId)) state.avatarStamps.set(member.agentId, 1)
    }
    // 名单变了（新成员、换外号），开着的点名簿跟着换页。
    renderMention()
    // 设置页开着时不重画右栏成员卡，免得把没保存的外号冲掉。
    if (!state.settingsOpen) renderMembers()
    renderCrew()
    renderMetrics(overview.counts)
    renderFailures(overview.failures)
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      el.topStatus.textContent = '没登录'
      clear(el.identity)
      const link = make('a', null, '去登录')
      link.href = '/auth'
      el.identity.appendChild(link)
      return
    }
    el.topStatus.textContent = '读取失败'
  }
}

/**
 * 左栏列表。
 *
 * 会话标题与预览来自牛马大总管会话记录：标题由宿主首句标题服务生成，预览取该会话最近一条
 * 任务的目标或汇总，所以每行都能看出「这次派的是什么活」。
 */
export async function refreshChatList() {
  try {
    // 0.12.5：浏览=按页取；搜索=拉全量（后端显式 limit）再本地过滤——只筛当页会漏掉后面页的记录。
    const searching = el.chatSearch.value.trim() !== ''
    const offset = searching ? 0 : state.chatPage * state.chatPageSize
    const [conversations, history] = await Promise.all([
      searching ? api.conversations(0, 200) : api.conversations(offset),
      api.history(),
    ])
    if (conversations.items.length === 0 && state.chatPage > 0 && !searching) {
      state.chatPage -= 1
      return await refreshChatList()
    }
    state.chatTotal = conversations.total ?? conversations.items.length
    const byConversation = new Map()
    for (const task of history.items) {
      if (!byConversation.has(task.conversationId)) byConversation.set(task.conversationId, task)
    }
    const items = conversations.items.map(item => {
      const task = byConversation.get(item.id)
      return {
        ...item,
        preview: task === undefined ? '' : task.goal,
      }
    })
    renderChatList(items, el.chatSearch.value.trim().toLowerCase())
    renderPager()
    updateManageBar()
  } catch (error) {
    // 把服务端给的原因一并显示：只说「读取记录失败」，排查时等于什么都没有。
    const reason = error instanceof Error ? error.message : ''
    el.chatList.replaceChildren(make('p', 'empty', reason === '' ? '读取记录失败' : `读取记录失败：${reason}`))
  }
}
