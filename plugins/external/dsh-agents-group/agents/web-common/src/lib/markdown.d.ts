/**
 * lib/markdown.js 的窄声明：只收窄桥接面用到的入口（RichText.tsx 与行为测试），
 * 不给 JS 本体补全类型——那是渲染器自己的事，行为护城河在 tests/rich-text.test.ts。
 */

/** markdownPlan 的节点计划（纯数据）：字段与 markdown.js 的产出对齐，只声明读取面。 */
export interface MarkdownPlanNode {
  tag?: string
  text?: string
  className?: string
  align?: string
  attrs?: Record<string, string>
  children?: MarkdownPlanNode[]
}

export interface MarkdownPlanOptions {
  /** thinking 变体的窄解析（关掉 4 空格缩进代码块）。 */
  narrow?: boolean
  /** false 时地址一律保持文本（thinking/ask 变体）。 */
  images?: boolean
  /**
   * 外链可点击（批 2b 增量，缺省 false）：http(s) 的 markdown 链接与裸地址出受控
   * `<a target=_blank rel=noopener noreferrer>`；命中图片/文件地址时优先升级
   * md-pic/md-file。非 http(s) 协议不受此开关影响，恒为纯文本。
   */
  links?: boolean
  /**
   * 代码块复制工具栏（批 2b 增量，缺省 false）：fence/缩进代码块包
   * div.code-block（div.code-toolbar：语言标签 + 复制按钮 + pre.md-code）。
   */
  codeCopy?: boolean
}

export interface RichTextOptions {
  variant?: 'message' | 'thinking' | 'ask' | 'card'
  streaming?: boolean
  narrow?: boolean
  images?: boolean
  /** 透传 markdownPlan 的 links 开关（缺省关闭，butler 基线不变）。 */
  links?: boolean
  /** 透传 markdownPlan 的 codeCopy 开关（缺省关闭，butler 基线不变）。 */
  codeCopy?: boolean
}

/** 解析 Markdown 为节点计划（纯数据，不碰 DOM）。 */
export function markdownPlan(text: string, opts?: MarkdownPlanOptions): MarkdownPlanNode[]

/** 把 Markdown 渲染进目标容器：先清空，再按节点计划建受控 DOM。 */
export function renderMarkdownInto(target: HTMLElement, text: string, opts?: MarkdownPlanOptions): HTMLElement

/**
 * 模型文本的统一渲染入口：span 容器会升级为 div 并返回新节点（调用方必须用返回值
 * 更新引用）；渲染异常时容器降级纯文本并记住（同一容器不再反复尝试）。
 */
export function richText<T extends HTMLElement>(container: T, text: string, opts?: RichTextOptions): T
