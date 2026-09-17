/**
 * 调度卡。
 *
 * 本次派活只有这一张卡：状态条 + 成员格子（一行最多三个）+ 选中成员的结果区。它替掉了原先
 * 三处重复（「已分派」计划贴纸、群里每位成员的一行状态、「本次已调度 N 个成员」面板），
 * 格子是**唯一**的状态来源。
 *
 * 这里跑的是"真源码 + 替身 DOM"：本插件没有浏览器工装（同 `page-thinking.test.ts` 的做法）。
 * 替身 DOM 必须支持真实交互用到的面（事件、`classList`、`setAttribute`、`querySelector`、
 * `dataset`、`focus`），否则"点击/键盘/脉冲"这几条就测不到——那正是这次改造的重点。
 *
 * 三条交互各有**能变红**的判据（见文件末尾的变异说明），并且刷新后的一致性也在这里钉住：
 * 偏好存在本机、由 `mountDispatch` 在渲染时先读。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

interface StubNode {
  tag: string
  className: string
  children: StubNode[]
  dataset: Record<string, string>
  hidden: boolean
  open: boolean
  type: string
  textContent: string
  title: string
  tabIndex: number
  focused: boolean
  attrs: Record<string, string>
  /** 事件名 → 注册的回调（本替身只保留一层，够用且足以发现"根本没绑"）。 */
  handlers: Record<string, ((event: StubEvent) => void)[]>
  classList: {
    add(name: string): void
    remove(name: string): void
    toggle(name: string, on?: boolean): void
    contains(name: string): boolean
  }
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  removeAttribute(name: string): void
  appendChild(child: StubNode): StubNode
  prepend(child: StubNode): void
  addEventListener(name: string, run: (event: StubEvent) => void): void
  fire(name: string, event?: Partial<StubEvent>): void
  querySelector(selector: string): StubNode | null
  focus(): void
  remove(): void
}

interface StubEvent {
  key: string
  preventDefault(): void
  stopPropagation(): void
  defaultPrevented: boolean
}

/** 一个够真的替身节点：类名、属性、dataset、事件、查询都按真实用法实现。 */
function node(tag = '', className = ''): StubNode {
  const classes = new Set(String(className ?? '').split(' ').filter(Boolean))
  const attrs: Record<string, string> = {}
  const kebab = (key: string) => key.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
  // `dataset` 与 `data-*` 属性是同一份东西（真实 DOM 就是这样）：只用其中一种写法断言，
  // 会让"实现改用另一种写法"这件事变成假红/假绿。
  const dataset = new Proxy({} as Record<string, string>, {
    get: (_target, key) => attrs[`data-${kebab(String(key))}`],
    set: (_target, key, value) => {
      const name = `data-${kebab(String(key))}`
      if (value === undefined || value === null) delete attrs[name]
      else attrs[name] = String(value)
      return true
    },
    deleteProperty: (_target, key) => { delete attrs[`data-${kebab(String(key))}`]; return true },
  })
  const element: StubNode = {
    tag, className, children: [], dataset, hidden: false, open: false, type: '', textContent: '', title: '', tabIndex: -1,
    focused: false, attrs, handlers: {},
    classList: {
      add(name) { classes.add(name); element.className = [...classes].join(' ') },
      remove(name) { classes.delete(name); element.className = [...classes].join(' ') },
      toggle(name, on) {
        const wanted = on === undefined ? !classes.has(name) : on
        if (wanted) classes.add(name); else classes.delete(name)
        element.className = [...classes].join(' ')
      },
      contains(name) { return classes.has(name) },
    },
    setAttribute(name, value) { element.attrs[name] = String(value) },
    getAttribute(name) { return element.attrs[name] ?? null },
    removeAttribute(name) { delete element.attrs[name] },
    appendChild(child) { element.children.push(child); return child },
    prepend(child) { element.children.unshift(child) },
    addEventListener(name, run) { (element.handlers[name] ??= []).push(run) },
    fire(name, event = {}) {
      const full: StubEvent = {
        key: event.key ?? '', defaultPrevented: false,
        preventDefault() { full.defaultPrevented = true },
        stopPropagation() {},
        ...event,
      }
      for (const run of element.handlers[name] ?? []) run(full)
    },
    querySelector(selector) { return find(element, selector) },
    focus() { element.focused = true },
    remove() { element.children = [] },
  }
  return element
}

