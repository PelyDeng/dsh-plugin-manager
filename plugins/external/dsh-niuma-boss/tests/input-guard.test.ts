import { describe, expect, it } from 'vitest'
import { MOVE_CODES, MovementIntent, isComposingKey, isEditableTarget, keyBlocked } from '../src/input-guard.ts'
import { Pathfinder, stepPosition } from '../src/navigation.ts'

/**
 * 输入边界：键盘与触摸共用同一份碰撞与位移实现；输入法组词、输入框焦点与弹层
 * 打开时都不产生移动意图（真人输入法与软键盘未在真机验证，这里只覆盖可模拟的部分）。
 */

const press = (intent: MovementIntent, codes: string[]) => { for (const code of codes) intent.press(code) }

describe('移动意图', () => {
  it('只认方向键与 WASD，其它键不进意图', () => {
    const intent = new MovementIntent()
    expect(Object.keys(MOVE_CODES).sort()).toEqual(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'KeyA', 'KeyD', 'KeyS', 'KeyW'])
    expect(intent.press('KeyE')).toBe(false)
    expect(intent.press('Space')).toBe(false)
    expect(intent.press('KeyW')).toBe(true)
    expect(intent.active).toBe(true)
  })

  it('四向移动，横向优先，不允许斜向', () => {
    const intent = new MovementIntent()
    press(intent, ['KeyD', 'KeyS'])
    expect(intent.axis()).toEqual({ dx: 1, dy: 0 })
    intent.clear()
    press(intent, ['KeyS'])
    expect(intent.axis()).toEqual({ dx: 0, dy: 1 })
    intent.clear()
    press(intent, ['KeyA', 'ArrowUp'])
    expect(intent.axis()).toEqual({ dx: -1, dy: 0 })
    intent.clear()
    expect(intent.axis()).toEqual({ dx: 0, dy: 0 })
  })

  it('抬起与清空都不留幽灵移动', () => {
    const intent = new MovementIntent()
    press(intent, ['KeyW', 'KeyA'])
    expect(intent.release('KeyW')).toBe(true)
    expect(intent.axis()).toEqual({ dx: -1, dy: 0 })
    expect(intent.clear()).toBe(1)
    expect(intent.active).toBe(false)
    expect(intent.release('KeyW')).toBe(false)
  })
})

describe('输入法边界', () => {
  it('组词中的按键（isComposing / keyCode 229）不产生移动意图', () => {
    expect(isComposingKey({ isComposing: true })).toBe(true)
    expect(isComposingKey({ keyCode: 229 })).toBe(true)
    expect(isComposingKey({ isComposing: false, keyCode: 87 })).toBe(false)
    expect(keyBlocked({ isComposing: true, code: 'KeyW' } as never, { inputLocked: false, composing: false })).toBe(true)
    expect(keyBlocked({ keyCode: 229 } as never, { inputLocked: false, composing: false })).toBe(true)
  })

  it('组词开始后的所有按键都被丢弃，直到组词结束', () => {
    // 「组词中」是会话级状态：compositionstart 之后即使事件本身不带 isComposing 也不移动。
    expect(keyBlocked({ code: 'KeyW' } as never, { inputLocked: false, composing: true })).toBe(true)
    expect(keyBlocked({ code: 'KeyW' } as never, { inputLocked: false, composing: false })).toBe(false)
  })

  it('焦点在输入框或可编辑区域时按键属于输入，不属于人物', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'CANVAS' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(keyBlocked({ target: { tagName: 'TEXTAREA' } } as never, { inputLocked: false, composing: false })).toBe(true)
  })

  it('任务本等弹层打开时按键被丢弃（输入的确认键不会误触地图动作）', () => {
    expect(keyBlocked({ code: 'Enter' } as never, { inputLocked: true, composing: false })).toBe(true)
    expect(keyBlocked({ code: 'ArrowUp' } as never, { inputLocked: true, composing: false })).toBe(true)
  })
})

