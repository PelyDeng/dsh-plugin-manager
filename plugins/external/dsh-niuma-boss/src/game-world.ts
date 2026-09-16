/**
 * GameWorld：Phaser 三图（office / street / cafe）、人物、寻路、镜头与动画。
 * 不读取任何业务接口；管家任务投影由 GameSession 送进 Pinia，两边只通过回调与
 * DOM 事件边界交流。
 *
 * 三图往返：走到入口触发格发起切图，落点取对端入口的到达格（不可站立时退到退回格，
 * 再不行回出生格），全程只换前台地图与落点，业务任务不受影响。同一入口在角色离开
 * 触发格之前不再触发（防连跳），切图失败保留原图最后合法位置、不自动重试。
 *
 * 首包预算（≤10 个静态请求）：出生只加载候选地图（默认 office）的运行时 JSON、
 * 地图图集、老板全量动画与 office NPC 的 idle 合并图集；street / cafe 的资源在
 * 第一次切图时按需加载，不进首包。
 *
 * 人物逐帧状态只留在 Phaser 内部；挂载点上的 data-player-cell / data-player-facing /
 * data-world-map 按格变化节流更新，供无界面诊断与自动化验收使用，不是逐帧同步。
 */
import Phaser from 'phaser'
import { Pathfinder, stepPosition, type Point } from './navigation.ts'
import { MovementIntent, keyBlocked } from './input-guard.ts'
import type { WorldSnapshot } from './recovery.ts'
import {
  BIRTH_MAP, MapRouter, cellPoint, directionOf, frameOrigin, integerZoom, safeMapId,
  type Cell, type Direction, type EntrySpec, type Feet, type Portal, type WorldSpec,
} from './world-runtime.ts'

type Frame = { path: string; size: [number, number]; anchor: [number, number] }
type Clip = { action: string; direction: string; frames: Frame[] }
export type WorldCharacter = { id: string; label: string; atlas: string; cell: [number, number]; clips: Clip[] }
export type RuntimeMap = {
  id: string
  width: number
  height: number
  tileSize: number
  collision: number[]
  spawn: [number, number]
  entries: EntrySpec[]
  /** 这张图需要的图集键（不含三图共用的 boss）。 */
  atlases: string[]
  /** 三图各自带着同一份世界拓扑：先加载哪张图都能立刻拿到地图与连接。 */
  world: WorldSpec
  draws: { x: number; y: number; width: number; height: number; frame: string; depth: number }[]
  characters: WorldCharacter[]
}

export interface GameWorldOptions {
  /** 界面要求暂停键盘移动时返回 true（输入法组词、弹层等）。 */
  readonly inputLocked: () => boolean
  /** 点击了地图上的角色；正式对白属后续切片，这里只回调标签。 */
  readonly onInteract: (label: string) => void
  /** 运行资源加载失败；任务本据此显示明确错误而不是黑屏，原图继续可用。 */
  readonly onAssetsError: (detail: string) => void
  /** 场景渲染完成（含切图后的目标图）。 */
  readonly onReady?: () => void
  /** 开始切图加载。 */
  readonly onLoading?: () => void
  /** 人物位置或朝向按格变化；会话据此写回按用户快照。 */
  readonly onFeet?: (feet: Feet) => void
  /** 编译后资源的基路径，默认按部署前缀推导。 */
  readonly assetsBase: string
  /** 按用户存的恢复候选（坏快照由 RecoveryStore 判为 null）。 */
  readonly restore?: () => WorldSnapshot | null
}

const TILE = 32
/** 老板速度：balance_params.yaml#movement.boss_walk_tiles_per_sec = 4.0 格/秒，与 8fps 行走帧同步。 */
const SPEED = 4 * TILE
const CELL_ATTRIBUTE = 'data-player-cell'
const FACING_ATTRIBUTE = 'data-player-facing'
const MAP_ATTRIBUTE = 'data-world-map'
const SCENE_KEY = 'room'
/** 三图共用的老板图集键。 */
const PLAYER_ATLAS = 'boss'

type RoomData = { runtime: RuntimeMap; feet: Feet; arrivedEntry?: string }

