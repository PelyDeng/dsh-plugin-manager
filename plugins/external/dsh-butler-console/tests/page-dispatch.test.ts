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
  id: string
  children: StubNode[]
  parent: StubNode | null
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
  replaceChildren(...children: StubNode[]): void
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
    tag, className, id: '', children: [], parent: null, dataset, hidden: false, open: false, type: '', textContent: '', title: '', tabIndex: -1,
    focused: false, attrs, handlers: {},
    replaceChildren(...children: StubNode[]) {
      // 真 DOM 的 replaceChildren：一次换掉全部子节点（历史卡升级用的就是它）。
      for (const child of children) child.parent = element
      element.children = children
    },
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
    appendChild(child) { child.parent = element; element.children.push(child); return child },
    prepend(child) { child.parent = element; element.children.unshift(child) },
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
    // 真实 DOM 的 remove() 是**从父节点摘掉自己**（不是清空自己的子节点）：占位说明被撤掉
    // 这件事只有按这个语义才测得到。
    remove() {
      const parent = element.parent
      if (parent === null) return
      parent.children = parent.children.filter(child => child !== element)
      element.parent = null
    },
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
  settleCardForSummary(state: string, at: number): void
  cardPrefs(taskId: string): Record<string, unknown>
  saveCardPref(taskId: string, patch: Record<string, unknown>): void
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
    // 与真实现同一个签名：`to` 缺省是"现在"（进行中的秒数按它算），替身不能少这个默认值，
    // 否则"定格"与"跳表"这两条断言测的就不是同一件事。
    formatElapsed: (from: number, to: number = now) => `${Math.max(0, Math.round((to - from) / 1000))} 秒`,
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
    'let cardTicker = null', 'let cardSeq = 0', "const CARD_PREF_PREFIX = 'butler.card.'", "const TASK_CARD_CACHE_LIMIT = 50",
    pick('cardPrefs'), pick('saveCardPref'), pick('cardStateText'), pick('cardSettled'), pick('emptySlotHint'),
    pick('cardElapsedText'), pick('syncCardTicker'), pick('mountDispatch'), pick('updateCardCell'),
    pick('toggleDispatchResultOnly'), pick('renderDispatchHeader'), pick('selectDispatch'),
    pick('attachToDispatch'), pick('pulseCardCell'), pick('settleCardForSummary'),
  ].join('\n')
  const loaded = Function(...names, `${body}\nreturn { mountDispatch, selectDispatch, renderDispatchHeader, toggleDispatchResultOnly, attachToDispatch, updateCardCell, cardPrefs, saveCardPref, settleCardForSummary }`)(
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
    const loadUpgrade = (task: Record<string, unknown>, records: (Record<string, unknown> | Error)[]) => {
      const calls: { cards: { value: Record<string, unknown>; options: { live?: boolean } }[]; replaced: StubNode[][]; fetches: number } =
        { cards: [], replaced: [], fetches: 0 }
      const makeNode = (tag: string, className?: string, text?: string) => {
        const element = node(tag, className ?? '')
        if (text !== undefined) element.textContent = String(text)
        element.replaceChildren = ((...nodes: StubNode[]) => { calls.replaced.push(nodes); element.children = nodes }) as never
        return element
      }
      const wrap = node('div', 'entry-task')
      ;(wrap as unknown as { isConnected: boolean }).isConnected = true
      wrap.replaceChildren = ((...nodes: StubNode[]) => { calls.replaced.push(nodes); wrap.children = nodes }) as never
      const api = {
        task: async () => {
          const next = records.length > 1 ? records.shift()! : records[0]!
          calls.fetches += 1
          if (next instanceof Error) throw next
          return next
        },
      }
      const renderTaskCard = (value: Record<string, unknown>, options: { live?: boolean }) => { calls.cards.push({ value, options }); return makeNode('details', 'dcard') }
      const loaded = Function('api', 'renderTaskCard', 'taskSummaryCard', 'cardPrefs', 'make', 'stabilizeViewport',
        `const taskCardRequests = new Map()\n${pickFn('taskRecord')}\n${pickFn('upgradeTaskEntry')}\nreturn { upgradeTaskEntry, taskCardRequests }`,
      )(api, renderTaskCard, (value: unknown) => makeNode('button', 'task-card'), () => ({}), makeNode, (mutate: () => void) => { mutate() }) as {
        upgradeTaskEntry(wrap: StubNode, task: Record<string, unknown>): Promise<void>
        taskCardRequests: Map<string, unknown>
      }
      /** 另一个「活在文档里」的条目节点：并发/再次渲染都要走真实形状（`isConnected` 守卫）。 */
      const connected = () => {
        const other = makeNode('div', 'entry-task')
        ;(other as unknown as { isConnected: boolean }).isConnected = true
        return other
      }
      return { ...loaded, wrap, calls, task, connected }
    }

    // 正常：详情回来之后换成调度卡，并且**不接管**实时那一张的位置（历史可能同时有好几张）。
    const ok = loadUpgrade({ id: 'task-h1' }, [{ id: 'task-h1', state: 'running', subtasks: [] }])
    await ok.upgradeTaskEntry(ok.wrap, ok.task)
    expect(ok.calls.cards).toHaveLength(1)
    expect(ok.calls.cards[0]!.options.live).toBe(false)
    expect((ok.calls.replaced.at(-1)! as StubNode[])[0]!.className).toBe('dcard')

    // 并发渲染同一个任务只问一次服务端；**但不把结果长期缓存**：结局会变，缓存住第一次的
    // 快照，用户切走再切回就会看到一张"永远进行中、秒数还在跳"的历史卡（评审 R2）。
    const fresh = loadUpgrade({ id: 'task-h3' }, [
      { id: 'task-h3', state: 'running', subtasks: [] },
      { id: 'task-h3', state: 'completed', subtasks: [] },
    ])
    await Promise.all([fresh.upgradeTaskEntry(fresh.wrap, fresh.task), fresh.upgradeTaskEntry(fresh.connected(), fresh.task)])
    expect(fresh.calls.fetches).toBe(1)
    const later = fresh.connected()
    await fresh.upgradeTaskEntry(later, fresh.task)
    expect(fresh.calls.fetches).toBe(2)
    expect(fresh.calls.cards.at(-1)!.value.state).toBe('completed')
    expect(later.children[0]!.className).toBe('dcard')

    // 读不到：摘要卡留着 + 如实说明（不是空白，也不是假成功）。
    const bad = loadUpgrade({ id: 'task-h2' }, [new Error('网络异常')])
    await bad.upgradeTaskEntry(bad.wrap, bad.task)
    expect(bad.calls.cards).toHaveLength(0)
    const shown = bad.calls.replaced.at(-1)! as StubNode[]
    expect(shown[0]!.className).toBe('task-card')
    expect(shown[1]!.textContent).toContain('调度卡读不到')
  })

  it('折叠态挂在按钮的 aria-expanded 上，且随折叠同步（读屏拿得到同一份事实）', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-10' })
    const fold = panelOf(card).foldButton as StubNode
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    fold.fire('click')
    card.fire('toggle')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(fold.textContent).toBe('展开')
    fold.fire('click')
    card.fire('toggle')
    expect(fold.getAttribute('aria-expanded')).toBe('true')
  })

  it('tab 与它控制的结果格成对（aria-controls ↔ aria-labelledby），折叠时焦点不留在隐藏格子上', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-11' })
    const panel = panelOf(card)
    const cell = cellOf(card, 's1')
    const slot = panel.slots.get('s1') as StubNode
    expect(cell.getAttribute('aria-controls')).toBe(slot.id)
    expect(slot.getAttribute('role')).toBe('tabpanel')
    expect(slot.getAttribute('aria-labelledby')).toBe(cell.id)
    expect(slot.id).not.toBe('')
    // Esc 收起之后焦点交给还看得见的折叠按钮（不能停在看不见的格子上）。
    card.open = true
    card.fire('keydown', { key: 'Escape' })
    expect(card.open).toBe(false)
    expect((panel.foldButton as StubNode).focused).toBe(true)
  })

  it('还没有内容的格子给一句说明，内容一到就撤掉（不留空白框）', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-12' })
    const panel = panelOf(card)
    const slot = panel.slots.get('s3') as StubNode
    expect(slot.querySelector!('.dcard__empty')!.textContent).toBe('还没开始，等前一步交回材料。')
    // 成员第一段输出到了：占位说明撤掉，气泡进来。
    const view = { msg: node('div', 'msg'), body: '在写了', terminal: false }
    page.attachToDispatch(view, { id: 's3', state: 'running', time: 1_005_000 }, panel)
    expect(slot.children).toContain(view.msg)
    expect(slot.querySelector('.dcard__empty')).toBe(null)
  })

  it('等你回话/待外部处理/终态的秒数都定格（等你回话可能挂几小时，不能一直往上加）', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-13' })
    const panel = panelOf(card)
    const view = { msg: node('div', 'msg'), body: '先看了一部分', terminal: false }
    // 夹具的"现在"是 1_000_000；进行中的秒数按 now - since 走，所以事件时间取在这之前。
    page.attachToDispatch(view, { id: 's3', state: 'dispatched', time: 900_000 }, panel)
    page.attachToDispatch(view, { id: 's3', state: 'running', time: 903_000 }, panel)
    const elapsed = cellOf(card, 's3').querySelector('.dcard__elapsed')!
    expect(elapsed.getAttribute('data-live')).toBe('1')
    expect(elapsed.textContent).toBe('100 秒')
    // 进入等待：秒数在这里定格（按进入等待那一刻算），不再往上走。
    page.attachToDispatch(view, { id: 's3', state: 'waiting_user', time: 905_000 }, panel)
    expect(elapsed.textContent).toBe('5 秒')
    expect(elapsed.getAttribute('data-live')).toBe(null)
    // 回来接着干：照旧跳表。
    page.attachToDispatch(view, { id: 's3', state: 'running', time: 906_000 }, panel)
    expect(elapsed.getAttribute('data-live')).toBe('1')
    // 收尾的状态也定格。
    page.attachToDispatch(view, { id: 's3', state: 'external_pending', time: 908_000 }, panel)
    expect(elapsed.textContent).toBe('8 秒')
    expect(elapsed.getAttribute('data-live')).toBe(null)
  })

  it('一轮收尾的汇总让还在动的格子收口成「已停止」；暂停中的汇总不动它们', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-14' })
    const panel = panelOf(card)
    const view = { msg: node('div', 'msg'), body: '', terminal: false }
    page.attachToDispatch(view, { id: 's2', state: 'running', time: 900_000 }, panel)
    expect(cellOf(card, 's2').querySelector('.dcard__statetext')!.textContent).toBe('进行中')
    // 暂停（等你回话/待外部处理）不是收尾：成员真的还在等，不能说成已停止。
    page.settleCardForSummary('waiting_user', 950_000)
    expect(cellOf(card, 's2').querySelector('.dcard__statetext')!.textContent).toBe('进行中')
    // 收尾：还没定论的格子一律收口，秒数也停。
    page.settleCardForSummary('failed', 960_000)
    expect(cellOf(card, 's2').querySelector('.dcard__statetext')!.textContent).toBe('已停止')
    expect(cellOf(card, 's2').querySelector('.dcard__elapsed')!.getAttribute('data-live')).toBe(null)
    expect(panel.title.textContent).toBe('4 位成员 · 4 位没成')
  })

  it('「只看结论」不藏失败原因的原文（CSS 与行内类名成对，改任一侧就红）', () => {
    const css = readFileSync(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8')
    // 失败/取消的原因原文住在 `.msg__meta` 里；「只看结论」按通配藏 `.msg__meta` 会把它一起藏掉，
    // 而那是用户最需要看到的一句话 ⇒ 这一条必须带 `--keep` 豁免。
    expect(css).toContain('.dcard__slots--result-only .msg__meta:not(.msg__meta--keep) { display: none; }')
    expect(source).toContain("make('div', 'msg__meta msg__meta--keep', event.detail)")
  })

  it('卡片已被清掉就不再往里写成员消息（`state.dispatch` 不会自己归零）', () => {
    const page = load()
    const card = page.mountDispatch(subtasks, { taskId: 'task-15' })
    const panel = panelOf(card)
    const view = { msg: node('div', 'msg'), body: '', terminal: false }
    // 线程被清空：卡片已经不在文档里（真实 DOM 里 `isConnected === false`）。
    ;(card as unknown as { isConnected: boolean }).isConnected = false
    page.attachToDispatch(view, { id: 's1', state: 'running', time: 999_000 }, panel)
    // 结果格里只有那句占位说明，成员消息没有被搬进来（状态也没被改）。
    expect(panel.slots.get('s1').children).not.toContain(view.msg)
    expect(panel.states.get('s1')).toBe('dispatched')
    // 重建路径在卡片挂进线程之前就在填内容：`building` 显式放行。
    panel.building = true
    page.attachToDispatch(view, { id: 's1', state: 'running', time: 999_000 }, panel)
    expect(panel.slots.get('s1').children).toContain(view.msg)
    expect(panel.states.get('s1')).toBe('running')
  })

  it('成员交回内容统一走一个渲染入口：表格/列表在四种结论里都渲染成结构，不是一行文本', () => {
    // 页面里只有一处把成员正文写成 Markdown：`renderMemberContent`。
    expect(source).toContain('function renderMemberContent(view, text)')
    expect(source).toMatch(/function renderMemberContent\(view, text\) \{[\s\S]{0,300}settleMarkdown\(view\.text, body\)/)
    // 四种结论都必须过它：成功、失败、等你回话、待外部处理。
    // 改造前只有"成功"走渲染，其余走 `textContent` —— 业务方看到的表格因此是一行竖线文本。
    expect(source).toContain('renderMemberContent(view, text)')
    // 四种结局：成功走 renderMemberContent，其余三种走 settleMemberBody（先落定流式预览，
    // 没有预览时用服务端给的说明）——都不再直接写 textContent。
    expect(source).toContain('settleMemberBody(view, event.question ?? event.detail)')
    expect(source).toContain('settleMemberBody(view, event.detail)')
    expect(source).not.toMatch(/if \(view\.body === ''\) view\.text\.textContent = event\.(detail|question)/)
    // 刷新重建走同一个入口（实时与重建不会各渲染一套）。
    expect(source).toMatch(/function renderTaskCard\(record, opts = \{\}\) \{[\s\S]{0,2600}renderMemberContent\(view, text\)/)
  })

  it('Markdown 表格真的产出表格结构（业务方截图里那一段就是表格）', async () => {
    // 用真渲染器跑一遍节点计划（`markdownPlan` 是纯数据、不碰 DOM）：必须是 table/thead/tbody/tr/th/td。
    // `web/` 是浏览器源码（无类型声明），按仓库既有做法取出函数、把解析器注入后执行。
    const mdSource = readFileSync(fileURLToPath(new URL('../web/markdown.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
    const MarkdownIt = (await import('markdown-it')).default
    // 去掉 import 与 `export` 关键字（取出来的是一个函数体，不是模块）。
    const body = mdSource.replace(/^import .*$/m, '').replace(/^export /gm, '')
    const planOf = Function('MarkdownIt', `${body}\nreturn markdownPlan`)(MarkdownIt) as (text: string) => unknown[]
    const plan = planOf([
      '| 项目 | 值 |',
      '| --- | --- |',
      '| 状态 | prepared |',
      '',
      '- 第一项',
      '- 第二项',
    ].join('\n'))
    const tags = JSON.stringify(plan)
    expect(tags).toContain('"tag":"table"')
    expect(tags).toContain('"tag":"thead"')
    expect(tags).toContain('"tag":"tbody"')
    expect(tags).toContain('"tag":"th"')
    expect(tags).toContain('"tag":"td"')
    expect(tags).toContain('"tag":"ul"')
    // 大表格套一层可聚焦的横向滚动容器（窄屏不破版）。
    expect(tags).toContain('table-scroll')
  })

  it('任务记录视图有返回入口，且与浏览器返回键走同一条栈', () => {
    expect(source).toContain('function viewHead()')
    expect(source).toContain('会话 › 任务记录')
    expect(source).toMatch(/function openTask\(id\) \{[\s\S]{0,900}pushViewState\(\{ butler: 'task', taskId: record\.id, conversationId: record\.conversationId \}\)/)
    expect(source).toMatch(/function openTask\(id\) \{[\s\S]{0,1100}inner\.appendChild\(viewHead\(\)\)/)
    // 返回按钮：优先退栈（与浏览器返回键同一条路径），没有栈就按当前会话回。
    expect(source).toMatch(/viewHead\(\) \{[\s\S]{0,700}canGoBack\(\)\) history\.back\(\)/)
    expect(source).toMatch(/function bindViewHistory\(\) \{[\s\S]{0,600}value\.butler === 'task'[\s\S]{0,200}openTask\(value\.taskId\)/)
    // 会话是栈底：进入时替换而不是压栈（否则栈里会堆满同一个会话）。
    expect(source).toMatch(/replaceViewState\(\{ butler: 'conversation', conversationId: id \}\)/)
  })

  it('流式预览在「待外部处理/等你回话/失败」结束时也要落定成 Markdown（生产截图抓到的那条）', () => {
    // 流式增量是纯文本（`appendPreviewText`），只有 succeeded 那条路径落定过 —— 于是成员
    // 交回的 Markdown 表格在"待外部处理"里仍然是一行竖线文本。这条钉住四种结局都落定。
    expect(source).toContain('function settleMemberBody(view, fallback)')
    expect(source).toMatch(/function settleMemberBody\(view, fallback\) \{[\s\S]{0,400}renderMemberContent\(view, body\)/)
    expect(source).toContain('settleMemberBody(view, event.question ?? event.detail)')
    expect(source).toContain('settleMemberBody(view, event.detail)')
    // 有正文的失败：正文落定 + 失败原因另起一行（那一行不被「只看结论」藏掉）。
    expect(source).toMatch(/renderMemberContent\(view, view\.body\)[\s\S]{0,200}msg__meta msg__meta--keep/)
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
