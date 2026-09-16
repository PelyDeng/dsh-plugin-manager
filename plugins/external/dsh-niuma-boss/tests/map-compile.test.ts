import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileActivity, compileMap, compileProfile, compileSeats, compileWorld, delivery, needsWalk, readProfiles, reachable } from '../scripts/prepare-assets.mjs'

/**
 * 构建期资源编译：三张图走同一套双源校验（Tiled `.tmj` + 验收过的 `.layout.json`），
 * 保留尺寸、碰撞、缺图与锚点（入口/落点）负例；实时真实交付的编译结果由 map-compile
 * 的最后一组用例校验（出生地图、入口格与连接）。
 */

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'))

/** 编译产物里本切片关心的字段（脚本是 .mjs，这里用显式形状收窄）。 */
type Runtime = {
  id: string
  width: number
  height: number
  spawn: number[]
  collision: number[]
  entries: { id: string; region?: string; trigger: number[]; arrival: number[]; return: number[] }[]
  draws: unknown[]
}
type Compiled = { runtime: Runtime; used: { asset: string }[] }
const compile = (tmj: unknown, layout: unknown, tsj: unknown): Compiled => compileMap(tmj, layout, tsj) as unknown as Compiled

/** 6×4 的最小双源夹具：地面一层、一个入口、一个家具物件。 */
function fixture() {
  const width = 6, height = 4
  const tmj = {
    width, height, tilewidth: 32, tileheight: 32, infinite: false,
    tilesets: [{ firstgid: 1, source: 'world.tsj' }],
    layers: [
      { name: 'ground', type: 'tilelayer', data: Array.from({ length: width * height }, () => 1) },
      { name: 'collision', type: 'tilelayer', data: Array.from({ length: width * height }, (_, i) => (i === 7 ? 1 : 0)) },
      {
        name: 'furniture', type: 'objectgroup',
        objects: [{ name: 'desk_01', gid: 2, x: 64, y: 96, width: 32, height: 32, rotation: 0, properties: [{ name: 'blocked_cells', value: '[[2,2]]' }] }],
      },
    ],
  }
  const tsj = { tiles: [
    { id: 0, image: '../assets/floor.png', properties: [{ name: 'asset_id', value: 'floor' }] },
    { id: 1, image: '../assets/desk.png', properties: [{ name: 'asset_id', value: 'desk' }] },
  ] }
  const layout = {
    id: 'mini', width, height, tile_size: 32, runtime_ready: true,
    blocked_cells: [[1, 1]], // 与 collision 的第 7 格（x=1,y=1）一致
    objects: [{
      id: 'desk_01', layer: 'furniture', image_position_px: [64, 64], pixel_width: 32, pixel_height: 32,
      blocked_cells: [[2, 2]], sort_anchor_px: [64, 96], asset: 'desk',
    }],
    entries: [{ id: 'mini_door', region: 'hall', trigger: [0, 3], arrival: [1, 3], return: [2, 3] }],
  }
  return { tmj, tsj, layout }
}

const clone = <T>(value: T): T => structuredClone(value)

