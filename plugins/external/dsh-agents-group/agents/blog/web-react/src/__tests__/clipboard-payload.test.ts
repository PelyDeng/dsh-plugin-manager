/**
 * 剪贴板 payload 的等价单测（删码评审 B F3：旧 tests/clipboard.test.ts 的
 * 粘贴/命名用例与旧 chat-ui 导出语义随 vanilla 前端删除，React 侧实现分别
 * 收敛在 chat-controller（attachmentName/transferredFiles）与 lib/history.ts
 * （conversationMarkdown/exportFileName），这里补回护栏）。
 *
 * 导出的敏感文本边界沿用旧口径：只导出问答正文（user/assistant 的非空文本），
 * 工具记录等其余角色（含 PRIVATE-RESULT 类工具原文）不进剪贴板与下载文件。
 */
import { describe, expect, it } from 'vitest'
import { installBrowserGlobals } from './helpers.ts'

installBrowserGlobals()

const { attachmentName, transferredFiles } = await import('../chat-controller.ts')
const { conversationMarkdown, exportFileName } = await import('../lib/history.ts')

describe('剪贴板/拖放的文件提取（transferredFiles）', () => {
  it('files 与 items 只收一次文件 payload；纯文本不是普通粘贴之外的文件', () => {
    const image = new File(['image'], 'image.png', { type: 'image/png' })
    const document = new File(['doc'], 'notes.docx')
    // files 优先：items 不重复计入。
    expect(transferredFiles({ files: [image, document], items: [{ kind: 'file', getAsFile: () => image }] } as unknown as DataTransfer)).toEqual([image, document])
    // 无 files 时回退 items：字符串条目与空引用过滤。
    expect(transferredFiles({ files: [], items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => image }, { kind: 'file', getAsFile: () => null }] } as unknown as DataTransfer)).toEqual([image])
    expect(transferredFiles({ files: [], items: [{ kind: 'string' }] } as unknown as DataTransfer)).toEqual([])
    expect(transferredFiles(null)).toEqual([])
  })
})

describe('粘贴文件命名（attachmentName）', () => {
  it('带扩展名的原名保留；无名图片给时间戳名', () => {
    expect(attachmentName(new File(['doc'], 'notes.docx'))).toBe('notes.docx')
    expect(attachmentName(new File(['image'], 'image', { type: 'image/png' }))).toMatch(/^粘贴图片-\d+-1\.png$/)
  })

  it('已知图片类型按扩展名映射，无名与未知类型各自回落', () => {
    expect(attachmentName(new File(['x'], '', { type: 'image/webp' }))).toMatch(/^粘贴图片-\d+-1\.webp$/)
    expect(attachmentName(new File(['x'], 'photo.jpeg'))).toBe('photo.jpeg')
    // 名字没有扩展名的已知图片类型走时间戳映射（旧码同口径）。
    expect(attachmentName(new File(['x'], 'blob', { type: 'image/gif' }))).toMatch(/\.gif$/)
    // 完全无名的非图片文件：序号占位名。
    expect(attachmentName(new File(['x'], ''))).toBe('粘贴文件-1')
    // 多份文件时序号随 index 递增。
    expect(attachmentName(new File(['x'], '', { type: 'image/png' }), 2)).toMatch(/^粘贴图片-\d+-3\.png$/)
  })
})

describe('导出复制的文本组装（conversationMarkdown/exportFileName）', () => {
  it('标题消毒 + 问答分段，分隔线只落在段落之间', () => {
    const text = conversationMarkdown('我的对话', [
      { role: 'user', text: '第一问' },
      { role: 'assistant', text: '第一答' },
      { role: 'assistant', text: '第二答' },
    ])
    expect(text).toBe('# 我的对话\n\n## 我\n\n第一问\n\n---\n\n## 助手\n\n第一答\n\n---\n\n## 助手\n\n第二答\n')
  })

  it('空文本与非问答角色不进导出（PRIVATE-RESULT 类工具原文不泄漏）', () => {
    const text = conversationMarkdown('导出', [
      { role: 'user', text: '问' },
      { role: 'tool', text: 'PRIVATE-RESULT' },
      { role: 'assistant', text: '   ' },
      { role: 'assistant', text: '答' },
    ])
    expect(text).toContain('## 我\n\n问')
    expect(text).toContain('## 助手\n\n答')
    expect(text).not.toContain('PRIVATE-RESULT')
    expect(text).not.toContain('tool')

    // 空标题回落「对话记录」，标题内换行压成空格（旧码消毒口径）。
    expect(conversationMarkdown('', [{ role: 'user', text: '问' }]).startsWith('# 对话记录\n\n')).toBe(true)
    expect(conversationMarkdown('第一行\n第二行', [{ role: 'user', text: '问' }]).startsWith('# 第一行 第二行\n\n')).toBe(true)
  })

  it('文件名消毒：单会话用标题，多会话统一「对话记录」，非法字符替换并限长', () => {
    expect(exportFileName(['会话:标题'])).toBe('会话_标题.md')
    expect(exportFileName(['a', 'b'])).toBe('对话记录.md')
    expect(exportFileName([])).toBe('对话记录.md')
    expect(exportFileName(['?*'])).toBe('__.md')
    expect(exportFileName(['x'.repeat(70)])).toBe(`${'x'.repeat(60)}.md`)
  })
})
