/**
 * 构建期资源编译：读取美术交付的 Tiled `.tmj/.tsj` 与已验收 `*.layout.json` 双源，
 * 校验一致后输出唯一的精简运行时 JSON，并把地图物件与角色帧打成 Phaser multiatlas。
 * 地图编译与图集参数沿用第四阶段已验证实现；本脚本差异：三张图（office/street/cafe）
 * 同一套双源校验，只打包布局许可的角色，未获布局放置的角色直接构建失败。
 *
 * 第五阶段切片 4 在这一层编译**人物表现需要的作者数据**，运行时不再猜坐标：
 *
 * - 座位：工位给出 `seat_cell`（坐姿导航脚点）、`seat_anchor_px`（坐格中心）、
 *   `seat_contact_px`（臀部接触点）、`seat_direction`、`stand_cell`（站格）与
 *   `chair_object_id`。坐姿精灵左上角 = 接触点 − 逐帧 `seatAnchor`；
 * - 遮挡：作者用 `chair_foreground_rect_px` + 一张 `preview_state =
 *   seated_chair_foreground` 的椅背对象声明「画在坐姿角色之上」的那部分。运行时数据把
 *   椅座 → 坐姿角色 → 椅背编译成同一 y 锚点内的三个深度槽位（作者在 TMJ 里的绘制顺序
 *   就是这三者的先后，构建期核对）；没有声明前景的座位（例如面朝南的前台）不给遮挡层；
 * - 职责与对白：`role` 由布局的角色来源给出（老板/牛马大总管/业务员工/普通 NPC），
 *   普通 NPC 的预写内容与名字取美术交付的 NPC 档（`delivery/office-live/scene-data.js`
 *   的 `actors[].lines`），`authored_lines` 之外一律 `unavailable`；业务员工不编译对白
 *   （本切片不给员工开搭话通道，也不接模型通道）。
 * - 走动与活动域：**走帧单独一张图集**（`<map>-walk`），只编给本切片真会走动的角色——
 *   业务员工（派单去会合点、终态交回工位）与美术交付标记 `ordinary: true` 的普通职员
 *   （`npc_rules.yaml#preview` 的职责域自主活动预览）。老板的全量动画本来就在自己的图集里，
 *   牛马大总管与设计示例（`sample_explorer`/`sample_cafe_keeper`）保持到位表现，不编走帧。
 *   图集键写在 `runtime.walkAtlas` 上，但**不进** `runtime.atlases`：它由运行时的懒加载
 *   在出生地图就绪之后按需拉取（首包预算只有 10 个静态请求，走帧并入 `*-npcs` 或首包
 *   都会顶破门槛，`office-npcs.png` 到 2048 上限也只剩 20px）。普通职员的活动域
 *   （`activity_region` + `activity_cells`）在同一层校验后编进 `character.activity`。
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

/** 作者在场景数据里的职责方向、对白通道与遮挡标记（npc_rules.yaml / 美术交付）。 */
const DIRECTIONS = ['north', 'south', 'east', 'west']
const DIALOGUE_MODES = ['authored_lines', 'model_chat', 'unavailable']
const SEATED_FOREGROUND = 'seated_chair_foreground'
/**
 * 同一 y 锚点内的遮挡槽位步长：作者用绘制顺序表达「椅座 0 / 坐姿角色 1 / 椅背 2」，
 * 运行时数据把它编译成同一锚点上的三个深度，保持 map_rules.rendering.y_sort 的锚点排序。
 */
const SEAT_SLOT_STEP = 0.25

/** 普通 NPC 的作者预写内容：美术交付的 office-live 场景数据（JSON 形式，构建期不解析 YAML）。 */
export async function readProfiles() {
  const file = resolve(delivery, 'office-live/scene-data.js')
  const text = await readFile(file, 'utf8')
  const body = text.replace(/^\s*window\.OFFICE_LIVE_DATA\s*=\s*/, '').replace(/;\s*$/, '')
  const data = JSON.parse(body)
  const profiles = new Map()
  for (const actor of data.actors ?? []) {
    assert(typeof actor.id === 'string' && actor.id !== '', '作者 NPC 档缺少 id')
    profiles.set(actor.id, {
      name: typeof actor.name === 'string' ? actor.name : '',
      role: typeof actor.role === 'string' ? actor.role : '',
      lines: Array.isArray(actor.lines) ? actor.lines.filter(line => typeof line === 'string' && line.trim() !== '') : [],
      ordinary: actor.ordinary === true,
    })
  }
  return profiles
}

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

