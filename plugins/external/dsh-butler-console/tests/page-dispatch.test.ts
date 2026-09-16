/**
 * 「本次已调度成员」面板。
 *
 * 群里只留大总管的结论与每位成员的一行状态，成员真正在查什么、交回了什么收进这块面板，
 * 用 tab 切换着看——这样大总管汇总时就不用再复述一遍成员原文。默认折叠，点开才是完整流式
 * 输出。本插件没有浏览器工装，按仓库既有做法把函数取出来、用替身 DOM 跑一遍。
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
  listeners: (() => void)[]
  firstDot: StubNode | null
  classList: { toggle(name: string, on: boolean): void }
  appendChild(child: StubNode): StubNode
  addEventListener(_name: string, run: () => void): void
  querySelector(selector: string): StubNode | null
}

function node(tag = '', className = ''): StubNode {
  const classes = new Set(String(className ?? '').split(' ').filter(Boolean))
  const element: StubNode = {
    tag, className, children: [], dataset: {}, hidden: false, open: false, type: '', textContent: '', listeners: [],
    firstDot: null,
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); element.className = [...classes].join(' ') },
    },
    appendChild(child) { element.children.push(child); return child },
    addEventListener(_name, run) { element.listeners.push(run) },
    querySelector(selector) { return selector === '.dot' ? element.firstDot : null },
  }
  return element
}

function loadPanel() {
  const pick = (name: string) => {
    const body = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
    if (body === undefined) throw new Error(`${name} 源码未找到`)
    return body
  }
  const state: { dispatch: unknown } = { dispatch: null }
  const displayNameOf = (id: string) => `成员-${id}`
  const api = Function('state', 'make', 'displayNameOf', 'DISPATCH_TONE',
    `${pick('renderDispatchHeader')}\n${pick('selectDispatch')}\n${pick('mountDispatch')}\n${pick('toggleDispatchResultOnly')}\n`
    + 'return { mountDispatch, selectDispatch, renderDispatchHeader, toggleDispatchResultOnly }',
  )(state, node, displayNameOf, { succeeded: 'ok', failed: 'error', waiting_user: 'warn' }) as {
    mountDispatch(subtasks: { id: string; agentId: string; state?: string }[]): StubNode
    selectDispatch(panel: unknown, id: string): void
    renderDispatchHeader(panel: unknown): void
    toggleDispatchResultOnly(panel: unknown, on: boolean): void
  }
  return { ...api, state }
}

/** 「复制」要碰剪贴板与定时器：两者都注入，标签才不会在断言前被还原。 */
function loadPanelTools(clipboard: { writeText(text: string): Promise<void> }) {
  const body = source.match(/async function copyDispatchText\([^)]*\) \{[\s\S]*?\n\}\n/)?.[0]
  if (body === undefined) throw new Error('copyDispatchText 源码未找到')
  return Function('navigator', 'setTimeout', `${body}\nreturn { copyDispatchText }`)(
    { clipboard }, () => 0,
  ) as { copyDispatchText(panel: unknown, button: StubNode): Promise<void> }
}

const subtasks = [
  { id: 's1', agentId: 'blog', state: 'dispatched' },
  { id: 's2', agentId: 'closedoff', state: 'dispatched' },
]

