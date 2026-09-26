import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GameWorld } from '../src/game-world.ts'
import type { StaffCommand } from '../src/performance.ts'

/**
 * GameWorld 的表现边界（Phaser 用最小替身，只实现真正被调用的接口）：
 * 切图失败要在原图上恢复「地图就绪」并保留原图可玩；窗口失焦要立刻停手，
 * 不留「按住不放」的幽灵移动。真实渲染、真实浏览器事件与画面由
 * scripts/browser-check.mjs 在 Chromium/Edge 上验证，不在单测范围。
 */

const stub = vi.hoisted(() => {
  /** 已加载的纹理键（游戏级）：走帧图集默认**没有**，测试按需放行以复现懒加载与失败。 */
  const textures = new Set<string>(['boss', 'office', 'office-npcs'])
  /** 已登记的动画键（对应 Phaser 的全局 AnimationManager）与它们的帧图集。 */
  const anims = new Set<string>()
  const animFrames: { key: string; atlas: string; frames: number }[] = []
  /** 懒加载记录：multiatlas 请求与 load.start 调用，以及加载器的 complete/loaderror 监听。 */
  const walked: string[] = []
  let loadStarts = 0
  const listeners = new Map<string, ((payload: unknown) => void)[]>()
  const emit = (event: string, payload?: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
  }
  /** 精灵替身：位置、深度、origin 与播放过的动画键足够断言站坐、遮挡与表现命令。 */
  class Sprite {
    depth = 0
    origin: { x: number; y: number } = { x: 0, y: 0 }
    visible = true
    /** 当前帧：帧名按角色动画键区分；帧锚点由测试通过 frameOf 提供。 */
    frame = { name: 'frame' }
    readonly played: string[] = []
    constructor(public x: number, public y: number) {}
    setOrigin(x: number, y: number) { this.origin = { x, y }; return this }
    setDepth(value: number) { this.depth = value; return this }
    setPosition(x: number, y: number) { this.x = x; this.y = y; return this }
    setVisible(value: boolean) { this.visible = value; return this }
    setInteractive() { return this }
    setDisplaySize() { return this }
    play(key: string) { this.played.push(key); return this }
    on() { return this }
  }
  /** 静态图片替身（地图绘制与椅背遮挡层）：只记位置、尺寸、深度与可见性。 */
  class Image {
    visible = true
    constructor(public x: number, public y: number, public key: string, public frame?: string) {}
    setOrigin() { return this }
    setDisplaySize() { return this }
    setDepth(value: number) { this.depth = value; return this }
    setVisible(value: boolean) { this.visible = value; return this }
    depth = 0
  }
  const camera = {
    setBounds: () => camera, setRoundPixels: () => camera, startFollow: () => camera,
    setZoom: () => camera, centerOn: () => camera,
    setBackgroundColor: () => camera, setScroll: () => camera,
    scrollX: 0, scrollY: 0, zoom: 1,
    getWorldPoint: (x: number, y: number) => ({ x, y }),
  }
  /** 每次 scene.start 的落点；切图失败时这里必须保持为空。 */
  const transitions: { key: string; data: unknown }[] = []
  /**
   * 场景外壳：生命周期方法由真实 RoomScene 覆盖，这里只提供字段、记录器与
   * 一个可用的 `scene.start`（成功切图才会走到）。`time.now` 与 update 的 time
   * 共用同一个可推进的时钟，走动超时与自主活动的时长都以它为准。
   */
  class Scene {
    readonly sprites: Sprite[] = []
    readonly images: InstanceType<typeof Image>[] = []
    readonly time = { now: 0 }
    init(_data: unknown): void {}
    preload(): void {}
    create(): void {}
    update(_time: number, _delta: number): void {}
    readonly textures = { exists: (key: string) => textures.has(key) }
    readonly load = {
      multiatlas: (key: string) => { walked.push(key) },
      start: () => { loadStarts++ },
      isLoading: () => false,
      on: (event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
      off: (event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== listener))
      },
      once: (event: string, listener: (payload: unknown) => void) => {
        const wrapper = (payload: unknown) => {
          listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== wrapper))
          listener(payload)
        }
        listeners.set(event, [...(listeners.get(event) ?? []), wrapper])
      },
    }
    readonly anims = {
      exists: (key: string) => anims.has(key),
      create: (config: { key: string; frames: { key: string }[] }) => {
        anims.add(config.key)
        animFrames.push({ key: config.key, atlas: config.frames[0]?.key ?? '', frames: config.frames.length })
      },
    }
    readonly cameras = { main: camera }
    readonly scale = {
      width: 1440, height: 1000,
      gameSize: { width: 1440, height: 1000 },
      on: (_event: string, _listener: unknown) => {}, off: (_event: string, _listener: unknown) => {},
    }
    readonly input = { on: (_event: string, _listener: unknown) => {} }
    readonly events = { once: (_event: string, _listener: unknown) => {} }
    readonly scene = { start: (key: string, data: unknown) => { transitions.push({ key, data }) } }
    readonly add = {
      sprite: (x: number, y: number) => { const sprite = new Sprite(x, y); this.sprites.push(sprite); return sprite },
      image: (x: number, y: number, key: string, frame?: string) => {
        const image = new Image(x, y, key, frame)
        this.images.push(image)
        return image
      },
    }
  }
  const games: InstanceType<typeof Game>[] = []
  /** 游戏替身：scene.add 立刻走一次 init/preload/create，与 Phaser 的自动启动等价。 */
  class Game {
    readonly scenes: InstanceType<typeof Scene>[] = []
    constructor(_options: unknown) { games.push(this) }
    readonly destroy = (_removeCanvas: boolean) => {}
    readonly scene = {
      add: (_key: string, SceneClass: new () => InstanceType<typeof Scene>, _auto: boolean, data: unknown) => {
        const scene = new SceneClass()
        this.scenes.push(scene)
        scene.init(data)
        scene.preload()
        scene.create()
        return scene
      },
      pause: (_key: string) => {}, resume: (_key: string) => {},
    }
  }
  /** 走帧懒加载的收尾：把图集标记为已加载并触发监听（等价于真实加载完成/失败）。 */
  const finishWalk = (key: string) => { textures.add(key); emit('complete') }
  const failWalk = (key: string) => emit('loaderror', { key })
  return {
    Sprite, Image, Scene, Game, games, transitions,
    textures, anims, animFrames, walked, listeners, finishWalk, failWalk,
    loadStarts: () => loadStarts,
    reset: () => {
      textures.clear()
      textures.add('boss'); textures.add('office'); textures.add('office-npcs')
      anims.clear(); animFrames.length = 0; walked.length = 0; loadStarts = 0; listeners.clear()
    },
  }
})

