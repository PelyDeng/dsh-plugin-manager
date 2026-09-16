/**
 * 成员名单在页面上的说法。
 *
 * 名单只收能接活的成员（服务端按调度执行入口过滤，见 `member-busy.test.ts`），所以页面上
 * 没有「在场但派不了活」这一档：群头、右栏与状态列表只说成员数、谁在忙。开场示例话题同理，
 * 只写群里真有人能接的活。
 *
 * 本插件没有浏览器工装，按仓库既有做法把函数取出来、用替身 DOM 跑一遍。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

interface StubNode {
  tag: string
  className: string
  children: StubNode[]
  textContent: string
  title: string
  appendChild(child: StubNode): StubNode
  prepend(child: StubNode): void
}

function node(tag = '', className = ''): StubNode {
  return {
    tag, className, children: [], textContent: '', title: '',
    appendChild(child) { this.children.push(child); return child },
    prepend(child) { this.children.unshift(child) },
  }
}

/** 页面里的 `make(tag, className, text)` 替身：文本走 textContent，不做标记解析。 */
function make(tag: string, className: string | null, text?: string): StubNode {
  const element = node(tag, className ?? '')
  if (text !== undefined) element.textContent = text
  return element
}

/** 把用到的页面函数取出来，注入替身 DOM 与状态。 */
function loadRoster() {
  const pick = (name: string) => {
    const body = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
    if (body === undefined) throw new Error(`${name} 源码未找到`)
    return body
  }
  const el = { crewFaces: node(), crewLine: node(), crewNote: node(), groupSub: node(), memberList: node(), statusList: node() }
  const state: { members: unknown[] } = { members: [] }
  const avatarNode = (agentId: string) => {
    const face = node('span', 'avatar')
    face.textContent = agentId
    return face
  }
  const clear = (parent: StubNode) => { parent.children = [] }
  const stateText = { running: '在干活', waiting_user: '等着你回话' }
  const api = Function('state', 'el', 'make', 'clear', 'avatarNode', 'STATE_TEXT',
    `${pick('renderMembers')}\n${pick('renderCrew')}\n${pick('renderStatuses')}\n`
    + 'return { renderMembers, renderCrew, renderStatuses }',
  )(state, el, make, clear, avatarNode, stateText) as {
    renderMembers(): void
    renderCrew(): void
    renderStatuses(): void
  }
  return { ...api, el, state }
}

const members = [
  { agentId: 'blog', displayName: '博客', declaredName: '博客工作台', busy: null },
  { agentId: 'closedoff', displayName: '封闭化助手', declaredName: '封闭化助手', busy: { taskId: 't', subtaskId: 's', state: 'running' } },
  { agentId: 'helper', displayName: '第三位', declaredName: '第三位', busy: { taskId: 't', subtaskId: 's2', state: 'waiting_user' } },
]

/** 状态行：头像、名字、状态（状态格在第 3 个位置）。 */
const stateTextOf = (row: StubNode) => row.children[2]?.textContent

describe('成员名单的页面文案', () => {
  it('群头只说成员数与在忙数，不再分「能干活」', () => {
    const page = loadRoster()
    page.state.members = members
    page.renderCrew()
    expect(page.el.crewLine.textContent).toBe('3 个牛马 · 2 位在忙')
    expect(page.el.crewNote.textContent).toBe('共 3 位 · 2 位在忙')
    expect(page.el.groupSub.textContent).toBe('3 位成员 · 2 位在忙')
    expect(page.el.crewFaces.children).toHaveLength(3)
  })

  it('没人在忙时不带尾巴，也不提「未接入调度」', () => {
    const page = loadRoster()
    page.state.members = [{ agentId: 'blog', displayName: '博客', declaredName: '博客工作台', busy: null }]
    page.renderCrew()
    page.renderStatuses()
    expect(page.el.groupSub.textContent).toBe('1 位成员')
    expect(page.el.crewLine.textContent).toBe('1 个牛马')
    expect(page.el.statusList.children.map(stateTextOf)).toEqual(['待命'])
    expect(JSON.stringify(page.el.statusList.children)).not.toContain('未接入调度')
  })

  it('状态列表按手上有没有活说话', () => {
    const page = loadRoster()
    page.state.members = members
    page.renderStatuses()
    expect(page.el.statusList.children.map(stateTextOf)).toEqual(['待命', '在干活', '等着你回话'])
  })

  it('右栏成员行只列人，不再挂一个恒亮的状态点', () => {
    const page = loadRoster()
    page.state.members = members
    page.renderMembers()
    expect(page.el.memberList.children).toHaveLength(3)
    for (const row of page.el.memberList.children) {
      // 头像 + 名字两栏，没有第三个「在线」标记：名单上的人都能接活。
      expect(row.children).toHaveLength(2)
      expect(row.children.map(child => child.className)).toEqual(['avatar', 'member__col'])
    }
  })

  it('空名单时给一句人话', () => {
    const page = loadRoster()
    page.renderMembers()
    expect(page.el.memberList.children[0]?.textContent).toBe('还没有能派活的成员。')
  })

  it('开场示例话题不提没有成员能接的开发接入问题', () => {
    const list = source.match(/const SUGGESTIONS = \[([\s\S]*?)\n\]/)?.[1] ?? ''
    const items = [...list.matchAll(/'([^']+)'/g)].map(match => match[1]!)
    expect(items.length).toBeGreaterThan(0)
    expect(items.filter(text => /接入|声明文件|插件开发/.test(text))).toEqual([])
  })
})
