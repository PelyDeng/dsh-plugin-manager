/**
 * 通用小组件（评审 #13 抽取批）：三处以上逐字重复的 UI 模式收拢为一份实现。
 * 只抽「结构+语义完全一致」的；各自带布局差异的保持在位（防过度抽象）。
 */
import { useEffect, useRef } from 'react'
import { RichText } from '../chat/RichText.tsx'

/** 思考折叠块：流式版（open 跟随 streaming）与终态版（默认展开）共用一份 DOM。 */
export function ThinkBlock({ text, streaming }: { text: string; streaming?: boolean | undefined }) {
  return (
    <details className="think" open={streaming ?? true}>
      <summary className="think__summary"><span className="think__title">思考</span></summary>
      <div className="think__body"><RichText text={text} variant="thinking" /></div>
    </details>
  )
}

/** 点击容器外部时触发回调（菜单弹层关闭等）。容器自身内部的点击不算「外部」。 */
export function useClickOutside(rootRef: React.RefObject<HTMLElement | null>, onOutside: () => void, active: boolean): void {
  // onOutside 走 ref 转发：调用方每次渲染传新箭头函数不影响监听器的挂载周期。
  const handlerRef = useRef(onOutside)
  handlerRef.current = onOutside
  useEffect(() => {
    if (!active) return
    const handler = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) handlerRef.current()
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [active, rootRef])
}