describe('双源地图编译', () => {
  it('尺寸一致、碰撞一致时输出精简运行时 JSON', () => {
    const { tmj, tsj, layout } = fixture()
    const { runtime, used } = compile(tmj, layout, tsj)
    expect(runtime).toMatchObject({ id: 'mini', width: 6, height: 4, tileSize: 32, spawn: [1, 3] })
    expect(runtime.collision[7]).toBe(1)
    expect(runtime.collision.filter(Boolean)).toHaveLength(1)
    expect(runtime.entries).toEqual([{ id: 'mini_door', region: 'hall', trigger: [0, 3], arrival: [1, 3], return: [2, 3] }])
    expect(used.map(t => t.asset).sort()).toEqual(['desk', 'floor'])
  })

  it('负例：尺寸不一致必须失败', () => {
    const { tmj, tsj, layout } = fixture()
    const bad = clone(layout); bad.width = 7
    expect(() => compile(tmj, bad, tsj)).toThrow()
  })

  it('负例：碰撞与布局 blocked_cells 不一致必须失败', () => {
    const { tmj, tsj, layout } = fixture()
    const bad = clone(layout); bad.blocked_cells = [[2, 2]]
    expect(() => compile(tmj, bad, tsj)).toThrow(/碰撞差异/)
  })

  it('负例：缺图（未支持的 gid）必须失败', () => {
    const { tmj, tsj, layout } = fixture()
    const bad = clone(tsj)
    bad.tiles = [bad.tiles[0]]
    expect(() => compile(tmj, layout, bad)).toThrow(/未支持的 gid/)
  })

  it('负例：物件锚点与布局记录不一致必须失败', () => {
    const { tmj, tsj, layout } = fixture()
    const bad = clone(layout); bad.objects[0].image_position_px = [64, 96]
    expect(() => compile(tmj, bad, tsj)).toThrow()
  })

  it('负例：出生点落在阻挡格上必须失败', () => {
    const { tmj, tsj, layout } = fixture()
    const bad = clone(layout); bad.entries[0].arrival = [1, 1]
    expect(() => compile(tmj, bad, tsj)).toThrow(/出生点/)
  })

  it('负例：到达格落在返程触发格上必须失败', () => {
    const { tmj, tsj, layout } = fixture()
    const bad = clone(layout); bad.entries[0].arrival = [0, 3]
    expect(() => compile(tmj, bad, tsj)).toThrow(/到达格/)
  })

  it('负例：入口格不可站立或从到达格不可达必须失败', () => {
    const { tmj, tsj, layout } = fixture()
    const walled = clone(layout); walled.entries[0].trigger = [1, 1]
    expect(() => compile(tmj, walled, tsj)).toThrow(/不可站立/)
    // 把中列堵死：触发格本身可站立，但从到达格走不到（没有可用返程）。
    const sealed = fixture()
    sealed.tmj.layers[1].data = Array.from({ length: 24 }, (_, i) => (i % 6 === 3 ? 1 : 0))
    sealed.layout.blocked_cells = [[3, 0], [3, 1], [3, 2], [3, 3]]
    sealed.layout.entries[0] = { id: 'mini_door', region: 'hall', trigger: [4, 3], arrival: [1, 3], return: [2, 3] }
    expect(() => compile(sealed.tmj, sealed.layout, sealed.tsj)).toThrow(/不可达/)
  })

  it('可行走格集合从到达格连通，被围死的格子不算数', () => {
    const { tmj, tsj, layout } = fixture()
    const { runtime } = compile(tmj, layout, tsj)
    expect(reachable(runtime, runtime.spawn).size).toBe(23)
  })
})

