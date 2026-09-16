import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GameWorld } from '../src/game-world.ts'

/**
 * GameWorld 的表现边界（Phaser 用最小替身，只实现真正被调用的接口）：
 * 切图失败要在原图上恢复「地图就绪」并保留原图可玩；窗口失焦要立刻停手，
 * 不留「按住不放」的幽灵移动。真实渲染、真实浏览器事件与画面由
 * scripts/browser-check.mjs 在 Chromium/Edge 上验证，不在单测范围。
 */

const stub = vi.hoisted(() => {
  /** 精灵替身：位置、深度与播放过的动画键足够断言移动与停手。 */
  class Sprite {
    depth = 0
    /** 当前帧：boss 的 clips 为空时 anchor 取不到逐帧锚点，直接跳过。 */
    frame = { name: 'idle' }
    readonly played: string[] = []
    constructor(public x: number, public y: number) {}
    setOrigin() { return this }
    setDepth(value: number) { this.depth = value; return this }
    setPosition(x: number, y: number) { this.x = x; this.y = y; return this }
    setInteractive() { return this }
    play(key: string) { this.played.push(key); return this }
    on() { return this }
  }
  const camera = {
    setBounds: () => camera, setRoundPixels: () => camera, startFollow: () => camera,
    setZoom: () => camera, centerOn: () => camera,
    getWorldPoint: (x: number, y: number) => ({ x, y }),
  }
  /** 每次 scene.start 的落点；切图失败时这里必须保持为空。 */
  const transitions: { key: string; data: unknown }[] = []
  /**
   * 场景外壳：生命周期方法由真实 RoomScene 覆盖，这里只提供字段、记录器与
   * 一个可用的 `scene.start`（成功切图才会走到）。
   */
  class Scene {
    readonly sprites: Sprite[] = []
    init(_data: unknown): void {}
    preload(): void {}
    create(): void {}
    update(_time: number, _delta: number): void {}
    readonly textures = { exists: (_key: string) => true }
    readonly load = { multiatlas: (_key: string, _url: string, _base: string) => {}, on: (_event: string, _listener: unknown) => {} }
    readonly anims = { exists: (_key: string) => true, create: (_config: unknown) => {} }
    readonly cameras = { main: camera }
    readonly scale = {
      width: 1440, height: 1000,
      on: (_event: string, _listener: unknown) => {}, off: (_event: string, _listener: unknown) => {},
    }
    readonly input = { on: (_event: string, _listener: unknown) => {} }
    readonly events = { once: (_event: string, _listener: unknown) => {} }
    readonly scene = { start: (key: string, data: unknown) => { transitions.push({ key, data }) } }
    readonly add = {
      sprite: (x: number, y: number) => { const sprite = new Sprite(x, y); this.sprites.push(sprite); return sprite },
      image: () => { const image = { setOrigin: () => image, setDisplaySize: () => image, setDepth: () => image }; return image },
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
  return { Sprite, Scene, Game, games, transitions }
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
const OFFICE = {
  id: 'office', width: 42, height: 30, tileSize: 32,
  collision: Array.from({ length: 42 * 30 }, () => 0),
  spawn: [34, 26], entries: WORLD.maps[0].entries, atlases: ['office'], world: WORLD,
  draws: [],
  characters: [{ id: 'boss', label: '老板', atlas: 'boss', cell: [34, 26], clips: [] }],
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
  const seen = { ready: 0, loading: 0, error: '', feet: [] as { map: string; cell: [number, number]; facing: string }[] }
  const world = new GameWorld(host as unknown as HTMLElement, {
    assetsBase: '/generated/',
    inputLocked: () => false,
    onInteract: () => {},
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
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  stub.games.length = 0
  stub.transitions.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/office.runtime.json')
    ? { ok: true, status: 200, json: async () => OFFICE }
    : { ok: false, status: 404, json: async () => ({ error: 'not found', code: 'not_found' }) }))
})
afterEach(() => { vi.unstubAllGlobals() })

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