/** TMJ 里的物件绘制顺序（家具层内的先后）：作者用它表达「椅座 → 坐姿角色 → 椅背」。 */
export function objectOrder(tmj) {
  const order = new Map()
  for (const layer of tmj.layers ?? []) {
    if (layer.type !== 'objectgroup') continue
    layer.objects.forEach((object, index) => order.set(object.name, index))
  }
  return order
}

/**
 * 座位与遮挡编译：工位给出的坐格/坐姿锚点/接触点/方向/站格 + 坐姿帧 + 作者声明的
 * 椅背遮挡层，一起编译成运行时座位块。全部校验都在这里，运行时只读结果。
 * `tilesByAsset` 用于核对遮挡资源确实存在，并把它的 tile 交给调用方打进地图图集。
 */
export function compileSeats(layout, tmj, runtime, characters, tilesByAsset = new Map()) {
  const order = objectOrder(tmj)
  const seats = new Map()
  const used = []
  for (const workstation of layout.workstations ?? []) {
    const occupant = workstation.occupant
    // 空席不创建人物，也不编译座位（map_rules.yaml：空席不创建人物或任务）。
    if (occupant === null || occupant === undefined) continue
    const label = layout.id + ' 工位 ' + workstation.seat_id + '（' + occupant + '）'
    assert(!seats.has(occupant), label + ' 同一角色占了多个工位')
    const character = characters.characters.find(c => c.id === occupant)
    assert(character !== undefined, label + ' 没有对应角色数据')
    const direction = workstation.seat_direction
    assert(DIRECTIONS.includes(direction), label + ' 坐姿方向非法：' + direction)
    // 作者约定：坐姿导航脚点对齐坐格中心（与美术交付的坐立预览同一套校验）。
    assert(cellIn(runtime, workstation.seat_cell), label + ' 坐格越界')
    assert.deepEqual(workstation.seat_anchor_px, [workstation.seat_cell[0] * 32 + 16, workstation.seat_cell[1] * 32 + 16],
      label + ' 坐姿锚点没有对齐坐格中心')
    assert(Array.isArray(workstation.seat_contact_px) && workstation.seat_contact_px.every(Number.isInteger),
      label + ' 缺少座位接触点')
    // 站格：员工离座与回位站的地方，必须可走且与坐格分开。
    assert(cellIn(runtime, workstation.stand_cell), label + ' 站格越界')
    assert.notDeepEqual(workstation.stand_cell, workstation.seat_cell, label + ' 坐格与站格重合')
    assert.equal(runtime.collision[workstation.stand_cell[1] * runtime.width + workstation.stand_cell[0]], 0,
      label + ' 站格不可站立')
    // 坐姿帧：方向要对得上，逐帧必须带作者接触锚点（否则坐姿会滑到地上）。
    const sit = character.clips.find(c => c.action === 'sit' && c.direction === direction)
    assert(sit !== undefined, label + ' 缺少 ' + direction + ' 坐姿帧')
    assert(sit.frames.length > 0, label + ' 坐姿帧为空')
    for (const frame of sit.frames) {
      assert(Array.isArray(frame.seatAnchor) && frame.seatAnchor.every(Number.isInteger),
        label + ' 坐姿帧缺少臀部接触锚点')
    }
    // 椅座与遮挡：椅座锚点必须与坐姿锚点一致（坐姿角色才落在椅座与椅背之间）。
    const chair = layout.objects.find(o => o.id === workstation.chair_object_id)
    assert(chair !== undefined && !chair.preview_only, label + ' 缺少作者椅座对象：' + workstation.chair_object_id)
    assert(Array.isArray(chair.sort_anchor_px) && chair.sort_anchor_px.every(Number.isInteger), label + ' 椅座缺少排序锚点')
    assert.deepEqual(chair.sort_anchor_px, workstation.seat_anchor_px, label + ' 椅座锚点与坐姿锚点不一致')
    const occlusion = compileOcclusion(workstation, { layout, chair, order, tilesByAsset, label })
    const anchorY = workstation.seat_anchor_px[1]
    seats.set(occupant, {
      cell: [...workstation.seat_cell],
      direction,
      anchor: [...workstation.seat_anchor_px],
      contact: [...workstation.seat_contact_px],
      // 同一 y 锚点内的槽位：椅座（地图绘制里已有的深度）< 坐姿角色 < 椅背。
      depth: anchorY + SEAT_SLOT_STEP,
      stand: [...workstation.stand_cell],
      sit: { action: 'sit', direction, frames: sit.frames.map(f => ({ path: f.path, size: f.size, anchor: f.frameAnchor, seat: f.seatAnchor })) },
      occlusion: occlusion === null ? null : { ...occlusion.block, depth: anchorY + 2 * SEAT_SLOT_STEP },
    })
    if (occlusion !== null) used.push(occlusion.tile)
  }
  return { seats, used }
}