describe('触摸与键盘共用碰撞与位移', () => {
  // 中间一堵墙的 5×3 网格：[2,*] 全阻挡，左右两侧互不连通。
  const collision = [
    0, 0, 1, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 1, 0, 0,
  ]
  const grid = () => Array.from({ length: 3 }, (_, y) => collision.slice(y * 5, (y + 1) * 5))
  const walkable = (x: number, y: number) => collision[y * 5 + x] === 0
  /** 寻路是分批计算的：由帧循环驱动 tick；easystar 的回调走宏任务，这里手动驱动到出结果。 */
  const drive = async <T>(finder: Pathfinder, promise: Promise<T>): Promise<T> => {
    let done = false
    let result: T | undefined
    void promise.then(value => { done = true; result = value })
    for (let i = 0; i < 200 && !done; i++) {
      finder.tick()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    return result as T
  }

  it('键盘走向墙：停在墙前最后合法位置，不进入阻挡格', () => {
    const from = { x: 1 * 32 + 16, y: 1 * 32 + 16 }
    const target = { x: from.x + 32, y: from.y }
    const stopped = stepPosition(from, target, 32, walkable)
    expect(Math.floor(stopped.x / 32)).toBe(1)
    expect(Math.floor(stopped.y / 32)).toBe(1)
    expect(stopped.x).toBeGreaterThan(from.x)
  })

  it('触摸寻路走同一网格：墙另一侧不可达返回空路径，可达时每格都可站立', async () => {
    const finder = new Pathfinder(grid())
    expect(await drive(finder, finder.find({ x: 1, y: 1 }, { x: 3, y: 1 }))).toBeNull()
    const path = await drive(finder, finder.find({ x: 0, y: 0 }, { x: 1, y: 2 }))
    expect(path).not.toBeNull()
    for (const step of path ?? []) expect(finder.walkable(step.x, step.y)).toBe(true)
    finder.cancel()
  })

  it('键盘位移与触摸路径用同一个 walkable 判定', () => {
    const from = { x: 1 * 32 + 16, y: 1 * 32 + 16 }
    // 朝墙方向（键盘）与朝墙目标（触摸）都需要先过 walkable，这里对同一格比对结论。
    const stopped = stepPosition(from, { x: from.x + 32, y: from.y }, 32, walkable)
    expect(walkable(2, 1)).toBe(false)
    expect(Math.floor(stopped.x / 32)).toBe(1)
    const towardOpen = stepPosition(from, { x: from.x, y: from.y + 32 }, 32, walkable)
    expect(walkable(1, 2)).toBe(true)
    expect(Math.floor(towardOpen.y / 32)).toBe(2)
  })
})

/**
 * 寻路预算：搜索必须按帧分批，单帧耗时不超过计划预算（2ms），逼近节点上限时
 * 按上限取消并如实标记 limited——不给出不可信的截断路径。
 */
describe('寻路预算', () => {
  /** 大片可走的正方形网格：对角搜索要展开大量节点才能到终点。 */
  const openGrid = (size: number) => Array.from({ length: size }, () => Array.from({ length: size }, () => 0))
  const drive = async <T>(finder: Pathfinder, promise: Promise<T>): Promise<T> => {
    let done = false
    let result: T | undefined
    void promise.then(value => { done = true; result = value })
    for (let i = 0; i < 200 && !done; i++) {
      finder.tick()
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    return result as T
  }

  it('每次 tick 不超过预算；逼近 4096 节点上限时按 limited 取消', async () => {
    const size = 100
    const finder = new Pathfinder(openGrid(size))
    // 对角搜索：起点到终点的每个格子的 f 值都相同，展开量足够撞上 4096 节点上限。
    const result = await drive(finder, finder.find({ x: 0, y: 0 }, { x: size - 1, y: size - 1 }))
    expect(result).toBeNull()
    expect(finder.iterations).toBe(4096)
    expect(finder.limited).toBe(true)
    // 单帧耗时：分批计算（每帧最多 128 次 calculate，累计 1.5ms 就不再发起下一次）。
    expect(finder.maxFrameMs).toBeLessThanOrEqual(2)
    // 未撞上限的短搜索不误报 limited，路径照常给出。
    const path = await drive(finder, finder.find({ x: 0, y: 0 }, { x: 1, y: 0 }))
    expect(finder.limited).toBe(false)
    expect(path?.[0]).toEqual({ x: 0, y: 0 })
    expect(path?.at(-1)).toEqual({ x: 1, y: 0 })
    expect(finder.maxFrameMs).toBeLessThanOrEqual(2)
    finder.cancel()
  })
})
