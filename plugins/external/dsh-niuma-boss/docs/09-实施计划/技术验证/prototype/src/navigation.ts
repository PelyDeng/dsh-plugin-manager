import EasyStar from 'easystarjs'

export type Point = { x: number; y: number }
export class Pathfinder {
  private finder = new EasyStar.js()
  private id?: number
  private generation = 0
  private pending = false
  private resolve?: (path: Point[] | null) => void
  iterations = 0
  maxFrameMs = 0
  limited = false
  constructor(private grid: number[][]) {
    this.finder.setGrid(grid)
    this.finder.setAcceptableTiles([0])
    this.finder.setIterationsPerCalculation(1)
  }
  walkable(x: number, y: number): boolean { return Number.isInteger(x) && Number.isInteger(y) && this.grid[y]?.[x] === 0 }
  cancel(): void {
    this.generation++
    if (this.id !== undefined) this.finder.cancelPath(this.id)
    this.pending = false
    this.resolve?.(null)
    this.resolve = undefined
  }
  find(from: Point, to: Point): Promise<Point[] | null> {
    this.cancel()
    this.iterations = 0
    this.limited = false
    if (!this.walkable(from.x, from.y) || !this.walkable(to.x, to.y)) return Promise.resolve(null)
    if (from.x === to.x && from.y === to.y) return Promise.resolve([from])
    this.pending = true
    const generation = this.generation
    return new Promise(resolve => {
      this.resolve = resolve
      this.id = this.finder.findPath(from.x, from.y, to.x, to.y, path => {
        if (generation !== this.generation) return
        this.pending = false
        this.resolve = undefined
        resolve(path)
      })
    })
  }
  tick(): void {
    if (!this.pending) return
    const started = performance.now()
    // 一次 calculate 最多弹出一个节点；调用数是展开节点数的保守上界。
    // ponytail: 每帧最多 128 次、留 0.5ms 余量；实测持续超预算后再考虑 Worker。
    for (let batch = 0; batch < 128 && this.pending && performance.now() - started < 1.5 && this.iterations < 4096; batch++) {
      this.finder.calculate()
      this.iterations++
    }
    this.maxFrameMs = Math.max(this.maxFrameMs, performance.now() - started)
    if (this.iterations >= 4096) {
      const generation = this.generation
      setTimeout(() => { if (this.pending && generation === this.generation) { this.limited = true; this.cancel() } }, 0)
    }
  }
}

export function stepPosition(point: Point, target: Point, distance: number, walkable: (x: number, y: number) => boolean): Point {
  const length = Math.hypot(target.x - point.x, target.y - point.y)
  if (!length) return point
  const travel = Math.min(length, distance)
  const steps = Math.ceil(travel / 4)
  let result = point
  for (let i = 1; i <= steps; i++) {
    const next = { x: point.x + (target.x - point.x) / length * travel * i / steps, y: point.y + (target.y - point.y) / length * travel * i / steps }
    if (!walkable(Math.floor(next.x / 32), Math.floor(next.y / 32))) break
    result = next
  }
  return result
}