describe('世界拓扑编译', () => {
  const map = (id: string, entries: { id: string; trigger: number[]; arrival: number[]; return: number[] }[]) => ({
    id, width: 10, height: 10, spawn: entries[0].arrival, collision: Array.from({ length: 100 }, () => 0),
    entries: entries.map(e => ({ ...e, region: 'r' })),
  })
  const a = map('a', [{ id: 'a_door', trigger: [1, 1], arrival: [2, 2], return: [3, 3] }])
  const b = map('b', [{ id: 'b_door', trigger: [4, 4], arrival: [5, 5], return: [6, 6] }])
  const worldLayout = {
    schema: 'niuma-art-world-v1', tile_size: 32,
    maps: ['a.layout.json', 'b.layout.json'],
    connections: [{ id: 'ab', from: { map_id: 'a', entry_id: 'a_door' }, to: { map_id: 'b', entry_id: 'b_door' }, bidirectional: true, runtime_enabled: false }],
  }

  it('两端入口都成立时写出可用连接与出生地图', () => {
    const world = compileWorld([a, b], worldLayout)
    expect(world).toMatchObject({ tileSize: 32, birth: 'a' })
    expect(world.connections).toEqual([{ id: 'ab', from: { map: 'a', entry: 'a_door' }, to: { map: 'b', entry: 'b_door' } }])
    expect(world.maps.map((m: { id: string }) => m.id)).toEqual(['a', 'b'])
    // 每张图的入口三格都带上，客户端不必再读地图数据猜落点。
    expect(world.maps[0].entries[0]).toMatchObject({ trigger: [1, 1], arrival: [2, 2], return: [3, 3] })
  })

  it('负例：连接引用未编译的地图或入口必须失败', () => {
    const missingMap = clone(worldLayout); missingMap.connections[0].to.map_id = 'c'
    expect(() => compileWorld([a, b], missingMap)).toThrow(/未编译的地图/)
    const missingEntry = clone(worldLayout); missingEntry.connections[0].from.entry_id = 'nope'
    expect(() => compileWorld([a, b], missingEntry)).toThrow(/不存在的入口/)
  })

  it('负例：地图清单对不上、连接两端同图、非双向连接必须失败', () => {
    expect(() => compileWorld([a], worldLayout)).toThrow(/地图清单/)
    const same = clone(worldLayout); same.connections[0].to.map_id = 'a'
    expect(() => compileWorld([a, b], same)).toThrow(/同一张图/)
    const oneWay = clone(worldLayout); oneWay.connections[0].bidirectional = false
    expect(() => compileWorld([a, b], oneWay)).toThrow(/双向/)
  })

  it('负例：同一张图两个入口共用触发格必须失败', () => {
    const twin = map('a', [
      { id: 'a_door', trigger: [1, 1], arrival: [2, 2], return: [3, 3] },
      { id: 'a_door2', trigger: [1, 1], arrival: [4, 4], return: [5, 5] },
    ])
    const shared = clone(worldLayout); shared.connections[0].from.entry_id = 'a_door2'
    expect(() => compileWorld([twin, b], shared)).toThrow(/共用触发格/)
  })

  it('负例：到达/退回格压在本图另一入口的触发格上必须失败', () => {
    // 跨入口重合：运行时只保证「刚用过的入口」不被立刻再次触发，落在另一个入口的
    // 触发格上会立刻连跳，构建期就必须拒绝这种数据。
    const byArrival = map('a', [
      { id: 'a_door', trigger: [1, 1], arrival: [2, 2], return: [3, 3] },
      { id: 'a_door2', trigger: [4, 4], arrival: [1, 1], return: [5, 5] },
    ])
    const arrival = clone(worldLayout); arrival.connections[0].from.entry_id = 'a_door2'
    expect(() => compileWorld([byArrival, b], arrival)).toThrow(/重合/)
    const byReturn = map('a', [
      { id: 'a_door', trigger: [1, 1], arrival: [2, 2], return: [3, 3] },
      { id: 'a_door2', trigger: [4, 4], arrival: [5, 5], return: [1, 1] },
    ])
    const back = clone(worldLayout); back.connections[0].from.entry_id = 'a_door2'
    expect(() => compileWorld([byReturn, b], back)).toThrow(/重合/)
  })
})

