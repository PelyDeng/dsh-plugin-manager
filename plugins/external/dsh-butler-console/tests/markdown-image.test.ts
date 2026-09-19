/**
 * 聊天里的图片预览（kkFileView 接入）的受控渲染边界。
 *
 * 2026-09-19 生产：成员交回的图片地址只是正文里的一行裸文本，用户要自己复制粘贴才能看图。
 * 现在正文里的图片地址渲染成受控缩略图，点击新窗口进 kkFileView 在线预览。本文件锁的是
 * **安全与识别边界**，全部走 `markdownPlan`（纯数据，不碰 DOM）：
 *
 * 1. 裸图片 URL（正文文本）与 markdown 图片语法都出图片节点；
 * 2. 协议白名单：`javascript:`、`data:` 不出 `<img>`（维持占位文本）；
 * 3. 非图片后缀的 URL 保持纯文本（不开自动图片化）；
 * 4. 中文标点跟在 URL 后面不被吃进地址；
 * 5. 预览地址按 kkFileView 约定拼装（Base64(encodeURIComponent(url))）。
 */
import { describe, expect, it } from 'vitest'
// 渲染器是 JS 模块（无声明文件）；计划函数是纯数据输出，形状在用例里宽松读取。
// @ts-expect-error 见上。
import { markdownPlan } from '../web/markdown.js'

/** 深度摊平节点计划。计划来自无类型的 JS 渲染器，这里按宽松结构读取。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function flatten(nodes: readonly any[], out: any[] = []): any[] {
  for (const node of nodes ?? []) {
    out.push(node)
    flatten(node.children ?? [], out)
  }
  return out
}

const IMG = 'https://img.pelycloud.com/huiyu/2026/09/19/cf8f97d1.png'

function pics(text: string) {
  return flatten(markdownPlan(text)).filter(node => node.tag === 'a' && node.className === 'md-pic')
}

function files(text: string) {
  return flatten(markdownPlan(text)).filter(node => node.tag === 'a' && node.className === 'md-file')
}

describe('聊天图片预览：受控渲染边界', () => {
  it('正文里的裸图片地址渲染成受控图片节点（截图病灶：地址只是一行文本）', () => {
    const found = pics(`图出来了，老大：\n\n${IMG}\n\n- 尺寸 1672×941`)
    expect(found).toHaveLength(1)
    expect(found[0]!.children?.[0]?.attrs).toMatchObject({ src: IMG, loading: 'lazy' })
    expect(found[0]!.attrs?.target).toBe('_blank')
    expect(found[0]!.attrs?.rel).toContain('noopener')
  })

  it('markdown 图片语法同样出节点，alt 带上', () => {
    const found = pics(`![架构图](${IMG})`)
    expect(found).toHaveLength(1)
    expect(found[0]!.children?.[0]?.attrs).toMatchObject({ src: IMG, alt: '架构图' })
  })

  it('协议白名单：javascript: 与 data: 不出图片节点', () => {
    // markdown-it 对危险协议的地址直接拒绝解析，整段按原文显示——比占位文本更严格。
    expect(pics('![x](javascript:alert(1))')).toHaveLength(0)
    expect(pics('![x](data:image/png;base64,AAAA)')).toHaveLength(0)
    expect(flatten(markdownPlan('![x](javascript:alert(1))')).some(node => (node.text ?? '').includes('![x](javascript:alert(1))'))).toBe(true)
  })

  it('非图片后缀不出缩略图：带扩展名的走文件卡，纯路径保持纯文本', () => {
    expect(pics('文档在 https://example.com/page 查看')).toHaveLength(0)
    // json 有扩展名：不是图片（无缩略图），但升级成文件卡（kkFileView 能预览）。
    expect(pics('发布记录 https://example.com/r.json 在这里')).toHaveLength(0)
    expect(files('发布记录 https://example.com/r.json 在这里')).toHaveLength(1)
  })

  it('URL 后面的中文标点不会被吃进地址', () => {
    const found = pics(`见 ${IMG}。后续文字。`)
    expect(found).toHaveLength(1)
    expect(found[0]!.children?.[0]?.attrs?.src).toBe(IMG)
    const texts = flatten(markdownPlan(`见 ${IMG}。后续文字。`)).filter(node => node.tag === undefined).map(node => node.text)
    expect(texts.join('')).toContain('。后续文字。')
  })

  it('预览地址按 kkFileView 实测约定拼装：url=直接 Base64（不 encodeURIComponent，编码版 403）', () => {
    const found = pics(IMG)
    const href = found[0]!.attrs?.href ?? ''
    expect(href.startsWith('https://preview.pelycloud.com/onlinePreview?url=')).toBe(true)
    // 实测（2026-09-19）：kkFileView 只认「直接 Base64」；编码后 %3A 会被拒成 403。
    expect(Buffer.from(href.split('url=')[1] ?? '', 'base64').toString()).toBe(IMG)
    // data-preview 供点击弹窗取原始地址；href/target 只是 JS 失效时的回退。
    expect(found[0]!.attrs?.['data-preview']).toBe(IMG)
    expect(found[0]!.attrs?.target).toBe('_blank')
  })

  it('非图片文件（pdf/office/压缩包/音视频）渲染成着重文件卡，ext 徽标取自地址', () => {
    for (const [url, ext] of [
      ['https://img.pelycloud.com/huiyu/report.pdf', 'pdf'],
      // 真实地址里非 ASCII 必然百分号编码（HTTP 协议要求），中文文件名见解码用例。
      ['https://example.com/files/%E5%AD%A3%E6%8A%A5.xlsx?token=1', 'xlsx'],
      ['https://example.com/deck.pptx', 'pptx'],
      ['https://example.com/a/demo.mp4', 'mp4'],
      ['https://example.com/b/archive.7z', '7z'],
    ] as const) {
      const cards = files(`材料在这：${url}`)
      expect(cards, url).toHaveLength(1)
      expect(cards[0]!.children?.map((child: any) => child.text)).toEqual([ext, expect.any(String)])
      expect(cards[0]!.attrs?.['data-preview']).toBe(url)
    }
  })

  it('没有扩展名的网页地址保持纯文本；`v1.2` 这类版本号不算扩展名', () => {
    expect(files('文档在 https://example.com/page 查看')).toHaveLength(0)
    expect(files('发布记录 https://example.com/v1.2 已更新')).toHaveLength(0)
    expect(files('看 https://example.com/a/b/c 就行')).toHaveLength(0)
  })

  it('文件卡上的名字取地址末段并解百分号编码', () => {
    const card = files('交付：https://example.com/files/%E5%AD%A3%E6%8A%A5.pdf')[0]!
    const name = card.children?.find((child: any) => child.className === 'md-file__name')
    expect(name?.text).toBe('季报.pdf')
  })
})
