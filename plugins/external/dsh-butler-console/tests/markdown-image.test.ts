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

  it('非图片后缀的 URL 保持纯文本，不自动图片化', () => {
    expect(pics('文档在 https://example.com/page 查看')).toHaveLength(0)
    expect(pics('发布记录 https://example.com/r.json 在这里')).toHaveLength(0)
  })

  it('URL 后面的中文标点不会被吃进地址', () => {
    const found = pics(`见 ${IMG}。后续文字。`)
    expect(found).toHaveLength(1)
    expect(found[0]!.children?.[0]?.attrs?.src).toBe(IMG)
    const texts = flatten(markdownPlan(`见 ${IMG}。后续文字。`)).filter(node => node.tag === undefined).map(node => node.text)
    expect(texts.join('')).toContain('。后续文字。')
  })

  it('预览地址按 kkFileView 约定拼装：/onlinePreview?url=Base64(encodeURIComponent(src))', () => {
    const found = pics(IMG)
    const href = found[0]!.attrs?.href ?? ''
    expect(href.startsWith('http://preview.pelycloud.com/onlinePreview?url=')).toBe(true)
    const encoded = decodeURIComponent(href.split('url=')[1] ?? '')
    expect(Buffer.from(encoded, 'base64').toString()).toBe(encodeURIComponent(IMG))
  })
})