describe('本次已调度成员面板', () => {
  it('按成员建 tab 与格子，默认收起且停在第一位', () => {
    const f = loadPanel()
    const details = f.mountDispatch(subtasks)
    expect(details.tag).toBe('details')
    // 默认折叠：挂载时不设 open（只有用户点开才展开）。
    expect(details.open).toBe(false)
    const panel = f.state.dispatch as { tabs: StubNode; body: StubNode; active: string }
    expect(panel.tabs.children).toHaveLength(2)
    expect(panel.body.children).toHaveLength(2)
    expect(panel.active).toBe('s1')
    // 只有选中的那格可见。
    expect(panel.body.children.map(slot => slot.hidden)).toEqual([false, true])
  })

  it('切换 tab 只显示那一格，并记住选择', () => {
    const f = loadPanel()
    f.mountDispatch(subtasks)
    const panel = f.state.dispatch as { body: StubNode; buttons: Map<string, StubNode>; active: string }
    f.selectDispatch(panel, 's2')
    expect(panel.active).toBe('s2')
    expect(panel.body.children.map(slot => slot.hidden)).toEqual([true, false])
    // 切回来也认。
    f.selectDispatch(panel, 's1')
    expect(panel.body.children.map(slot => slot.hidden)).toEqual([false, true])
    // 不在名单里的 id 不动状态，也不抛。
    f.selectDispatch(panel, 's9')
    expect(panel.active).toBe('s1')
  })

  it('标题按成员状态报「几个在干活」，全部收工后不再提', () => {
    const f = loadPanel()
    f.mountDispatch(subtasks)
    const panel = f.state.dispatch as { title: StubNode; buttons: Map<string, StubNode> }
    expect(panel.title.textContent).toBe('本次已调度 2 个成员，2 个在干活')
    const first = panel.buttons.get('s1')!
    first.dataset.tone = 'ok'
    f.renderDispatchHeader(panel)
    expect(panel.title.textContent).toBe('本次已调度 2 个成员，1 个在干活')
    panel.buttons.get('s2')!.dataset.tone = 'ok'
    f.renderDispatchHeader(panel)
    expect(panel.title.textContent).toBe('本次已调度 2 个成员')
  })

  it('接线：计划贴纸之后挂面板，成员事件把气泡搬进格子并给群里那行留入口', () => {
    // 计划事件（实时与历史两条路径）都要挂面板，成员气泡靠 handleSubtask 搬进去。
    expect(source.match(/append\(mountDispatch\(/g) ?? []).toHaveLength(2)
    expect(source).toMatch(/function handleSubtask\(event\) \{[\s\S]{0,200}attachToDispatch\(view, event\)/)
    expect(source).toMatch(/function attachToDispatch\(view, event\) \{[\s\S]{0,400}slot\.appendChild\(view\.bubble\)/)
    // 群里那行是入口：点开面板并切到该成员；只绑一次（含键盘可达）。
    expect(source).toContain('panel.details.open = true')
    expect(source).toContain("view.msg.dataset.dispatchBound !== '1'")
    expect(source).toContain("input.key === 'Enter'")
    // 历史回放（任务记录恢复）也把成员输出收进面板，两条路径观感一致。
    expect(source).toMatch(/attachToDispatch\(view, \{ id: subtask\.id, state: subtask\.state \}\)/)
    // 复制取的是成员累积正文，而不是面板 DOM 的全文（免得把思考也拷走）。
    expect(source).toContain('panel.texts.set(event.id, () => view.body ?? \'\')')
  })

  it('「只看结论」开关切换类名与按钮文案', () => {
    const f = loadPanel()
    const body = node()
    const button = node()
    const panel = { body, resultOnlyButton: button, resultOnly: false }
    f.toggleDispatchResultOnly(panel, true)
    expect(panel.resultOnly).toBe(true)
    expect(body.className).toContain('dispatch__body--result-only')
    expect(button.className).toContain('dispatch__tool--on')
    expect(button.textContent).toBe('看完整过程')
    f.toggleDispatchResultOnly(panel, false)
    expect(panel.resultOnly).toBe(false)
    expect(body.className).not.toContain('dispatch__body--result-only')
    expect(button.textContent).toBe('只看结论')
  })

  it('复制当前成员正文：成功报「已复制」，没有内容时如实报失败', async () => {
    const copied: string[] = []
    const failures: string[] = []
    const runner = loadPanelTools({
      writeText: async (text: string) => { copied.push(text); if (text === '炸') throw new Error('denied') },
    })
    const button = node()
    button.textContent = '复制'
    await runner.copyDispatchText({ active: 's1', texts: new Map([['s1', () => '博客交回的清单']]) }, button)
    expect(copied).toEqual(['博客交回的清单'])
    expect(button.textContent).toBe('已复制')

    const empty = node()
    empty.textContent = '复制'
    await runner.copyDispatchText({ active: 's1', texts: new Map([['s1', () => '   ']]) }, empty)
    failures.push(empty.textContent)
    expect(empty.textContent).toBe('复制失败')
  })
})
