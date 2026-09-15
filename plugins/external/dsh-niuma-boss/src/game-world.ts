/**
 * GameWorld：Phaser 地图、人物、寻路、镜头与动画。不读取任何业务接口；
 * 管家任务投影由 GameSession 送进 Pinia，两边只通过回调与 DOM 事件边界交流。
 *
 * 首包预算（≤10 个静态请求）：出生加载 office 地图、老板全量动画与全部 NPC 的
 * idle 合并图集；NPC 的走动/手势帧属后续表现切片，不进首包。
 * 人物逐帧状态只留在 Phaser 内部；挂载点上的 data-player-cell 按格变化节流更新，
 * 供无界面诊断与自动化验收使用，不是逐帧同步。
 */
import Phaser from 'phaser'
import { Pathfinder, stepPosition, type Point } from './navigation.ts'

type Frame = { path: string; size: [number, number]; anchor: [number, number] }
type Clip = { action: string; direction: string; frames: Frame[] }
export type WorldCharacter = { id: string; label: string; atlas: string; cell: [number, number]; clips: Clip[] }
export type RuntimeMap = {
  width: number
  height: number
  tileSize: number
  collision: number[]
  spawn: [number, number]
  draws: { x: number; y: number; width: number; height: number; frame: string; depth: number }[]
  characters: WorldCharacter[]
}

export interface GameWorldOptions {
  /** 界面要求暂停键盘移动时返回 true（输入法组词、弹层等）。 */
  readonly inputLocked: () => boolean
  /** 点击了地图上的角色；正式对白属后续切片，这里只回调标签。 */
  readonly onInteract: (label: string) => void
  /** 运行资源加载失败；任务本据此显示明确错误而不是黑屏。 */
  readonly onAssetsError: (detail: string) => void
  /** 出生地图渲染完成。 */
  readonly onReady?: () => void
  /** 编译后资源的基路径，默认按部署前缀推导。 */
  readonly assetsBase: string
}

const TILE = 32
const SPEED = 150
const CELL_ATTRIBUTE = 'data-player-cell'

export class GameWorld {
  private game?: Phaser.Game

  constructor(private readonly parent: HTMLElement, private readonly options: GameWorldOptions) {}

