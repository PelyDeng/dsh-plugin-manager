/**
 * 构建期资源编译：读取美术交付的 Tiled `.tmj/.tsj` 与已验收 `*.layout.json` 双源，
 * 校验一致后输出唯一的精简运行时 JSON，并把地图物件与角色帧打成 Phaser multiatlas。
 * 地图编译与图集参数沿用第四阶段已验证实现；本脚本差异：三张图（office/street/cafe）
 * 同一套双源校验，只打包布局许可的角色，未获布局放置的角色直接构建失败。
 *
 * 世界拓扑（`maps/*.layout.json` 里的 entries 与 `maps/world-layout.json` 的连接）编译成
 * 一份 `world` 块，随每张图的运行时 JSON 一起下发：出生地图的首次静态请求预算只有 10 个，
 * 再单开一个 world.runtime.json 会超预算，而每张图带着同一份 world 块时，客户端无论
 * 先加载哪张图都能立刻拿到拓扑。三份必须逐字节相同，构建期断言。
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import texturePacker from 'free-tex-packer-core'

export const delivery = fileURLToPath(new URL('../docs/04-资源/美术资源包/delivery/', import.meta.url))
export const generated = fileURLToPath(new URL('../public/generated/', import.meta.url))
const json = async (file) => JSON.parse(await readFile(file, 'utf8'))
const props = (object) => Object.fromEntries((object.properties ?? []).map(p => [p.name, p.value]))
const inside = (root, file) => {
  const local = relative(root, file)
  assert(!local.startsWith('..') && !isAbsolute(local), '资源路径越界')
  return file
}
export const runtimeFile = (id) => id + '.runtime.json'

/** 可行走格集合（四邻域，0 可走）：入口的「可用返程」与出生点校验都用它。 */
export function reachable(runtime, start) {
  const index = (x, y) => y * runtime.width + x
  const seen = new Set()
  if (runtime.collision[index(start[0], start[1])]) return seen
  const queue = [start]
  while (queue.length) {
    const [x, y] = queue.pop()
    const key = x + ',' + y
    if (seen.has(key)) continue
    seen.add(key)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= runtime.width || ny >= runtime.height) continue
      if (runtime.collision[index(nx, ny)]) continue
      queue.push([nx, ny])
    }
  }
  return seen
}

const cellIn = (runtime, cell) => Array.isArray(cell) && cell.length === 2
  && cell.every(Number.isInteger) && cell[0] >= 0 && cell[1] >= 0 && cell[0] < runtime.width && cell[1] < runtime.height

/** 入口三格：触发格、到达格、退回格。构建期保证三格互不相同且都可站立。 */
export function compileEntries(layout, runtime, label) {
  const home = reachable(runtime, layout.entries[0].arrival)
  return layout.entries.map(entry => {
    for (const key of ['trigger', 'arrival', 'return']) {
      assert(cellIn(runtime, entry[key]), label + ' 入口格越界：' + entry.id + ' ' + key)
      assert.equal(runtime.collision[entry[key][1] * runtime.width + entry[key][0]], 0, label + ' 入口格不可站立：' + entry.id + ' ' + key)
    }
    assert.equal(typeof entry.region, 'string', label + ' 入口缺少区域：' + entry.id)
    assert.notDeepEqual(entry.arrival, entry.trigger, label + ' 到达格不能落在返程触发格上：' + entry.id)
    assert.notDeepEqual(entry.return, entry.trigger, label + ' 退回格不能与触发格重合：' + entry.id)
    assert.notDeepEqual(entry.arrival, entry.return, label + ' 到达格与退回格必须分开：' + entry.id)
    assert(home.has(entry.trigger.join(',')), label + ' 触发格从到达格不可达：' + entry.id)
    assert(home.has(entry.return.join(',')), label + ' 入口没有可用返程：' + entry.id)
    return { id: entry.id, region: entry.region, trigger: entry.trigger, arrival: entry.arrival, return: entry.return }
  })
}

