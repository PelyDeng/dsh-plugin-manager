/**
 * 输入意图与输入法边界：键盘、触摸和输入法三件事分开判定。
 *
 * - 键盘只负责「按下哪些方向键」，位移与碰撞仍走 navigation 的同一份实现；
 * - 输入法组词（composition）、输入框持有焦点、弹层打开时不产生移动意图——
 *   中文输入法确认词的回车、方向键不能带动人物（interaction_rules.selection.focus）；
 * - 这里不依赖 Phaser 与 DOM：DOM 事件由 GameWorld 转发进来，判定本身可直接单测。
 */

export type Axis = { dx: number; dy: number }

/** 只认物理键位（event.code）：输入法改写字符时键位不变，方向判定不受影响。 */
export const MOVE_CODES: Readonly<Record<string, Axis>> = {
  KeyW: { dx: 0, dy: -1 }, ArrowUp: { dx: 0, dy: -1 },
  KeyS: { dx: 0, dy: 1 }, ArrowDown: { dx: 0, dy: 1 },
  KeyA: { dx: -1, dy: 0 }, ArrowLeft: { dx: -1, dy: 0 },
  KeyD: { dx: 1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 },
}

/**
 * 按下中的移动键集合。键位在按下与抬起之间保持，松开一定清掉：
 * 组词开始、弹层打开、窗口失焦时整体清空，不留「按住不放」的幽灵移动。
 */
export class MovementIntent {
  private pressed = new Set<string>()

  press(code: string): boolean {
    if (MOVE_CODES[code] === undefined || this.pressed.has(code)) return false
    this.pressed.add(code)
    return true
  }

  release(code: string): boolean { return this.pressed.delete(code) }

  clear(): number {
    const size = this.pressed.size
    this.pressed.clear()
    return size
  }

  get active(): boolean { return this.pressed.size > 0 }

  /** 横向优先、纵向让位：人物只有四向动画，不允许斜向（map_rules.pathfinding.diagonal）。 */
  axis(): Axis {
    let dx = 0, dy = 0
    for (const code of this.pressed) {
      const axis = MOVE_CODES[code]
      dx += axis.dx
      dy += axis.dy
    }
    if (dx) return { dx: Math.sign(dx), dy: 0 }
    if (dy) return { dx: 0, dy: Math.sign(dy) }
    return { dx: 0, dy: 0 }
  }
}

/** 输入法正在组词的按键事件：浏览器给 isComposing，旧式实现给 keyCode 229。 */
export function isComposingKey(event: { isComposing?: boolean; keyCode?: number } | null | undefined): boolean {
  return event?.isComposing === true || event?.keyCode === 229
}

/** 事件目标是输入控件或可编辑区域：此时按键属于输入，不属于人物移动。 */
export function isEditableTarget(target: unknown): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown } | null | undefined
  if (!element) return false
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true
}

/** 一次按键是否应该被丢弃：面板锁、组词中、焦点在输入控件里。 */
export function keyBlocked(
  event: { isComposing?: boolean; keyCode?: number; target?: unknown } | null | undefined,
  state: { inputLocked: boolean; composing: boolean },
): boolean {
  return state.inputLocked || state.composing || isComposingKey(event) || isEditableTarget(event?.target)
}
