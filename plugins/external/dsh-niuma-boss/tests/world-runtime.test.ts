import { describe, expect, it } from 'vitest'
import {
  ARRIVAL_RADIUS_TILES, BIRTH_MAP, FACINGS, IDLE_MS_MAX, IDLE_MS_MIN, MapRouter, WALK_TILES_PER_SEC,
  activityRoute, activityTarget, cellPoint, directionOf, frameOrigin, idleMs, rendezvousCell, safeMapId,
  type Cell, type EntrySpec, type MapSpec, type WorldSpec,
} from '../src/world-runtime.ts'

/**
 * 三图拓扑与入口安全格：地图 id、入口三格与连接取自作者布局（与
 * docs/04-资源/美术资源包/delivery/maps/*.layout.json 一致，tests/map-compile.test.ts
 * 断言构建产物给出同一组数字）。这一层不依赖 Phaser/DOM，直接判定往返与恢复落点。
 */
const entry = (id: string, trigger: Cell, arrival: Cell, back: Cell): EntrySpec => ({ id, region: 'r', trigger, arrival, return: back })

const office: MapSpec = { id: 'office', width: 42, height: 30, spawn: [34, 26], entries: [entry('office_to_street', [34, 27], [34, 26], [33, 26])] }
const street: MapSpec = {
  id: 'street', width: 40, height: 30, spawn: [5, 12],
  entries: [entry('street_to_office', [5, 11], [5, 12], [6, 12]), entry('street_to_cafe', [13, 11], [13, 13], [14, 13])],
}
const cafe: MapSpec = { id: 'cafe', width: 14, height: 15, spawn: [6, 11], entries: [entry('cafe_to_street', [6, 12], [6, 11], [7, 11])] }

const world: WorldSpec = {
  tileSize: 32,
  birth: BIRTH_MAP,
  maps: [office, street, cafe],
  connections: [
    { id: 'office_street', from: { map: 'office', entry: 'office_to_street' }, to: { map: 'street', entry: 'street_to_office' } },
    { id: 'cafe_street', from: { map: 'cafe', entry: 'cafe_to_street' }, to: { map: 'street', entry: 'street_to_cafe' } },
  ],
}

const open = () => true
const router = () => new MapRouter(structuredClone(world))

describe('世界拓扑', () => {
  it('三图与两条连接进入路由，出生地图为 office', () => {
    const map = router()
    expect(map.maps.map(m => m.id)).toEqual(['office', 'street', 'cafe'])
    expect(map.world.birth).toBe('office')
    expect(map.spawn('office')).toEqual([34, 26])
    expect(map.spawn('street')).toEqual([5, 12])
    expect(map.spawn('cafe')).toEqual([6, 11])
  })

  it('地图 id 白名单挡住越界路径：拼 URL 前先过这一层', () => {
    expect(safeMapId('office')).toBe('office')
    expect(safeMapId('../../etc/passwd')).toBe('')
    expect(safeMapId('Office')).toBe('')
    expect(safeMapId(42)).toBe('')
    const map = router()
    expect(map.pick('../../etc/passwd')).toBe('office')
    expect(map.pick('unknown')).toBe('office')
  })

  it('拓扑非法直接拒绝：缺地图、缺入口、连接引用不存在', () => {
    expect(() => new MapRouter({ ...structuredClone(world), maps: [] })).toThrow()
    expect(() => new MapRouter({ ...structuredClone(world), birth: 'nowhere' })).toThrow()
    const broken = structuredClone(world)
    broken.maps[0].entries = []
    expect(() => new MapRouter(broken)).toThrow()
    const dangling = structuredClone(world)
    dangling.connections[0].to.entry = 'missing'
    expect(() => new MapRouter(dangling)).toThrow()
    const sameMap = structuredClone(world)
    sameMap.connections[0].to.map = 'office'
    expect(() => new MapRouter(sameMap)).toThrow()
  })
})