export function compileMap(tmj, layout, tsj) {
  assert.equal(tmj.width, layout.width)
  assert.equal(tmj.height, layout.height)
  assert.equal(tmj.tilewidth, 32)
  assert.equal(tmj.tileheight, 32)
  assert.equal(layout.tile_size, 32)
  assert.equal(tmj.infinite, false)
  assert.equal(tmj.tilesets.length, 1)
  const firstgid = tmj.tilesets[0].firstgid
  const tiles = new Map(tsj.tiles.map(t => [t.id + firstgid, { ...t, asset: props(t).asset_id }]))
  const blocked = new Set(layout.blocked_cells.map(([x, y]) => {
    assert(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < tmj.width && y < tmj.height)
    return y * tmj.width + x
  }))
  const collision = tmj.layers.find(l => l.name === 'collision').data
  assert.equal(collision.length, tmj.width * tmj.height)
  collision.forEach((gid, index) => assert.equal(Boolean(gid), blocked.has(index), '碰撞差异 ' + layout.id + ' ' + index))
  const authored = new Map(layout.objects.map(o => [o.id, o]))
  const draws = []
  const used = new Map()
  const add = (gid, draw) => {
    const tile = tiles.get(gid)
    assert(tile, '未支持的 gid ' + gid)
    used.set(tile.asset, tile)
    draws.push({ ...draw, frame: tile.asset })
    return tile
  }
  for (const layer of tmj.layers) {
    if (layer.name === 'collision') continue
    if (layer.type === 'tilelayer') {
      assert.equal(layer.data.length, tmj.width * tmj.height)
      layer.data.forEach((gid, i) => gid && add(gid, { x: (i % tmj.width) * 32, y: Math.floor(i / tmj.width) * 32, width: 32, height: 32, depth: -2000 }))
    } else {
      for (const object of layer.objects) {
        const source = authored.get(object.name)
        assert(source, '缺少布局物件 ' + object.name)
        assert.equal(source.layer, layer.name)
        assert.equal(object.rotation, 0)
        assert.deepEqual([object.x, object.y - object.height], source.image_position_px)
        assert.deepEqual([object.width, object.height], [source.pixel_width, source.pixel_height])
        assert.deepEqual(JSON.parse(props(object).blocked_cells), source.blocked_cells)
        const tile = tiles.get(object.gid)
        assert(tile, '未支持的 gid ' + object.gid)
        if (!source.preview_only) add(object.gid, {
          x: object.x, y: object.y - object.height, width: object.width, height: object.height,
          depth: layer.name === 'decoration' ? -1000 : source.sort_anchor_px[1],
        })
        assert.equal(tile.asset, source.asset)
        authored.delete(object.name)
      }
    }
  }
  assert.equal(authored.size, 0, '布局物件未出现在 TMJ')
  const runtime = {
    id: layout.id, width: tmj.width, height: tmj.height, tileSize: 32,
    collision: collision.map(gid => gid ? 1 : 0), draws, spawn: layout.entries[0].arrival,
  }
  // 出生点（= 首个入口的到达格）必须在非阻挡格上，否则拒绝激活这张图。
  assert.equal(runtime.collision[runtime.spawn[1] * runtime.width + runtime.spawn[0]], 0, layout.id + ' 出生点落在阻挡格上')
  runtime.entries = compileEntries(layout, runtime, layout.id)
  return { runtime, used: [...used.values()] }
}

/**
 * 世界拓扑编译：连接两端的地图与入口必须都已编译，入口格可站立且触发格、退回格
 * 都能从到达格走到——「地图不得用可进入但没有可用返程的入口困住老板」。
 * 同一张图里入口三格互不重合：到达/退回格压在任何入口的触发格上都会立刻连跳，
 * 构建期直接拒绝，不只依赖运行时的防连跳记录。
 * 只有全部通过才写进运行时，客户端不猜地图 id、不硬编码连接。
 */