describe('真实交付的三图', () => {
  it('编译后出生地图是 office，两条连接与入口格与作者布局一致', async () => {
    const worldLayout = await json(resolve(delivery, 'maps/world-layout.json'))
    const runtimes = []
    for (const id of ['office', 'street', 'cafe']) {
      const [tmj, layout, tsj] = await Promise.all([
        json(resolve(delivery, 'maps', id + '.tmj')),
        json(resolve(delivery, 'maps', id + '.layout.json')),
        json(resolve(delivery, 'maps', 'world.tsj')),
      ])
      runtimes.push(compile(tmj, layout, tsj).runtime)
    }
    const world = compileWorld(runtimes, worldLayout)
    expect(world.birth).toBe('office')
    expect(world.connections.map((c: { id: string }) => c.id)).toEqual(['office_street', 'cafe_street'])
    const office = world.maps.find((m: { id: string }) => m.id === 'office')
    const street = world.maps.find((m: { id: string }) => m.id === 'street')
    const cafe = world.maps.find((m: { id: string }) => m.id === 'cafe')
    expect(office.spawn).toEqual([34, 26])
    expect(office.entries).toEqual([{ id: 'office_to_street', region: 'reception', trigger: [34, 27], arrival: [34, 26], return: [33, 26] }])
    expect(street.spawn).toEqual([5, 12])
    expect(street.entries.map((e: { id: string }) => e.id)).toEqual(['street_to_office', 'street_to_cafe'])
    expect(cafe.spawn).toEqual([6, 11])
    expect(cafe.entries[0].trigger).toEqual([6, 12])
    // 三张图的出生点都能从本图到达格连通区走出来（不困住老板）。
    for (const runtime of runtimes) expect(reachable(runtime, runtime.spawn).size).toBeGreaterThan(100)
  })

  it('真实交付的七席座位：坐姿锚点、站格与作者椅背遮挡都编译进运行时', async () => {
    const characters = await json(resolve(delivery, 'characters.json'))
    const [tmj, layout, tsj] = await Promise.all([
      json(resolve(delivery, 'maps/office.tmj')),
      json(resolve(delivery, 'maps/office.layout.json')),
      json(resolve(delivery, 'maps/world.tsj')),
    ])
    const { runtime } = compile(tmj, layout, tsj)
    const tiles = new Map((tsj.tiles as { properties: { name: string; value: string }[]; image: string }[])
      .map(tile => [tile.properties.find(p => p.name === 'asset_id')!.value, tile]))
    const { seats, used } = compileSeats(layout, tmj, runtime, characters, tiles)
    // 有作者工位的七个角色各有一座，业务员工与普通职员都在内，旧示例（无工位）不在。
    expect([...seats.keys()].sort()).toEqual(['blog', 'closedoff', 'example', 'npc_admin', 'npc_hr', 'npc_reception', 'npc_recruiter'])
    const example = seats.get('example')!
    expect(example).toMatchObject({ cell: [5, 13], direction: 'north', stand: [5, 14], anchor: [176, 432], contact: [176, 402] })
    // 深度取同一 y 锚点内的槽位：坐姿角色在椅座之上、椅背之下。
    expect(example.depth).toBe(432.25)
    expect(example.occlusion).toMatchObject({ frame: 'tech-chair-back-north', x: 160, y: 385, depth: 432.5 })
    // 坐姿帧带逐帧接触锚点（坐姿精灵左上角 = 接触点 − 该锚点）。
    expect(example.sit).toMatchObject({ action: 'sit', direction: 'north' })
    expect(example.sit.frames[0].seat).toEqual([16, 39])
    // 面朝南的前台没有声明前景遮挡：不给它编一个遮挡层。
    expect(seats.get('npc_reception')!.occlusion).toBeNull()
    expect(seats.get('npc_reception')!.direction).toBe('south')
    // 遮挡图集资源进地图图集（不新增首包请求）。
    expect(used.map((tile: { asset: string }) => tile.asset)).toEqual([
      'tech-chair-back-north', 'tech-chair-back-north', 'tech-chair-back-north',
      'tech-chair-back-north', 'tech-chair-back-north', 'tech-chair-back-north',
    ])
  })

  it('走帧按需编给会走动的角色：3 位员工与 4 位普通职员各 32 帧、四向齐整', async () => {
    const characters = await json(resolve(delivery, 'characters.json'))
    const layout = await json(resolve(delivery, 'maps/office.layout.json'))
    const profiles = await readProfiles()
    const walkers = (characters.characters as { id: string; clips: { action: string; direction: string; frames: unknown[] }[] }[])
      .filter(character => needsWalk(character.id, layout, profiles.get(character.id)))
    expect(walkers.map(character => character.id).sort()).toEqual(
      ['blog', 'closedoff', 'example', 'npc_admin', 'npc_hr', 'npc_reception', 'npc_recruiter'])
    // 每位走动的角色都要有完整四向走帧：缺向会让运行时走到某个方向时没有帧可播。
    let frames = 0
    for (const walker of walkers) {
      const walk = walker.clips.filter(clip => clip.action === 'walk')
      expect(walk.map(clip => clip.direction).sort(), walker.id).toEqual(['east', 'north', 'south', 'west'])
      expect(walk.every(clip => clip.frames.length > 0), walker.id).toBe(true)
      frames += walk.reduce((sum, clip) => sum + clip.frames.length, 0)
    }
    expect(frames).toBe(224)
    // 老板的走帧在自己的全量图集里；牛马大总管与设计示例没有走动命令或活动域，不编走帧。
    expect(needsWalk('boss', layout, profiles.get('boss'))).toBe(false)
    expect(needsWalk('butler', layout, profiles.get('butler'))).toBe(false)
    expect(needsWalk('sample_explorer', layout, profiles.get('sample_explorer'))).toBe(false)
  })

  it('普通职员的活动域按作者数据编译：格必须可站立、出生格必须在域内', async () => {
    const layout = await json(resolve(delivery, 'maps/office.layout.json'))
    const [tmj, tsj] = await Promise.all([
      json(resolve(delivery, 'maps/office.tmj')),
      json(resolve(delivery, 'maps/world.tsj')),
    ])
    const { runtime } = compile(tmj, layout, tsj)
    const profiles = await readProfiles()
    const hr = compileActivity(layout, runtime, 'npc_hr', profiles.get('npc_hr'))
    expect(hr).toMatchObject({ region: 'hr' })
    expect(hr!.cells).toHaveLength(12)
    expect(hr!.cells).toContainEqual([18, 5])
    // 员工与设计示例都没有活动域（自主活动只给本轮的普通职员）。
    expect(compileActivity(layout, runtime, 'blog', profiles.get('blog'))).toBeNull()
    expect(compileActivity(layout, runtime, 'sample_explorer', profiles.get('sample_explorer'))).toBeNull()
    // 负例一：活动域里混进阻挡格 → 构建失败（否则角色会被引到墙里）。
    const blocked = runtime.collision.findIndex(value => value === 1)
    const blockedCell = [blocked % runtime.width, Math.floor(blocked / runtime.width)]
    const onWall = clone(layout)
    onWall.npcs = clone(layout.npcs).map((npc: { id: string; activity_cells: number[][] }) =>
      npc.id === 'npc_hr' ? { ...npc, activity_cells: [...npc.activity_cells, blockedCell] } : npc)
    expect(() => compileActivity(onWall, runtime, 'npc_hr', profiles.get('npc_hr'))).toThrow(/不可站立/)
    // 负例二：出生格不在活动域里 → 构建失败（角色一开局就走不出去）。
    const outside = clone(layout)
    outside.npcs = clone(layout.npcs).map((npc: { id: string; initial_cell: number[] }) =>
      npc.id === 'npc_hr' ? { ...npc, initial_cell: [30, 25] } : npc)
    expect(() => compileActivity(outside, runtime, 'npc_hr', profiles.get('npc_hr'))).toThrow(/出生格不在活动域内/)
  })

  it('职责与作者预写对白：员工没有对白块，普通 NPC 用名册里的内容，旧示例保持 unavailable', async () => {
    const characters = await json(resolve(delivery, 'characters.json'))
    const layout = await json(resolve(delivery, 'maps/office.layout.json'))
    const profiles = new Map([
      ['npc_hr', { name: '沈禾', role: '人事', lines: ['这页先留白，你说完我再记。'], ordinary: true }],
    ])
    const character = (id: string) => (characters.characters as { id: string; label: string }[]).find(c => c.id === id)!
    expect(compileProfile('boss', layout, character('boss'), profiles)).toEqual({ role: 'player' })
    expect(compileProfile('butler', layout, character('butler'), profiles)).toEqual({ role: 'butler' })
    expect(compileProfile('blog', layout, character('blog'), profiles)).toEqual({ role: 'staff' })
    expect(compileProfile('npc_hr', layout, character('npc_hr'), profiles)).toEqual({
      role: 'npc',
      dialogue: { mode: 'authored_lines', name: '沈禾', role: '人事', lines: ['这页先留白，你说完我再记。'] },
    })
    // 设计示例（sample_explorer）按作者数据原样保留：id 不改、名字来自交付、通道 unavailable。
    expect(compileProfile('sample_explorer', layout, character('sample_explorer'), profiles)).toEqual({
      role: 'npc',
      dialogue: { mode: 'unavailable', name: '探险NPC示例', role: '', lines: [] },
    })
    // 业务员工拿不到对白块：本切片不给员工开搭话通道。
    expect(compileProfile('closedoff', layout, character('closedoff'), profiles)).not.toHaveProperty('dialogue')
    // 负例：声明了 authored_lines 却没有作者预写内容，构建期直接失败。
    expect(() => compileProfile('npc_hr', layout, character('npc_hr'), new Map())).toThrow(/预写台词/)
    // 负例：名册与美术档名字不一致必须失败（防止两处漂移）。
    expect(() => compileProfile('npc_hr', layout, character('npc_hr'), new Map([
      ['npc_hr', { name: '沈禾（改）', role: '人事', lines: ['x'], ordinary: true }],
    ]))).toThrow(/名字不一致/)
    // 负例：本切片不接模型对白通道。
    const modelLayout = clone(layout)
    modelLayout.npcs = clone(layout.npcs).map((n: { id: string }) => n.id === 'npc_hr' ? { ...n, dialogue_mode: 'model_chat' } : n)
    expect(() => compileProfile('npc_hr', modelLayout, character('npc_hr'), profiles)).toThrow(/模型对白通道/)
  })
})

