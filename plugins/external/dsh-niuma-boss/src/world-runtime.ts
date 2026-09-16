/**
 * 世界拓扑与三图往返的纯逻辑：地图、入口、连接与镜头缩放规则都来自构建期编译的
 * `world` 块（scripts/prepare-assets.mjs），运行时既不猜地图 id，也不硬编码连接。
 *
 * 这里不依赖 Phaser 与 DOM，三图往返、入口安全格（防连跳）、恢复落点合法性都在
 * 这一层判定，便于单测直接驱动。
 */
import type { Point } from './navigation.ts'

export type Direction = 'north' | 'south' | 'east' | 'west'
export type Cell = [number, number]
/** 入口三格：触发格（走上去发起切图）、到达格（从对端进入本图的落点）、退回格（到达格不可用时的退回落点）。 */
export type EntrySpec = { id: string; region?: string; trigger: Cell; arrival: Cell; return: Cell }
export type MapSpec = { id: string; width: number; height: number; spawn: Cell; entries: EntrySpec[] }
export type ConnectionSpec = { id: string; from: { map: string; entry: string }; to: { map: string; entry: string } }
export type WorldSpec = { tileSize: number; birth: string; maps: MapSpec[]; connections: ConnectionSpec[] }

/** 人物所在：地图、格子与朝向。逐帧坐标不进 Pinia，这是按格节流后的位置事实。 */
export type Feet = { map: string; cell: Cell; facing: Direction }
/** 一条可走的入口：从当前图的触发格走到目标图的到达格。 */
export type Portal = { entryId: string; to: { map: string; entry: string; cell: Cell } }

export const FACINGS: readonly Direction[] = ['north', 'south', 'east', 'west']
/** 出生地图的兜底常量：与构建产物 `world.birth` 一致（tests/map-compile.test.ts 断言）。 */
export const BIRTH_MAP = 'office'
/** 地图 id 白名单形状：恢复快照来自浏览器存储，拼 URL 前先过这一层，避免越界路径。 */
export const MAP_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
const MAX_CELL = 4096

export function safeMapId(value: unknown): string {
  return typeof value === 'string' && MAP_ID_PATTERN.test(value) ? value : ''
}

/** 移动向量 → 四向朝向（只有四向动画，斜向不允许）。 */
export function directionOf(dx: number, dy: number, fallback: Direction): Direction {
  if (dx && Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'east' : 'west'
  if (dy) return dy > 0 ? 'south' : 'north'
  return fallback
}

/** 格子中心：作者导航脚点约定 [x*32+16, y*32+16]，人物的脚底中心对到这里。 */
export function cellPoint(cell: Cell, tileSize = 32): Point {
  return { x: cell[0] * tileSize + tileSize / 2, y: cell[1] * tileSize + tileSize / 2 }
}

/** 逐帧脚点锚点：origin = frameAnchor / frameSize，脚底中心因此落在格子中心上。 */
export function frameOrigin(frame: { size: [number, number]; anchor: [number, number] }): Point {
  return { x: frame.anchor[0] / frame.size[0], y: frame.anchor[1] / frame.size[1] }
}

/**
 * 镜头缩放：只允许整数倍（map_rules.coordinate_system.scale），宁可留黑边也不用
 * 非整数倍缩放；地图比视口大时用 1 倍，等于开一个窗口看地图。
 */
export function integerZoom(viewport: { width: number; height: number }, map: { width: number; height: number }, tileSize = 32, allowed: readonly number[] = [1, 2, 3, 4]): number {
  const fit = Math.min(viewport.width / (map.width * tileSize), viewport.height / (map.height * tileSize))
  let zoom = allowed[0]
  for (const candidate of allowed) if (candidate <= fit + 1e-9) zoom = candidate
  return zoom
}

const sameCell = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]

/**
 * 地图路由：入口索引、防连跳的武装状态与恢复落点判定。
 * 「同一角色只存在于一张地图」由调用方保证：切图就是换前台地图与落点。
 */
export class MapRouter {
  private readonly byId = new Map<string, MapSpec>()
  /** `${地图}/${入口}` → 对端地图与入口，两个方向都在这里登记。 */
  private readonly portals = new Map<string, { entry: EntrySpec; to: { map: string; entry: string } }>()
  /** 刚用过的入口：角色不离开触发格就不再触发（防连跳，也是失败后不自动重试的依据）。 */
  private disarmed: { map: string; entryId: string; trigger: Cell } | null = null