/**
 * 前景遮挡层：作者用 `chair_foreground_rect_px` 声明存在遮挡，并用一张
 * `preview_state = seated_chair_foreground` 的椅背对象给出要画在角色之上的那部分。
 * 声明与对象必须一一对应：少了画不出来，多了说明数据自相矛盾，都直接构建失败。
 */
function compileOcclusion(workstation, { layout, chair, order, tilesByAsset, label }) {
  const rect = workstation.chair_foreground_rect_px
  // 匹配作者声明的椅背：优先按坐席标识（`seat_id` 或 `chair_back_<seat_id>` 命名约定），
  // 其余按「同一个 y 排序槽位」这个几何事实配对——它正是遮挡层要落在的位置。
  const candidates = layout.objects.filter(o => o.preview_state === SEATED_FOREGROUND
    && Array.isArray(o.sort_anchor_px) && o.sort_anchor_px[0] === chair.sort_anchor_px[0] && o.sort_anchor_px[1] === chair.sort_anchor_px[1])
  const named = candidates.filter(o => o.seat_id === workstation.seat_id || o.id === 'chair_back_' + workstation.seat_id)
  const foregrounds = named.length > 0 ? named : candidates
  if (rect === null || rect === undefined) {
    assert.equal(candidates.length, 0, label + ' 没有声明前景遮挡，却存在作者椅背对象')
    return null
  }
  assert(Array.isArray(rect) && rect.length === 4 && rect.every(Number.isInteger)
    && rect[0] >= 0 && rect[1] >= 0 && rect[2] > 0 && rect[3] > 0
    && rect[0] + rect[2] <= chair.pixel_width && rect[1] + rect[3] <= chair.pixel_height,
  label + ' 前景遮挡矩形不合法：' + JSON.stringify(rect))
  assert.equal(foregrounds.length, 1, label + ' 前景遮挡对象不唯一：' + foregrounds.length)
  const foreground = foregrounds[0]
  assert.equal(foreground.layer, 'furniture', label + ' 前景遮挡必须在家具层')
  assert.deepEqual(foreground.blocked_cells ?? [], [], label + ' 前景遮挡不能阻挡通行')
  assert.deepEqual(foreground.sort_anchor_px, chair.sort_anchor_px, label + ' 前景遮挡与椅座锚点不一致')
  assert(Number.isInteger(foreground.image_position_px?.[0]) && Number.isInteger(foreground.image_position_px?.[1]),
    label + ' 前景遮挡缺少图片位置')
  assert(order.has(foreground.id) && order.has(chair.id) && order.get(foreground.id) > order.get(chair.id),
    label + ' 作者绘制顺序里椅背必须在椅座之后')
  const tile = tilesByAsset.get(foreground.asset)
  assert(tile !== undefined, label + ' 前景遮挡缺少图集资源：' + foreground.asset)
  return {
    block: {
      frame: foreground.asset, x: foreground.image_position_px[0], y: foreground.image_position_px[1],
      width: foreground.pixel_width, height: foreground.pixel_height,
    },
    tile: { asset: foreground.asset, image: tile.image },
  }
}