describe('三图往返', () => {
  it('office→street→cafe→street→office 逐段成立且落点固定', () => {
    const map = router()
    // 出生在办公楼前台，往南走一步到门口触发格。
    expect(map.portal('office', [34, 26])).toBeNull()
    const out = map.portal('office', [34, 27])
    expect(out).toEqual({ entryId: 'office_to_street', to: { map: 'street', entry: 'street_to_office', cell: [5, 12] } })
    // 街上往咖啡店的门。
    const toCafe = map.portal('street', [13, 11])
    expect(toCafe).toEqual({ entryId: 'street_to_cafe', to: { map: 'cafe', entry: 'cafe_to_street', cell: [6, 11] } })
    // 咖啡店里回街上的门。
    const backToStreet = map.portal('cafe', [6, 12])
    expect(backToStreet).toEqual({ entryId: 'cafe_to_street', to: { map: 'street', entry: 'street_to_cafe', cell: [13, 13] } })
    // 街上回办公楼的门。
    const backToOffice = map.portal('street', [5, 11])
    expect(backToOffice).toEqual({ entryId: 'street_to_office', to: { map: 'office', entry: 'office_to_street', cell: [34, 26] } })
    // 地图里没有入口的格子不触发。
    expect(map.portal('street', [6, 12])).toBeNull()
  })

  it('落点取到达格；到达格不可站立时退到退回格，再不行回出生格', () => {
    const map = router()
    const noArrival = (id: string, cell: Cell) => id !== 'street' || cell.join(',') !== '5,12'
    expect(map.land('street', street.entries[0], 'north', noArrival)).toEqual({ map: 'street', cell: [6, 12], facing: 'north' })
    expect(map.land('street', street.entries[0], 'north', () => false)).toEqual({ map: 'street', cell: [5, 12], facing: 'north' })
  })

  it('防连跳：用过的入口在离开触发格之前不再触发，走开后重新可用', () => {
    const map = router()
    map.disarm('office', 'office_to_street')
    expect(map.disarmedEntry).toBe('office/office_to_street')
    expect(map.portal('office', [34, 27])).toBeNull()
    // 站在触发格上不动：仍然不触发（不自动重试、不来回穿门）。
    map.rearm([34, 27])
    expect(map.portal('office', [34, 27])).toBeNull()
    // 走开一格后重新武装。
    map.rearm([34, 26])
    expect(map.disarmedEntry).toBe('')
    expect(map.portal('office', [34, 27])).not.toBeNull()
  })

  it('另一张图的入口不受本图解除武装影响', () => {
    const map = router()
    map.disarm('office', 'office_to_street')
    expect(map.portal('street', [5, 11])).not.toBeNull()
  })

  it('查不到目标入口时保留原有记录：跨图到达不把另一侧的解除武装抹掉', () => {
    const map = router()
    // 走过咖啡店的门：该入口解除武装，角色不离开它的触发格就不再触发。
    map.disarm('street', 'street_to_cafe')
    expect(map.disarmedEntry).toBe('street/street_to_cafe')
    // 从办公楼进入街道：新场景按「来源图的入口 id」初始化，这个 id 在街道上不存在；
    // 这里必须 no-op，否则刚才那条记录会被清空。
    map.disarm('street', 'office_to_street')
    expect(map.disarmedEntry).toBe('street/street_to_cafe')
    // 远处入口的到达格不是任何触发格：站上去不会立刻连跳。
    expect(map.portal('street', [13, 13])).toBeNull()
    // 已解除武装的入口仍然不可用，另一入口（办公楼的门）不受影响。
    expect(map.portal('street', [13, 11])).toBeNull()
    expect(map.portal('street', [5, 11])).not.toBeNull()
  })
})

describe('恢复落点', () => {
  it('合法快照原样落地', () => {
    const map = router()
    expect(map.resolve({ map: 'street', cell: [8, 12], facing: 'east' }, open)).toEqual({ map: 'street', cell: [8, 12], facing: 'east' })
  })

  it('格子在墙上时回该图出生格，不放进墙里也不换图', () => {
    const map = router()
    // 只有 [6,12] 是障碍：恢复格正好落在墙上时改用本图出生格。
    const wall = (id: string, cell: Cell) => id !== 'street' || cell.join(',') !== '6,12'
    expect(map.resolve({ map: 'street', cell: [6,12], facing: 'north' }, wall)).toEqual({ map: 'street', cell: [5, 12], facing: 'north' })
    expect(map.resolve({ map: 'street', cell: [6, 12], facing: 'north' }, () => true)).toEqual({ map: 'street', cell: [6, 12], facing: 'north' })
  })

  it('坏快照（地图未知、格子越界、朝向非法）回安全出生点', () => {
    const map = router()
    expect(map.resolve({ map: 'nowhere', cell: [3, 3], facing: 'east' }, open)).toEqual({ map: 'office', cell: [34, 26], facing: 'east' })
    expect(map.resolve({ map: 'street', cell: [999, 999], facing: 'east' }, () => true)).toEqual({ map: 'street', cell: [5, 12], facing: 'east' })
    expect(map.resolve({ map: 'street', cell: [-1, 4], facing: 'east' }, open)).toEqual({ map: 'street', cell: [5, 12], facing: 'east' })
    expect(map.resolve(null, open)).toEqual({ map: 'office', cell: [34, 26], facing: 'south' })
    expect(map.resolve({ map: 'cafe', cell: [6, 11], facing: 'up' }, open).facing).toBe('south')
    expect(FACINGS).toEqual(['north', 'south', 'east', 'west'])
  })
})

