/**
 * 侧栏列表的**行过滤**：`conversationRowVisible` 的判据，以及 `render()` 是否真的按它落笔。
 *
 * 判据从 closedoff 回移（那边修的"列表出现点不开的死行"，blog 这份副本当时漏了同步）。
 * 两边副本各自演化，这份测试把 blog 侧的接入点钉住：判据存在、render 真的调用它、
 * 空态按过滤后的清单判断。
 *
 * 不引 DOM 实现（blog 测试栈是 node:test，没有 jsdom）：手写本模块用到的最小节点替身，
 * 然后真的把列表渲染一遍——只测判据函数本身是不够的，render() 不再调用它时照样绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { conversationRowVisible, createConversationHistory } from '../web/conversation-history.js'

/** 最小 DOM 节点：属性、子节点、classList 与事件回调，其余空实现。 */
function makeNode(tag = 'div', className = '') {
  const node = {
    tagName: String(tag).toUpperCase(),
    className,
    children: [],
    dataset: {},
    attributes: {},
    handlers: {},
    parentNode: null,
    setAttribute(name, value) { node.attributes[name] = String(value) },
    getAttribute(name) { return node.attributes[name] ?? null },
    append(...nodes) { for (const n of nodes) { node.children.push(n); n.parentNode = node } },
    prepend(...nodes) { for (const n of nodes) node.children.unshift(n) },
    appendChild(n) { node.append(n); return n },
    replaceChildren(...nodes) { node.children = []; node.append(...nodes) },
    remove() { if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(c => c !== node) },
    classList: {
      toggle(name, on) {
        const set = new Set(node.className.split(/\s+/).filter(Boolean))
        if (on === undefined) on = !set.has(name)
        if (on) set.add(name); else set.delete(name)
        node.className = [...set].join(' ')
      },
    },
    addEventListener(type, fn) { node.handlers[type] = fn },
    querySelectorAll() { return [] },
    focus() {},
    close() {},
    show() {},
    showModal() {},
    hidePopover() {},
    showPopover() {},
    textContent: '',
  }
  return node
}

/** 把页面模块要的全局面装上（createConversationHistory 需要 document.createTextNode 与 matchMedia）。 */
function installDom() {
  globalThis.document = {
    body: makeNode('body'),
    createElement: tag => makeNode(tag),
    createTextNode: text => Object.assign(makeNode('#text'), { textContent: text }),
  }
  globalThis.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
}

test('判据：ready/busy/缺 state 可见，pending/failed/legacy 不可见', () => {
  assert.equal(conversationRowVisible({ state: 'ready' }), true)
  assert.equal(conversationRowVisible({ state: 'busy' }), true, '正在回答的那条必须留下')
  assert.equal(conversationRowVisible({}), true, 'state 缺失按可显示处理（升级不同步不清空列表）')
  assert.equal(conversationRowVisible({ state: 'pending' }), false)
  assert.equal(conversationRowVisible({ state: 'failed' }), false)
  assert.equal(conversationRowVisible({ state: 'legacy' }), false)
})

test('render 按判据落笔：死行不进列表，可见行照常画', async () => {
  installDom()
  const mount = makeNode()
  const rows = []
  const history = createConversationHistory({
    mount,
    toggle: undefined,
    newConversation() {},
    openConversation: async () => {},
    currentId: () => '',
    list: async () => ({
      items: [
        { id: 'ok', title: '正常的', updatedAt: Date.now(), state: 'ready' },
        { id: 'busy', title: '正在回答的', updatedAt: Date.now(), state: 'busy' },
        { id: 'dead', title: '死行', updatedAt: Date.now(), state: 'pending' },
        { id: 'gone', title: '已归档的', updatedAt: Date.now(), state: 'legacy' },
      ],
      nextOffset: null,
    }),
    mutate: async () => {},
    read: async () => ({ messages: [] }),
  })
  await history.refresh()
  const walk = node => {
    for (const child of node.children ?? []) {
      if (child.dataset?.conversation !== undefined) rows.push(child.dataset.conversation)
      walk(child)
    }
  }
  walk(mount)
  assert.deepEqual(rows.sort(), ['busy', 'ok'], '死行（pending/legacy）不出现，busy 保留')
  history.dispose()
})

test('全部是死行时显示空态，而不是空白', async () => {
  installDom()
  const mount = makeNode()
  const history = createConversationHistory({
    mount,
    toggle: undefined,
    newConversation() {},
    openConversation: async () => {},
    currentId: () => '',
    list: async () => ({ items: [{ id: 'dead', title: '死行', updatedAt: Date.now(), state: 'failed' }], nextOffset: null }),
    mutate: async () => {},
    read: async () => ({ messages: [] }),
  })
  await history.refresh()
  const texts = []
  const collect = node => {
    // element() 直接给 textContent 赋值（不建 #text 子节点），两种形态都收。
    if (typeof node.textContent === 'string' && node.textContent !== '') texts.push(node.textContent)
    for (const child of node.children ?? []) collect(child)
  }
  collect(mount)
  assert.ok(texts.some(text => text.includes('还没有历史对话')), '过滤后为空要给出空态提示')
  history.dispose()
})