/**
 * 角色职责与对白：职责来自布局（工位 role_kind / 普通 NPC 名册），对白内容来自美术交付的
 * NPC 档。业务员工（staff）不编译对白块——本切片不给员工开搭话通道，也不接模型通道。
 */
export function compileProfile(id, layout, character, profiles = new Map()) {
  const label = layout.id + ' 角色 ' + id
  if (id === 'boss') return { role: 'player' }
  if (id === 'butler') return { role: 'butler' }
  if ((layout.posts ?? []).some(post => post.occupant === id && post.role_kind === 'special_npc_staff')) {
    return { role: 'staff' }
  }
  const npc = (layout.npcs ?? []).find(entry => entry.id === id)
  // 布局没登记的角色（街道陈设等）按场景角色处理，不给任何对白内容。
  if (npc === undefined) return { role: 'npc' }
  const mode = npc.dialogue_mode ?? 'unavailable'
  assert(DIALOGUE_MODES.includes(mode), label + ' 对白通道非法：' + mode)
  assert(mode !== 'model_chat', label + ' 本切片不接模型对白通道')
  const profile = profiles.get(id)
  if (mode === 'authored_lines') {
    const lines = profile?.lines ?? []
    assert(lines.length > 0, label + ' 缺少作者预写台词')
    if (npc.name !== undefined && profile?.name) {
      assert.equal(npc.name, profile.name, label + ' 作者名册与美术档名字不一致')
    }
    return {
      role: 'npc',
      dialogue: { mode, name: npc.name ?? profile?.name ?? character.label, role: profile?.role ?? '', lines: [...lines] },
    }
  }
  // unavailable：名牌与职责可展示，不提供自然语言输入（设计示例按作者数据原样保留）。
  return {
    role: 'npc',
    dialogue: { mode, name: npc.name ?? character.label, role: profile?.role ?? '', lines: [] },
  }
}