  constructor(readonly world: WorldSpec) {
    if (!world || world.tileSize !== 32) throw new Error('世界拓扑缺少 tile 尺寸')
    if (!Array.isArray(world.maps) || world.maps.length === 0) throw new Error('世界拓扑没有地图')
    for (const map of world.maps) {
      if (!safeMapId(map.id) || this.byId.has(map.id)) throw new Error('世界拓扑地图 id 非法：' + map.id)
      if (!map.entries?.length) throw new Error('地图缺少入口：' + map.id)
      this.byId.set(map.id, map)
    }
    if (!this.byId.has(world.birth)) throw new Error('世界拓扑缺少出生地图：' + world.birth)
    for (const connection of world.connections ?? []) {
      for (const [end, other] of [[connection.from, connection.to], [connection.to, connection.from]] as const) {
        const map = this.byId.get(end.map)
        const entry = map?.entries.find(e => e.id === end.entry)
        const target = this.byId.get(other.map)
        if (!map || !entry || !target) throw new Error('连接引用了不存在的地图或入口：' + connection.id)
        const key = map.id + '/' + entry.id
        if (this.portals.has(key)) throw new Error('入口重复接入连接：' + key)
        this.portals.set(key, { entry, to: { map: target.id, entry: other.entry } })
      }
    }
  }

  get maps(): MapSpec[] { return [...this.byId.values()] }

  has(map: string): boolean { return this.byId.has(map) }

  spec(map: string): MapSpec | undefined { return this.byId.get(map) }

  /** 恢复候选的地图：非法 id、未知地图或缺失时回出生地图。 */
  pick(candidate: unknown): string {
    const id = safeMapId(candidate)
    return id !== '' && this.byId.has(id) ? id : this.world.birth
  }

  spawn(map: string): Cell {
    const spec = this.byId.get(this.pick(map))
    if (!spec) throw new Error('世界拓扑没有可用的出生地图')
    return [...spec.spawn] as Cell
  }

  /**
   * 恢复快照落点：地图非法或格子在墙上/越界时只在本图内选合法恢复点（出生格），
   * 不把人物放进墙里，也不换成别的地图。朝向非法回 south。
   */
  resolve(candidate: { map?: unknown; cell?: unknown; facing?: unknown } | null | undefined, isWalkable: (map: string, cell: Cell) => boolean): Feet {
    const wanted = safeMapId(candidate?.map)
    const map = this.pick(wanted)
    const facing = FACINGS.includes(candidate?.facing as Direction) ? candidate?.facing as Direction : 'south'
    const cell = wanted === map && this.isCell(candidate?.cell) ? candidate?.cell as Cell : null
    if (cell && this.inBounds(map, cell) && isWalkable(map, cell)) return { map, cell: [...cell] as Cell, facing }
    return { map, cell: this.spawn(map), facing }
  }

  /** 进入某图时的落点：到达格不可站立时退到退回格，再不行回出生格（构建期已保证三格可用）。 */
  land(map: string, entry: EntrySpec, facing: Direction, isWalkable: (map: string, cell: Cell) => boolean): Feet {
    for (const cell of [entry.arrival, entry.return]) if (isWalkable(map, cell)) return { map, cell: [...cell] as Cell, facing }
    return { map, cell: this.spawn(map), facing }
  }

  /** 站在触发格上且该入口处于武装状态时可发起切图。 */
  portal(map: string, cell: Cell): Portal | null {
    const id = this.byId.get(map)
    if (!id) return null
    const entry = id.entries.find(e => sameCell(e.trigger, cell))
    if (!entry) return null
    if (this.disarmed && this.disarmed.map === map && this.disarmed.entryId === entry.id) return null
    const linked = this.portals.get(map + '/' + entry.id)
    if (!linked) return null
    const target = this.byId.get(linked.to.map)
    const targetEntry = target?.entries.find(e => e.id === linked.to.entry)
    if (!target || !targetEntry) return null
    return { entryId: entry.id, to: { map: target.id, entry: targetEntry.id, cell: [...targetEntry.arrival] as Cell } }
  }

  /**
   * 用过的入口解除武装：角色离开该触发格后才重新可用。
   * 目标入口在本图不存在时保持原样（切图后按来源地图的入口 id 初始化是正常情形），
   * 不把另一侧已经记下的解除武装状态抹掉——那会让防守连跳只剩数据兜底。
   */
  disarm(map: string, entryId: string): void {
    const entry = this.byId.get(map)?.entries.find(e => e.id === entryId)
    if (entry) this.disarmed = { map, entryId, trigger: [...entry.trigger] as Cell }
  }

  rearm(cell: Cell): void {
    if (this.disarmed && !sameCell(this.disarmed.trigger, cell)) this.disarmed = null
  }

  get disarmedEntry(): string { return this.disarmed ? this.disarmed.map + '/' + this.disarmed.entryId : '' }

  private isCell(value: unknown): boolean {
    return Array.isArray(value) && value.length === 2
      && value.every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) < MAX_CELL)
  }

  /** 越界格直接拒绝：碰撞查询之外再加一道尺寸校验，坏快照不会落到图外。 */
  private inBounds(map: string, cell: Cell): boolean {
    const spec = this.byId.get(map)
    return spec !== undefined && cell[0] < spec.width && cell[1] < spec.height
  }
}