/** 只支持这一批用例用到的选择器：`.class` 与 `tag.class`（够表达格子里的圆点、状态词与秒数）。 */
function find(root: StubNode, selector: string): StubNode | null {
  const [tag, cls] = selector.startsWith('.') ? ['', selector.slice(1)] : selector.split('.')
  const matches = (candidate: StubNode) =>
    (tag === '' || candidate.tag === tag) && (cls === undefined || candidate.classList.contains(cls))
  const walk = (current: StubNode): StubNode | null => {
    for (const child of current.children) {
      if (matches(child)) return child
      const deeper = walk(child)
      if (deeper !== null) return deeper
    }
    return null
  }
  return walk(root)
}

function make(tag: string, className: string | null, text?: string): StubNode {
  const element = node(tag, className ?? '')
  if (text !== undefined && text !== null) element.textContent = String(text)
  return element
}

/** 页面状态与替身的本机存储（偏好就落在这里）。 */
function storage() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    map,
  }
}

interface Loaded {
  mountDispatch(subtasks: { id: string; agentId: string; state?: string; goal?: string; startedAt?: number; finishedAt?: number }[], options?: Record<string, unknown>): StubNode
  selectDispatch(panel: unknown, id: string): void
  renderDispatchHeader(panel: unknown): void
  toggleDispatchResultOnly(panel: unknown, on: boolean): void
  attachToDispatch(view: unknown, event: Record<string, unknown>, panel?: unknown): void
  updateCardCell(panel: unknown, id: string): void
  state: { dispatch: unknown; taskId: string | null }
  localStorage: ReturnType<typeof storage>
}

function pick(name: string) {
  // `async` 前缀要一起取到：只取 `function …` 会让取出来的片段里的 `await` 变成语法错误
  // （而错误信息指向 Function 构造，非常难认）。
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
  if (body === undefined) throw new Error(`${name} 源码未找到`)
  return body
}

/**
 * 取出一组页面函数并注入替身。
 *
 * `DISPATCH_TONE` / `CARD_STATE_TEXT` / `CARD_RESULT_TITLE` 是按源码里的字面量注入的常量：
 * 它们只是查表，取出来跑不会增加判据强度，反而让用例与实现的常量名绑死。
 */
function load(now = 1_000_000): Loaded {
  const state: { dispatch: unknown; taskId: string | null } = { dispatch: null, taskId: null }
  const localStorage = storage()
  let ticker: (() => void) | null = null
  const globals: Record<string, unknown> = {
    state, localStorage, make,
    displayNameOf: (id: string) => `成员-${id}`,
    avatarNode: (id: string) => make('div', 'avatar avatar--sm', id),
    formatElapsed: (from: number, to: number) => `${Math.max(0, Math.round((to - from) / 1000))} 秒`,
    STATE_TEXT: { queued: '排队中', running: '在干活', succeeded: '已完成', failed: '失败', cancelled: '已停止', waiting_user: '等你回话', external_pending: '待外部处理', completed: '已完成' },
    DISPATCH_TONE: { succeeded: 'ok', completed: 'ok', failed: 'error', cancelled: 'error', waiting_user: 'warn', external_pending: 'warn' },
    CARD_STATE_TEXT: { queued: '排队', dispatched: '已收到', running: '进行中', waiting_user: '等你回话', external_pending: '待外部处理', partial: '部分完成', succeeded: '已完成', completed: '已完成', failed: '失败', cancelled: '已停止', summarizing: '在总结' },
    CARD_RESULT_TITLE: { queued: '还没开始', dispatched: '正在做的事', running: '正在做的事', summarizing: '正在总结', succeeded: '交回的内容', completed: '交回的内容', external_pending: '交回的内容（还有事在外面办）', waiting_user: '等你回话', partial: '交回的部分', failed: '失败原因', cancelled: '已经停下' },
    Date: { now: () => now },
    document: { querySelectorAll: () => [] as unknown[] },
    setInterval: (run: () => void) => { ticker = run; return 1 },
    clearInterval: () => { ticker = null },
    setTimeout: () => 1,
  }
  const names = Object.keys(globals)
  const body = [
    // 模块级的那一个定时器与偏好前缀：取函数时一并声明，免得替身里没有它们。
    'let cardTicker = null', "const CARD_PREF_PREFIX = 'butler.card.'",
    pick('cardPrefs'), pick('saveCardPref'), pick('cardStateText'), pick('cardWorking'), pick('cardSettled'),
    pick('cardElapsedText'), pick('syncCardTicker'), pick('mountDispatch'), pick('updateCardCell'),
    pick('toggleDispatchResultOnly'), pick('renderDispatchHeader'), pick('selectDispatch'),
    pick('attachToDispatch'), pick('pulseCardCell'),
  ].join('\n')
  const loaded = Function(...names, `${body}\nreturn { mountDispatch, selectDispatch, renderDispatchHeader, toggleDispatchResultOnly, attachToDispatch, updateCardCell, cardPrefs, saveCardPref }`)(
    ...names.map(name => globals[name]),
  ) as Loaded
  loaded.state = state
  loaded.localStorage = localStorage
  return loaded
}