/**
 * 世界拓扑编译：连接两端的地图与入口必须都已编译，入口格可站立且触发格、退回格
 * 都能从到达格走到——「地图不得用可进入但没有可用返程的入口困住老板」。
 * 同一张图里入口三格互不重合：到达/退回格压在任何入口的触发格上都会立刻连跳，
 * 构建期直接拒绝，不只依赖运行时的防连跳记录。
 * 只有全部通过才写进运行时，客户端不猜地图 id、不硬编码连接。
 */export function compileWorld(runtimes, worldLayout) {
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

/**
 * 这一位是否要编走帧：业务员工（布局工位 `role_kind = special_npc_staff`）与美术交付标记
 * `ordinary: true` 的普通职员（`npc_rules.yaml#preview` 的活动预览）。规则只看作者数据，
 * 不按角色 id 特判。
 */
export function needsWalk(id, layout, profile) {
  if ((layout.posts ?? []).some(post => post.occupant === id && post.role_kind === 'special_npc_staff')) return true
  return profile?.ordinary === true
}

/**
 * 普通职员的自主活动域（`npc_rules.yaml#movement`）：作者给的 `activity_cells` 必须是
 * 本图内可站立的格，出生格也要落在域里（否则角色一开局就走不出去）。运行时的自主活动
 * 只在域内选点，并整条路径核对——越界的路一律丢弃，不因为老板靠近而扩大范围。
 */
export function compileActivity(layout, runtime, id, profile) {
  if (profile?.ordinary !== true) return null
  const npc = (layout.npcs ?? []).find(entry => entry.id === id)
  const label = layout.id + ' 普通职员 ' + id
  assert(npc !== undefined, label + ' 缺少作者 NPC 名册项')
  assert.equal(npc.status, 'roster', label + ' 作者标记为普通职员，名册状态却是 ' + npc.status)
  assert(typeof npc.activity_region === 'string' && npc.activity_region !== '', label + ' 缺少职责活动区域')
  const cells = npc.activity_cells
  assert(Array.isArray(cells) && cells.length > 0, label + ' 缺少作者活动域格集合')
  for (const cell of cells) {
    assert(cellIn(runtime, cell), label + ' 活动域格越界：' + JSON.stringify(cell))
    assert.equal(runtime.collision[cell[1] * runtime.width + cell[0]], 0, label + ' 活动域格不可站立：' + JSON.stringify(cell))
  }
  assert(cells.some(cell => cell[0] === npc.initial_cell[0] && cell[1] === npc.initial_cell[1]),
    label + ' 出生格不在活动域内')
  return { region: npc.activity_region, cells: cells.map(cell => [...cell]) }
}

const toClip = (clip) => ({ action: clip.action, direction: clip.direction, frames: clip.frames.map(f => ({ path: f.path, size: f.size, anchor: f.frameAnchor })) })

/**
 * 按地图许可装载角色：老板走出生点与全量动画，其余角色须逐个对上布局的工位/出生格。
 * 有作者座位的角色额外打包**坐姿帧**，会的走动的角色再单独打一张**走帧图集**
 * （`<map>-walk`，键写在 `runtime.walkAtlas` 上、不进 `runtime.atlases`，由运行时懒加载）
 * 与职责/对白/活动域块；骨架不齐整直接构建失败。
 */
async function buildCharacters(characters, layout, runtime, atlases, cache, profiles, seats) {
  const placements = new Map([...layout.posts.map(p => [p.occupant, p.cell]), ...layout.npcs.map(n => [n.id, n.initial_cell])])
  const npcAtlas = layout.id + '-npcs'
  const walkAtlas = layout.id + '-walk'
  const npcInputs = []
  const walkInputs = []
  const seen = new Set()
  runtime.characters = []
  for (const character of characters.characters) {
    if (!placements.has(character.id) && character.id !== 'boss') continue
    assert(!seen.has(character.id), '布局许可角色重复：' + character.id)
    seen.add(character.id)
    const clips = character.clips.map(toClip)
    const profile = compileProfile(character.id, layout, character, profiles)
    const seat = seats.get(character.id)
    if (character.id === 'boss') {
      assert(seat === undefined, '老板走出生点，不按工位编译座位')
      const inputs = await Promise.all(clips.flatMap(c => c.frames).map(async f => ({ path: f.path, contents: await readFile(inside(delivery, resolve(delivery, f.path))) })))
      atlases.push(await packOnce(cache, character.id, inputs))
      runtime.characters.push({ id: character.id, label: character.label, atlas: 'boss', clips, cell: runtime.spawn, ...profile })
      continue
    }
    // 首包预算：地图 NPC 带上站姿（idle）与坐姿（sit，仅座位方向）；走帧进独立图集，
    // 既不为「看起来更全」把首包撑过门槛，也不去挤已经贴到 2048 上限的 npc 图集。
    const packed = clips.filter(c => c.action === 'idle' || (seat !== undefined && c.action === 'sit' && c.direction === seat.direction))
    assert(packed.some(c => c.action === 'idle'), 'NPC 缺少 idle 动画：' + character.id)
    assert(seat === undefined || packed.some(c => c.action === 'sit'), '角色缺少可用的坐姿帧：' + character.id)
    for (const clip of packed) for (const frame of clip.frames) npcInputs.push({ path: frame.path, contents: await readFile(inside(delivery, resolve(delivery, frame.path))) })
    const walk = needsWalk(character.id, layout, profiles.get(character.id))
      ? clips.filter(clip => clip.action === 'walk')
      : []
    // 走的角色必须有四向走帧：缺向会让运行时走到某个方向时没有帧可播。
    if (walk.length > 0) {
      assert.equal(walk.length, DIRECTIONS.length, '走帧不齐（需要四向）：' + character.id)
      for (const clip of walk) {
        assert(clip.frames.length > 0, '走帧为空：' + character.id + ' ' + clip.direction)
        for (const frame of clip.frames) walkInputs.push({ path: frame.path, contents: await readFile(inside(delivery, resolve(delivery, frame.path))) })
      }
    }
    const activity = compileActivity(layout, runtime, character.id, profiles.get(character.id))
    runtime.characters.push({
      id: character.id, label: character.label, atlas: npcAtlas, clips: packed,
      cell: seat ? seat.cell : placements.get(character.id), ...profile,
      ...(seat === undefined ? {} : { seat }),
      ...(walk.length === 0 ? {} : { walk }),
      ...(activity === null ? {} : { activity }),
    })
  }
  const placed = [...placements.keys()].sort()
  const loaded = runtime.characters.map(c => c.id).sort()
  // 老板是玩家、走出生点，不按工位比对；其余角色必须与布局许可一一对应。
  assert.deepEqual(loaded.filter(id => id !== 'boss'), placed.filter(id => id !== 'boss'), layout.id + ' 布局许可角色与运行时角色不一致')
  runtime.atlases = [layout.id, ...(npcInputs.length ? [npcAtlas] : [])]
  runtime.walkAtlas = walkInputs.length > 0 ? walkAtlas : null
  if (npcInputs.length) atlases.push(await packOnce(cache, npcAtlas, npcInputs))
  if (walkInputs.length > 0) atlases.push(await packOnce(cache, walkAtlas, walkInputs))
  return atlases
}

export async function prepare() {
  const worldLayout = await json(resolve(delivery, 'maps/world-layout.json'))
  const characters = await json(resolve(delivery, 'characters.json'))
  const profiles = await readProfiles()
  const mapIds = worldLayout.maps.map(file => file.replace(/\.layout\.json$/, ''))
  const compiled = []
  for (const id of mapIds) {
    const [tmj, layout] = await Promise.all([
      json(resolve(delivery, 'maps/' + id + '.tmj')), json(resolve(delivery, 'maps/' + id + '.layout.json')),
    ])
    assert.equal(layout.id, id, '布局 id 与文件名不一致：' + id)
    const tsjFile = inside(delivery, resolve(delivery, 'maps', tmj.tilesets[0].source))
    const tsj = await json(tsjFile)
    compiled.push({ id, layout, tmj, tsj, tsjFile, ...compileMap(tmj, layout, tsj) })
  }
  const world = compileWorld(compiled.map(c => c.runtime), worldLayout)
  assert.equal(relative(fileURLToPath(new URL('../public/', import.meta.url)), generated), 'generated')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const maps = []
  const cache = new Map()
  for (const item of compiled) {
    const atlases = []
    // 座位与遮挡：作者工位 + 坐姿帧 + 椅背遮挡层；遮挡资源同时进地图图集。
    const tiles = new Map(item.tsj.tiles.map(tile => [props(tile).asset_id, tile]))
    const { seats, used } = compileSeats(item.layout, item.tmj, item.runtime, characters, tiles)
    item.used.push(...used.filter(tile => !item.used.some(existing => existing.asset === tile.asset)))
    // 地图图集：只用这张图实际引用到的 tile。
    atlases.push(await packOnce(cache, item.id, await Promise.all(item.used.map(async t => ({ path: t.asset, contents: await readFile(inside(delivery, resolve(dirname(item.tsjFile), t.image))) })))))
    await buildCharacters(characters, item.layout, item.runtime, atlases, cache, profiles, seats)
    item.runtime.world = world
    await writeFile(resolve(generated, runtimeFile(item.id)), JSON.stringify(item.runtime))
    maps.push({
      map: item.id, blocked: item.runtime.collision.filter(Boolean).length, renderedDraws: item.runtime.draws.length,
      characters: item.runtime.characters.map(c => c.id), spawn: item.runtime.spawn,
      entries: item.runtime.entries.map(e => e.id), atlases,
      seats: [...seats.keys()].sort(),
      // 走帧图集与自主活动域：走帧不进首包（运行时懒加载），活动域只有普通职员才有。
      walkAtlas: item.runtime.walkAtlas,
      walkers: item.runtime.characters.filter(c => c.walk).map(c => c.id),
      activity: item.runtime.characters.filter(c => c.activity).map(c => c.id + ':' + c.activity.region + ':' + c.activity.cells.length),
    })
  }
  const result = { birth: world.birth, maps, connections: world.connections.map(c => c.id), sourceRuntimeReady: compiled[0].layout.runtime_ready }
  await writeFile(resolve(generated, 'asset-report.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare()