vi.mock('phaser', () => ({ default: { AUTO: 'AUTO', Scale: { RESIZE: 'RESIZE' }, Scene: stub.Scene, Game: stub.Game } }))

/** 世界拓扑：与构建产物同形状，office↔street 一条双向连接。 */
const WORLD = {
  tileSize: 32,
  birth: 'office',
  maps: [
    { id: 'office', width: 42, height: 30, spawn: [34, 26], entries: [{ id: 'office_to_street', region: 'reception', trigger: [34, 27], arrival: [34, 26], return: [33, 26] }] },
    { id: 'street', width: 40, height: 30, spawn: [5, 12], entries: [{ id: 'street_to_office', region: 'sidewalk', trigger: [5, 11], arrival: [5, 12], return: [6, 12] }] },
  ],
  connections: [{ id: 'office_street', from: { map: 'office', entry: 'office_to_street' }, to: { map: 'street', entry: 'street_to_office' } }],
}

/** 出生地图的运行时：碰撞全 0（整片可走），出生点与门口触发格相邻。 */
const idleClips = (id: string) => ['south', 'north'].map(direction => ({
  action: 'idle', direction,
  frames: [{ path: id + '-idle-' + direction + '.png', size: [32, 48] as [number, number], anchor: [16, 47] as [number, number] }],
}))
const sitClip = (id: string) => ({
  action: 'sit', direction: 'north',
  frames: [{ path: id + '-sit-north.png', size: [32, 48] as [number, number], anchor: [16, 47] as [number, number], seat: [16, 39] as [number, number] }],
})
/** 作者座位（与编译产物同形状）：坐格、接触点、深度槽位与椅背遮挡层。 */
const seatAt = (cell: [number, number], contact: [number, number], stand: [number, number], occlusion: boolean) => ({
  cell, direction: 'north' as const, anchor: [(cell[0] * 32) + 16, (cell[1] * 32) + 16] as [number, number], contact,
  depth: (cell[1] * 32) + 16 + 0.25, stand,
  sit: sitClip('x'),
  occlusion: occlusion
    ? { frame: 'tech-chair-back-north', x: cell[0] * 32, y: (cell[1] - 1) * 32 + 1, width: 32, height: 32, depth: (cell[1] * 32) + 16 + 0.5 }
    : null,
})