  start(): Phaser.Game {
    const world = this
    const host = this.parent
    class OfficeScene extends Phaser.Scene {
      constructor() { super('office') }
      private runtime!: RuntimeMap
      private player!: Phaser.GameObjects.Sprite
      private keys!: Record<string, Phaser.Input.Keyboard.Key>
      private finder!: Pathfinder
      private path: Point[] = []
      private pathGeneration = 0
      private lastCellAttribute = ''

      preload(): void {
        const base = world.options.assetsBase
        this.load.json('runtime', base + 'office.runtime.json')
        this.load.multiatlas('office', base + 'office.json', base)
        this.load.multiatlas('boss', base + 'boss.json', base)
        this.load.multiatlas('office-npcs', base + 'office-npcs.json', base)
        this.load.on('loaderror', (file: { key: string }) => world.options.onAssetsError('资源加载失败：' + file.key))
      }

      /** 建角色精灵与四向动画；anchor 按逐帧 frameAnchor 设置，保证脚点对齐。 */
      private character(character: WorldCharacter, interactive: boolean): Phaser.GameObjects.Sprite {
        const frames = new Map(character.clips.flatMap(c => c.frames).map(f => [f.path, f]))
        for (const clip of character.clips) this.anims.create({
          key: character.id + ':' + clip.action + ':' + clip.direction,
          frames: clip.frames.map(f => ({ key: character.atlas, frame: f.path })), frameRate: 8, repeat: -1,
        })
        const sprite = this.add.sprite((character.cell[0] + .5) * TILE, (character.cell[1] + .5) * TILE, character.atlas)
        const anchor = () => { const f = frames.get(sprite.frame.name); if (f) sprite.setOrigin(f.anchor[0] / f.size[0], f.anchor[1] / f.size[1]) }
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
        this.runtime = this.cache.json.get('runtime') as RuntimeMap
        for (const draw of this.runtime.draws) {
          this.add.image(draw.x, draw.y, 'office', draw.frame).setOrigin(0).setDisplaySize(draw.width, draw.height).setDepth(draw.depth)
        }
        const playerData = this.runtime.characters.find(c => c.id === 'boss')
        if (!playerData) { world.options.onAssetsError('出生角色缺失'); return }
        this.player = this.character({ ...playerData, cell: this.runtime.spawn }, false)
        for (const npc of this.runtime.characters) {
          if (npc.id !== 'boss') this.character(npc, true)
        }
        this.keys = this.input.keyboard!.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT', false) as Record<string, Phaser.Input.Keyboard.Key>
        const grid = Array.from({ length: this.runtime.height }, (_, y) => this.runtime.collision.slice(y * this.runtime.width, (y + 1) * this.runtime.width))
        this.finder = new Pathfinder(grid)
        this.cameras.main.setBounds(0, 0, this.runtime.width * TILE, this.runtime.height * TILE).startFollow(this.player, true, 0.12, 0.12)
        const applyZoom = () => {
          this.cameras.main.setZoom(this.scale.width >= 1024 ? Math.min(1, this.scale.width / 1344, this.scale.height / 960) : 1)
        }
        this.scale.on('resize', () => requestAnimationFrame(applyZoom))
        applyZoom()
        this.input.on('pointerdown', (pointer: Phaser.Input.Pointer, objects: Phaser.GameObjects.GameObject[]) => {
          // 点在角色上属于交互，不触发移动。
          if (world.options.inputLocked() || objects.length) return
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
        this.events.once('shutdown', () => this.finder.cancel())
        world.options.onReady?.()
      }

      update(_time: number, delta: number): void {
        this.finder.tick()
        if (world.options.inputLocked()) { this.player.anims.stop(); return }
        const dx = (this.keys.D.isDown || this.keys.RIGHT.isDown ? 1 : 0) - (this.keys.A.isDown || this.keys.LEFT.isDown ? 1 : 0)
        const dy = dx ? 0 : (this.keys.S.isDown || this.keys.DOWN.isDown ? 1 : 0) - (this.keys.W.isDown || this.keys.UP.isDown ? 1 : 0)
        let target: Point | undefined
        if (dx || dy) {
          this.pathGeneration++
          this.finder.cancel()
          this.path = []
          target = { x: this.player.x + dx * TILE, y: this.player.y + dy * TILE }
        } else {
          target = this.path[0]
          if (target && Math.hypot(target.x - this.player.x, target.y - this.player.y) < .5) { this.path.shift(); target = this.path[0] }
        }
        if (target) {
          const position = stepPosition(this.player, target, SPEED * Math.min(delta, 50) / 1000, (x, y) => this.finder.walkable(x, y))
          const moveX = position.x - this.player.x, moveY = position.y - this.player.y
          if (moveX || moveY) {
            const direction = Math.abs(moveX) > Math.abs(moveY) ? moveX > 0 ? 'east' : 'west' : moveY > 0 ? 'south' : 'north'
            this.player.play('boss:walk:' + direction, true).setPosition(position.x, position.y).setDepth(position.y)
          } else { this.path = []; this.player.anims.stop() }
        } else this.player.anims.stop()
        // 诊断锚点：只在所在格变化时更新，不是逐帧 DOM 同步。
        const cell = Math.floor(this.player.x / TILE) + ',' + Math.floor(this.player.y / TILE)
        if (cell !== this.lastCellAttribute) {
          this.lastCellAttribute = cell
          host.setAttribute(CELL_ATTRIBUTE, cell)
        }
      }
    }
    this.game = new Phaser.Game({
      type: Phaser.AUTO, parent: this.parent, backgroundColor: '#dbe9f4', pixelArt: true,
      scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: OfficeScene,
    })
    return this.game
  }

  pause(): void { this.game?.scene.pause('office') }

  resume(): void { this.game?.scene.resume('office') }

  destroy(): void { this.game?.destroy(true) }
}