const subtasks = [
  { id: 's1', agentId: 'blog', state: 'dispatched', goal: '写一篇博客' },
  { id: 's2', agentId: 'closedoff', state: 'running', goal: '整理封闭化材料' },
  { id: 's3', agentId: 'butler', state: 'queued', goal: '汇总' },
  { id: 's4', agentId: 'helper', state: 'queued', goal: '第四位' },
]

/** 面板对象：从卡片节点上取（卡片把它挂在自己的节点上，历史那一页可能同时有好几张）。 */
const panelOf = (card: StubNode) => (card as unknown as { __dcard: Record<string, any> }).__dcard

const cellOf = (card: StubNode, id: string) =>
  card.children.flatMap(child => child.children).find(child => child.dataset.id === id)!

describe('调度卡', () => {
  it('一张卡装下所有成员：格子按状态给词给点，状态条给计数', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-1' })
    expect(card.tag).toBe('details')
    const panel = panelOf(card)
    expect(panel.order).toEqual(['s1', 's2', 's3', 's4'])
    // 四个成员在四个格子里，不再有"计划贴纸 + 独立成员行 + 折叠面板"三处重复。
    expect(panel.buttons.size).toBe(4)
    const grid = card.children.find(child => child.tag === 'div')!
    expect(grid.children).toHaveLength(4)
    expect(grid.children.map(cell => cell.querySelector('.dcard__statetext')!.textContent))
      .toEqual(['已收到', '进行中', '排队', '排队'])
    expect(panel.title.textContent).toBe('4 位成员 · 2 位进行中 · 2 位排队')
  })

  it('点格子选中并显示它的结果区；再点已选中的不变（没有"空选"这种态）', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-3' })
    const panel = panelOf(card)
    const first = cellOf(card, 's1')
    const second = cellOf(card, 's2')
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect([...panel.slots.values()].map((slot: StubNode) => slot.hidden)).toEqual([false, true, true, true])
    second.fire('click')
    expect(panel.active).toBe('s2')
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(first.getAttribute('aria-selected')).toBe('false')
    expect([...panel.slots.values()].map((slot: StubNode) => slot.hidden)).toEqual([true, false, true, true])
    // 再点一次：选中不动、结果区不收起（收起是"折叠"这一个动作的事）。
    second.fire('click')
    expect(panel.active).toBe('s2')
    expect(panel.slots.get('s2').hidden).toBe(false)
  })

  it('方向键换人，Esc 收起整卡（键盘不能只服务鼠标）', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-4' })
    const panel = panelOf(card)
    const grid = card.children.find(child => child.tag === 'div')!
    grid.fire('keydown', { key: 'ArrowRight' })
    expect(panel.active).toBe('s2')
    expect(cellOf(card, 's2').focused).toBe(true)
    grid.fire('keydown', { key: 'ArrowLeft' })
    expect(panel.active).toBe('s1')
    card.open = true
    card.fire('keydown', { key: 'Escape' })
    expect(card.open).toBe(false)
  })

  it('折叠与「只看结论」跟着任务存在本机，重建时先读偏好（刷新后一致）', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-5' })
    const panel = panelOf(card)
    // 默认展开：正在干活时用户要看得到谁在干。
    expect(card.open).toBe(true)
    const fold = panel.foldButton as StubNode
    fold.fire('click')
    expect(card.open).toBe(false)
    // 浏览器在 open 变化后会派发 toggle：按钮文案与偏好都在那一个回调里同步（程序化改 open
    // 同样会派发，所以只有一处真相）。
    card.fire('toggle')
    expect(fold.textContent).toBe('展开')
    expect(page.localStorage.map.get('butler.card.task-5')).toBe('{"open":false}')
    // 「只看结论」同样记住。
    panel.resultOnlyButton.fire('click')
    expect(page.localStorage.map.get('butler.card.task-5')).toBe('{"open":false,"resultOnly":true}')
    expect(panel.body.classList.contains('dcard__slots--result-only')).toBe(true)
    // 刷新：同一张卡按偏好重建。
    const again = page.mountDispatch(subtasks, { taskId: 'task-5' })
    expect(again.open).toBe(false)
    expect(panelOf(again).resultOnly).toBe(true)
    expect(panelOf(again).resultOnlyButton.textContent).toBe('看完整过程')
    // 另一个任务不受影响。
    const other = page.mountDispatch(subtasks, { taskId: 'task-6' })
    expect(other.open).toBe(true)
  })

  it('默认折叠留给历史那种"一次好几张卡"的场景', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-7', defaultOpen: false })
    expect(card.open).toBe(false)
  })

  it('成员状态更新：选中格不变、格子只更新自己，秒数按真实起止走', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-8' })
    const panel = panelOf(card)
    cellOf(card, 's2').fire('click')
    const view = { msg: node('div', 'msg'), body: '已经查完三篇文章', terminal: false }
    // 真实顺序：先派发（记开始时刻，秒数开始跳），再交回（定格）。
    page.attachToDispatch(view, { id: 's1', state: 'dispatched', time: 1_000_000 }, panel)
    expect(cellOf(card, 's1').querySelector('.dcard__elapsed')!.getAttribute('data-live')).toBe('1')
    page.attachToDispatch(view, { id: 's1', state: 'succeeded', time: 1_002_000 }, panel)
    // 选中仍是 s2：别人的进展不抢焦点、不改用户正在看的那一格。
    expect(panel.active).toBe('s2')
    expect(cellOf(card, 's1').querySelector('.dcard__statetext')!.textContent).toBe('已完成')
    expect(cellOf(card, 's1').classList.contains('dcard__cell--pulse')).toBe(true)
    expect(panel.title.textContent).toBe('4 位成员 · 1 位进行中 · 2 位排队 · 1 位已交回')
    // 成员的整条消息被搬进它自己的格子（群里不再有单独一行）。
    expect(panel.slots.get('s1').children).toContain(view.msg)
    // 秒数：完成的那一格定格（不再往上走）。
    expect(cellOf(card, 's1').querySelector('.dcard__elapsed')!.textContent).toBe('2 秒')
    expect(cellOf(card, 's1').querySelector('.dcard__elapsed')!.getAttribute('data-live')).toBe(null)
  })

  it('收起时来了新进展：状态条上出现「有更新」，展开即消失', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-9' })
    const panel = panelOf(card)
    const fresh = panel.fresh as StubNode
    expect(fresh.hidden).toBe(true)
    page.attachToDispatch({ msg: node(), body: '' }, { id: 's3', state: 'running', time: 1_003_000 }, panel)
    expect(fresh.hidden).toBe(true)
    card.open = false
    page.attachToDispatch({ msg: node(), body: '' }, { id: 's3', state: 'succeeded', time: 1_004_000 }, panel)
    expect(fresh.hidden).toBe(false)
    card.open = true
    card.fire('toggle')
    expect(fresh.hidden).toBe(true)
  })

  it('「只看结论」开关切换类名与按钮文案', () => {
    const page = load()
    const body = node('div', 'dcard__slots')
    const button = node('button', 'dcard__tool')
    const panel = { body, resultOnlyButton: button, resultOnly: false }
    page.toggleDispatchResultOnly(panel, true)
    expect(panel.resultOnly).toBe(true)
    expect(body.className).toContain('dcard__slots--result-only')
    expect(button.className).toContain('dcard__tool--on')
    expect(button.textContent).toBe('看完整过程')
    page.toggleDispatchResultOnly(panel, false)
    expect(panel.resultOnly).toBe(false)
    expect(body.className).not.toContain('dcard__slots--result-only')
    expect(button.textContent).toBe('只看结论')
  })

  it('接线：实时与重建共用同一条渲染路径，历史也换成同一张卡', () => {
    // 实时：计划事件建卡（唯一来源），成员事件把整条消息搬进它自己的格子。
    expect(source).toMatch(/case 'plan':[\s\S]{0,900}mountDispatch\(event\.subtasks, \{ taskId: event\.taskId, live: true \}\)/)
    expect(source).toMatch(/function handleSubtask\(event\) \{[\s\S]{0,400}attachToDispatch\(view, event\)/)
    expect(source).toMatch(/function attachToDispatch\(view, event, panel = state\.dispatch\) \{[\s\S]{0,400}slot\.appendChild\(view\.msg\)/)
    // 重建：任务记录与历史条目都走 renderTaskCard（刷新后与执行时同一个组件）。
    expect(source).toMatch(/append\(renderTaskCard\(record, \{ liveResume, live: true \}\)\)/)
    expect(source).toMatch(/function taskHistoryEntry\(task\) \{[\s\S]{0,400}upgradeTaskEntry\(wrap, task\)/)
    expect(source).toMatch(/async function upgradeTaskEntry\(wrap, task\) \{[\s\S]{0,900}renderTaskCard\(record, \{ live: false/)
    // 复制取的是成员累积正文，而不是卡片 DOM 的全文（免得把思考也拷走）。
    expect(source).toContain("panel.texts.set(event.id, () => view.body ?? '')")
  })

  it('历史条目拿到任务详情后就地换成同一张调度卡；读不到时留着摘要卡并说明原因', async () => {
    const pickFn = (name: string) => {
      const body = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
      if (body === undefined) throw new Error(`${name} 源码未找到`)
      return body
    }
    const loadUpgrade = (task: Record<string, unknown>, record: Record<string, unknown> | Error) => {
      const calls: { cards: unknown[]; replaced: unknown[][] } = { cards: [], replaced: [] }
      const makeNode = (tag: string, className?: string, text?: string) => {
        const element = node(tag, className ?? '')
        if (text !== undefined) element.textContent = String(text)
        element.replaceChildren = ((...nodes: StubNode[]) => { calls.replaced.push(nodes); element.children = nodes }) as never
        return element
      }
      const wrap = node('div', 'entry-task')
      ;(wrap as unknown as { isConnected: boolean }).isConnected = true
      wrap.replaceChildren = ((...nodes: StubNode[]) => { calls.replaced.push(nodes); wrap.children = nodes }) as never
      const api = { task: async () => { if (record instanceof Error) throw record; return record } }
      const renderTaskCard = (value: unknown, options: unknown) => { calls.cards.push({ value, options }); return makeNode('details', 'dcard') }
      const loaded = Function('api', 'renderTaskCard', 'taskSummaryCard', 'cardPrefs', 'make',
        `const taskCardRequests = new Map()\n${pickFn('taskRecord')}\n${pickFn('upgradeTaskEntry')}\nreturn { upgradeTaskEntry, taskCardRequests }`,
      )(api, renderTaskCard, (value: unknown) => makeNode('button', 'task-card'), () => ({}), makeNode) as {
        upgradeTaskEntry(wrap: StubNode, task: Record<string, unknown>): Promise<void>
        taskCardRequests: Map<string, unknown>
      }
      return { ...loaded, wrap, calls, task }
    }

    // 正常：详情回来之后换成调度卡，并且**不接管**实时那一张的位置（历史可能同时有好几张）。
    const ok = loadUpgrade({ id: 'task-h1' }, { id: 'task-h1', subtasks: [] })
    await ok.upgradeTaskEntry(ok.wrap, ok.task)
    expect(ok.calls.cards).toHaveLength(1)
    expect((ok.calls.cards[0] as { options: { live: boolean } }).options.live).toBe(false)
    expect(ok.calls.replaced.at(-1)![0]!.className).toBe('dcard')
    // 同一批任务只取一次详情。
    expect(ok.taskCardRequests.size).toBe(1)

    // 读不到：摘要卡留着 + 如实说明（不是空白，也不是假成功）。
    const bad = loadUpgrade({ id: 'task-h2' }, new Error('网络异常'))
    await bad.upgradeTaskEntry(bad.wrap, bad.task)
    expect(bad.calls.cards).toHaveLength(0)
    const shown = bad.calls.replaced.at(-1)!
    expect(shown[0]!.className).toBe('task-card')
    expect(shown[1]!.textContent).toContain('调度卡读不到')
  })

  it('复制当前成员正文：成功报「已复制」，没有内容时如实报失败', async () => {
    const body = source.match(/async function copyDispatchText\([^)]*\) \{[\s\S]*?\n\}\n/)?.[0]
    if (body === undefined) throw new Error('copyDispatchText 源码未找到')
    const runner = Function('navigator', 'setTimeout', `${body}\nreturn { copyDispatchText }`)(
      { clipboard: { writeText: async (text: string) => { copied.push(text) } } }, () => 0,
    ) as { copyDispatchText(panel: unknown, button: StubNode): Promise<void> }
    const copied: string[] = []
    const button = node('button', 'dcard__tool')
    button.textContent = '复制'
    await runner.copyDispatchText({ active: 's1', texts: new Map([['s1', () => '博客交回的清单']]) }, button)
    expect(copied).toEqual(['博客交回的清单'])
    expect(button.textContent).toBe('已复制')
    const empty = node('button', 'dcard__tool')
    empty.textContent = '复制'
    await runner.copyDispatchText({ active: 's1', texts: new Map([['s1', () => '   ']]) }, empty)
    expect(empty.textContent).toBe('复制失败')
  })
})