/** 座位编译的最小双源夹具：一个工位、一把椅子和作者声明的椅背遮挡层。 */
type FixtureObject = {
  id: string; asset: string; x: number; y: number; pixel_width: number; pixel_height: number; layer: string
  image_position_px: number[]; blocked_cells: number[][]; sort_anchor_px: number[]
  preview_only?: boolean; preview_state?: string; seat_id?: string
}
type FixtureWorkstation = {
  seat_id: string; occupant: string | null; region: string; seat_direction: string; seat_cell: number[]
  seat_anchor_px: number[]; seat_contact_px: number[]; stand_cell: number[]; chair_object_id: string
  chair_foreground_rect_px: number[] | null
}
type FixtureFrame = { path: string; size: number[]; frameAnchor: number[]; seatAnchor?: number[] }
type FixtureClip = { action: string; direction: string; frames: FixtureFrame[] }
type SeatFixture = {
  layout: { id: string; width: number; height: number; tile_size: number; objects: FixtureObject[]; workstations: FixtureWorkstation[] }
  tmj: { layers: { name: string; type: string; objects: { name: string }[] }[] }
  runtime: { id: string; width: number; height: number; tileSize: number; collision: number[]; spawn: number[] }
  characters: { characters: { id: string; label: string; clips: FixtureClip[] }[] }
  tiles: Map<string, { image: string }>
}