/** 走帧（四向）：帧在独立图集 `office-walk` 里，加载完成后才登记动画。 */
const walkClips = (id: string) => ['south', 'north', 'east', 'west'].map(direction => ({
  action: 'walk', direction,
  frames: [0, 1].map(index => ({
    path: id + '-walk-' + direction + '-' + index + '.png', size: [32, 48] as [number, number], anchor: [16, 47] as [number, number],
  })),
}))
/** 作者给的有限活动域（普通职员）：整条路径都不许越出这一集合。 */
const HR_ACTIVITY = { region: 'hr', cells: [[18, 5], [19, 5], [18, 6], [19, 6]] as [number, number][] }

const OFFICE = {
  id: 'office', width: 42, height: 30, tileSize: 32,
  collision: Array.from({ length: 42 * 30 }, () => 0),
  spawn: [34, 26], entries: WORLD.maps[0].entries, atlases: ['office'], walkAtlas: 'office-walk', world: WORLD,
  draws: [],
  characters: [
    { id: 'boss', label: '老板', role: 'player', atlas: 'boss', cell: [34, 26], clips: [] },
    { id: 'butler', label: '牛马大总管', role: 'butler', atlas: 'office-npcs', cell: [13, 6], clips: idleClips('butler') },
    {
      id: 'blog', label: '博客', role: 'staff', atlas: 'office-npcs', cell: [21, 14],
      clips: [...idleClips('blog'), sitClip('blog')], walk: walkClips('blog'),
      seat: { ...seatAt([21, 13], [688, 402], [21, 14], true), sit: sitClip('blog') },
    },
    {
      id: 'npc_hr', label: '沈禾', role: 'npc', atlas: 'office-npcs', cell: [18, 5],
      clips: [...idleClips('npc_hr'), sitClip('npc_hr')], walk: walkClips('npc_hr'), activity: HR_ACTIVITY,
      seat: { ...seatAt([18, 5], [592, 146], [18, 6], false), sit: sitClip('npc_hr') },
      dialogue: { mode: 'authored_lines', name: '沈禾', role: '人事', lines: ['这页先留白，你说完我再记。'] },
    },
  ],
}

type Listener = (event: unknown) => void

