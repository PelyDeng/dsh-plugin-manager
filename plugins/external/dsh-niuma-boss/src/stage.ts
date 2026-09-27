/**
 * 舞台布局：一张地图在视口里的整数倍缩放与摆放（可玩性扩展批 F1/F1b）。
 *
 * 「铺满全屏」的口径：地图渲染尺寸在**两轴都不小于视口**（跟随轴裁切边界，
 * 不露地图外空白）；只有当降一档后所有轴的缺口都足够小（≤ 边缘容差）时才降档，
 * 缺口交给界面按地图主题包边，避免为几十像素的边带把画面放大一倍。
 *
 * 这里只做「按视口与地图尺寸算数」这一件可测的事；相机应用（applyCamera）与
 * DOM 舞台变量（--stage-*）都消费同一份结果，保证画面与界面锚定同源。
 */

/** 降档允许的最大单轴缺口（像素）：1366×768 下 office 缺 22px、1440×1000 下缺 96px 都走包边。 */
export const EDGE_TOLERANCE_PX = 96

export interface StageLayout {
  /** 整数倍缩放（map_rules.coordinate_system.scale：非整数倍会像素抖动，不用）。 */
  readonly zoom: number
  /** 舞台（地图渲染区域）在视口内的偏移：铺满态为 0，包边态为居中留边。 */
  readonly offsetX: number
  readonly offsetY: number
  /** 舞台尺寸 = 地图尺寸 × zoom（可能大于视口，此时偏移为 0）。 */
  readonly width: number
  readonly height: number
  /** 两轴都覆盖视口（严格铺满）；false 表示有包边。 */
  readonly covered: boolean
}

/**
 * 纯函数：视口 + 地图 → 缩放与舞台矩形。
 * 规则：取「两轴都覆盖视口」的最小整数倍；若降一档后**所有轴的最大缺口** ≤ 容差则降一档
 * （任一轴口径是错的——390×844 下 cafe 纵轴缺 364px，不能因为横轴缺口为 0 就降档）。
 */
export function stageLayout(
  viewport: { width: number; height: number },
  map: { width: number; height: number },
  tileSize = 32,
  edgeTolerance = EDGE_TOLERANCE_PX,
): StageLayout {
  const mapW = map.width * tileSize
  const mapH = map.height * tileSize
  const minCover = Math.max(1, Math.ceil(Math.max(viewport.width / mapW, viewport.height / mapH) - 1e-9))
  let zoom = minCover
  if (minCover >= 2) {
    const previous = minCover - 1
    const gapX = Math.max(0, viewport.width - mapW * previous)
    const gapY = Math.max(0, viewport.height - mapH * previous)
    if (Math.max(gapX, gapY) <= edgeTolerance) zoom = previous
  }
  const width = mapW * zoom
  const height = mapH * zoom
  const covered = width >= viewport.width && height >= viewport.height
  return {
    zoom,
    offsetX: covered ? 0 : Math.floor((viewport.width - width) / 2),
    offsetY: covered ? 0 : Math.floor((viewport.height - height) / 2),
    width,
    height,
    covered,
  }
}

/**
 * 跟随轴与包边轴的镜头 scroll 目标（世界单位）。
 * Phaser 的 zoom 围绕视口中心缩放：可视世界中心恒为 scroll + 视口/2，可视宽度 = 视口/zoom。
 * 因此跟随轴把「中心 = 焦点」解出来再钳到地图内；包边轴解出让世界 0 恰好落在舞台偏移处。
 * 调用方保证 zoom 已按 layout 设置。
 */
export function cameraScrollFor(
  layout: StageLayout,
  viewport: { width: number; height: number },
  map: { width: number; height: number },
  tileSize: number,
  focus: { x: number; y: number },
): { scrollX: number; scrollY: number } {
  const mapW = map.width * tileSize
  const mapH = map.height * tileSize
  const halfW = viewport.width / 2
  const halfH = viewport.height / 2
  const visibleHalfW = halfW / layout.zoom
  const visibleHalfH = halfH / layout.zoom
  // 覆盖轴：scroll ∈ [-(half - visibleHalf)（可视左缘贴地图 0）, mapPx - half - visibleHalf（可视右缘贴地图边界）]；
  // 小地图 + 大 zoom 时上限也可能是负数，不能对 0 取 max。
  // 包边轴：可视左缘 = -offset/zoom，解出 scroll。
  const axis = (mapPx: number, half: number, visibleHalf: number, focusV: number, covered: boolean, offset: number) => {
    if (!covered) return -offset / layout.zoom - (half - visibleHalf)
    const min = -(half - visibleHalf)
    const max = mapPx - half - visibleHalf
    return (Math.min(Math.max(focusV - half, min), Math.max(min, max)) || 0)
  }
  return {
    scrollX: axis(mapW, halfW, visibleHalfW, focus.x, layout.width >= viewport.width, layout.offsetX),
    scrollY: axis(mapH, halfH, visibleHalfH, focus.y, layout.height >= viewport.height, layout.offsetY),
  }
}

/**
 * 把舞台矩形写进 CSS 变量（--stage-*）：提示/对白/toast 的定位锚定游戏画面。
 * 视口内可见的舞台：横向 [max(0,x), min(x+w, viewport)]，纵向同理——舞台大于视口
 * （covered/裁切态）时可见区就是整个视口，锚点不得落到画面外（多视口验收缺陷 #7/#8）。
 */
export function applyStageVariables(
  host: HTMLElement | null | undefined,
  stage: StageLayout,
  viewport: { width: number; height: number },
): void {
  if (!host) return
  host.style.setProperty('--stage-x', stage.offsetX + 'px')
  host.style.setProperty('--stage-y', stage.offsetY + 'px')
  host.style.setProperty('--stage-w', stage.width + 'px')
  host.style.setProperty('--stage-h', stage.height + 'px')
  const visibleLeft = Math.max(0, stage.offsetX)
  const visibleRight = Math.min(stage.offsetX + stage.width, viewport.width)
  const visibleBottom = Math.min(stage.offsetY + stage.height, viewport.height)
  host.style.setProperty('--stage-center-x', ((visibleLeft + visibleRight) / 2) + 'px')
  host.style.setProperty('--stage-bottom-px', Math.max(0, viewport.height - visibleBottom) + 'px')
}
