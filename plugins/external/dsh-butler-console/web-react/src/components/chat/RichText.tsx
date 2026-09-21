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
// web/markdown.js 是旧前端的受控资产（JS 无声明文件，方案 §2 原样保留）：桥接处的
// 类型缺口由这一行 @ts-expect-error 单点承担，渲染行为断言由 rich-text.test.ts 守护。
// @ts-expect-error JS 资产无类型声明（tests/rich-text.test.ts 是它的行为护城河）
import { richText } from '../../../../web/markdown.js'

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