function seatFixture(): SeatFixture {
  const width = 8, height = 8
  const chair = { id: 'chair_a', asset: 'chair', x: 2, y: 2, pixel_width: 32, pixel_height: 32, layer: 'furniture', image_position_px: [64, 64], blocked_cells: [[2, 2]], sort_anchor_px: [80, 112] }
  const back = { id: 'chair_back_a', asset: 'chair-back', x: 2, y: 3, pixel_width: 32, pixel_height: 32, layer: 'furniture', image_position_px: [64, 64], blocked_cells: [], sort_anchor_px: [80, 112], preview_only: true, preview_state: 'seated_chair_foreground' }
  const tmj = {
    layers: [{ name: 'furniture', type: 'objectgroup', objects: [{ name: 'chair_a' }, { name: 'chair_back_a' }] }],
  }
  const runtime = { id: 'mini', width, height, tileSize: 32, collision: Array.from({ length: width * height }, () => 0), spawn: [1, 1] }
  const characters = { characters: [{
    id: 'staff_a', label: '员工甲', clips: [
      { action: 'idle', direction: 'south', frames: [{ path: 'idle.png', size: [32, 48], frameAnchor: [16, 47] }] },
      { action: 'sit', direction: 'north', frames: [{ path: 'sit.png', size: [32, 48], frameAnchor: [16, 47], seatAnchor: [16, 39] }] },
    ],
  }] }
  const tiles = new Map([['chair', { image: 'chair.png' }], ['chair-back', { image: 'chair-back.png' }]])
  const layout = {
    id: 'mini', width, height, tile_size: 32, objects: [chair, back], workstations: [{
      seat_id: 'a_01', occupant: 'staff_a', region: 'dev', seat_direction: 'north', seat_cell: [2, 3], seat_anchor_px: [80, 112],
      seat_contact_px: [80, 82], stand_cell: [2, 4], chair_object_id: 'chair_a', chair_foreground_rect_px: [0, 0, 32, 18],
    }],
  }
  return { layout, tmj, runtime, characters, tiles }
}

const seatsOf = (fixture: SeatFixture) =>
  compileSeats(fixture.layout, fixture.tmj, fixture.runtime, fixture.characters, fixture.tiles)

