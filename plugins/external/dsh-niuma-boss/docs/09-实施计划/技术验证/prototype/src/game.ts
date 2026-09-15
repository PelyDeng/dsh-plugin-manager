import Phaser from 'phaser'
import { Pathfinder, stepPosition, type Point } from './navigation.ts'

type Frame = { path: string; size: [number, number]; anchor: [number, number] }
type Clip = { action: string; direction: string; frames: Frame[] }
type Character = { id: string; label: string; cell: [number, number]; clips: Clip[] }
type RuntimeMap = { width: number; height: number; tileSize: number; collision: number[]; spawn: [number, number]; draws: { x: number; y: number; width: number; height: number; frame: string; depth: number }[]; characters: Character[]; effects: string[][] }
export const metrics = { frameP95Ms: 0, fps: 0, pathMaxFrameMs: 0, pathIterations: 0, keyboardMoves: 0, pointerPaths: 0, collisionStops: 0, characters: 0, effects: 0, loaded: false, x: 0, y: 0, error: '', view: { x: 0, y: 0, worldX: 0, worldY: 0, zoom: 1 } }

export function startGame(parent: HTMLElement, inputLocked: () => boolean): Phaser.Game {
  class OfficeScene extends Phaser.Scene {
    constructor() { super('office-validation') }
    private runtime!: RuntimeMap
    private player!: Phaser.GameObjects.Sprite
    private keys!: Record<string, Phaser.Input.Keyboard.Key>
    private finder!: Pathfinder
    private path: Point[] = []
    private samples: number[] = []
    private totalTime = 0
    private stressLoaded = false
    private pathGeneration = 0

    preload(): void {
      const base = '/niuma-boss/generated/'
      this.load.json('runtime', base + 'office.runtime.json')
      this.load.multiatlas('office', base + 'office.json', base)
      this.load.multiatlas('boss', base + 'boss.json', base)
      this.load.on('loaderror', (file: { key: string }) => { metrics.error = '资源加载失败：' + file.key })
    }
    private character(character: Character): Phaser.GameObjects.Sprite {
      const frames = new Map(character.clips.flatMap(c => c.frames).map(f => [f.path, f]))
      for (const clip of character.clips) this.anims.create({
        key: character.id + ':' + clip.action + ':' + clip.direction,
        frames: clip.frames.map(f => ({ key: character.id, frame: f.path })), frameRate: 8, repeat: -1,
      })
      const sprite = this.add.sprite((character.cell[0] + .5) * 32, (character.cell[1] + .5) * 32, character.id)
      const anchor = () => { const f = frames.get(sprite.frame.name); if (f) sprite.setOrigin(f.anchor[0] / f.size[0], f.anchor[1] / f.size[1]) }
      sprite.on('animationupdate', anchor)
      sprite.play(character.id + ':walk:south')
      anchor()
      sprite.setDepth(sprite.y).setInteractive()
      sprite.on('pointerdown', () => dispatchEvent(new CustomEvent('validation-npc', { detail: character.label })))
      metrics.characters++
      return sprite
    }
    create(): void {
      this.runtime = this.cache.json.get('runtime') as RuntimeMap
      for (const draw of this.runtime.draws) this.add.image(draw.x, draw.y, 'office', draw.frame).setOrigin(0).setDisplaySize(draw.width, draw.height).setDepth(draw.depth)
      this.player = this.character(this.runtime.characters[0])
      const keyboard = this.input.keyboard!
      this.keys = keyboard.addKeys('W,A,S,D,UP,LEFT,DOWN,RIGHT', false) as Record<string, Phaser.Input.Keyboard.Key>
      const grid = Array.from({ length: this.runtime.height }, (_, y) => this.runtime.collision.slice(y * this.runtime.width, (y + 1) * this.runtime.width))
      this.finder = new Pathfinder(grid)
      this.cameras.main.setBounds(0, 0, this.runtime.width * 32, this.runtime.height * 32).startFollow(this.player)
      const resize = () => {
        const hud = document.querySelector('.hud')!.getBoundingClientRect()
        const portrait = this.scale.width < this.scale.height
        const top = portrait ? 0 : hud.bottom
        const height = portrait ? hud.top : this.scale.height - top
        this.cameras.main.setViewport(0, top, this.scale.width, Math.max(1, height))
          .setZoom(this.scale.width >= 1024 ? Math.min(1, this.scale.width / 1344, height / 960) : 1)
      }
      this.scale.on('resize', () => requestAnimationFrame(resize))
      resize()
      this.input.on('pointerdown', (pointer: Phaser.Input.Pointer, objects: Phaser.GameObjects.GameObject[]) => {
        if (inputLocked() || objects.length) return
        const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y)
        const generation = ++this.pathGeneration
        this.path = []
        void this.finder.find({ x: Math.floor(this.player.x / 32), y: Math.floor(this.player.y / 32) }, { x: Math.floor(point.x / 32), y: Math.floor(point.y / 32) }).then(path => {
          if (generation !== this.pathGeneration || !path) return
          metrics.pointerPaths++
          this.path = path.map(p => ({ x: (p.x + .5) * 32, y: (p.y + .5) * 32 }))
        })
      })
      this.game.events.on('validation-stress', this.stress, this)
      this.events.once('shutdown', () => { this.finder.cancel(); this.game.events.off('validation-stress', this.stress, this) })
      metrics.loaded = true
    }
    private stress(): void {
      if (this.stressLoaded) return
      this.stressLoaded = true
      const base = '/niuma-boss/generated/'
      for (const c of this.runtime.characters.slice(1)) this.load.multiatlas(c.id, base + c.id + '.json', base)
      this.load.multiatlas('vfx', base + 'vfx.json', base)
      this.load.once('complete', () => {
        this.runtime.characters.slice(1).forEach(c => this.character(c))
        for (const [index, frames] of this.runtime.effects.entries()) this.anims.create({ key: 'vfx:' + index, frames: frames.map(frame => ({ key: 'vfx', frame })), frameRate: 8, repeat: -1 })
        for (let i = 0; i < 48; i++) this.add.sprite(60 + i * 79 % 1220, 64 + i * 53 % 800, 'vfx').setOrigin(.5, 15 / 16).setDepth(2000).play('vfx:' + i % 4)
        metrics.effects = 48
        this.samples = []
      })
      this.load.start()
    }
    update(_time: number, delta: number): void {
      const camera = this.cameras.main
      metrics.view = { x: camera.x, y: camera.y, worldX: camera.worldView.x, worldY: camera.worldView.y, zoom: camera.zoom }
      this.totalTime += delta
      if (this.totalTime > 2000 && !document.hidden) {
        this.samples.push(delta)
        if (this.samples.length > 600) this.samples.shift()
        if (this.samples.length % 30 === 0) {
          const sorted = [...this.samples].sort((a, b) => a - b)
          metrics.frameP95Ms = sorted[Math.floor(sorted.length * .95)] ?? 0
          metrics.fps = 1000 / (this.samples.reduce((sum, v) => sum + v, 0) / this.samples.length)
        }
      }
      this.finder.tick()
      metrics.pathMaxFrameMs = this.finder.maxFrameMs
      metrics.pathIterations = this.finder.iterations
      if (inputLocked()) { this.player.anims.stop(); return }
      const dx = (this.keys.D.isDown || this.keys.RIGHT.isDown ? 1 : 0) - (this.keys.A.isDown || this.keys.LEFT.isDown ? 1 : 0)
      const dy = dx ? 0 : (this.keys.S.isDown || this.keys.DOWN.isDown ? 1 : 0) - (this.keys.W.isDown || this.keys.UP.isDown ? 1 : 0)
      let target: Point | undefined
      if (dx || dy) {
        this.pathGeneration++
        this.finder.cancel()
        this.path = []
        target = { x: this.player.x + dx * 32, y: this.player.y + dy * 32 }
      } else {
        target = this.path[0]
        if (target && Math.hypot(target.x - this.player.x, target.y - this.player.y) < .5) { this.path.shift(); target = this.path[0] }
      }
      if (target) {
        const position = stepPosition(this.player, target, 150 * Math.min(delta, 50) / 1000, (x, y) => this.finder.walkable(x, y))
        const moveX = position.x - this.player.x, moveY = position.y - this.player.y
        if (moveX || moveY) {
          const direction = Math.abs(moveX) > Math.abs(moveY) ? moveX > 0 ? 'east' : 'west' : moveY > 0 ? 'south' : 'north'
          this.player.play('boss:walk:' + direction, true).setPosition(position.x, position.y).setDepth(position.y)
          if (dx || dy) metrics.keyboardMoves++
        } else { metrics.collisionStops++; this.path = []; this.player.anims.stop() }
      } else this.player.anims.stop()
      metrics.x = this.player.x
      metrics.y = this.player.y
    }
  }
  return new Phaser.Game({ type: Phaser.AUTO, parent, backgroundColor: '#dbe9f4', pixelArt: true, scale: { mode: Phaser.Scale.RESIZE, width: '100%', height: '100%' }, scene: OfficeScene })
}
