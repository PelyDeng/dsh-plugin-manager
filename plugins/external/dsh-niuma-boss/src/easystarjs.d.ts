declare module 'easystarjs' {
  type Point = { x: number; y: number }
  class EasyStar {
    setGrid(grid: number[][]): void
    setAcceptableTiles(tiles: number[]): void
    setIterationsPerCalculation(iterations: number): void
    findPath(x1: number, y1: number, x2: number, y2: number, callback: (path: Point[] | null) => void): number | undefined
    cancelPath(id: number): boolean
    calculate(): void
  }
  const api: { js: typeof EasyStar }
  export default api
}