/** GameWorld 通过这个窄接口驱动当前场景，不把 Phaser 类型泄给会话层。 */
interface RoomSceneApi {
  readonly feet: Feet
  /** 键盘按下/抬起（已过输入法边界）。 */
  intentDown(code: string): void
  intentUp(code: string): void
  /** 组词开始、窗口失焦：立刻停手。 */
  cancelInput(): void
  /** 身份确认后按用户应用恢复快照（null = 回出生点）。 */
  applyRestore(snapshot: WorldSnapshot | null): void
}

export class GameWorld {
  private game?: Phaser.Game
  private router?: MapRouter
  private sceneApi?: RoomSceneApi
  /** 已加载的地图运行时（含碰撞），恢复落点与落点校验都用它。 */
  private readonly loaded = new Map<string, RuntimeMap>()
  private current: Feet = { map: BIRTH_MAP, cell: [0, 0], facing: 'south' }
  private detach: (() => void)[] = []
  /** 输入法组词中：键盘意图不进、已按下的键立刻清掉。 */
  private composing = false

  constructor(private readonly parent: HTMLElement, private readonly options: GameWorldOptions) {}

  get state(): Feet { return { map: this.current.map, cell: [...this.current.cell] as Cell, facing: this.current.facing } }

  get mapId(): string { return this.current.map }

