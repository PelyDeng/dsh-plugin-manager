/**
 * 待确认操作卡（**一个组件渲染所有"要用户点确认"的操作**）。
 *
 * 这一批用例的核心不是"画得好不好看"，而是**通用性**：新增一种操作（哪怕来自另一个插件、
 * `kind` 台账从没见过）时，前端**一行都不用改**就该能画出来、能点。所以这里特意用
 * `demo.confirm` 这种"台账不可能认识"的 kind 做断言——一旦有人在 `actionCard` 里按 kind
 * 写分支，这条就会红。
 *
 * 其余几条：状态决定有没有按钮、过期不给按钮、点击把决策送出去且按钮锁住、
 * 重画时整块替换（不叠卡）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

interface StubNode {
  tag: string
  className: string
  id: string
  textContent: string
  type: string
  disabled: boolean
  hidden: boolean
  attrs: Record<string, string>
  dataset: Record<string, string>
  children: StubNode[]
  parent: StubNode | null
  handlers: Record<string, (() => void)[]>
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  appendChild(child: StubNode): StubNode
  prepend(child: StubNode): void
  replaceChildren(...children: StubNode[]): void
  addEventListener(name: string, run: () => void): void
  fire(name: string): void
  querySelector(selector: string): StubNode | null
  querySelectorAll(selector: string): StubNode[]
  remove(): void
}

function node(tag = '', className = ''): StubNode {
  const attrs: Record<string, string> = {}
  const classes = new Set(String(className ?? '').split(' ').filter(Boolean))
  const kebab = (key: string) => key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
  const dataset = new Proxy({} as Record<string, string>, {
    get: (_t, key) => attrs[`data-${kebab(String(key))}`],
    set: (_t, key, value) => { attrs[`data-${kebab(String(key))}`] = String(value); return true },
  })
  const element: StubNode = {
    tag, className, id: '', textContent: '', type: '', disabled: false, hidden: false,
    attrs, dataset, children: [], parent: null, handlers: {},
    setAttribute(name, value) { attrs[name] = String(value) },
    getAttribute(name) { return attrs[name] ?? null },
    appendChild(child) { child.parent = element; element.children.push(child); return child },
    prepend(child) { child.parent = element; element.children.unshift(child) },
    replaceChildren(...children) { for (const child of children) child.parent = element; element.children = children },
    addEventListener(name, run) { (element.handlers[name] ??= []).push(run) },
    fire(name) { for (const run of element.handlers[name] ?? []) run() },
    querySelector(selector) { return flatten(element).find(child => matches(child, selector)) ?? null },
    querySelectorAll(selector) { return flatten(element).filter(child => matches(child, selector)) },
    remove() {
      const parent = element.parent
      if (parent === null) return
      parent.children = parent.children.filter(child => child !== element)
      element.parent = null
    },
  }
  // 类名切换（`toggle`/`add`）用得上：这里只需要 `contains` 与类名字符串一致。
  ;(element as unknown as { classList: { contains(name: string): boolean } }).classList = {
    contains: name => classes.has(name),
  }
  return element
}

function flatten(root: StubNode): StubNode[] {
  const out: StubNode[] = []
  const walk = (current: StubNode) => { for (const child of current.children) { out.push(child); walk(child) } }
  walk(root)
  return out
}

/** 只支持这一批用例用到的选择器：`.class`、`tag`、`tag.class`、`.a.b`。 */
function matches(candidate: StubNode, selector: string): boolean {
  return selector.split(/(?=[.#])/).every(part => {
    if (part.startsWith('.')) return candidate.className.split(' ').includes(part.slice(1))
    if (part.startsWith('#')) return candidate.id === part.slice(1)
    return candidate.tag === part
  })
}

function make(tag: string, className: string | null, text?: string): StubNode {
  const element = node(tag, className ?? '')
  if (text !== undefined && text !== null) element.textContent = String(text)
  return element
}

interface Loaded {
  actionCard(action: Record<string, unknown>, context: Record<string, unknown>): StubNode
  renderActionsInto(view: Record<string, unknown>, actions: unknown[], context: Record<string, unknown>): void
  acts: Record<string, unknown>[]
  marked: string[]
}

/** 取出 `actionCard` / `renderActionsInto` 并用替身注入依赖。 */
function load(): Loaded {
  const pick = (name: string) => {
    const body = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
    if (body === undefined) throw new Error(`${name} 源码未找到`)
    return body
  }
  const acts: Record<string, unknown>[] = []
  const marked: string[] = []
  const clear = (parent: StubNode) => { parent.children = [] }
  const state = {}
  const globals: Record<string, unknown> = {
    make, clear, state,
    // 受控 Markdown：这一步只记"渲染过"，内容解析由 `page-dispatch` 那条用例负责。
    renderMarkdownInto: (target: StubNode, text: string) => { marked.push(text); target.textContent = text; return target },
    formatTime: (value: number) => `时间戳${value}`,
    runAct: async (input: Record<string, unknown>) => { acts.push(input) },
    newConversationId: () => 'req-1',
    Date,
    // `actionCard` 里 `card.querySelectorAll('.act__row button')` 的失败分支用得上。
  }
  const names = Object.keys(globals)
  const body = [
    "const ACTION_STATE_TEXT = { prepared: '等你确认', executing: '正在办', succeeded: '已办完', failed: '没办成', cancelled: '先不办', expired: '已过期' }",
    pick('actionCard'), pick('runAction'), pick('renderActionsInto'),
  ].join('\n')
  const loaded = Function(...names, `${body}\nreturn { actionCard, runAction, renderActionsInto }`)(...names.map(name => globals[name])) as Loaded
  loaded.acts = acts
  loaded.marked = marked
  return loaded
}

const context = { taskId: 'task-1', subtaskId: 's1' }

describe('待确认操作卡', () => {
  it('一个没见过的 kind 也能画出来并点得动（新增操作不用改前端）', () => {
    const page = load()
    const card = page.actionCard({
      // 台账完全不认识这个 kind：来自另一个插件，未来新增的操作就是这样。
      id: 'op-1', kind: 'demo.confirm', title: '确认一下这件事', summary: '确认后会做一件你要求的事。',
      detail: '**详情**在这里', fields: [{ label: '目标', value: '示例' }, { label: '影响', value: '只动这一条' }],
      confirmLabel: '就这么办', cancelLabel: '算了', state: 'prepared',
    }, context)
    expect(card.className).toContain('act')
    expect(card.dataset.kind).toBe('demo.confirm')
    expect(flatten(card).map(child => child.textContent)).toContain('确认一下这件事')
    expect(flatten(card).map(child => child.textContent)).toContain('确认后会做一件你要求的事。')
    // 详情走统一渲染器（受控 Markdown）。
    expect(page.marked).toContain('**详情**在这里')
    // 结构化字段渲染成表格（同一套 `.md table` 样式）。
    const table = card.querySelector('table')
    expect(table).not.toBeNull()
    expect(table!.querySelectorAll('tr').map(row => row.children.map(cell => cell.textContent)))
      .toEqual([['目标', '示例'], ['影响', '只动这一条']])
    // 按钮文案由**执行方**给，前端不写死。
    const buttons = card.querySelectorAll('button')
    expect(buttons.map(button => button.textContent)).toEqual(['就这么办', '算了'])
  })

  it('点确认把决策送出去并锁住按钮（凭据不经过前端）', async () => {
    const page = load()
    const card = page.actionCard({ id: 'op-2', kind: 'blog.publish', title: '发布', summary: 's', state: 'prepared' }, context)
    const [confirm, cancel] = card.querySelectorAll('button')
    confirm!.fire('click')
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(page.acts).toEqual([{ taskId: 'task-1', subtaskId: 's1', actionId: 'op-2', decision: 'confirm', requestId: 'req-1' }])
    expect(confirm!.disabled).toBe(true)
    expect(cancel!.disabled).toBe(true)
  })

  it('办完的、正在办的、过期的一律不再给按钮', () => {
    const page = load()
    for (const state of ['executing', 'succeeded', 'failed', 'cancelled']) {
      const card = page.actionCard({ id: 'op-3', kind: 'blog.publish', title: 't', summary: 's', state }, context)
      expect(card.querySelectorAll('button')).toHaveLength(0)
    }
    // 过期：不给按钮，并说明该重新生成一次。
    const expired = page.actionCard({ id: 'op-4', kind: 'blog.publish', title: 't', summary: 's', state: 'prepared', expiresAt: Date.now() - 1000 }, context)
    expect(expired.querySelectorAll('button')).toHaveLength(0)
    expect(expired.dataset.state).toBe('expired')
    expect(flatten(expired).map(child => child.textContent)).toContain('这条确认已经过期，让它重新生成一次再确认。')
  })

  it('重画整块替换：确认完只剩一张，不会越叠越多', () => {
    const page = load()
    const view: Record<string, unknown> = { footer: make('div', 'msg__col') }
    page.renderActionsInto(view, [{ id: 'a', kind: 'x', title: '一', summary: 's', state: 'prepared' }], context)
    page.renderActionsInto(view, [{ id: 'b', kind: 'x', title: '二', summary: 's', state: 'prepared' }], context)
    const host = view.footer as StubNode
    expect(host.children).toHaveLength(1)
    expect(host.children[0]!.querySelectorAll('.act')).toHaveLength(1)
    expect(flatten(host.children[0]!).map(child => child.textContent)).toContain('二')
    // 空列表：不动已有的卡（"没有待办"由服务端的结果文本表达，不在这里悄悄清空）。
    page.renderActionsInto(view, [], context)
    expect(host.children).toHaveLength(1)
  })
})