/** 挂载点与它的 defaultView：GameWorld 通过 ownerDocument.defaultView 注册事件。 */
class FakeHost {
  readonly attributes = new Map<string, string>()
  readonly ownerDocument: { defaultView: unknown }
  private readonly listeners = new Map<string, Set<Listener>>()
  constructor() {
    this.ownerDocument = {
      defaultView: {
        addEventListener: (type: string, listener: Listener) => {
          const set = this.listeners.get(type) ?? new Set<Listener>()
          set.add(listener)
          this.listeners.set(type, set)
        },
        removeEventListener: (type: string, listener: Listener) => { this.listeners.get(type)?.delete(listener) },
      },
    }
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  /** 派发一个 DOM 事件给已注册的监听（keydown/keyup/blur/composition*）。 */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

const makeWorld = () => {
  const host = new FakeHost()
  const seen = {
    ready: 0, loading: 0, error: '', feet: [] as { map: string; cell: [number, number]; facing: string }[],
    near: [] as unknown[], interactions: [] as unknown[],
  }
  const world = new GameWorld(host as unknown as HTMLElement, {
    assetsBase: '/generated/',
    inputLocked: () => false,
    onInteract: target => { seen.interactions.push(target) },
    onNearTargets: targets => { seen.near.push(targets) },
    onInteractKey: () => {},
    onAssetsError: detail => { seen.error = detail },
    onReady: () => { seen.ready++ },
    onLoading: () => { seen.loading++ },
    onFeet: feet => { seen.feet.push(feet) },
    // 文件里没有恢复快照：出生地图走默认 office。
    restore: () => null,
  })
  return { world, host, seen }
}

/** 替身创建的场景（就是真实 RoomScene 的实例）与它的老板精灵。 */
const sceneOf = () => stub.games[0]!.scenes[0]!
const playerOf = () => sceneOf().sprites[0]!
/** 非老板角色精灵：按创建顺序跟着老板精灵（与运行时角色名册同序）。 */
const actorOf = (id: string) => {
  const index = OFFICE.characters.findIndex(c => c.id === id)
  return sceneOf().sprites[index]!
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  stub.games.length = 0
  stub.transitions.length = 0
  stub.reset()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/office.runtime.json')
    ? { ok: true, status: 200, json: async () => OFFICE }
    : { ok: false, status: 404, json: async () => ({ error: 'not found', code: 'not_found' }) }))
})
afterEach(() => { vi.unstubAllGlobals() })

/**
 * 推进场景更新：时间与 `scene.time.now` 同步前进，走动的位移与时长都以它为准。
 * EasyStar 用 setTimeout 回调路径结果，所以要等一次宏任务，不能只用微任务。
 */
const tick = async (scene: InstanceType<typeof stub.Scene>, ms = 48): Promise<void> => {
  scene.time.now += ms
  scene.update(scene.time.now, ms)
  await new Promise(resolve => setTimeout(resolve, 0))
}
/** 按 48ms 的帧长推进若干帧（游戏对 delta 的上限就是 50ms）。 */
const run = async (scene: InstanceType<typeof stub.Scene>, frames: number, step = 48): Promise<void> => {
  for (let index = 0; index < frames; index++) await tick(scene, step)
}
/** 当前格（与 data-actor-cells 同口径：脚点所在格）。 */
const cellNow = (sprite: { x: number; y: number }) => [Math.floor(sprite.x / 32), Math.floor(sprite.y / 32)]

describe('GameWorld 的切图与输入边界', () => {
  it('切图失败：如实报错、恢复地图就绪，原图仍可玩', async () => {
    const { world, host, seen } = makeWorld()
    await world.start()
    expect(seen.ready).toBe(1)
    expect(playerOf().x).toBe(34 * 32 + 16)
    // 往南走上门口触发格：切图开始装载，street 的运行时取不到 → 失败。
    host.dispatch('keydown', { code: 'KeyS' })
    for (let i = 0; i < 8 && seen.loading === 0; i++) sceneOf().update(0, 50)
    expect(seen.loading).toBe(1)
    expect(stub.transitions).toHaveLength(0)
    // 失败同样在就绪回调上收尾：界面不能停在「地图装载中」。
    await flush()
    expect(seen.error).toBe('地图资源加载失败：street（HTTP 404）')
    expect(seen.ready).toBe(2)
    expect(world.mapId).toBe('office')
    // 原图仍可玩：抬起南键改往西走，人物离开触发格、位置照常变化。
    const before = playerOf().x
    host.dispatch('keyup', { code: 'KeyS' })
    host.dispatch('keydown', { code: 'KeyA' })
    for (let i = 0; i < 6; i++) sceneOf().update(0, 50)
    expect(playerOf().x).toBeLessThan(before)
    expect(world.state).toEqual({ map: 'office', cell: [33, 27], facing: 'west' })
    world.destroy()
  })

  it('窗口失焦立刻停手：按住方向键不再产生位移', async () => {
    const { world, host } = makeWorld()
    await world.start()
    host.dispatch('keydown', { code: 'KeyD' })
    for (let i = 0; i < 3; i++) sceneOf().update(0, 50)
    const moving = playerOf().x
    expect(moving).toBeGreaterThan(34 * 32 + 16)
    host.dispatch('blur')
    for (let i = 0; i < 5; i++) sceneOf().update(0, 50)
    expect(playerOf().x).toBe(moving)
    // 失焦清的是「按住不放」的状态，不是把键盘锁死：重新按下照常移动。
    host.dispatch('keyup', { code: 'KeyD' })
    host.dispatch('keydown', { code: 'KeyD' })
    for (let i = 0; i < 3; i++) sceneOf().update(0, 50)
    expect(playerOf().x).toBeGreaterThan(moving)
    world.destroy()
  })
})

