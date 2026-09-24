/**
 * <RichText>：richText（受控 DOM 飞地）的 React 包装（方案 §3.4 四坑全防）。
 *
 * richText 内部 DOM 对 React 不透明（reconciliation 不覆盖它）——这正是设计意图：
 * 五道保护（选区冻结/分级降级/置换池/后台降频/降级记忆）是已验收资产，不在 React
 * reconciliation 里重造。四个具体的坑：
 * 1. 容器只能渲染 <div>：richText 遇 span 容器会 replaceWith 换新 div，升级发生在
 *    React 不知情处会让 ref 指向脱离节点，卸载时炸——这里从第一帧就是 div；
 * 2. className 管辖权：richText 用 classList.add(variant.className) 打类，React 侧
 *    不给容器传 className prop（重渲会覆盖整个 class 列表抹掉 richText 加的类）——
 *    布局类交给外层元素，本容器不随重渲变类；
 * 3. 流式期间不 remount：调用方保证 key 稳定；本组件依赖数组只含 text/variant/streaming，
 *    父组件其他状态重渲不触发 effect 重跑；
 * 4. 分级降级（STREAM_RICH_LIMIT）不在飞地内：调用方（store/渲染层）负责判断与
 *    纯文本呈现，本组件只按 `degraded` prop 切换呈现通道。
 */
import { useEffect, useRef } from 'react'
// markdown.js 是受控渲染资产，JS 本体原样保留。与 butler 原版的差异：这里**有**
// lib/markdown.d.ts——butler 靠 import 行上的 @ts-expect-error 单点压类型缺口，但
// blog 的 tsconfig 开了 allowJs，@ts-expect-error 在那边会变成「未使用指令」反而红。
// 声明文件只收窄桥接面用到的三个入口，行为断言仍由 rich-text.test.ts 守护。
import { richText } from './lib/markdown.js'

export interface RichTextProps {
  /** 全量正文（不是增量）：richText 每次调用都按全量重排内部 DOM。 */
  text: string
  /** message=气泡正文（缺省）/ thinking=思考区窄解析 / ask=提问卡 / card=任务卡明细。 */
  variant?: 'message' | 'thinking' | 'ask' | 'card'
  /** 流式期：选区冻结与后台降频生效（richText 内部行为）。 */
  streaming?: boolean
}

export function RichText({ text, variant = 'message', streaming = false }: RichTextProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    // richText 返回的 host 与 container 是同一个节点（本组件保证容器从一开始就是 div，
    // 不触发它内部的 span 升级路径），无需更新引用。
    richText(container, text, { variant, streaming })
  }, [text, variant, streaming])

  return <div ref={containerRef} />
}
