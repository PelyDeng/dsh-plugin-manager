/** Compact selectors backed by the official host catalog. */
export function createDefaultModels(api) {
  const root = document.querySelector('#conversation-models')
  const status = document.querySelector('#conversation-model-status')
  const refresh = document.querySelector('#conversation-model-refresh')
  let epoch = 0, visible = false, catalog, pending
  const same = (a, b) => a?.provider === b?.provider && a?.model === b?.model
  function render() {
    root.replaceChildren()
    for (const group of catalog?.groups ?? []) for (const model of group.models) {
      const selection = { provider: group.id, model: model.id }
      const card = document.createElement('label')
      card.className = 'chat-model-card'
      card.classList.toggle('is-default', same(catalog.selected, selection))
      const radio = document.createElement('input')
      radio.type = 'radio'; radio.name = 'default-conversation-model'
      radio.checked = same(catalog.selected, selection)
      radio.disabled = !!pending || !catalog.writable
      radio.setAttribute('aria-label', `将 ${group.name} · ${model.name} 设为对话默认模型`)
      const provider = document.createElement('span'); provider.className = 'muted small'; provider.textContent = group.name
      const title = document.createElement('strong'); title.textContent = model.name
      const id = document.createElement('span'); id.className = 'model-id'; id.textContent = model.id
      const badge = document.createElement('span'); badge.className = 'default-model-badge'; badge.textContent = radio.checked ? '对话默认' : '设为默认'
      card.append(radio, provider, title, id, badge)
      radio.addEventListener('change', () => { if (!pending && !same(catalog.selected, selection)) void save(selection) })
      root.append(card)
    }
    refresh.disabled = !!pending
  }
  async function load(version) {
    try {
      const value = await api('conversation-model')
      if (!visible || version !== epoch) return
      catalog = value; render()
      const found = value.groups.some(group => group.id === value.selected.provider && group.models.some(model => model.id === value.selected.model))
      status.textContent = !value.writable ? '宿主设置服务不可写，暂时无法更改默认模型。'
        : !found ? `当前默认 ${value.selected.provider} / ${value.selected.model} 未出现在目录中，请检查模型服务。`
        : value.failures.length ? '部分服务商的模型目录读取失败，可刷新重试。' : '选择后自动保存，仅影响新会话；已有会话沿用原模型。'
    } catch (error) { if (visible && version === epoch) { status.textContent = error.message; refresh.disabled = false } }
  }
  async function save(selection) {
    const version = epoch
    status.textContent = '正在保存默认模型…'
    pending = api('conversation-model', selection)
    render()
    try {
      const result = await pending
      if (visible && version === epoch) { catalog.selected = result.selected; status.textContent = '默认模型已保存，新会话立即生效。' }
    } catch (error) { if (visible && version === epoch) status.textContent = error.message ?? '保存失败，请刷新核实当前默认模型。' }
    finally { pending = undefined; if (visible && version === epoch) render() }
  }
  async function enter() {
    visible = true
    const version = ++epoch
    root.replaceChildren(); status.textContent = '正在读取模型目录…'; refresh.disabled = true
    await pending?.catch(() => {})
    if (visible && version === epoch) await load(version)
  }
  refresh.addEventListener('click', () => { void enter() })
  return { enter, leave() { visible = false; epoch++; catalog = undefined; root.replaceChildren(); status.textContent = '' } }
}
