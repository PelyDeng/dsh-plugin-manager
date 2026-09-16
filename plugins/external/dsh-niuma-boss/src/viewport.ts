/**
 * 可见区域与键盘遮挡：Android 软键盘弹出时布局视口不变、visualViewport 变矮，
 * 任务本按可见高度收缩，输入框再用 scrollIntoView 滚进可见区。
 *
 * 这里只做「按可见高度算像素」这一件可测的事；真实软键盘行为须真机验证
 * （见第五阶段实施计划「范围内真机与真实输入」一项）。
 */

export type VisualViewportLike = { height: number } | null | undefined

/** 可见高度：visualViewport 有效时取它，否则退回窗口高度；取整避免半像素抖动。 */
export function visibleHeight(visual: VisualViewportLike, innerHeight: number): number {
  const height = positive(visual)
  if (height > 0 && innerHeight > 0) return Math.round(Math.min(height, innerHeight))
  return Math.round(Math.max(height, innerHeight, 0))
}

const positive = (visual: VisualViewportLike): number =>
  typeof visual?.height === 'number' && Number.isFinite(visual.height) && visual.height > 0 ? visual.height : 0

/** 竖屏：宽度小于高度（横竖屏布局与旋转后位置保留都以此判定）。 */
export function isPortrait(viewport: { width: number; height: number }): boolean {
  return viewport.width < viewport.height
}

/**
 * 把可见高度写进 `--vvh`，并在窗口/可视视口变化时更新；返回解除监听的函数。
 * 软键盘未验证：这里只保证「有变化就跟随」，不在真机上汇报通过。
 */
export function installViewportHeight(win: Window, doc: Document): () => void {
  const root = doc.documentElement
  const apply = () => {
    const visual = (win as Window & { visualViewport?: VisualViewportLike }).visualViewport ?? null
    root.style.setProperty('--vvh', visibleHeight(visual, win.innerHeight) + 'px')
  }
  apply()
  const visual = (win as Window & { visualViewport?: VisualViewportLike & EventTarget }).visualViewport
  win.addEventListener('resize', apply)
  win.addEventListener('orientationchange', apply)
  visual?.addEventListener?.('resize', apply)
  return () => {
    win.removeEventListener('resize', apply)
    win.removeEventListener('orientationchange', apply)
    visual?.removeEventListener?.('resize', apply)
  }
}
