/**
 * GameWorld：Phaser 三图（office / street / cafe）、人物、寻路、镜头与动画。
 * 不读取任何业务接口；管家任务投影由 GameSession 送进 Pinia，两边只通过回调与
 * DOM 事件边界交流。
 *
 * 人物表现只消费**表现命令**（src/performance.ts）：员工的工作状态来自权威任务投影，
 * 表现层按作者锚点到位并显示状态，没有任何回写任务状态的通路（ADR 0003）。
 *
 * 三图往返：走到入口触发格发起切图，落点取对端入口的到达格（不可站立时退到退回格，
 * 再不行回出生格），全程只换前台地图与落点，业务任务不受影响。同一入口在角色离开
 * 触发格之前不再触发（防连跳），切图失败保留原图最后合法位置、不自动重试。
 *
 * 作者数据驱动：站坐、座位锚点与遮挡都读编译产物（scripts/prepare-assets.mjs 从
 * 布局与图集锚点编译）——坐姿精灵左上角 = 座位接触点 − 逐帧 seatAnchor，深度取
 * 椅座与椅背之间的作者槽位，椅背遮挡层按作者声明绘制在坐姿角色之上。运行时不猜坐标，
 * 也不为没有作者数据的角色补造座位。
 *
 * 逐格走动（第五阶段切片 4 修复轮）：员工与普通 NPC 的走帧在**独立图集** `*_walk`
 * （构建期编译，`runtime.walkAtlas`）里，不进 `runtime.atlases`——首包预算（≤10 个静态请求）
 * 留给站坐与遮挡，走帧由运行时在**出生地图就绪且玩家开始操作之后**用
 * `load.multiatlas + load.start()` 懒加载，加载完成后再注册动画。位移只用
 * `navigation.ts` 的 A* + `stepPosition` 逐格推进，速度取 author 数据
 * （balance_params.yaml#movement 的 3.0 / 2.5 格每秒），到位判定用欧氏距离
 * ≤ arrival_radius_tiles（1.5 格）——不滑行、不瞬移、不穿墙。
 *
 * 降级如实标注（data-staff 的动作后缀）：`+walking` 正在逐格走、`+arrived` 已到位、
 * `+instant` 走帧还没就绪（按到位处理）、`+walk_failed` 图集加载失败或路径不可达、
 * `+walk_timeout` 走到超时（就地等待）。**任何一种都不改业务状态**，也不伪造「走过了」。
 *
 * 普通职员（作者标记 ordinary 的 4 位）按 npc_rules.yaml#preview.autonomy 在自己的
 * 活动域内自主走动：只从作者给的 activity_cells 选点，整条路径都在域内，闲时用
 * balance_params.yaml#autonomous 的时长；老板打开任务本或对白时暂停。
 *
 * 首包预算（≤10 个静态请求）：出生只加载候选地图（默认 office）的运行时 JSON、
 * 地图图集、老板全量动画与 office NPC 的 idle/sit 合并图集；street / cafe 的资源在
 * 第一次切图时按需加载，走帧图集在出生边界之后才拉，都不进首包。
 *
 * 人物逐帧状态只留在 Phaser 内部；挂载点上的 data-player-cell / data-player-facing /
 * data-world-map / data-seats / data-staff / data-actor-cells / data-walk 按格、命令或
 * 加载状态变化节流更新，供无界面诊断与自动化验收使用，不是逐帧同步。
 */
import Phaser from 'phaser'
import { Pathfinder, stepPosition, type Point } from './navigation.ts'
import { MovementIntent, keyBlocked } from './input-guard.ts'
import type { StaffCommand } from './performance.ts'
import { INTERACT_KEY, type NearTarget } from './interaction.ts'
import type { WorldSnapshot } from './recovery.ts'
import {
  ARRIVAL_RADIUS_TILES, BIRTH_MAP, MapRouter, RETURN_TILES_PER_SEC, WALK_TILES_PER_SEC, activityRoute, activityTarget,
  cellKey, cellPoint, directionOf, frameOrigin, idleMs, rendezvousCell, safeMapId,
  seatOrigin, seatPosition,
  type ActivityDomain, type Cell, type CharacterSpec, type Direction, type EntrySpec, type Feet, type Portal, type WorldSpec,
} from './world-runtime.ts'
import { cameraScrollFor, stageLayout, type StageLayout } from './stage.ts'

type Frame = { path: string; size: [number, number]; anchor: [number, number]; seat?: [number, number] }
type Clip = { action: string; direction: string; frames: Frame[] }
/**
 * 运行时角色：作者数据的编译结果。`role` 只在编译产物里出现（老运行时数据没有这一项，
 * 按普通场景角色处理，不给对白、不参与派单表现）。
 */
export type WorldCharacter = Omit<CharacterSpec, 'role' | 'dialogue' | 'seat'> & {
  role?: string
  dialogue?: CharacterSpec['dialogue']
  seat?: CharacterSpec['seat']
  atlas: string
  clips: Clip[]
  /** 走帧（四向）：帧在 `runtime.walkAtlas` 里，懒加载完成后才注册动画。 */
  walk?: Clip[]
  /** 作者给的有限活动域（普通职员）：自主走动只在这个集合内选点与走路。 */
  activity?: ActivityDomain
}
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
  /** 走帧图集键（`<map>-walk`）：**不在** atlases 里，出生边界之后才懒加载；null 表示本图没有。 */
  walkAtlas?: string | null
  /** 三图各自带着同一份世界拓扑：先加载哪张图都能立刻拿到地图与连接。 */
  world: WorldSpec
  draws: { x: number; y: number; width: number; height: number; frame: string; depth: number }[]
  characters: WorldCharacter[]
}

export interface GameWorldOptions {
  /** 界面要求暂停键盘移动时返回 true（输入法组词、弹层等）。 */
  readonly inputLocked: () => boolean
  /** 点击（或在范围内按交互键）地图上的角色；表现层只报事实与距离，怎么响应由会话层决定。 */
  readonly onInteract: (target: NearTarget) => void
  /** 就近范围内的可交互对象变了（含清空）：会话据此解析唯一提示。 */
  readonly onNearTargets: (targets: NearTarget[]) => void
  /** 按了交互键（E）；有提示就执行提示动作，没有就只给一次轻微反馈。 */
  readonly onInteractKey: () => void
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
  /** 舞台布局变化（建场景/resize/换 zoom）：界面据此把 DOM 提示锚定在游戏画面内。 */
  readonly onStage?: (stage: StageLayout) => void
  /** 角色「头顶锚点」的视口坐标（节流 100ms）：头顶气泡层的定位数据，App 层直写 DOM。 */
  readonly onActorScreens?: (screens: readonly { id: string; x: number; y: number }[]) => void
}

