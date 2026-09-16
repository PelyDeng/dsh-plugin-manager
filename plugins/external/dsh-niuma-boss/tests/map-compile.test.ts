import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileMap, compileWorld, delivery, reachable } from '../scripts/prepare-assets.mjs'

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
})
