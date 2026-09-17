/**
 * 侧栏列表的**行过滤**：`conversationRowVisible` 的判据，以及 `render()` 是否真的按它落笔。
 *
 * 为什么值得单独测：`/conversations` 回来的行里有 `pending` / `failed` / `legacy` 三种
 * **点开会 404、在本页再删也 404** 的状态（围栏把它们挡在 `assertConversation` 外面）。
 * 列出来就是死行，用户点一下什么都得不到；而 `busy`（正在回答）必须留下 —— 旧实现里它照常
 * 出现，用 `state === 'ready'` 一刀切会让正在回答的那条会话从列表里凭空消失。
 *
 * 这里不引 DOM 实现（仓库里没有 jsdom/happy-dom，也不值得为一条过滤规则引一个）：
 * 手写一个只实现本模块用到的那几个面的最小替身，然后**真的把列表渲染一遍**。只测
 * `conversationRowVisible` 本身是不够的 —— `render()` 不再调用它时那条断言照样是绿的。
 */
import { describe, expect, it } from 'vitest'
import { conversationRowVisible, createConversationHistory } from '../web/conversation-history.js'

/** 深度优先收集子节点。 */
function walk(node, found = []) {
  for (const child of node.children) { found.push(child); walk(child, found) }
  return found
}

/** 只认本模块用到的三种选择器：标签名、`.class`、`[attr]`。 */
function matches(node, selector) {
  const token = selector.trim()
  if (token.startsWith('.')) return node.className.split(/\s+/).includes(token.slice(1))
  if (token.startsWith('[')) return node.getAttribute(token.slice(1, -1)) !== undefined
  return node.tagName === token.toUpperCase()
}

/** 最小 DOM 节点：属性、子节点、classList，其余是空实现。 */
function node(tag) {
  const children = []
  const attributes = {}
  const element = {
    tagName: String(tag).toUpperCase(),
    children,
    dataset: {},
    style: {},
    className: '',
    textContent: undefined,
    innerHTML: '',
    hidden: false,
    disabled: false,
    open: false,
    scrollTop: 0,
    append: (...nodes) => { children.push(...nodes) },
    prepend: (...nodes) => { children.unshift(...nodes) },
    replaceChildren: (...nodes) => { children.splice(0, children.length, ...nodes) },
    setAttribute: (name, value) => { attributes[name] = String(value) },
    getAttribute: name => attributes[name],
    removeAttribute: (name) => { delete attributes[name] },
    remove: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelectorAll: selector => walk(element).filter(child => matches(child, selector)),
    querySelector: selector => element.querySelectorAll(selector)[0] ?? null,
    focus: () => {},
    select: () => {},
    click: () => {},
    show: () => {},
    showModal: () => { element.open = true },
    close: () => { element.open = false },
    showPopover: () => {},
    hidePopover: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }),
    offsetHeight: 0,
    classList: {
      add: (...names) => { for (const name of names) if (!element.className.split(/\s+/).includes(name)) element.className = `${element.className} ${name}`.trim() },
      remove: (...names) => { element.className = element.className.split(/\s+/).filter(value => value && !names.includes(value)).join(' ') },
      contains: name => element.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const on = force ?? !element.classList.contains(name)
        if (on) element.classList.add(name); else element.classList.remove(name)
        return on
      },
    },
  }
  return element
}

/** 把页面模块要的全局面装上（只在调用 `createConversationHistory` 之前需要）。 */
function installDom() {
  const body = node('body')
  globalThis.document = {
    body,
    createElement: tag => node(tag),
    createTextNode: text => Object.assign(node('#text'), { textContent: text }),
  }
  globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
}

const NOW = 1_700_000_000_000

/** 造一份列表页数据。`list()` 的内容由用例给。 */
function sidebar(items, mount = node('main')) {
  installDom()
  const painted = { refreshed: 0 }
  const history = createConversationHistory({
    mount,
    currentId: () => '',
    newConversation: () => {},
    openConversation: async () => {},
    list: async () => { painted.refreshed += 1; return { items, nextOffset: null } },
    mutate: async () => ({}),
    read: async () => ({ messages: [] }),
    onDeleted: async () => {},
  })
  return { mount, history, painted }
}

const rowIds = mount => mount.querySelectorAll('.qh-row').map(row => row.dataset.conversation)

describe('会话历史列表的行过滤', () => {
  it('pending / failed / legacy 不落笔，ready / busy 与缺 state 的照常显示', async () => {
    const { mount, history } = sidebar([
      { id: 'ready-1', title: '可打开', updatedAt: NOW, state: 'ready' },
      { id: 'failed-1', title: '移除失败', updatedAt: NOW, state: 'failed' },
      { id: 'busy-1', title: '正在回答', updatedAt: NOW, state: 'busy' },
      { id: 'pending-1', title: '移除中', updatedAt: NOW, state: 'pending' },
      { id: 'legacy-1', title: '宿主已归档', updatedAt: NOW, state: 'legacy' },
      // 服务端比页面旧（没有 `state`）时不能把整份列表清空。
      { id: 'nostate-1', title: '老服务端', updatedAt: NOW },
    ])
    await history.refresh()
    expect(rowIds(mount)).toEqual(['ready-1', 'busy-1', 'nostate-1'])
    // 行里的标题照旧渲染（过滤没有把可见行也一起弄丢）。
    expect(mount.querySelectorAll('.qh-title').map(link => link.textContent))
      .toEqual(['可打开', '正在回答', '老服务端'])
    history.dispose()
  })

  it('一行都显示不出来时给空态提示，而不是一片空白', async () => {
    const { mount, history } = sidebar([
      { id: 'failed-1', title: '移除失败', updatedAt: NOW, state: 'failed' },
      { id: 'legacy-1', title: '宿主已归档', updatedAt: NOW, state: 'legacy' },
    ])
    await history.refresh()
    expect(rowIds(mount)).toEqual([])
    expect(mount.querySelectorAll('.qh-empty').map(empty => empty.textContent)).toEqual(['还没有历史对话'])
    history.dispose()
  })

  it('判据本身：只有 ready / busy / 未提供 state 算可显示', () => {
    for (const state of ['ready', 'busy']) expect(conversationRowVisible({ id: 'a', state }), state).toBe(true)
    for (const state of ['pending', 'failed', 'legacy']) expect(conversationRowVisible({ id: 'a', state }), state).toBe(false)
    expect(conversationRowVisible({ id: 'a' })).toBe(true)
  })
})
