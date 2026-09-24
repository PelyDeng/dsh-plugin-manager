/**
 * 对话导出纯函数单测（批 1b，旧 conversation-history.js conversationMarkdown 对照）。
 */
import { describe, expect, it } from 'vitest'
import { conversationMarkdown, exportFileName } from '../lib/conversation-export.ts'

describe('conversationMarkdown', () => {
  it('标题 + 我/助手分段 + 分隔线（旧口径）', () => {
    const markdown = conversationMarkdown('轨迹会话', [
      { role: 'user', text: '查一下轨迹' },
      { role: 'assistant', text: '轨迹如下' },
      { role: 'tool', text: '不该出现' },
    ])
    expect(markdown).toBe('# 轨迹会话\n\n## 我\n\n查一下轨迹\n\n---\n\n## 助手\n\n轨迹如下\n')
  })

  it('只收正文非空的 user/assistant', () => {
    const markdown = conversationMarkdown('T', [
      { role: 'user', text: '  ' },
      { role: 'assistant', text: '有内容' },
    ])
    expect(markdown).not.toContain('## 我')
    expect(markdown).toContain('## 助手')
  })

  it('标题里的换行拍平（旧 replace(/[\r\n]/g," ")）', () => {
    expect(conversationMarkdown('第一行\n第二行', []).startsWith('# 第一行 第二行')).toBe(true)
  })

  it('空标题退化为「对话记录」', () => {
    expect(conversationMarkdown('', []).startsWith('# 对话记录')).toBe(true)
  })
})

describe('exportFileName', () => {
  it('单会话用标题（消毒 + 截断 60）', () => {
    expect(exportFileName(['会话:标题/一'])).toBe('会话_标题_一.md')
    expect(exportFileName(['x'.repeat(80)])).toBe(`${'x'.repeat(60)}.md`)
  })

  it('多会话用「对话记录」', () => {
    expect(exportFileName(['a', 'b'])).toBe('对话记录.md')
  })

  it('空标题兜底', () => {
    expect(exportFileName([''])).toBe('对话记录.md')
  })
})