const TILE = 32
/** 各地图「地图外」包边色（相机背景），与 style.css 的 --stage-bg 主题一一对应。 */
const SCENE_BACKDROP: Record<string, string> = {
  office: '#dbe9f4',
  street: '#3a3440',
  cafe: '#452f22',
}
/** 传送门色相按目标地图（F9-1）：通向办公楼冷蓝、商业街暖橙、咖啡店咖啡棕。 */
const PORTAL_COLORS: Record<string, number> = {
  office: 0x4a90d9,
  street: 0xd99a4a,
  cafe: 0xb0703c,
}
/** 老板速度：balance_params.yaml#movement.boss_walk_tiles_per_sec = 4.0 格/秒，与 8fps 行走帧同步。 */
const SPEED = 4 * TILE
/** 员工速度：balance_params.yaml#movement.staff_walk/return_tiles_per_sec（3.0 / 2.5 格每秒）。 */
const STAFF_SPEED = WALK_TILES_PER_SEC * TILE
const STAFF_RETURN_SPEED = RETURN_TILES_PER_SEC * TILE
/** 走到会合点的上限（balance_params.yaml#staff_timeouts.walk_to_rendezvous_ms）：超时就地等待，不谎称报到。 */
const WALK_TIMEOUT_MS = 20000
/** balance_params.yaml#autonomous.roam_chance：普通职员歇够之后继续走动的概率。 */
const ROAM_CHANCE = 0.6
/** 到达判定半径（balance_params.yaml#interaction.arrival_radius_tiles）换算成像素。 */
const ARRIVAL_RADIUS_PX = ARRIVAL_RADIUS_TILES * TILE
const CELL_ATTRIBUTE = 'data-player-cell'
const FACING_ATTRIBUTE = 'data-player-facing'
const MAP_ATTRIBUTE = 'data-world-map'
/** 诊断属性：坐着的角色 id（作者座位到位）与员工当前表现命令。 */
const SEATS_ATTRIBUTE = 'data-seats'
const STAFF_ATTRIBUTE = 'data-staff'
/** 诊断属性：非老板角色的格与姿态（`id:x,y:pose`），自动化验收的位移轨迹读它。 */
const ACTORS_ATTRIBUTE = 'data-actor-cells'
/** 诊断属性：走帧图集的加载状态（idle/loading/ready/failed），自动化验收等它到位。 */
const WALK_ATTRIBUTE = 'data-walk'
const SCENE_KEY = 'room'
/** 三图共用的老板图集键。 */
const PLAYER_ATLAS = 'boss'
/** 就近范围扫描间隔：提示按变化上报，不逐帧刷界面。 */
const NEAR_INTERVAL_MS = 200

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
  /** 表现命令：员工按权威状态到位。 */
  applyPerformance(commands: readonly StaffCommand[]): void
  /** 玩家开始操作：把走帧图集（不进首包）拉到后台。 */
  warmWalk(): void
}

/** 走动的终态：到哪一格、到了之后是站是坐。 */
type WalkPlan = { cell: Cell; pose: 'idle' | 'sit' }
/**
 * 走动阶段（写进 data-staff 后缀，如实反映「怎么到的」）：
 * `walking` 正在逐格走；`arrived` 已到位；`instant` 走帧未就绪按到位处理；
 * `walk_failed` 图集加载失败/路径不可达；`walk_timeout` 走到上限就地等待。
 */
type WalkPhase = 'walking' | 'arrived' | 'instant' | 'walk_failed' | 'walk_timeout'

