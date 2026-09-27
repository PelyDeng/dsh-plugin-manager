import { describe, expect, it } from 'vitest'
import { EDGE_TOLERANCE_PX, cameraScrollFor, stageLayout } from '../src/stage.ts'

/** 地图网格（格数 × 32px）。office 1344×960、street 1280×960、cafe 448×480。 */
const MAPS = {
  office: { width: 42, height: 30 },
  street: { width: 40, height: 30 },
  cafe: { width: 14, height: 15 },
}

describe('stageLayout（F1 铺满与包边判定）', () => {
  it('大地图 + 常见视口：zoom 1 已覆盖，无偏移', () => {
    expect(stageLayout({ width: 1280, height: 800 }, MAPS.office)).toMatchObject({ zoom: 1, offsetX: 0, offsetY: 0, covered: true })
    expect(stageLayout({ width: 1280, height: 800 }, MAPS.street)).toMatchObject({ zoom: 1, covered: true })
  })

  it('1440×1000 + office：上一档缺口恰为 96px（横）——包边兜底不放大（G2 锁定）', () => {
    const layout = stageLayout({ width: 1440, height: 1000 }, MAPS.office)
    expect(layout.zoom).toBe(1)
    expect(layout.covered).toBe(false)
    expect(layout.offsetX).toBe(Math.floor((1440 - 1344) / 2))
    expect(layout.offsetY).toBe(Math.floor((1000 - 960) / 2))
  })

  it('1366×768 + office：缺口 22px ≤ 容差——降档包边；street 缺 86px 同样包边', () => {
    expect(stageLayout({ width: 1366, height: 768 }, MAPS.office).zoom).toBe(1)
    expect(stageLayout({ width: 1366, height: 768 }, MAPS.street).zoom).toBe(1)
  })

  it('1440×1000 + street：上一档横缺口 160px > 96px——升到 zoom 2 严格铺满', () => {
    const layout = stageLayout({ width: 1440, height: 1000 }, MAPS.street)
    expect(layout.zoom).toBe(2)
    expect(layout.covered).toBe(true)
    expect(layout.offsetX).toBe(0)
  })

  it('小地图铺满：1280×800 下 cafe 用 zoom 3（zoom 2 横缺 384px 不允许降档）', () => {
    const layout = stageLayout({ width: 1280, height: 800 }, MAPS.cafe)
    expect(layout.zoom).toBe(3)
    expect(layout.covered).toBe(true)
    expect(layout.width).toBe(14 * 32 * 3)
    expect(layout.height).toBe(15 * 32 * 3)
  })

  it('竖屏 390×844 下 cafe 用 zoom 2：降档判据看「所有轴最大缺口」，纵缺 364px 不许降（E2 反例）', () => {
    expect(stageLayout({ width: 390, height: 844 }, MAPS.cafe).zoom).toBe(2)
  })

  it('极大视口：整数倍继续放大且保持覆盖', () => {
    expect(stageLayout({ width: 3000, height: 2000 }, MAPS.office).zoom).toBe(3)
    expect(stageLayout({ width: 8000, height: 8000 }, MAPS.cafe).zoom).toBe(18)
  })

  it('容差可调：96px 阈值是旋钮（G1），调 0 则 1366×768 的 office 也升档铺满', () => {
    expect(stageLayout({ width: 1366, height: 768 }, MAPS.office, 32, 0).zoom).toBe(2)
    expect(stageLayout({ width: 1366, height: 768 }, MAPS.office, 32, EDGE_TOLERANCE_PX).zoom).toBe(1)
  })
})

describe('cameraScrollFor（跟随轴钳制 / 包边轴居中）', () => {
  it('跟随轴：把焦点放中间并钳在地图内', () => {
    const layout = stageLayout({ width: 1280, height: 800 }, MAPS.office)
    const scroll = cameraScrollFor(layout, { width: 1280, height: 800 }, MAPS.office, 32, { x: 432, y: 208 })
    expect(scroll.scrollX).toBe(0)
    expect(scroll.scrollY).toBe(0)
    const bottom = cameraScrollFor(layout, { width: 1280, height: 800 }, MAPS.office, 32, { x: 1300, y: 900 })
    expect(bottom.scrollX).toBe(1344 - 1280)
    expect(bottom.scrollY).toBe(960 - 800)
  })

  it('包边轴：scroll 为负，让世界 0 落在舞台偏移处；不随焦点移动', () => {
    const viewport = { width: 1366, height: 768 }
    const layout = stageLayout(viewport, MAPS.office)
    const a = cameraScrollFor(layout, viewport, MAPS.office, 32, { x: 100, y: 100 })
    const b = cameraScrollFor(layout, viewport, MAPS.office, 32, { x: 1200, y: 800 })
    expect(a.scrollX).toBe(-layout.offsetX / layout.zoom)
    expect(b.scrollX).toBe(a.scrollX)
    expect(a.scrollY).toBe(0)
  })

  it('zoom 3 的小地图：按「中心 = scroll + 视口/2」换算，可视区钳在地图内', () => {
    const viewport = { width: 1280, height: 800 }
    const layout = stageLayout(viewport, MAPS.cafe)
    expect(layout.zoom).toBe(3)
    // 可视半宽 = 640/3 ≈ 213.33：焦点 208 会让可视左缘越界，钳到 -426.67（可视左缘 = 0）
    const at = cameraScrollFor(layout, viewport, MAPS.cafe, 32, { x: 208, y: 368 })
    expect(at.scrollX).toBeCloseTo(-426.6667, 3)
    // 纵向：钳在可视下缘贴地图底（480），老板 y=368 仍落在可视区 [213.3, 480] 内
    expect(at.scrollY).toBeCloseTo(-53.3333, 3)
  })
})
