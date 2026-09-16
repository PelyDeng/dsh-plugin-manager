import { describe, expect, it } from 'vitest'
import { installViewportHeight, isPortrait, visibleHeight } from '../src/viewport.ts'

/**
 * 横竖屏与可见区域：可见高度取 visualViewport 与窗口高度的较小值（软键盘弹出时
 * 布局视口不变、可视视口变矮）。真机软键盘行为未验证，这里只覆盖可模拟的计算与跟随。
 */

describe('可见高度', () => {
  it('取可视视口与窗口高度的较小值', () => {
    expect(visibleHeight({ height: 844 }, 844)).toBe(844)
    expect(visibleHeight({ height: 480 }, 844)).toBe(480)
    expect(visibleHeight({ height: 900 }, 844)).toBe(844)
    expect(visibleHeight({ height: 500.4 }, 844)).toBe(500)
  })

  it('可视视口缺失或不可用时退回窗口高度', () => {
    expect(visibleHeight(undefined, 844)).toBe(844)
    expect(visibleHeight(null, 700)).toBe(700)
    expect(visibleHeight({ height: 0 }, 700)).toBe(700)
    expect(visibleHeight({ height: Number.NaN }, 700)).toBe(700)
    expect(visibleHeight(undefined, 0)).toBe(0)
  })

  it('横竖屏按宽高比判定', () => {
    expect(isPortrait({ width: 390, height: 844 })).toBe(true)
    expect(isPortrait({ width: 844, height: 390 })).toBe(false)
    expect(isPortrait({ width: 1000, height: 1000 })).toBe(false)
  })
})

describe('可见高度跟随', () => {
  const fake = (innerHeight: number, visualHeight?: number) => {
    const listeners = new Map<string, Set<() => void>>()
    const root = { style: { values: new Map<string, string>(), setProperty(name: string, value: string) { this.values.set(name, value) } } }
    const visual = visualHeight === undefined ? null : {
      height: visualHeight,
      listeners: new Set<() => void>(),
      addEventListener(_type: string, listener: () => void) { this.listeners.add(listener) },
      removeEventListener(_type: string, listener: () => void) { this.listeners.delete(listener) },
    }
    const fake = {
      innerHeight,
      visualViewport: visual,
      listeners,
      addEventListener(type: string, listener: () => void) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)!.add(listener)
      },
      removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener) },
      emit(type: string) { for (const listener of listeners.get(type) ?? []) listener() },
      detach: (type: string) => listeners.get(type)?.size ?? 0,
    }
    return { win: fake, doc: { documentElement: root } as unknown as Document, root, visual, fake }
  }

  it('挂载时写入 --vvh，键盘弹出（可视视口变矮）后跟随更新', () => {
    const { win, doc, root, visual, fake: raw } = fake(844, 844)
    const detach = installViewportHeight(win as unknown as Window, doc)
    expect(root.style.values.get('--vvh')).toBe('844px')
    visual!.height = 520
    raw.emit('resize')
    expect(root.style.values.get('--vvh')).toBe('520px')
    detach()
    expect(raw.detach('resize')).toBe(0)
    expect(visual!.listeners.size).toBe(0)
  })

  it('旋转（窗口尺寸变化）后重新计算', () => {
    const { win, doc, root, fake: raw } = fake(844)
    const detach = installViewportHeight(win as unknown as Window, doc)
    expect(root.style.values.get('--vvh')).toBe('844px')
    win.innerHeight = 390
    raw.emit('orientationchange')
    expect(root.style.values.get('--vvh')).toBe('390px')
    detach()
  })
})