describe('坐标、朝向与镜头', () => {
  it('脚点：精灵坐标取格子中心，origin 取逐帧 frameAnchor/size', () => {
    expect(cellPoint([34, 26])).toEqual({ x: 34 * 32 + 16, y: 26 * 32 + 16 })
    expect(frameOrigin({ size: [32, 48], anchor: [16, 47] })).toEqual({ x: 0.5, y: 47 / 48 })
  })

  it('朝向只有四向，横向优先', () => {
    expect(directionOf(1, 1, 'south')).toBe('east')
    expect(directionOf(-1, 1, 'east')).toBe('west')
    expect(directionOf(0, 1, 'north')).toBe('south')
    expect(directionOf(0, -1, 'south')).toBe('north')
    expect(directionOf(0, 0, 'west')).toBe('west')
  })
})

/**
 * 走动与自主活动（balance_params.yaml / npc_rules.yaml#movement）：速度、到达半径、
 * 活动域选点与整条路径的边界判定都是纯函数，这里直接驱动。
 */
describe('走动参数与普通职员的活动域', () => {
  it('到达半径取欧氏距离 ≤ 1.5 格：斜邻算到，隔两格不算', () => {
    expect(ARRIVAL_RADIUS_TILES).toBe(1.5)
    const walkable = () => true
    expect(rendezvousCell([[4, 4]], walkable)).toEqual([4, 3])
    // 只留斜邻（距离 √2 ≈ 1.414）：仍在半径内。
    const diagonalOnly = (cell: Cell) => Math.abs(cell[0] - 4) === 1 && Math.abs(cell[1] - 4) === 1
    expect(rendezvousCell([[4, 4]], diagonalOnly)).toEqual([3, 3])
    // 只留隔两格（距离 2.0）：超出半径，宁可空着也不放人到半径外。
    const farOnly = (cell: Cell) => Math.hypot(cell[0] - 4, cell[1] - 4) >= 2
    expect(rendezvousCell([[4, 4]], farOnly)).toBeNull()
  })

  it('速度取自 balance_params：员工走 3.0 格/秒', () => {
    expect(WALK_TILES_PER_SEC).toBe(3.0)
  })

  it('活动域整条路径判定：只要有一格在域外就整条丢弃', () => {
    const domain = { region: 'hr', cells: [[18, 5], [19, 5], [18, 6]] as Cell[] }
    expect(activityRoute([[18, 5], [19, 5]], domain)).toEqual([[18, 5], [19, 5]])
    // 绕到域外再回来（[20,5] 不在域里）：不许走。
    expect(activityRoute([[18, 5], [19, 5], [20, 5], [19, 5]], domain)).toBeNull()
    expect(activityRoute([], domain)).toBeNull()
    expect(activityRoute(null, domain)).toBeNull()
  })

  it('自主活动只在域内换点：不会选当前格，随机源给定时结果确定', () => {
    const domain = { region: 'hr', cells: [[18, 5], [19, 5], [18, 6]] as Cell[] }
    expect(activityTarget(domain, [18, 5], () => 0)).toEqual([19, 5])
    expect(activityTarget(domain, [18, 5], () => 0.99)).toEqual([18, 6])
    // 只有这一格时没有可去的地方。
    expect(activityTarget({ region: 'hr', cells: [[18, 5]] }, [18, 5])).toBeNull()
  })

  it('闲下来的时长取 balance_params#autonomous 的区间', () => {
    expect(idleMs(() => 0)).toBe(IDLE_MS_MIN)
    expect(idleMs(() => 0.999999)).toBe(IDLE_MS_MAX)
    expect(IDLE_MS_MAX).toBe(6000)
  })
})
