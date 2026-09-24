/**
 * 图标组件（P1.5.1）：Lucide 线性图标（ISC 协议），SVG 内容内联、stroke=currentColor
 * 跟随文字颜色——替代 emoji（emoji 与手账墨线风格不符且跨平台渲染不一致）。
 * 图标源文件存档：butler web/media/icons/lucide/*.svg（官方 0.469.0 原样拷贝）。
 * 新增图标：从 lucide 拉取 SVG 存入该目录后，在 ICON_CONTENTS 加一条。
 *
 * ── DSH 官方 SVG 双体系决策（群组二期批 0 登记，方案 §3.1 待拍板项 7）──────────
 * 群组成员页（blog/closedoff）的回答操作/回合元信息区图标（copy/like/dislike/branch/
 * clock/database/think/api/send/stop/chevron-down 等）来自 DSH harness 官方 UI
 * primitives（MIT），closedoff app.css:111 明文「与 DSH 对话页一致的回答操作」——
 * 这是刻意的亲缘设计，**保留 DSH 形制**，不换 Lucide；导航/工具/管理类才用本组件。
 * DSH 官方 SVG 已随 LICENSE 存档于本包 media/dsh-icons/（blog sprite + mask 图标、
 * closedoff outline mask 图标）。批 0 只存档+机制就位；具体组件化（DSHIcon 或
 * mask 工具）在批 1/2 按需做。
 */
import type { JSX } from 'react'

const ICON_CONTENTS: Record<string, string> = {
  search: "<circle cx=\"11\" cy=\"11\" r=\"8\" />\n  <path d=\"m21 21-4.3-4.3\" />",
  pen_line: "<path d=\"M12 20h9\" />\n  <path d=\"M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z\" />",
  camera: "<path d=\"M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z\" />\n  <circle cx=\"12\" cy=\"13\" r=\"3\" />",
  chevron_down: "<path d=\"m6 9 6 6 6-6\" />",
  chevron_up: "<path d=\"m18 15-6-6-6 6\" />",
  scissors: "<circle cx=\"6\" cy=\"6\" r=\"3\" />\n  <path d=\"M8.12 8.12 12 12\" />\n  <path d=\"M20 4 8.12 15.88\" />\n  <circle cx=\"6\" cy=\"18\" r=\"3\" />\n  <path d=\"M14.8 14.8 20 20\" />",
  trash_2: "<path d=\"M3 6h18\" />\n  <path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\" />\n  <path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\" />\n  <line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\" />\n  <line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\" />",
  arrow_up_right: "<path d=\"M7 7h10v10\" />\n  <path d=\"M7 17 17 7\" />",
  download: "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" />\n  <polyline points=\"7 10 12 15 17 10\" />\n  <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\" />",
  x: "<path d=\"M18 6 6 18\" />\n  <path d=\"m6 6 12 12\" />",
  sparkles: "<path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\" />\n  <path d=\"M20 3v4\" />\n  <path d=\"M22 5h-4\" />\n  <path d=\"M4 17v2\" />\n  <path d=\"M5 18H3\" />",
  hand: "<path d=\"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2\" />\n  <path d=\"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2\" />\n  <path d=\"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8\" />\n  <path d=\"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15\" />",
  heart: "<path d=\"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z\" />",
  check: "<path d=\"M20 6 9 17l-5-5\" />",
}

export type IconName = keyof typeof ICON_NAMES

const ICON_NAMES = {
  search: 'search',
  pen_line: 'pen-line',
  camera: 'camera',
  chevron_down: 'chevron-down',
  chevron_up: 'chevron-up',
  scissors: 'scissors',
  trash_2: 'trash-2',
  arrow_up_right: 'arrow-up-right',
  download: 'download',
  x: 'x',
  sparkles: 'sparkles',
  hand: 'hand',
  heart: 'heart',
  check: 'check',
} as const

export function Icon({ name, size = 14, className }: { name: IconName; size?: number; className?: string }) {
  const content = ICON_CONTENTS[name] ?? ''
  if (content === '') return null
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      style={{ verticalAlign: '-0.15em', flex: 'none' }}
      dangerouslySetInnerHTML={{ __html: content }}
    />
  )
}