  /** 启动：先按恢复候选装载出生地图，再创建 Phaser 场景；管家不可用不影响这一步。 */
  async start(): Promise<void> {
    const candidate = this.options.restore?.() ?? null
    const runtime = await this.loadBoot(candidate)
    this.router = new MapRouter(runtime.world)
    const feet = this.router.resolve(candidate, (map, cell) => this.walkable(map, cell))
    this.current = feet
    this.bindDom()
    const world = this
    class RoomScene extends Phaser.Scene {
      private room!: RuntimeMap
      feet!: Feet
      private player!: Phaser.GameObjects.Sprite
      private intent = new MovementIntent()
      private finder!: Pathfinder
      private path: Point[] = []
      private pathGeneration = 0
      private loading = false
      private facing: Direction = 'south'
      /** 场景还没建好时收到的恢复请求：先记下，create 之后立刻应用。 */
      private pending: WorldSnapshot | null | undefined
      private onResize = () => this.applyZoom()

      constructor() { super(SCENE_KEY); world.sceneApi = this }

      init(data: RoomData): void {
        this.room = data.runtime
        this.feet = { map: data.feet.map, cell: [...data.feet.cell] as Cell, facing: data.feet.facing }
        this.facing = data.feet.facing
        this.path = []
        this.pathGeneration++
        this.loading = false
        this.pending = undefined
        // 刚穿过的入口保持解除武装，直到角色离开触发格（防连跳）。
        if (data.arrivedEntry) world.router!.disarm(this.room.id, data.arrivedEntry)
      }

      preload(): void {
        const base = world.options.assetsBase
        for (const key of [PLAYER_ATLAS, ...this.room.atlases]) {
          if (this.textures.exists(key)) continue
          this.load.multiatlas(key, base + key + '.json', base)
        }
        this.load.on('loaderror', (file: { key: string }) => world.options.onAssetsError('资源加载失败：' + file.key))
      }

      /** 建角色精灵与四向动画；origin 按逐帧 frameAnchor 设置，脚底中心落在格子中心上。 */
      private character(character: WorldCharacter, interactive: boolean): Phaser.GameObjects.Sprite {
        const frames = new Map(character.clips.flatMap(c => c.frames).map(f => [f.path, f]))
        for (const clip of character.clips) {
          const key = character.id + ':' + clip.action + ':' + clip.direction
          if (this.anims.exists(key)) continue
          this.anims.create({
            key, frames: clip.frames.map(f => ({ key: character.atlas, frame: f.path })), frameRate: 8, repeat: -1,
          })
        }
        const point = cellPoint(character.cell, TILE)
        const sprite = this.add.sprite(point.x, point.y, character.atlas)
        const anchor = () => {
          const frame = frames.get(sprite.frame.name)
          if (!frame) return
          const origin = frameOrigin(frame)
          sprite.setOrigin(origin.x, origin.y)
        }
        sprite.on('animationupdate', anchor)
        const idle = character.clips.some(c => c.action === 'idle' && c.direction === 'south')
        sprite.play(character.id + (idle ? ':idle:' : ':walk:') + 'south')
        anchor()
        sprite.setDepth(sprite.y)
        if (interactive) {
          sprite.setInteractive()
          sprite.on('pointerdown', () => world.options.onInteract(character.label))
        }
        return sprite
      }

      create(): void {
        this.room.draws.forEach(draw => {
          this.add.image(draw.x, draw.y, this.room.id, draw.frame)
            .setOrigin(0).setDisplaySize(draw.width, draw.height).setDepth(draw.depth)
        })
        const playerData = this.room.characters.find(c => c.id === 'boss')
        if (!playerData) { world.options.onAssetsError('出生角色缺失'); return }
        this.player = this.character({ ...playerData, cell: this.feet.cell }, false)
        for (const npc of this.room.characters) if (npc.id !== 'boss') this.character(npc, true)
        const grid = Array.from({ length: this.room.height }, (_, y) => this.room.collision.slice(y * this.room.width, (y + 1) * this.room.width))
        this.finder = new Pathfinder(grid)
        this.cameras.main
          .setBounds(0, 0, this.room.width * TILE, this.room.height * TILE)
          .setRoundPixels(true)
          .startFollow(this.player, true, 0.12, 0.12)
        this.applyZoom()
        this.scale.on('resize', this.onResize)
        this.bindPointer()
        this.play('idle')
        this.sync(true)
        this.events.once('shutdown', () => {
          this.scale.off('resize', this.onResize)
          this.finder.cancel()
          this.path = []
        })
        world.options.onReady?.()
        // 场景创建期间到达的恢复请求（身份确认早于首帧）在这里补上。
        if (this.pending !== undefined) {
          const pending = this.pending
          this.pending = undefined
          this.restore(pending)
        }
      }

      private play(action: 'idle' | 'walk'): void {
        const key = 'boss:' + action + ':' + this.facing
        if (this.anims.exists(key)) this.player.play(key, true)
      }

      /** 整数倍缩放：只在地图装得下时放大，宁可留黑边。 */
      private applyZoom(): void {
        this.cameras.main.setZoom(integerZoom(this.scale, this.room))
      }

      /** 触摸与键盘共用同一份碰撞与位移：点地走 A*（同一网格），键盘按下走同一 stepPosition。 */
      private bindPointer(): void {
        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer, objects: Phaser.GameObjects.GameObject[]) => {
          if (objects.length || world.movementLocked()) return
          const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y)
          const generation = ++this.pathGeneration
          this.path = []
          void this.finder.find(
            { x: Math.floor(this.player.x / TILE), y: Math.floor(this.player.y / TILE) },
            { x: Math.floor(point.x / TILE), y: Math.floor(point.y / TILE) },
          ).then(path => {
            if (generation !== this.pathGeneration || !path) return
            this.path = path.map(p => ({ x: (p.x + .5) * TILE, y: (p.y + .5) * TILE }))
          })
        })
      }

      cancelInput(): void {
        this.intent.clear()
        this.path = []
        this.pathGeneration++
        if (this.player) this.play('idle')
      }

      intentDown(code: string): void {
        if (this.intent.press(code)) {
          this.pathGeneration++
          this.path = []
        }
      }

      intentUp(code: string): void { this.intent.release(code) }

      applyRestore(snapshot: WorldSnapshot | null): void {
        // 身份确认可能早于场景创建完成：那时先把请求记下，等场景就绪再落地。
        if (!this.player) { this.pending = snapshot; return }
        this.restore(snapshot)
      }

      /** 按快照换落点：同图直接挪人，换图走与切图相同的加载与校验路径。 */
      private restore(snapshot: WorldSnapshot | null): void {
        try {
          const feet = world.router!.resolve(snapshot, (map, cell) => world.walkable(map, cell))
          if (feet.map === this.room.id) { this.teleport(feet); return }
          void world.openAt(feet).then(data => this.scene.start(SCENE_KEY, data))
            .catch(error => { world.options.onAssetsError(message(error)); world.options.onReady?.() })
        } catch (error) {
          // 恢复失败不能连带停掉管家链路：如实提示并保留当前画面。
          world.options.onAssetsError('位置恢复失败：' + message(error))
        }
      }

      private teleport(feet: Feet): void {
        this.feet = feet
        this.facing = feet.facing
        this.path = []
        const point = cellPoint(feet.cell, TILE)
        this.player.setPosition(point.x, point.y).setDepth(point.y)
        this.cameras.main.centerOn(point.x, point.y)
        this.play('idle')
        this.sync(true)
      }

      update(_time: number, delta: number): void {
        this.finder.tick()
        if (world.movementLocked()) {
          if (this.intent.clear()) this.path = []
          this.play('idle')
          this.sync()
          return
        }
        const axis = this.intent.axis()
        let target: Point | undefined
        if (axis.dx || axis.dy) {
          this.pathGeneration++
          this.finder.cancel()
          this.path = []
          this.facing = directionOf(axis.dx, axis.dy, this.facing)
          target = { x: this.player.x + axis.dx * TILE, y: this.player.y + axis.dy * TILE }
        } else {
          target = this.path[0]
          if (target && Math.hypot(target.x - this.player.x, target.y - this.player.y) < .5) {
            this.path.shift()
            target = this.path[0]
          }
        }
        if (target) {
          const position = stepPosition(this.player, target, SPEED * Math.min(delta, 50) / 1000, (x, y) => this.finder.walkable(x, y))
          const moveX = position.x - this.player.x, moveY = position.y - this.player.y
          if (moveX || moveY) {
            if (!axis.dx && !axis.dy) this.facing = directionOf(moveX, moveY, this.facing)
            this.player.setPosition(position.x, position.y).setDepth(position.y)
            this.play('walk')
          } else {
            this.path = []
            this.play('idle')
          }
        } else this.play('idle')
        this.sync()
      }

      /** 位置事实按格节流上报，并顺手做入口判定。 */
      private sync(force = false): void {
        const cell: Cell = [Math.floor(this.player.x / TILE), Math.floor(this.player.y / TILE)]
        const changed = force || cell[0] !== this.feet.cell[0] || cell[1] !== this.feet.cell[1] || this.facing !== this.feet.facing
        this.feet = { map: this.room.id, cell, facing: this.facing }
        world.setFeet(this.feet, changed)
        if (changed) this.tryPortal()
      }

      /** 站在触发格上且入口已武装：开始切图；加载期间不响应第二次触发。 */
      private tryPortal(): void {
        if (this.loading) return
        world.router!.rearm(this.feet.cell)
        const portal = world.router!.portal(this.room.id, this.feet.cell)
        if (!portal) return
        this.loading = true
        world.router!.disarm(this.room.id, portal.entryId)
        this.cancelInput()
        world.options.onLoading?.()
        void world.open(portal.to, portal.entryId)
          .then((data: RoomData) => this.scene.start(SCENE_KEY, data))
          .catch(error => {
            // 保留原图最后合法位置，入口保持解除武装：不自动重试，走开再回来才可能再触发。
            // 切图没成功、原图仍是前台地图：按原图就绪收尾，界面不能停在「地图装载中」。
            this.loading = false
            world.options.onAssetsError(message(error))
            world.options.onReady?.()
          })
      }
    }
    this.game = new Phaser.Game({
      type: Phaser.AUTO, parent: this.parent, backgroundColor: '#dbe9f4', pixelArt: true, roundPixels: true,
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' },
      scene: [],
    })
    // 出生落点作为场景初始数据：init/preload/create 都按它装载，避免先空跑一次场景。
    this.game.scene.add(SCENE_KEY, RoomScene, true, { runtime, feet })
  }

  /** 身份确认后按用户应用恢复快照（换用户时也要换位置）。 */
  applyRestore(snapshot: WorldSnapshot | null): void { this.sceneApi?.applyRestore(snapshot) }

  /** 切图或重开地图：装载目标图资产并给出落点（失败抛错，由调用方保留原图）。 */
  private async open(to: { map: string; entry: string }, arrivedEntry: string): Promise<RoomData> {
    const runtime = await this.loadMap(to.map)
    const entry = this.router!.spec(to.map)?.entries.find(e => e.id === to.entry)
    if (!entry) throw new Error('入口不存在：' + to.map + '/' + to.entry)
    const feet = this.router!.land(to.map, entry, this.current.facing, (map, cell) => this.walkable(map, cell))
    return { runtime, feet, ...(arrivedEntry === '' ? {} : { arrivedEntry }) }
  }

  /** 换前台地图到指定落点（按用户恢复用）：地图必须已在世界拓扑里，落点再按碰撞复核一次。 */
  private async openAt(feet: Feet): Promise<RoomData> {
    const runtime = await this.loadMap(feet.map)
    return { runtime, feet: this.router!.resolve(feet, (map, cell) => this.walkable(map, cell)) }
  }

  private walkable(map: string, cell: Cell): boolean {
    const runtime = this.loaded.get(map)
    if (!runtime) return false
    const { width, height } = runtime
    if (cell[0] < 0 || cell[1] < 0 || cell[0] >= width || cell[1] >= height) return false
    return runtime.collision[cell[1] * width + cell[0]] === 0
  }

  /** 出生装载：候选地图→按内容校验的拓扑；候选不可用时回出生地图并如实报告。 */
  private async loadBoot(candidate: { map?: unknown } | null): Promise<RuntimeMap> {
    const wanted = safeMapId(candidate?.map) || BIRTH_MAP
    try {
      return await this.loadMap(wanted)
    } catch (error) {
      if (wanted === BIRTH_MAP) throw error
      this.options.onAssetsError(message(error) + '；已改从出生地图 ' + BIRTH_MAP + ' 开始')
      return await this.loadMap(BIRTH_MAP)
    }
  }

  private async loadMap(map: string): Promise<RuntimeMap> {
    const cached = this.loaded.get(map)
    if (cached) return cached
    const url = this.options.assetsBase + map + '.runtime.json'
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('地图资源加载失败：' + map + '（HTTP ' + response.status + '）')
    const runtime = await response.json() as RuntimeMap
    if (runtime?.id !== map || !Array.isArray(runtime.collision) || runtime.collision.length !== runtime.width * runtime.height) {
      throw new Error('地图资源内容不符：' + map)
    }
    if (!Array.isArray(runtime.atlases) || runtime.atlases.length === 0) throw new Error('地图资源缺少图集清单：' + map)
    if (runtime.world?.tileSize !== runtime.tileSize) throw new Error('地图缺少世界拓扑：' + map)
    this.loaded.set(map, runtime)
    return runtime
  }

  /** 键盘意图与输入法边界：组词、输入框焦点、弹层打开时都不产生移动。 */
  private bindDom(): void {
    const view = this.parent.ownerDocument?.defaultView ?? globalThis
    const onKeyDown = (event: KeyboardEvent) => {
      if (keyBlocked(event, { inputLocked: this.options.inputLocked(), composing: this.composing })) return
      this.sceneApi?.intentDown(event.code)
    }
    const onKeyUp = (event: KeyboardEvent) => { this.sceneApi?.intentUp(event.code) }
    const onBlur = () => this.sceneApi?.cancelInput()
    const onComposition = () => {
      this.composing = true
      // 组词一开始就停手：已经按住的移动键不能带着人物继续走。
      this.sceneApi?.cancelInput()
    }
    const onCompositionEnd = () => { this.composing = false }
    view.addEventListener('keydown', onKeyDown as EventListener)
    view.addEventListener('keyup', onKeyUp as EventListener)
    view.addEventListener('blur', onBlur)
    view.addEventListener('compositionstart', onComposition)
    view.addEventListener('compositionend', onCompositionEnd)
    this.detach = [
      () => view.removeEventListener('keydown', onKeyDown as EventListener),
      () => view.removeEventListener('keyup', onKeyUp as EventListener),
      () => view.removeEventListener('blur', onBlur),
      () => view.removeEventListener('compositionstart', onComposition),
      () => view.removeEventListener('compositionend', onCompositionEnd),
    ]
  }

  /** 键盘与触摸共同的前置条件：弹层打开或输入法组词中都不接管按键。 */
  movementLocked(): boolean {
    return this.options.inputLocked() || this.composing
  }

  /** 位置事实：只在按格或朝向变化时回调一次（不是逐帧同步）。 */
  private setFeet(feet: Feet, changed: boolean): void {
    this.current = feet
    if (!changed) return
    this.parent.setAttribute(CELL_ATTRIBUTE, feet.cell.join(','))
    this.parent.setAttribute(FACING_ATTRIBUTE, feet.facing)
    this.parent.setAttribute(MAP_ATTRIBUTE, feet.map)
    this.options.onFeet?.(feet)
  }

  pause(): void { this.game?.scene.pause(SCENE_KEY) }

  resume(): void { this.game?.scene.resume(SCENE_KEY) }

  destroy(): void {
    for (const off of this.detach) off()
    this.detach = []
    this.sceneApi = undefined
    this.game?.destroy(true)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
