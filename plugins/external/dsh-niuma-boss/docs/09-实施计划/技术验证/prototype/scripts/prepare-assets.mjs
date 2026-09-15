import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import texturePacker from 'free-tex-packer-core'

export const delivery = fileURLToPath(new URL('../../../../04-资源/美术资源包/delivery/', import.meta.url))
export const generated = fileURLToPath(new URL('../public/generated/', import.meta.url))
const json = async (file) => JSON.parse(await readFile(file, 'utf8'))
const props = (object) => Object.fromEntries((object.properties ?? []).map(p => [p.name, p.value]))
const inside = (root, file) => {
  const local = relative(root, file)
  assert(!local.startsWith('..') && !isAbsolute(local), '资源路径越界')
  return file
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
  collision.forEach((gid, index) => assert.equal(Boolean(gid), blocked.has(index), '碰撞差异 ' + index))
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
  return { runtime: { id: layout.id, width: tmj.width, height: tmj.height, tileSize: 32, collision: collision.map(gid => gid ? 1 : 0), draws, spawn: layout.entries[0].arrival }, used: [...used.values()] }
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

export async function prepare() {
  const [tmj, layout, characters] = await Promise.all([
    json(resolve(delivery, 'maps/office.tmj')), json(resolve(delivery, 'maps/office.layout.json')), json(resolve(delivery, 'characters.json')),
  ])
  const tsjFile = inside(delivery, resolve(delivery, 'maps', tmj.tilesets[0].source))
  const tsj = await json(tsjFile)
  const { runtime, used } = compileMap(tmj, layout, tsj)
  assert.equal(relative(fileURLToPath(new URL('../public/', import.meta.url)), generated), 'generated')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const atlases = []
  atlases.push(await pack('office', await Promise.all(used.map(async t => ({ path: t.asset, contents: await readFile(inside(delivery, resolve(dirname(tsjFile), t.image))) })))))
  const placements = new Map([...layout.posts.map(p => [p.occupant, p.cell]), ...layout.npcs.map(n => [n.id, n.initial_cell])])
  runtime.characters = []
  for (const character of characters.characters) {
    const clips = character.clips.map(clip => ({ action: clip.action, direction: clip.direction, frames: clip.frames.map(f => ({ path: f.path, size: f.size, anchor: f.frameAnchor })) }))
    const inputs = await Promise.all(clips.flatMap(c => c.frames).map(async f => ({ path: f.path, contents: await readFile(inside(delivery, resolve(delivery, f.path))) })))
    atlases.push(await pack(character.id, inputs))
    // ponytail: 咖啡示例仅在重场景压力夹具里放到合法格；正式世界按地图许可加载。
    runtime.characters.push({ id: character.id, label: character.label, cell: character.id === 'boss' ? runtime.spawn : placements.get(character.id) ?? [29, 21], clips })
  }
  const effects = ['ambient-dust', 'coffee-steam', 'window-glint', 'window-rain']
  runtime.effects = effects.map(effect => Array.from({ length: 4 }, (_, i) => 'vfx/' + effect + '/frame_0' + i + '.png'))
  atlases.push(await pack('vfx', await Promise.all(runtime.effects.flat().map(async path => ({ path, contents: await readFile(resolve(delivery, path)) })))))
  await writeFile(resolve(generated, 'office.runtime.json'), JSON.stringify(runtime))
  const result = { map: 'office', blocked: runtime.collision.filter(Boolean).length, renderedDraws: runtime.draws.length, characters: runtime.characters.length, sourceRuntimeReady: layout.runtime_ready, atlases }
  await writeFile(resolve(generated, 'asset-report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare()