export function compileWorld(runtimes, worldLayout) {
  assert.equal(worldLayout.schema, 'niuma-art-world-v1', '世界布局 schema 不符')
  assert.equal(worldLayout.tile_size, 32, '世界布局 tile 尺寸不符')
  const order = worldLayout.maps.map(file => {
    assert.equal(typeof file, 'string', '世界布局 maps 必须是文件名')
    return file.replace(/\.layout\.json$/, '')
  })
  assert(order.length >= 2, '世界至少要有两张图')
  const byId = new Map(runtimes.map(r => [r.id, r]))
  assert.deepEqual([...byId.keys()].sort(), [...order].sort(), '世界布局的地图清单与已编译地图不一致')
  const seenTrigger = new Set()
  for (const runtime of runtimes) {
    const triggers = new Set(runtime.entries.map(entry => entry.trigger.join(',')))
    for (const entry of runtime.entries) {
      const key = runtime.id + '/' + entry.trigger.join(',')
      assert(!seenTrigger.has(key), '同一张图里两个入口共用触发格：' + key)
      seenTrigger.add(key)
      // 跨入口重合防线：本图任何入口的到达/退回格都不得与本图任何入口的触发格重合。
      // 落点正好压在触发格上时，人物一站定就会发起下一次切图（连跳），运行时的
      // 防连跳只保证「刚用过的那个入口」，跨入口的重合必须在构建期直接拒绝。
      for (const [name, cell] of [['到达格', entry.arrival], ['退回格', entry.return]]) {
        assert(!triggers.has(cell.join(',')), runtime.id + ' 入口 ' + entry.id + ' 的' + name + '与某个入口的触发格重合：' + cell.join(','))
      }
    }
  }
  const connections = worldLayout.connections.map(connection => {
    assert.equal(connection.bidirectional, true, '连接必须双向：' + connection.id)
    assert.equal(connection.from.map_id === connection.to.map_id, false, '连接两端不能是同一张图：' + connection.id)
    const ends = [connection.from, connection.to].map(end => {
      const runtime = byId.get(end.map_id)
      assert(runtime, '连接引用了未编译的地图：' + connection.id + ' ' + end.map_id)
      const entry = runtime.entries.find(e => e.id === end.entry_id)
      assert(entry, '连接引用了不存在的入口：' + connection.id + ' ' + end.entry_id)
      assert.equal(entry.region === undefined, false, '入口缺少区域：' + end.entry_id)
      return { map: runtime.id, entry: entry.id }
    })
    return { id: connection.id, from: { map: ends[0].map, entry: ends[0].entry }, to: { map: ends[1].map, entry: ends[1].entry } }
  })
  assert(connections.length > 0, '世界至少要有一条可用连接')
  return {
    tileSize: 32,
    birth: order[0],
    maps: runtimes.map(r => ({ id: r.id, width: r.width, height: r.height, spawn: r.spawn, entries: r.entries })),
    connections,
  }
}

async function pack(name, inputs) {
  const files = await new Promise((yes, no) => texturePacker(inputs, {
    textureName: name, exporter: 'Phaser3', width: 2048, height: 2048,
    allowRotation: false, allowTrim: false, detectIdentical: false, padding: 2,
  }, (files, error) => error ? no(error) : yes(files)))
  const atlas = JSON.parse(files.find(f => f.name.endsWith('.json')).buffer.toString())
  for (const texture of atlas.textures) {
    assert(texture.size.w <= 2048 && texture.size.h <= 2048)
    for (const frame of texture.frames) assert(!frame.rotated && !frame.trimmed)
  }
  await Promise.all(files.map(f => writeFile(resolve(generated, f.name), f.buffer)))
  return { name, frames: inputs.length, textures: atlas.textures.map(t => ({ image: t.image, ...t.size })) }
}

/** 同名图集只打一次：老板全量动画三张图共用同一份文件。 */
async function packOnce(cache, name, inputs) {
  const packed = cache.get(name)
  if (packed) return packed
  const result = await pack(name, inputs)
  cache.set(name, result)
  return result
}

const toClip = (clip) => ({ action: clip.action, direction: clip.direction, frames: clip.frames.map(f => ({ path: f.path, size: f.size, anchor: f.frameAnchor })) })