describe('座位与遮挡编译', () => {
  it('工位、坐姿帧与椅背遮挡一致时输出可用座位块', () => {
    const fixture = seatFixture()
    const { seats, used } = seatsOf(fixture)
    expect(seats.get('staff_a')).toMatchObject({
      cell: [2, 3], direction: 'north', anchor: [80, 112], contact: [80, 82], stand: [2, 4], depth: 112.25,
      occlusion: { frame: 'chair-back', x: 64, y: 64, width: 32, height: 32, depth: 112.5 },
    })
    expect(used).toEqual([{ asset: 'chair-back', image: 'chair-back.png' }])
  })

  it('没有作者座位的角色不会凭空得到座位（空席不创建人物）', () => {
    const fixture = seatFixture()
    fixture.layout.workstations = fixture.layout.workstations.map(workstation => ({ ...workstation, occupant: null }))
    expect(seatsOf(fixture).seats.size).toBe(0)
  })

  it('负例：坐姿锚点没有对齐坐格中心必须失败', () => {
    const fixture = seatFixture()
    fixture.layout.workstations[0].seat_anchor_px = [88, 96]
    expect(() => seatsOf(fixture)).toThrow(/坐格中心/)
  })

  it('负例：站格与坐格重合、站格不可站立或越界必须失败', () => {
    const same = seatFixture(); same.layout.workstations[0].stand_cell = [2, 3]
    expect(() => seatsOf(same)).toThrow(/重合/)
    const walled = seatFixture(); walled.runtime.collision[4 * 8 + 2] = 1
    expect(() => seatsOf(walled)).toThrow(/不可站立/)
    const outside = seatFixture(); outside.layout.workstations[0].stand_cell = [2, 9]
    expect(() => seatsOf(outside)).toThrow(/站格越界/)
  })

  it('负例：缺少坐姿帧、坐姿方向不符或坐姿帧没有接触锚点必须失败', () => {
    const missing = seatFixture(); missing.characters.characters[0].clips = [missing.characters.characters[0].clips[0]]
    expect(() => seatsOf(missing)).toThrow(/坐姿帧/)
    const wrongDirection = seatFixture()
    wrongDirection.layout.workstations[0].seat_direction = 'west'
    expect(() => seatsOf(wrongDirection)).toThrow(/坐姿帧/)
    const noAnchor = seatFixture()
    noAnchor.characters.characters[0].clips[1].frames[0].seatAnchor = undefined
    expect(() => seatsOf(noAnchor)).toThrow(/接触锚点/)
  })

  it('负例：椅座缺失、锚点不一致、椅背缺资源或绘制顺序颠倒必须失败', () => {
    const noChair = seatFixture(); noChair.layout.objects = noChair.layout.objects.filter(o => o.id !== 'chair_a')
    expect(() => seatsOf(noChair)).toThrow(/椅座/)
    const mismatched = seatFixture(); mismatched.layout.objects[0].sort_anchor_px = [80, 128]
    expect(() => seatsOf(mismatched)).toThrow(/锚点与坐姿锚点不一致/)
    const noTile = seatFixture(); noTile.tiles.delete('chair-back')
    expect(() => seatsOf(noTile)).toThrow(/图集资源/)
    const reversed = seatFixture(); reversed.tmj.layers[0].objects = [{ name: 'chair_back_a' }, { name: 'chair_a' }]
    expect(() => seatsOf(reversed)).toThrow(/椅背必须在椅座之后/)
    const noBack = seatFixture(); noBack.layout.objects = noBack.layout.objects.filter(o => o.id !== 'chair_back_a')
    expect(() => seatsOf(noBack)).toThrow(/前景遮挡对象不唯一/)
    // 数据自相矛盾：没有声明前景遮挡，却给了一张作者椅背对象。
    const undeclared = seatFixture(); undeclared.layout.workstations[0].chair_foreground_rect_px = null
    expect(() => seatsOf(undeclared)).toThrow(/没有声明前景遮挡/)
    const blocked = seatFixture(); blocked.layout.objects[1].blocked_cells = [[2, 3]]
    expect(() => seatsOf(blocked)).toThrow(/不能阻挡通行/)
  })

  it('负例：声明了椅背却把遮挡矩形写得超出椅座像素必须失败', () => {
    const fixture = seatFixture()
    fixture.layout.workstations[0].chair_foreground_rect_px = [0, 0, 32, 40]
    expect(() => seatsOf(fixture)).toThrow(/矩形不合法/)
  })
})