/**
 * 人物表现（切片 4）：站坐与遮挡读作者数据，员工只消费表现命令；
 * 到位不会回写任何业务状态（任务终态只来自权威投影，见 tests/performance.test.ts）。
 */
describe('作者座位、遮挡与表现命令', () => {
  const command = (overrides: Partial<StaffCommand> = {}): StaffCommand => ({
    agentId: 'blog', taskId: 'task-1', subtaskId: 's1', state: 'running', work: 'running',
    action: 'start_work', rendezvous: 'butler', dispatchOrder: 0, note: '', ...overrides,
  })

  it('有作者座位的角色按座位接触点与逐帧锚点就坐，椅背遮挡层按作者深度画在角色之上', async () => {
    const { world } = makeWorld()
    await world.start()
    const blog = actorOf('blog')
    // 坐姿精灵左上角 = 接触点 − 逐帧接触锚点 = (688−16, 402−39)。
    expect([blog.x, blog.y]).toEqual([672, 363])
    expect(blog.depth).toBe(432.25)
    expect(blog.played).toContain('blog:sit:north')
    // 椅背遮挡层用作者声明的图片位置与深度，且只在坐着时可见。
    const occlusion = sceneOf().images.find(image => image.frame === 'tech-chair-back-north' && image.x === 672)
    expect(occlusion).toBeDefined()
    expect([occlusion!.x, occlusion!.y, occlusion!.depth]).toEqual([672, 385, 432.5])
    expect(occlusion!.visible).toBe(true)
    // 作者没声明前景遮挡的座位（这里的前台角色同理）不画遮挡层。
    expect(sceneOf().images.filter(image => image.frame === 'tech-chair-back-north')).toHaveLength(1)
    expect(actorOf('npc_hr').played).toContain('npc_hr:sit:north')
    world.destroy()
  })

  it('表现命令：去会合点站位、回工位坐下，都按作者锚点解析且不碰业务状态', async () => {
    const { world } = makeWorld()
    await world.start()
    // 派单：员工离开自己的座位，站到牛马大总管（[13,6]）旁边的可站立格。
    world.applyPerformance([command()])
    const blog = actorOf('blog')
    expect(blog.played).toContain('blog:idle:north')
    const byButler = [[13, 5], [13, 7], [12, 6], [14, 6], [12, 5], [14, 5], [12, 7], [14, 7]]
      .map(cell => [(cell[0] * 32) + 16, (cell[1] * 32) + 16])
    expect(byButler).toContainEqual([blog.x, blog.y])
    expect(blog.depth).toBe(blog.y)
    // 椅背遮挡层跟着隐藏：站着的时候没有座位遮挡。
    expect(sceneOf().images.find(image => image.frame === 'tech-chair-back-north')!.visible).toBe(false)
    // 交回：终态一到就回自己的工位并坐下（不等待任何演出）。
    world.applyPerformance([command({ state: 'succeeded', work: 'free', action: 'hand_back', rendezvous: 'workstation' })])
    expect([blog.x, blog.y]).toEqual([672, 363])
    expect(blog.played.filter(key => key === 'blog:sit:north').length).toBeGreaterThanOrEqual(2)
    expect(sceneOf().images.find(image => image.frame === 'tech-chair-back-north')!.visible).toBe(true)
    // 同一条命令再来一次是幂等的：位置与姿态不变。
    world.applyPerformance([command({ state: 'succeeded', work: 'free', action: 'hand_back', rendezvous: 'workstation' })])
    expect([blog.x, blog.y]).toEqual([672, 363])
    world.destroy()
  })

  it('没有作者座位的角色不臆造坐姿，只按作者给的格站好', async () => {
    const { world } = makeWorld()
    await world.start()
    // 牛马大总管没有工位座位：命令让他在自己的作者格站好。
    world.applyPerformance([{
      agentId: 'butler', taskId: 'task-1', subtaskId: 's1', state: 'succeeded', work: 'free',
      action: 'hand_back', rendezvous: 'workstation', dispatchOrder: 0, note: '',
    }])
    const butler = actorOf('butler')
    expect([butler.x, butler.y]).toEqual([(13 * 32) + 16, (6 * 32) + 16])
    expect(butler.played).not.toContain('butler:sit:north')
    world.destroy()
  })
})