/** 按地图许可装载角色：老板走出生点与全量动画，其余角色须逐个对上布局的工位/出生格。 */
async function buildCharacters(characters, layout, runtime, atlases, cache) {
  const placements = new Map([...layout.posts.map(p => [p.occupant, p.cell]), ...layout.npcs.map(n => [n.id, n.initial_cell])])
  const npcAtlas = layout.id + '-npcs'
  const npcInputs = []
  runtime.characters = []
  for (const character of characters.characters) {
    if (!placements.has(character.id) && character.id !== 'boss') continue
    const clips = character.clips.map(toClip)
    if (character.id === 'boss') {
      const inputs = await Promise.all(clips.flatMap(c => c.frames).map(async f => ({ path: f.path, contents: await readFile(inside(delivery, resolve(delivery, f.path))) })))
      atlases.push(await packOnce(cache, character.id, inputs))
      runtime.characters.push({ id: character.id, label: character.label, atlas: 'boss', clips, cell: runtime.spawn })
      continue
    }
    // 首包预算：地图 NPC 这一阶段只需要站姿，全部 NPC 的 idle 帧合并进一张图集；
    // 表现所需的走动/手势帧留到对应切片再进入运行包。
    const idle = clips.filter(c => c.action === 'idle')
    assert(idle.length > 0, 'NPC 缺少 idle 动画：' + character.id)
    for (const clip of idle) for (const frame of clip.frames) npcInputs.push({ path: frame.path, contents: await readFile(inside(delivery, resolve(delivery, frame.path))) })
    runtime.characters.push({ id: character.id, label: character.label, atlas: npcAtlas, clips: idle, cell: placements.get(character.id) })
  }
  const placed = [...placements.keys()].sort()
  const loaded = runtime.characters.map(c => c.id).sort()
  // 老板是玩家、走出生点，不按工位比对；其余角色必须与布局许可一一对应。
  assert.deepEqual(loaded.filter(id => id !== 'boss'), placed.filter(id => id !== 'boss'), layout.id + ' 布局许可角色与运行时角色不一致')
  runtime.atlases = [layout.id, ...(npcInputs.length ? [npcAtlas] : [])]
  if (npcInputs.length) atlases.push(await packOnce(cache, npcAtlas, npcInputs))
  return atlases
}

export async function prepare() {
  const worldLayout = await json(resolve(delivery, 'maps/world-layout.json'))
  const characters = await json(resolve(delivery, 'characters.json'))
  const mapIds = worldLayout.maps.map(file => file.replace(/\.layout\.json$/, ''))
  const compiled = []
  for (const id of mapIds) {
    const [tmj, layout] = await Promise.all([
      json(resolve(delivery, 'maps/' + id + '.tmj')), json(resolve(delivery, 'maps/' + id + '.layout.json')),
    ])
    assert.equal(layout.id, id, '布局 id 与文件名不一致：' + id)
    const tsjFile = inside(delivery, resolve(delivery, 'maps', tmj.tilesets[0].source))
    const tsj = await json(tsjFile)
    compiled.push({ id, layout, tmj, tsjFile, ...compileMap(tmj, layout, tsj) })
  }
  const world = compileWorld(compiled.map(c => c.runtime), worldLayout)
  assert.equal(relative(fileURLToPath(new URL('../public/', import.meta.url)), generated), 'generated')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const maps = []
  const cache = new Map()
  for (const item of compiled) {
    const atlases = []
    // 地图图集：只用这张图实际引用到的 tile。
    atlases.push(await packOnce(cache, item.id, await Promise.all(item.used.map(async t => ({ path: t.asset, contents: await readFile(inside(delivery, resolve(dirname(item.tsjFile), t.image))) })))))
    await buildCharacters(characters, item.layout, item.runtime, atlases, cache)
    item.runtime.world = world
    await writeFile(resolve(generated, runtimeFile(item.id)), JSON.stringify(item.runtime))
    maps.push({
      map: item.id, blocked: item.runtime.collision.filter(Boolean).length, renderedDraws: item.runtime.draws.length,
      characters: item.runtime.characters.map(c => c.id), spawn: item.runtime.spawn,
      entries: item.runtime.entries.map(e => e.id), atlases,
    })
  }
  const result = { birth: world.birth, maps, connections: world.connections.map(c => c.id), sourceRuntimeReady: compiled[0].layout.runtime_ready }
  await writeFile(resolve(generated, 'asset-report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare()
