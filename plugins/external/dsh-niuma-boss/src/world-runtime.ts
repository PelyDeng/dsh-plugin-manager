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

/** 角色在世界里的职责（作者数据：posts.role_kind / npcs.status / characters.ordinaryNpc）。 */
export type CharacterRole = 'player' | 'butler' | 'staff' | 'npc'
/** npc_rules.yaml#dialogue.dialogue_modes；`model_chat` 本切片不接（不新增闲聊模型通道）。 */
export type DialogueMode = 'authored_lines' | 'model_chat' | 'unavailable'

/** 作者预写对白（普通 NPC）：名字、职责与已写定的场景台词。 */
export type DialogueSpec = { mode: DialogueMode; name: string; role: string; lines: string[] }

/** 逐帧锚点：`anchor` 是脚点，`seat` 是坐姿的臀部接触点（仅坐姿帧有）。 */
export type FrameSpec = { path: string; size: [number, number]; anchor: [number, number]; seat?: [number, number] }
export type ClipSpec = { action: string; direction: string; frames: FrameSpec[] }

/**
 * 作者座位与遮挡：坐姿导航脚点、臀部接触点、站格、坐姿帧与椅背遮挡层，
 * 全部来自构建期编译（scripts/prepare-assets.mjs）；运行时只读，不硬编码坐标。
 */
export type SeatSpec = {
  /** 坐姿导航脚点所在格（坐姿坐标指的是脚底中心，坐姿帧另有接触点）。 */
  cell: Cell
  direction: Direction
  /** 作者给的坐姿锚点像素（= 坐格中心）。 */
  anchor: [number, number]
  /** 臀部接触点像素：坐姿精灵按逐帧 `seat` 锚点对到这里。 */
  contact: [number, number]
  /** 坐姿角色在 y 排序里的深度（椅座与椅背之间）。 */
  depth: number
  sit: ClipSpec
  /** 作者声明的椅背遮挡层（布局/图集锚点/遮挡层），没有就为 null。 */
  occlusion: { frame: string; x: number; y: number; width: number; height: number; depth: number } | null
  /** 作者工位旁的站立格（员工离座/回位用）。 */
  stand: Cell
}

/** 运行时角色：位置、职责、作者座位与对白内容。 */
export type CharacterSpec = {
  id: string
  label: string
  role: CharacterRole
  cell: Cell
  seat?: SeatSpec
  dialogue?: DialogueSpec
}

/** balance_params.yaml#interaction.arrival_radius_tiles：到位判定与会合点落位的半径（格）。 */
export const ARRIVAL_RADIUS_TILES = 1.5
/**
 * balance_params.yaml#movement：走动速度（格/秒）。员工去干活比回工位快一点，
 * 与 8fps 走帧的步频一起决定位移，不允许用滑行凑距离。
 */
export const WALK_TILES_PER_SEC = 3.0
export const RETURN_TILES_PER_SEC = 2.5

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

/** 坐姿逐帧锚点：origin = seatAnchor / frameSize，臀部接触点因此落在作者给定的像素上。 */
export function seatOrigin(frame: { size: [number, number]; seat?: [number, number] }): Point | null {
  if (!frame.seat) return null
  return { x: frame.seat[0] / frame.size[0], y: frame.seat[1] / frame.size[1] }
}

/** 坐姿精灵左上角：接触点减去逐帧接触锚点（都用作者像素，不引入新坐标）。 */
export function seatPosition(contact: [number, number], frame: { seat?: [number, number] }): Point | null {
  if (!frame.seat) return null
  return { x: contact[0] - frame.seat[0], y: contact[1] - frame.seat[1] }
}

/**
 * 会合点解析（map_rules.yaml#anchors）：作者/后端只给语义目标，格子在这里算。
 * 从目标对象所在格向外按环搜索可站立格：先近后远，永不选中目标脚下的那一格
 * （never-on-top），相邻全被占时退到 arrival_radius_tiles 范围内的最近可站立格。
 * 判定用**欧氏距离 ≤ arrival_radius_tiles**（balance_params.yaml#interaction：
 * 1.5 格；斜邻 1.414 算抵达，隔两格的 2.0 不算）。距离相同的候选按「y 小优先、
 * x 小优先」取第一个：结果稳定，便于断言与复现。
 */
export function rendezvousCell(
  sources: readonly Cell[],
  isWalkable: (cell: Cell) => boolean,
  isFree: (cell: Cell) => boolean = () => true,
  radius = ARRIVAL_RADIUS_TILES,
): Cell | null {
  const rings = Math.max(1, Math.ceil(radius))
  for (let ring = 1; ring <= rings; ring++) {
    let best: Cell | null = null
    let bestDistance = Infinity
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
        const distance = Math.hypot(dx, dy)
        if (distance > radius || distance >= bestDistance) continue
        for (const source of sources) {
          const cell: Cell = [source[0] + dx, source[1] + dy]
          if (!isWalkable(cell) || !isFree(cell)) continue
          bestDistance = distance
          best = cell
          break
        }
      }
    }
    if (best) return best
  }
  return null
}

const sameCell = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]

/** 格集合的键：活动域判定只比较格，不比较像素。 */
export const cellKey = (cell: Cell): string => cell[0] + ',' + cell[1]

/** 作者给的有限活动域（npc_rules.yaml#movement）：目标与整条路径都必须落在里面。 */
export type ActivityDomain = { region: string; cells: Cell[] }

/**
 * 普通职员的整条路径核验：只要有一格落在活动域外就丢弃这条路径（境界外的近路也不许走），
 * 不因为老板靠近或域外有兴趣点而放宽。空路径按不可用处理。
 */
export function activityRoute(path: readonly Cell[] | null | undefined, domain: ActivityDomain): Cell[] | null {
  if (!path || path.length === 0) return null
  const allowed = new Set(domain.cells.map(cellKey))
  return path.every(cell => allowed.has(cellKey(cell))) ? [...path] : null
}

/**
 * 自主活动选点：只从活动域里挑一个不是当前格的格，避免原地打转。
 * `random` 注入随机源，测试可以给出确定序列。
 */
export function activityTarget(domain: ActivityDomain, from: Cell, random: () => number = Math.random): Cell | null {
  const candidates = domain.cells.filter(cell => !sameCell(cell, from))
  if (candidates.length === 0) return null
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
  return [...candidates[index]] as Cell
}

/** balance_params.yaml#autonomous：闲下来的时长区间（毫秒）。 */
export const IDLE_MS_MIN = 1500
export const IDLE_MS_MAX = 6000

/** 自主活动的停留时长：区间内的均匀取值。 */
export function idleMs(random: () => number = Math.random): number {
  return IDLE_MS_MIN + Math.floor(random() * (IDLE_MS_MAX - IDLE_MS_MIN + 1))
}

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

  /** 用过的入口解除武装：角色离开该触发格后才重新可用（防连跳）。 */
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
