/**
 * 协同链路条（拆分设计 v2 批 1b）：renderRail/applyRailStates/setRail/resetRail 与 SVG 小件。
 * 节点按 key 缓存、状态只改 data-state。
 */

import { DOODLE_PATHS, RAIL_ICON_PATHS, RAIL_STEPS, SVG_NS } from './config.js'
import { el, state } from './state.js'
import { make } from './dom.js'

/** 造一个内联 SVG 小件；markup 是固定常量，见 DOODLE_PATHS / RAIL_ICON_PATHS。 */
export function doodleSvg(markup, className) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  if (className) svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = markup
  return svg
}


/**
 * 链路条结构只建一次，状态变化只改 `data-state`（方案 6.1）。
 *
 * 整体重建会让未变化的 active 徽章重新起播动画——「进行中」的转动被打断重来的观感
 * 就是这么来的。节点按 key 缓存，更新走 `applyRailStates` 一条路。
 */
export const railNodes = new Map()

export function renderRail() {
  // 链路条节点已从页面移除（UI 重设计）：没有容器就不渲染；setRail/applySummaryRail
  // 的状态推进原样保留，恢复节点后链路条自动回来。
  if (el.rail === null) return
  if (el.rail.childElementCount === 0) {
    RAIL_STEPS.forEach((step, index) => {
      if (index > 0) el.rail.appendChild(doodleSvg(DOODLE_PATHS.railArrow, 'rail__arrow'))
      const node = make('span', 'rail__step')
      node.dataset.key = step.key
      const badge = make('span', 'rail__badge')
      badge.appendChild(doodleSvg(RAIL_ICON_PATHS[step.key] ?? ''))
      node.appendChild(badge)
      node.appendChild(make('span', 'rail__label', step.label))
      el.rail.appendChild(node)
      railNodes.set(step.key, node)
    })
  }
  applyRailStates()
}

/** 只更新各步状态：`ask` 恒为 done，其余跟 state.rail。 */
export function applyRailStates() {
  for (const [key, node] of railNodes) node.dataset.state = key === 'ask' ? 'done' : (state.rail[key] ?? 'idle')
}

export function setRail(key, value) {
  if (key === 'ask') return
  if (state.rail[key] === value) return
  state.rail[key] = value
  applyRailStates()
}

export function resetRail() {
  state.rail = { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' }
  applyRailStates()
}

/**
 * 按任务结果推进链路条：实时汇总与历史回放共用一套语义，避免两种口径。
 *
 * 等待不是执行（方案 6.1「等待仍旋转」的纠正）：waiting_user/external_pending 用静态的
 * `waiting` 态（琥珀、不转），partial 收在 `partial` 态；转动只留给真正执行中的 active。
 */
export function applySummaryRail(taskState) {
  if (taskState === 'completed') state.rail = { parse: 'done', dispatch: 'done', work: 'done', sum: 'done' }
  else if (taskState === 'waiting_user' || taskState === 'external_pending') state.rail = { parse: 'done', dispatch: 'done', work: 'waiting', sum: 'idle' }
  else if (taskState === 'partial') state.rail = { parse: 'done', dispatch: 'done', work: 'done', sum: 'partial' }
  else if (taskState === 'failed' || taskState === 'cancelled') state.rail = { parse: 'done', dispatch: 'done', work: 'done', sum: 'idle' }
  else state.rail = { parse: 'idle', dispatch: 'idle', work: 'idle', sum: 'idle' }
  applyRailStates()
}