/** 场景里的一个非老板角色（员工或普通 NPC）。 */
type Actor = {
  readonly character: WorldCharacter
  readonly sprite: Phaser.GameObjects.Sprite
  readonly occlusion?: Phaser.GameObjects.Image
  cell: Cell
  facing: Direction
  /** 站姿或坐姿（作者座位数据决定坐姿位置与深度）。 */
  pose: 'idle' | 'sit'
  action: string
  /** 最近一条表现命令（员工）；普通 NPC 没有命令，自主活动由 activity 驱动。 */
  command?: StaffCommand
  /** 走动的目标与剩余路点（格中心像素，按格推进）。 */
  plan?: WalkPlan
  path: Point[]
  /** 当前走动的速度（像素/秒，按命令动作取去程或回程）。 */
  speed: number
  phase: WalkPhase
  /** 本次走动的开始时刻与代次：重开走动时旧寻路结果按代次作废。 */
  startedAt: number
  generation: number
  /** 寻路在途：已经按 walking 计入状态，但路点还没回来（这一段不推位移）。 */
  pending: boolean
  /** 自主活动的下次决策时刻；null 表示这一位不自主活动。 */
  nextRoamAt: number | null
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
  /** 最近一次表现命令：切图重开场景后按它恢复员工表现（业务状态没有变化）。 */
  private commands: StaffCommand[] = []
  /** 当前前台地图的角色名册（作者数据），会话据此算员工表现与对白归属。 */
  private roster: WorldCharacter[] = []
  /** 当前场景里的非老板角色；就近判定与坐姿状态都读它。 */
  private sceneActors: Actor[] = []

  constructor(private readonly parent: HTMLElement, private readonly options: GameWorldOptions) {}

  get state(): Feet { return { map: this.current.map, cell: [...this.current.cell] as Cell, facing: this.current.facing } }

  get mapId(): string { return this.current.map }

  /** 当前地图的业务员工 id（作者数据 role=staff）；普通 NPC 永不进入派单表现。 */
  get staffIds(): string[] { return this.roster.filter(c => c.role === 'staff').map(c => c.id) }

  /** 当前地图的角色名册：会话用它显示员工名字、解析普通 NPC 的预写对白。 */
  get characters(): readonly WorldCharacter[] { return this.roster }

  character(id: string): WorldCharacter | undefined { return this.roster.find(c => c.id === id) }

  /** 启动：先按恢复候选装载出生地图，再创建 Phaser 场景；管家不可用不影响这一步。 */
  async start(): Promise<void> {
    const candidate = this.options.restore?.() ?? null
    const runtime = await this.loadBoot(candidate)
    this.setRoster(runtime)
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
      private nearKey = ''
      private nearAt = 0
      /** 场景还没建好时收到的恢复请求：先记下，create 之后立刻应用。 */
      private pending: WorldSnapshot | null | undefined
      /** 当前舞台布局（stageLayout 的场景侧缓存）：跟随与钳制每帧消费，resize/teleport 重算。 */
      private stage: StageLayout | null = null
      /** 点击寻路的一次性 finder（占格副本）：找到即弃，update 顺带 tick 它。 */
      private routeFinder?: Pathfinder
      private onResize = () => this.applyCamera()
      /** 走帧图集：是否已被要求/正在加载/就绪/失败；只有玩家操作过才会被要求。 */
      private walkWanted = false
      private walkLoading = false
      private walkReady = false
      private walkFailed = false
      /** 场景是否已经建好（走帧懒加载的边界：不得早于出生地图就绪）。 */
      private ready = false
      private actorsKey = ''

      constructor() { super(SCENE_KEY); world.sceneApi = this }

      init(data: RoomData): void {
        this.room = data.runtime
        this.feet = { map: data.feet.map, cell: [...data.feet.cell] as Cell, facing: data.feet.facing }
        this.facing = data.feet.facing
        this.path = []
        this.pathGeneration++
        this.loading = false
        this.pending = undefined
        this.nearKey = ''
        this.ready = false
        this.actorsKey = ''
        this.nametags = []
        // 场景重开等于换了一个加载器：在途的走帧加载不再回调，按未加载处理（纹理本身留在游戏级）。
        this.walkLoading = false
        world.sceneActors = []
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
        this.registerClips(character, character.clips, character.atlas)
        const frames = new Map(character.clips.flatMap(c => c.frames).map(f => [f.path, f]))
        for (const clip of character.walk ?? []) {
          for (const frame of clip.frames) frames.set(frame.path, frame)
        }
        const point = cellPoint(character.cell, TILE)
        const sprite = this.add.sprite(point.x, point.y, character.atlas)
        const anchor = () => {
          const frame = frames.get(sprite.frame.name)
          if (!frame) return
          // 坐姿帧带作者接触锚点：origin 用座位接触锚点，其余姿态用脚点锚点。
          const origin = seatOrigin(frame) ?? frameOrigin(frame)
          sprite.setOrigin(origin.x, origin.y)
        }
        sprite.on('animationupdate', anchor)
        const idle = character.clips.some(c => c.action === 'idle' && c.direction === 'south')
        sprite.play(character.id + (idle ? ':idle:' : ':walk:') + 'south')
        anchor()
        sprite.setDepth(sprite.y)
        if (interactive) {
          sprite.setInteractive()
          sprite.on('pointerdown', () => world.options.onInteract(world.nearTargetOf(character, this.feet.cell)))
        }
        return sprite
      }

      /** 建一个非老板角色：站姿起步，有作者座位的按座位表落到坐姿。 */
      private actor(character: WorldCharacter): Actor {
        const sprite = this.character(character, true)
        const seat = character.seat
        const occlusionData = seat?.occlusion ?? null
        const occlusion = occlusionData
          ? this.add.image(occlusionData.x, occlusionData.y, this.room.id, occlusionData.frame)
            .setOrigin(0).setDisplaySize(occlusionData.width, occlusionData.height).setDepth(occlusionData.depth).setVisible(false)
          : undefined
        const actor: Actor = {
          character, sprite, ...(occlusion ? { occlusion } : {}),
          cell: seat ? [...seat.cell] as Cell : [...character.cell] as Cell,
          facing: seat ? seat.direction : 'south',
          pose: seat ? 'sit' : 'idle',
          action: seat ? 'at_post' : 'idle',
          path: [], speed: STAFF_SPEED, phase: 'arrived', startedAt: 0, generation: 0, pending: false,
          // 有作者活动域的普通职员才自主走动；其余角色只在命令驱动下动。
          nextRoamAt: character.activity === undefined ? null : 0,
        }
        this.place(actor)
        return actor
      }
      /** 站/坐的默认姿态：站在自己的坐格上就坐下（作者座位数据），其余站着。 */
      private restPose(actor: Actor): 'idle' | 'sit' {
        const seat = actor.character.seat
        return seat !== undefined && sameCell(seat.cell, actor.cell) ? 'sit' : 'idle'
      }

      /** 按当前姿态把角色放到作者锚点上：坐姿走接触点 + 逐帧接触锚点，站姿走格中心。 */
      private place(actor: Actor): void {
        const seat = actor.character.seat
        if (actor.pose === 'sit' && seat !== undefined) {
          const frame = seat.sit.frames[0]
          const position = frame ? seatPosition(seat.contact, frame) : null
          if (position === null) { world.options.onAssetsError('坐姿帧缺少接触锚点：' + actor.character.id); return }
          actor.sprite.setPosition(position.x, position.y).setDepth(seat.depth)
          this.playActor(actor, 'sit', seat.direction)
          actor.occlusion?.setVisible(true)
          return
        }
        const point = cellPoint(actor.cell, TILE)
        actor.sprite.setPosition(point.x, point.y).setDepth(point.y)
        this.playActor(actor, 'idle', actor.facing)
        actor.occlusion?.setVisible(false)
      }

      /** 角色动作三态：站姿、坐姿、走路。走帧来自懒加载图集，没就绪时自动退回站姿。 */
      private playActor(actor: Actor, action: 'idle' | 'sit' | 'walk', direction: Direction): void {
        const key = actor.character.id + ':' + action + ':' + direction
        if (this.anims.exists(key)) { actor.sprite.play(key, true); return }
        if (action !== 'walk') return
        const idle = actor.character.id + ':idle:' + direction
        if (this.anims.exists(idle)) actor.sprite.play(idle, true)
      }

      /** 老板自己的站姿/走动动画（老板图集包含全量动画）。 */
      private play(action: 'idle' | 'walk'): void {
        const key = 'boss:' + action + ':' + this.facing
        if (this.anims.exists(key)) this.player.play(key, true)
      }

      /** 按图集登记一组动画键；走帧在懒加载图集里，加载完成后才登记。 */
      private registerClips(character: WorldCharacter, clips: readonly Clip[], atlas: string): void {
        for (const clip of clips) {
          const key = character.id + ':' + clip.action + ':' + clip.direction
          if (this.anims.exists(key)) continue
          this.anims.create({
            key, frames: clip.frames.map(f => ({ key: atlas, frame: f.path })), frameRate: 8, repeat: -1,
          })
        }
      }

      /**
       * 走帧图集的懒加载入口：由**玩家开始操作**（键盘/指针）触发，且必须在场景就绪之后。
       * 首个 walk 命令在出生装载时就到（快照先于管家订阅流就绪），那时拉图集会把首包从
       * 10 个静态请求变成 12 个——首包的边界先于玩家操作，所以走帧按玩家的第一次操作拉。
       */
      warmWalk(): void { this.requestWalkFrames() }

      private requestWalkFrames(): void {
        this.walkWanted = true
        const key = this.room.walkAtlas
        if (!key || !this.ready || this.walkLoading || this.walkReady || this.walkFailed) return
        if (this.textures.exists(key)) { this.finishWalkLoad(key); return }
        this.walkLoading = true
        world.parent.setAttribute(WALK_ATTRIBUTE, 'loading')
        const failed = (file: { key: string }) => {
          if (file.key !== key) return
          this.load.off('loaderror', failed)
          this.walkLoading = false
          this.walkFailed = true
          // 降级：走帧拉不到就保持「按命令到位」，并在 data-staff 上如实标注。
          world.parent.setAttribute(WALK_ATTRIBUTE, 'failed')
          world.options.onAssetsError('走帧资源加载失败：' + key)
          this.syncActors()
        }
        this.load.on('loaderror', failed)
        this.load.once('complete', () => {
          this.load.off('loaderror', failed)
          this.walkLoading = false
          this.finishWalkLoad(key)
        })
        this.load.multiatlas(key, world.options.assetsBase + key + '.json', world.options.assetsBase)
        this.load.start()
      }

      /** 走帧到位：登记四向动画，并让还没落位的角色按正式路径重走一遍。 */
      private finishWalkLoad(key: string): void {
        this.walkReady = true
        world.parent.setAttribute(WALK_ATTRIBUTE, 'ready')
        for (const actor of world.sceneActors) {
          if (actor.character.walk !== undefined) this.registerClips(actor.character, actor.character.walk, key)
          if (actor.plan !== undefined && actor.phase !== 'arrived') this.beginWalk(actor)
          // 歇够时长从走帧就绪开始算，避免几位普通职员同时迈步。
          if (actor.nextRoamAt !== null) actor.nextRoamAt = this.time.now + idleMs()
        }
        this.syncActors()
      }

      /**
       * 开始一次走动：A* 逐格推进，坐着先起身站到坐格中心（作者把坐姿脚点对齐在坐格中心，
       * 这一段是起身不是走路）。走帧没就绪、图集失败或路径不可达时按到位处理并如实标注，
       * 绝不伪造「走过了」。
       */
      private beginWalk(actor: Actor): void {
        const plan = actor.plan
        if (plan === undefined) return
        const generation = ++actor.generation
        actor.path = []
        actor.startedAt = this.time.now
        if (sameCell(actor.cell, plan.cell) && actor.pose === plan.pose) {
          actor.phase = 'arrived'
          this.place(actor)
          return
        }
        if (!this.walkReady) {
          actor.phase = this.walkFailed ? 'walk_failed' : 'instant'
          this.placeAt(actor, plan)
          return
        }
        if (actor.pose === 'sit') {
          // 起身：坐姿接触点落到坐格中心（不沿地面滑动），随后从坐格逐格走出去。
          const point = cellPoint(actor.cell, TILE)
          actor.sprite.setPosition(point.x, point.y).setDepth(point.y)
        }
        // 立刻进入走动状态：离开座位、收起遮挡、播走帧，阶段如实写 walking。
        // 路点回来之前不推位移（这一步由 update 逐格推进），也不谎称已经到位。
        actor.pending = true
        actor.phase = 'walking'
        actor.pose = 'idle'
        actor.occlusion?.setVisible(false)
        this.playActor(actor, 'walk', actor.facing)
        this.syncActors()
        const from: Cell = [...actor.cell] as Cell
        void this.finder.find({ x: from[0], y: from[1] }, { x: plan.cell[0], y: plan.cell[1] }).then(path => {
          if (generation !== actor.generation) return
          actor.pending = false
          if (path === null || path.length === 0) {
            // 路径不可达：留在原处如实保持（与命令解析不到可站立格时的处理一致）。
            actor.phase = 'walk_failed'
            actor.path = []
            this.place(actor)
            return
          }
          const cells: Cell[] = path.map(cell => [cell.x, cell.y] as Cell)
          // 自主活动只走活动域内的路：绕到域外再回到域内也拒绝（npc_rules.yaml#movement.boundary），
          // 起过身的角色回到最后合法位置的姿态（坐在自己坐格上就坐回去）。
          if (actor.command === undefined && actor.character.activity !== undefined
            && activityRoute(cells, actor.character.activity) === null) {
            actor.path = []
            actor.plan = undefined
            actor.phase = 'arrived'
            actor.pose = this.restPose(actor)
            this.place(actor)
            return
          }
          // 路点取格中心：逐格位移，路点之间不插值、不抄近道。
          actor.path = cells.slice(1).map(cell => cellPoint(cell, TILE))
          this.syncActors()
        })
      }

      /** 逐格位移：按速度推进路点，朝向取自实际位移；到达判定用欧氏距离 ≤ 到达半径。 */
      private stepActor(actor: Actor, time: number, delta: number): void {
        if (actor.phase !== 'walking' || actor.pending) return
        if (time - actor.startedAt > WALK_TIMEOUT_MS) {
          // 走到上限：就地等待，不谎称报到（balance_params.yaml#staff_timeouts.walk_to_rendezvous_ms）。
          actor.path = []
          actor.phase = 'walk_timeout'
          this.playActor(actor, 'idle', actor.facing)
          return
        }
        let budget = actor.speed * Math.min(delta, 50) / 1000
        while (actor.path.length > 0 && budget > 0) {
          const waypoint = actor.path[0]!
          const position = stepPosition(actor.sprite, waypoint, budget, (x, y) => this.finder.walkable(x, y))
          const moved = Math.hypot(position.x - actor.sprite.x, position.y - actor.sprite.y)
          if (moved > 0) {
            actor.facing = directionOf(position.x - actor.sprite.x, position.y - actor.sprite.y, actor.facing)
            actor.sprite.setPosition(position.x, position.y).setDepth(position.y)
            actor.cell = [Math.floor(position.x / TILE), Math.floor(position.y / TILE)]
          }
          budget -= moved
          if (Math.hypot(waypoint.x - actor.sprite.x, waypoint.y - actor.sprite.y) < .5) { actor.path.shift(); continue }
          break
        }
        if (actor.path.length === 0) { this.arrive(actor); return }
        this.playActor(actor, 'walk', actor.facing)
      }

      /** 路线走完：只有落在到达半径里才算到位，否则就地保持并标注未到位。 */
      private arrive(actor: Actor): void {
        const plan = actor.plan
        if (plan === undefined) { actor.phase = 'arrived'; this.playActor(actor, 'idle', actor.facing); return }
        const point = cellPoint(plan.cell, TILE)
        if (Math.hypot(point.x - actor.sprite.x, point.y - actor.sprite.y) > ARRIVAL_RADIUS_PX) {
          actor.phase = 'walk_failed'
          actor.path = []
          this.playActor(actor, 'idle', actor.facing)
          return
        }
        this.placeAt(actor, plan)
        actor.phase = 'arrived'
        // 自主活动的目标到此结束：清掉计划，等下一次歇够再选点；命令驱动的目标留着（幂等）。
        if (actor.command === undefined) actor.plan = undefined
      }

      /** 命令驱动的走动：速度按动作取去程/回程；同一条命令重复下发不重启走动。 */
      private commandWalk(actor: Actor, plan: WalkPlan, command: StaffCommand): void {
        actor.speed = command.action === 'hand_back' || command.action === 'at_post' ? STAFF_RETURN_SPEED : STAFF_SPEED
        const same = actor.plan !== undefined && sameCell(actor.plan.cell, plan.cell) && actor.plan.pose === plan.pose
        if (same && actor.phase !== 'walk_failed' && actor.phase !== 'walk_timeout') return
        actor.plan = plan
        this.beginWalk(actor)
      }

      /** 按到位处理（走帧未就绪/失败时的降级路径）：直接落到目标格与目标姿态。 */
      private placeAt(actor: Actor, plan: WalkPlan): void {
        actor.cell = [...plan.cell] as Cell
        actor.pose = plan.pose
        actor.path = []
        this.place(actor)
      }

      /**
       * 普通职员的自主活动（npc_rules.yaml#preview.autonomy）：只从作者活动域选点，
       * 整条路径都不许越出域外；歇够时长按 balance_params.yaml#autonomous。
       * 老板打开任务本或对白时暂停——搭话中不自己走开。
       */
      private roam(actor: Actor, time: number): void {
        const domain = actor.character.activity
        if (domain === undefined || actor.nextRoamAt === null || actor.character.walk === undefined) return
        if (!this.walkReady || world.movementLocked()) return
        if (actor.phase === 'walking' || actor.plan !== undefined) return
        if (time < actor.nextRoamAt) return
        actor.nextRoamAt = time + idleMs()
        if (Math.random() >= ROAM_CHANCE) return
        const cell = activityTarget(domain, actor.cell)
        if (cell === null) return
        actor.speed = STAFF_SPEED
        // 目标就是自己的坐格时坐下（作者给的坐姿），其余落在活动域里站着。
        const seat = actor.character.seat
        const own = seat !== undefined && sameCell(seat.cell, cell)
        actor.plan = { cell, pose: own ? 'sit' : 'idle' }
        this.beginWalk(actor)
      }

      create(): void {
        // 相机背景即「地图外」的颜色：按地图主题设定（office 保持冷白，street/cafe 用
        // 暗色包边），与 .shell 的 --stage-bg 一致——铺不满视口的轴不再露出刺眼空白。
        this.cameras.main.setBackgroundColor(SCENE_BACKDROP[this.room.id] ?? '#dbe9f4')
        this.drawPortals()
        // 切图/首屏淡入；传送门回到待命态（data-portal）。
        this.cameras.main.fadeIn(200, 0, 0, 0)
        this.setPortalState('idle')
        this.room.draws.forEach(draw => {
          this.add.image(draw.x, draw.y, this.room.id, draw.frame)
            .setOrigin(0).setDisplaySize(draw.width, draw.height).setDepth(draw.depth)
        })
        const playerData = this.room.characters.find(c => c.id === 'boss')
        if (!playerData) { world.options.onAssetsError('出生角色缺失'); return }
        this.player = this.character({ ...playerData, cell: this.feet.cell }, false)
        for (const npc of this.room.characters) if (npc.id !== 'boss') world.sceneActors.push(this.actor(npc))
        const grid = Array.from({ length: this.room.height }, (_, y) => this.room.collision.slice(y * this.room.width, (y + 1) * this.room.width))
        this.finder = new Pathfinder(grid)
        this.cameras.main.setRoundPixels(true)
        this.applyCamera()
        this.buildNametags()
        this.scale.on('resize', this.onResize)
        this.bindPointer()
        this.play('idle')
        this.sync(true)
        // 场景重建（切图/恢复）后按最近一次命令复位员工表现：业务状态没有变化。
        this.applyPerformance(world.commands)
        this.syncActors()
        this.events.once('shutdown', () => {
          this.scale.off('resize', this.onResize)
          this.finder.cancel()
          this.path = []
          // 在途的寻路回调按代次作废：关掉的场景不再动角色。
          for (const actor of world.sceneActors) actor.generation++
          world.sceneActors = []
        })
        this.ready = true
        // 玩家在装载期间就按过键：这时才算「出生地图就绪」，补上那次懒加载
        //（不早于这条边界）；图集已经在前台加载过（切图往返）就直接登记动画。
        if (this.room.walkAtlas) world.parent.setAttribute(WALK_ATTRIBUTE, this.walkReady ? 'ready' : 'idle')
        if (this.walkWanted && this.room.walkAtlas) this.requestWalkFrames()
        world.options.onReady?.()
        // 场景创建期间到达的恢复请求（身份确认早于首帧）在这里补上。
        if (this.pending !== undefined) {
          const pending = this.pending
          this.pending = undefined
          this.restore(pending)
        }
      }

      /**
       * 表现命令落地：员工的站坐到位置都按作者锚点解析，一条命令一个确定结果；位移逐格走
       * （走帧未就绪或不可达时按到位处理，data-staff 上如实标注）。
       * 解析不到可站立格（例如会合点周围都被占）时留在原处如实保持，不伪造到位。
       * 会合点槽位按「派单顺序 → 员工 id」分配（interaction_rules.yaml#slots），不叠在同一个人身上。
       */
      applyPerformance(commands: readonly StaffCommand[]): void {
        const staff = world.sceneActors.filter(a => a.character.role === 'staff')
        if (staff.length === 0) return
        for (const actor of staff) actor.command = commands.find(c => c.agentId === actor.character.id)
        staff.sort((a, b) =>
          (a.command?.dispatchOrder ?? Number.MAX_SAFE_INTEGER) - (b.command?.dispatchOrder ?? Number.MAX_SAFE_INTEGER)
          || a.character.id.localeCompare(b.character.id))
        const taken: Cell[] = []
        for (const actor of staff) {
          const command = actor.command
          if (command === undefined) continue
          const target = this.staffTarget(actor, command, taken)
          if (target === null) continue
          actor.action = command.action
          this.commandWalk(actor, target, command)
        }
        this.syncActors()
      }

      /** 命令 → 到位目标（作者锚点）：回工位坐自己的座位，去会合点站到语义目标的相邻可站立格。 */
      private staffTarget(actor: Actor, command: StaffCommand, taken: Cell[]): WalkPlan | null {
        const seat = actor.character.seat
        const own = command.action === 'at_post' || command.action === 'hand_back' || command.rendezvous === 'workstation'
        if (own) {
          if (seat) return { cell: [...seat.cell] as Cell, pose: 'sit' }
          // 没有作者座位的角色只在作者给的格上站好，不臆造坐姿。
          return { cell: [...actor.character.cell] as Cell, pose: 'idle' }
        }
        const source = world.cellOf('butler')
        if (source === null) return null
        const cell = rendezvousCell([source], (candidate) => this.walkable(candidate),
          (candidate) => !taken.some(cell => cell[0] === candidate[0] && cell[1] === candidate[1]) && !world.occupied(candidate, this.feet.cell))
        if (cell === null) return null
        taken.push(cell)
        return { cell, pose: 'idle' }
      }

      private walkable(cell: Cell): boolean {
        const { width, height, collision } = this.room
        if (cell[0] < 0 || cell[1] < 0 || cell[0] >= width || cell[1] >= height) return false
        return collision[cell[1] * width + cell[0]] === 0
      }

      /**
       * 角色到位、坐姿与走动状态是表现事实：按变化写到挂载点上，供诊断与自动化验收。
       * `data-staff` 的动作带走动后缀（walking/arrived/instant/walk_failed/walk_timeout），
       * 走帧没就绪或失败时按到位处理也会如实标注，不假装走过。
       */
      private syncActors(): void {
        const seated = world.sceneActors.filter(a => a.pose === 'sit').map(a => a.character.id)
        const staff = world.sceneActors.filter(a => a.character.role === 'staff').map(a => a.character.id + '=' + a.action + '+' + a.phase)
        const cells = world.sceneActors.map(a => a.character.id + ':' + a.cell[0] + ',' + a.cell[1] + ':' + a.pose).join(';')
        world.parent.setAttribute(SEATS_ATTRIBUTE, seated.join(','))
        world.parent.setAttribute(STAFF_ATTRIBUTE, staff.join(','))
        if (cells !== this.actorsKey) {
          this.actorsKey = cells
          world.parent.setAttribute(ACTORS_ATTRIBUTE, cells)
        }
      }

      /**
       * 舞台与镜头布局（F1）：stageLayout 算出整数倍 zoom 与舞台矩形，
       * setZoom 后把镜头**硬定位**到合法范围（teleport/resize/建场景共用）。
       * 不用 setBounds/startFollow：bounds 小于视口时 Phaser 会把 scroll 钳回左上（A1 根因），
       * 跟随轴的平滑逼近由 update 里的 followCamera 按帧做。
       */
      private applyCamera(): void {
        const viewport = { width: this.scale.gameSize.width, height: this.scale.gameSize.height }
        const layout = stageLayout(viewport, this.room, TILE)
        this.stage = layout
        this.cameras.main.setZoom(layout.zoom)
        const focus = this.player ? { x: this.player.x, y: this.player.y } : cellPoint(this.feet.cell, TILE)
        const scroll = cameraScrollFor(layout, viewport, this.room, TILE, focus)
        this.cameras.main.setScroll(scroll.scrollX, scroll.scrollY)
        world.options.onStage?.(layout)
      }

      /** 跟随轴每帧向目标 scroll 逼近（帧率无关的 0.12 lerp）；包边轴保持固定居中。 */
      private followCamera(delta: number): void {
        const layout = this.stage
        if (!layout || !this.player) return
        const viewport = { width: this.scale.gameSize.width, height: this.scale.gameSize.height }
        const target = cameraScrollFor(layout, viewport, this.room, TILE, { x: this.player.x, y: this.player.y })
        const cam = this.cameras.main
        const step = 1 - Math.pow(1 - 0.12, Math.min(delta, 100) / 16.666)
        if (layout.width >= viewport.width) cam.scrollX += (target.scrollX - cam.scrollX) * step
        if (layout.height >= viewport.height) cam.scrollY += (target.scrollY - cam.scrollY) * step
      }

      /** 触摸与键盘共用同一份碰撞与位移：点地走 A*（同一网格），键盘按下走同一 stepPosition。 */
      private bindPointer(): void {
        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer, objects: Phaser.GameObjects.GameObject[]) => {
          // 玩家点地图也是「开始操作」：走帧图集在这条路径上一起懒加载。
          this.requestWalkFrames()
          if (objects.length || world.movementLocked()) return
          const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y)
          const from = { x: Math.floor(this.player.x / TILE), y: Math.floor(this.player.y / TILE) }
          const to = { x: Math.floor(point.x / TILE), y: Math.floor(point.y / TILE) }
          // F6：把 NPC 当前格按墙写入碰撞副本、用一次性 finder 寻路——路径绕开人而不是穿过去，
          // 起点豁免（老板自己所在格必须可出发）；副本寻路也顺带不再与员工的寻路互抢同一 finder。
          const grid = Array.from({ length: this.room.height }, (_, y) => this.room.collision.slice(y * this.room.width, (y + 1) * this.room.width))
          for (const actor of world.sceneActors) {
            if (actor.phase !== 'walking') grid[actor.cell[1]][actor.cell[0]] = 1
          }
          // B1 防误触：与老板相邻的入口触发格在寻路网格里按墙处理——落点紧邻回程门时
          // （street 落点 (5,12) 与回程门 (5,11) 相邻），点远处不会第一步斜进家门弹回原图。
          // 点击门格本身仍是合法意图：终点格豁免。
          for (const entry of this.room.entries) {
            const [tx, ty] = entry.trigger
            if ((Math.abs(tx - from.x) === 1 && ty === from.y) || (Math.abs(ty - from.y) === 1 && tx === from.x)) {
              if (to.x !== tx || to.y !== ty) grid[ty][tx] = 1
            }
          }
          grid[from.y][from.x] = 0
          const finder = new Pathfinder(grid)
          const generation = ++this.pathGeneration
          this.path = []
          this.routeFinder = finder
          void finder.find(from, to).then(path => {
            if (this.routeFinder === finder) this.routeFinder = undefined
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

      /**
       * 老板可入格 = 碰撞可走且不与「站定/就座」的其他角色同格（F6 软阻挡：只拦老板；
       * 员工到位是脚本化落格，不经此判定，不存在互堵）。行走中的员工是瞬态位置，
       * 不当作阻挡——否则老板会被逐格走动的员工无端卡住。老板当前格恒放行——
       * stepPosition 的首个采样点就在当前格内，不能把它当阻挡。
       */
      private movableTo(x: number, y: number): boolean {
        if (!this.finder.walkable(x, y)) return false

        if (sameCell([x, y] as Cell, [Math.floor(this.player.x / TILE), Math.floor(this.player.y / TILE)])) return true
        return !world.sceneActors.some(actor => actor.phase !== 'walking' && sameCell([x, y] as Cell, actor.cell))
      }

      /** 角色头顶名牌（F1）：Text 随 sprite 每帧同步；切图随场景销毁重建。 */
      private nametags: { text: Phaser.GameObjects.Text; sprite: Phaser.GameObjects.Sprite }[] = []

      /** 建名牌：文字优先用对白名（阿沫/谷雨…），玩家用「老板」并配主题橙底。 */
      private buildNametags(): void {
        this.nametags = []
        for (const c of this.room.characters) {
          const sprite = c.id === 'boss'
            ? this.player
            : world.sceneActors.find(a => a.character.id === c.id)?.sprite
          if (!sprite) continue
          const text = this.add.text(sprite.x, sprite.y - 46, displayName(c), {
            fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
            fontSize: '10px',
            color: c.id === 'boss' ? '#ffd9a8' : '#e8f1f8',
            backgroundColor: c.id === 'boss' ? 'rgba(122,74,26,0.78)' : 'rgba(23,34,46,0.72)',
            padding: { x: 4, y: 2 },
          }).setOrigin(0.5, 1).setDepth(sprite.depth + 0.3)
          this.nametags.push({ text, sprite })
        }
      }

      /** 每帧把名牌钉在角色头顶（脚点上方 46px，随 zoom 自然缩放）。 */
      private followNametags(): void {
        for (const tag of this.nametags) {
          if (!tag.text || !tag.sprite) continue
          tag.text.setPosition(tag.sprite.x, tag.sprite.y - 46)
        }
      }

      /** 角色「头顶锚点」的视口坐标（节流 100ms，F2）：气泡层定位数据，经 onActorScreens 交给 App。 */
      private screensAt = -Infinity
      private emitScreens(time: number): void {
        if (!this.player || time - this.screensAt < 100) return
        this.screensAt = time
        const viewport = { width: this.scale.gameSize.width, height: this.scale.gameSize.height }
        const cam = this.cameras.main
        const halfW = viewport.width / 2
        const halfH = viewport.height / 2
        const project = (wx: number, wy: number) => ({
          x: Math.round((wx - cam.scrollX - halfW) * cam.zoom + halfW),
          y: Math.round((wy - cam.scrollY - halfH) * cam.zoom + halfH),
        })
        const list: { id: string; label: string; x: number; y: number }[] = [
          { id: 'boss', label: '老板', ...project(this.player.x, this.player.y - 52) },
        ]
        for (const actor of world.sceneActors) {
          list.push({
            id: actor.character.id,
            label: displayName(actor.character),
            ...project(actor.sprite.x, actor.sprite.y - 52),
          })
        }
        world.options.onActorScreens?.(list)
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
        this.applyCamera()
        this.play('idle')
        this.sync(true)
      }

      update(time: number, delta: number): void {
        this.finder.tick()
        this.routeFinder?.tick()
        this.followCamera(delta)
        this.followNametags()
        // 员工与普通职员的逐格走动不受老板输入锁影响：界面开着时只暂停自主活动（见 roam）。
        this.stepActors(time, delta)
        this.syncActors()
        this.emitScreens(time)
        if (world.movementLocked()) {
          if (this.intent.clear()) this.path = []
          this.play('idle')
          this.sync()
          this.reportNear(time)
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
          const position = stepPosition(this.player, target, SPEED * Math.min(delta, 50) / 1000, (x, y) => this.movableTo(x, y))
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
        this.reportNear(time)
      }

      /** 一帧里推进所有走动中的角色，再让普通职员按活动域自主活动。 */
      private stepActors(time: number, delta: number): void {
        for (const actor of world.sceneActors) this.stepActor(actor, time, delta)
        for (const actor of world.sceneActors) this.roam(actor, time)
      }

      /** 就近范围按间隔扫描、按变化上报：会话据此解析唯一提示，界面不逐帧重排。 */
      private reportNear(time: number): void {
        if (time - this.nearAt < NEAR_INTERVAL_MS) return
        this.nearAt = time
        const targets = world.nearTargets(this.feet.cell)
        const key = targets.map(t => t.id + ':' + t.kind + ':' + t.distanceTiles.toFixed(2)).join('|')
        if (key === this.nearKey) return
        this.nearKey = key
        world.options.onNearTargets(targets)
      }

      /** 位置事实按格节流上报，并顺手做入口判定。 */
      private sync(force = false): void {
        const cell: Cell = [Math.floor(this.player.x / TILE), Math.floor(this.player.y / TILE)]
        const changed = force || cell[0] !== this.feet.cell[0] || cell[1] !== this.feet.cell[1] || this.facing !== this.feet.facing
        this.feet = { map: this.room.id, cell, facing: this.facing }
        world.setFeet(this.feet, changed)
        if (changed) this.tryPortal()
      }

      /**
       * 站在触发格上且入口已武装：开始切图（F9 动效版）。
       * 演出：老板吸入（缩小淡出）+ 相机淡出 → 加载目标图 → 新场景 fadeIn。
       * 失败路径：恢复老板原状、画面淡回原图、入口保持解除武装（走开再回来才可能再触发），
       * 界面按原图就绪收尾，不停在「地图装载中」。
       */
      private tryPortal(): void {
        if (this.loading) return
        world.router!.rearm(this.feet.cell)
        const portal = world.router!.portal(this.room.id, this.feet.cell)
        if (!portal) return
        this.loading = true
        world.router!.disarm(this.room.id, portal.entryId)
        this.cancelInput()
        this.setPortalState('transition')
        world.options.onLoading?.()
        const body = this.player
        this.tweens.add({ targets: body, alpha: 0.15, scale: 0.55, duration: 150 })
        this.cameras.main.fadeOut(200, 0, 0, 0)
        this.time.delayedCall(200, () => {
          void world.open(portal.to, portal.entryId)
            .then((data: RoomData) => this.scene.start(SCENE_KEY, data))
            .catch(error => {
              // 演出回退：老板恢复原状、画面淡回原图——「表现不决定业务终态」（ADR 0003）。
              this.tweens.killTweensOf(body)
              body.setAlpha(1).setScale(1)
              this.cameras.main.fadeIn(200, 0, 0, 0)
              this.setPortalState('idle')
              this.loading = false
              world.options.onAssetsError(message(error))
              world.options.onReady?.()
            })
        })
      }

      /** 传送门演出状态（data-portal）：无界面诊断与自动化验收用，不是逐帧同步。 */
      private setPortalState(state: 'idle' | 'transition'): void {
        world.parent.setAttribute('data-portal', state)
      }

      /** 入口传送门（F9-1）：触发格上的双层能量圈，色相指向目标地图；纯表现层。
       *  用 Shape（Arc）而不是 Graphics 线描：与精灵同一渲染管线，缩放/像素风下稳定可见；
       *  内圈 scale 呼吸模拟漩涡脉动，只动 scale/alpha，渲染开销可忽略（G6 帧预算复核覆盖）。 */
      private drawPortals(): void {
        let count = 0
        for (const entry of this.room.entries) {
          const to = world.router!.portal(this.room.id, entry.trigger)?.to.map
          const color = PORTAL_COLORS[to ?? ''] ?? 0xf2e6c8
          const point = cellPoint(entry.trigger, TILE)
          // 三层传送门：深色底盘（嵌地凹陷感）+ 色相能量环 + 亮色内核——浅色地板上也清晰。
          const base = this.add.circle(point.x, point.y, 15, 0x1c2230, 0.55).setDepth(point.y - 1)
          const ring = this.add.circle(point.x, point.y, 11, color, 0.85).setDepth(point.y - 1)
          const core = this.add.circle(point.x, point.y, 4, 0xffe9b8, 0.95).setDepth(point.y - 1)
          this.tweens.add({ targets: ring, alpha: { from: 0.55, to: 0.95 }, duration: 850, yoyo: true, repeat: -1 })
          this.tweens.add({ targets: core, scale: { from: 0.7, to: 1.25 }, duration: 850, yoyo: true, repeat: -1 })
          this.tweens.add({ targets: base, alpha: { from: 0.4, to: 0.65 }, duration: 1700, yoyo: true, repeat: -1 })
          count++
        }
        world.parent.setAttribute('data-portals', String(count))
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

  /**
   * 表现命令：只把命令交给场景，不动任何业务状态。命令先收下再转发，
   * 场景还没建好时（切图中、启动早期）由 create 用同一份命令复位。
   */
  applyPerformance(commands: readonly StaffCommand[]): void {
    this.commands = [...commands]
    this.sceneApi?.applyPerformance(this.commands)
  }

  /**
   * 就近范围内的可交互对象：表现层只报事实（谁、在哪一格、离老板几格、对白通道模式），
   * 「当前生效哪一个提示」由会话层按作者优先级解析。
   */
  nearTargets(from: Cell): NearTarget[] {
    return this.sceneActors.map(actor => targetOf(actor, from))
  }

  /** 点击某个角色时的同一条事实；场景还没建好时退回名册里的落点。 */
  private nearTargetOf(character: WorldCharacter, from: Cell): NearTarget {
    const actor = this.sceneActors.find(a => a.character.id === character.id)
    if (actor) return targetOf(actor, from)
    const kind = character.role === 'staff' ? 'staff' : character.role === 'butler' ? 'butler' : 'npc'
    const dialogue = character.dialogue
    return {
      id: character.id, label: dialogue?.name ?? character.label, kind,
      distanceTiles: Math.hypot(character.cell[0] - from[0], character.cell[1] - from[1]),
      ...(dialogue
        ? { dialogueMode: dialogue.mode, authoredLines: dialogue.mode === 'authored_lines' ? [...dialogue.lines] : undefined }
        : {}),
    }
  }

  /** 某个角色当前的格（表现事实）；不在场返回 null。 */
  cellOf(id: string): Cell | null {
    const actor = this.sceneActors.find(a => a.character.id === id)
    return actor ? [...actor.cell] as Cell : null
  }

  /** 这一格是否已被某个角色占着（软阻挡的呈现侧判定，不参与业务）。 */
  occupied(cell: Cell, exclude: Cell): boolean {

    if (sameCell(cell, exclude)) return true
    return this.sceneActors.some(actor => sameCell(cell, actor.cell))
  }

  /** 目标图的 NPC 静态占格（open 时 sceneActors 仍是旧图，不能查它）：落点被占时 land 退格。
   *  boss 不算——它的静态出生格正是入口 arrival，把自己挡在外面就永远回不了常规落点。 */
  private occupiedInRuntime(runtime: RuntimeMap, cell: Cell): boolean {

    return runtime.characters.some(c => c.role !== 'player' && sameCell(cell, c.seat?.cell ?? c.cell))
  }

  /** 切图或重开地图：装载目标图资产并给出落点（失败抛错，由调用方保留原图）。 */
  private async open(to: { map: string; entry: string }, arrivedEntry: string): Promise<RoomData> {
    const runtime = await this.loadMap(to.map)
    const entry = this.router!.spec(to.map)?.entries.find(e => e.id === to.entry)
    if (!entry) throw new Error('入口不存在：' + to.map + '/' + to.entry)
    const feet = this.router!.land(to.map, entry, this.current.facing, (map, cell) => this.walkable(map, cell) && !this.occupiedInRuntime(runtime, cell))
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
    this.setRoster(runtime)
    return runtime
  }

  private setRoster(runtime: RuntimeMap): void {
    this.roster = Array.isArray(runtime.characters) ? runtime.characters : []
  }

  /** 键盘意图与输入法边界：组词、输入框焦点、弹层打开时都不产生移动。 */
  private bindDom(): void {
    const view = this.parent.ownerDocument?.defaultView ?? globalThis
    const onKeyDown = (event: KeyboardEvent) => {
      // 玩家开始操作：走帧图集在这条路径上懒加载（不早于出生地图就绪，见 requestWalkFrames）。
      this.sceneApi?.warmWalk()
      if (keyBlocked(event, { inputLocked: this.options.inputLocked(), composing: this.composing })) return
      if (event.code === INTERACT_KEY) {
        // 交互键等价于当前生效的就近提示动作（interaction_rules.yaml#hotkey）。
        this.options.onInteractKey()
        return
      }
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

const sameCell = (a: Cell, b: Cell) => a[0] === b[0] && a[1] === b[1]

/** 角色显示名:对白名(阿沫/谷雨…)优先,回退美术档 label。 */
function displayName(character: WorldCharacter): string {
  return character.dialogue?.name ?? character.label
}

/** 一个角色的就近事实：谁（对白名优先）、什么职责、离老板几格、对白通道与作者预写台词（作者数据）。 */
function targetOf(actor: Actor, from: Cell): NearTarget {
  const kind = actor.character.role === 'staff' ? 'staff' : actor.character.role === 'butler' ? 'butler' : 'npc'
  const dialogue = actor.character.dialogue
  return {
    id: actor.character.id, label: dialogue?.name ?? actor.character.label, kind,
    distanceTiles: Math.hypot(actor.cell[0] - from[0], actor.cell[1] - from[1]),
    ...(dialogue
      ? { dialogueMode: dialogue.mode, authoredLines: dialogue.mode === 'authored_lines' ? [...dialogue.lines] : undefined }
      : {}),
  }
}