/**
 * 逐格走动（切片 4 修复轮）：走帧在独立图集里、出生边界之后才懒加载；
 * 位移只用 A* + stepPosition 逐格推进，速度取 balance_params 的 3.0/2.5 格每秒，
 * 到达判定用欧氏距离 ≤ 1.5 格。降级一律如实标注，不伪造「走过了」。
 */
describe('员工与普通 NPC 的逐格走动', () => {
  const command = (overrides: Partial<StaffCommand> = {}): StaffCommand => ({
    agentId: 'blog', taskId: 'task-1', subtaskId: 's1', state: 'running', work: 'running',
    action: 'start_work', rendezvous: 'butler', dispatchOrder: 0, note: '', ...overrides,
  })
  const staffAttribute = (host: FakeHost) => host.attributes.get('data-staff') ?? ''
  /** 非老板角色的格与姿态：坐着时精灵位置是接触点，格口径只认表现层自己写的诊断属性。 */
  const actorEntry = (host: FakeHost, id: string) =>
    (host.attributes.get('data-actor-cells') ?? '').split(';').find(entry => entry.startsWith(id + ':')) ?? ''

  it('走帧不进出生装载：玩家操作前零请求，操作后 load.multiatlas + load.start', async () => {
    const { world, host, seen } = makeWorld()
    await world.start()
    expect(seen.ready).toBe(1)
    // 出生装载只请求首包资源：走帧图集一次都不许拉，更不许提前登记动画。
    expect(stub.walked).toEqual([])
    expect(stub.loadStarts()).toBe(0)
    expect(stub.anims.has('blog:walk:south')).toBe(false)
    // 出生装载期间就到了首个 walk 命令：走帧未就绪，按到位处理并如实标注（不伪造走过）。
    world.applyPerformance([command()])
    await flush()
    expect(stub.walked).toEqual([])
    expect(staffAttribute(host)).toBe('blog=start_work+instant')
    // 玩家第一次按键才算开始操作：这时才懒加载走帧图集（一条 multiatlas + 一次 start）。
    host.dispatch('keydown', { code: 'KeyX' })
    expect(stub.walked).toEqual(['office-walk'])
    expect(stub.loadStarts()).toBe(1)
    expect(stub.anims.has('blog:walk:south')).toBe(false)
    // 加载完成后才按图集登记走帧动画；已经到位的角色不因为加载完成而多走一遍。
    stub.finishWalk('office-walk')
    expect(stub.anims.has('blog:walk:south')).toBe(true)
    expect(staffAttribute(host)).toBe('blog=start_work+arrived')
    // 再按键不会重复请求（图集已在游戏级纹理里）。
    host.dispatch('keydown', { code: 'KeyX' })
    expect(stub.walked).toEqual(['office-walk'])
    world.destroy()
  })

  it('走帧就绪后逐格走到会合点：位移按速度推进、朝向随位移、座位遮挡随之收起', async () => {
    stub.textures.add('office-walk')
    const { world, host } = makeWorld()
    await world.start()
    host.dispatch('keydown', { code: 'KeyX' })
    expect(stub.anims.has('blog:walk:south')).toBe(true)
    const blog = actorOf('blog')
    // 坐着的时候椅背遮挡是显示的；离座走动必须收起。
    const occlusion = sceneOf().images.find(image => image.frame === 'tech-chair-back-north')!
    expect(occlusion.visible).toBe(true)
    world.applyPerformance([command()])
    const scene = sceneOf()
    const samples: [number, number][] = []
    let arrived = 0
    for (let elapsed = 48; elapsed <= 12000; elapsed += 48) {
      await tick(scene)
      samples.push([blog.x, blog.y])
      if (staffAttribute(host).includes('+arrived')) { arrived = elapsed; break }
    }
    expect(arrived).toBeGreaterThan(0)
    // 真的走到会合点：牛马大总管（[13,6]）附近的可站立格，且不是瞬移（至少 1 秒）。
    expect(actorEntry(host, 'blog')).toBe('blog:13,5:idle')
    expect(arrived).toBeGreaterThan(1000)
    expect(occlusion.visible).toBe(false)
    expect(host.attributes.get('data-seats')).not.toContain('blog')
    // 位移总量 ÷ 用时 = 走动速度（balance_params#movement.staff_walk_tiles_per_sec = 3.0 格/秒）。
    const travelled = samples.slice(1).reduce((sum, point, index) =>
      sum + Math.hypot(point[0] - samples[index]![0], point[1] - samples[index]![1]), 0)
    const speed = travelled / (arrived / 1000)
    expect(speed).toBeGreaterThan(96 * 0.75)
    expect(speed).toBeLessThan(96 * 1.3)
    // 逐格：相邻两个不同格必须四邻相接（不跳格、不抄近道），中间位置至少两个。
    const cells = samples.map(([x, y]) => [Math.floor(x / 32), Math.floor(y / 32)])
    const distinct = cells.filter((cell, index) => index === 0 || cell[0] !== cells[index - 1]![0] || cell[1] !== cells[index - 1]![1])
    expect(distinct.length).toBeGreaterThanOrEqual(4)
    for (let index = 1; index < distinct.length; index++) {
      const step = Math.abs(distinct[index]![0] - distinct[index - 1]![0]) + Math.abs(distinct[index]![1] - distinct[index - 1]![1])
      expect(step).toBe(1)
    }
    // 朝向跟着实际位移走（第一段位移的方向必须有对应的走帧）。
    const first = distinct[1]!
    const dx = first[0] - distinct[0]![0]
    const dy = first[1] - distinct[0]![1]
    const facing = dx !== 0 ? (dx > 0 ? 'east' : 'west') : (dy > 0 ? 'south' : 'north')
    expect(blog.played).toContain('blog:walk:' + facing)
    // 回工位坐下：走回作者坐格，遮挡重新画在角色之上。
    world.applyPerformance([command({ state: 'succeeded', work: 'free', action: 'hand_back', rendezvous: 'workstation' })])
    for (let frame = 0; frame < 260 && actorEntry(host, 'blog') !== 'blog:21,13:sit'; frame++) await tick(scene)
    expect(actorEntry(host, 'blog')).toBe('blog:21,13:sit')
    expect([blog.x, blog.y]).toEqual([672, 363])
    expect(occlusion.visible).toBe(true)
    world.destroy()
  })

  it('走到上限就地等待：超时后不动，也不谎称报到（balance_params#staff_timeouts）', async () => {
    stub.textures.add('office-walk')
    const { world, host } = makeWorld()
    await world.start()
    host.dispatch('keydown', { code: 'KeyX' })
    world.applyPerformance([command()])
    const scene = sceneOf()
    const blog = actorOf('blog')
    await run(scene, 4)
    // 让寻路落地并真的走起来（还没到会合点）。
    await run(scene, 20)
    expect(staffAttribute(host)).toBe('blog=start_work+walking')
    const midway = [blog.x, blog.y]
    // 时钟跳过 20 秒的上限：下一次更新就把走动按超时收口。
    scene.time.now += 20_500
    scene.update(scene.time.now, 48)
    expect(staffAttribute(host)).toBe('blog=start_work+walk_timeout')
    await run(scene, 30)
    expect([blog.x, blog.y]).toEqual(midway)
    expect(actorEntry(host, 'blog')).not.toBe('blog:13,5:idle')
    world.destroy()
  })

  it('走帧加载失败：保持按到位处理，并在 data-staff 如实标注 walk_failed', async () => {
    const { world, host, seen } = makeWorld()
    await world.start()
    host.dispatch('keydown', { code: 'KeyX' })
    expect(stub.walked).toEqual(['office-walk'])
    stub.failWalk('office-walk')
    expect(seen.error).toBe('走帧资源加载失败：office-walk')
    world.applyPerformance([command()])
    await flush()
    // 到位的画面照旧（业务与验收不回退），但状态说的是「按到位处理」而不是「走过了」。
    expect(staffAttribute(host)).toBe('blog=start_work+walk_failed')
    expect(actorEntry(host, 'blog')).toBe('blog:13,5:idle')
    expect([actorOf('blog').x, actorOf('blog').y]).toEqual([13 * 32 + 16, 5 * 32 + 16])
    expect(sceneOf().images.find(image => image.frame === 'tech-chair-back-north')!.visible).toBe(false)
    world.destroy()
  })

  it('普通职员只在作者活动域内自主走动，回到坐格就坐下', async () => {
    stub.textures.add('office-walk')
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const { world, host } = makeWorld()
    await world.start()
    host.dispatch('keydown', { code: 'KeyX' })
    const scene = sceneOf()
    const allowed = new Set(HR_ACTIVITY.cells.map(cell => cell.join(',')))
    const seenCells = new Set<string>()
    const poses = new Set<string>()
    // 活动域的格间距很小：先等歇够（1.5s）再走一小段，来回反复。
    for (let frame = 0; frame < 240; frame++) {
      await tick(scene)
      const entry = actorEntry(host, 'npc_hr')
      const [, cell, pose] = entry.split(':')
      if (cell) seenCells.add(cell)
      if (pose) poses.add(pose)
    }
    random.mockRestore()
    // 真的走动过（至少两个不同的格），且每一格都在作者给的活动域里。
    expect(seenCells.size).toBeGreaterThan(1)
    for (const cell of seenCells) expect(allowed.has(cell)).toBe(true)
    // 走起来也有坐回去：站姿走动 + 回坐格坐下两种姿态都出现过。
    expect(poses.has('idle')).toBe(true)
    expect(poses.has('sit')).toBe(true)
    world.destroy()
  })

  it('活动域外的近路一律拒绝：原地待机，不越界、不穿墙', async () => {
    // 把活动域切成两块（中间那一格不在域里）：绕到域外的路径必须被丢弃。
    const disjoint = {
      ...OFFICE,
      characters: OFFICE.characters.map(character => character.id === 'npc_hr'
        ? { ...character, activity: { region: 'hr', cells: [[18, 5], [21, 5]] as [number, number][] } }
        : character),
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => disjoint })))
    stub.textures.add('office-walk')
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const { world, host } = makeWorld()
    await world.start()
    host.dispatch('keydown', { code: 'KeyX' })
    await run(sceneOf(), 120)
    random.mockRestore()
    expect(actorEntry(host, 'npc_hr')).toBe('npc_hr:18,5:sit')
    world.destroy()
  })
})
