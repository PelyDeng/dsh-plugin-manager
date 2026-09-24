/**
 * 操作反馈的就近轻提示（0.14.6）：文本渲染在操作区附近的 role="status"（polite live
 * region）元素里，2.4s 淡入-保持-淡出，动画结束清文本。容器常驻——live region 节点
 * 不卸载，读屏播报不会因节点移除被吞。
 * 之前操作反馈误用 announce()（只写读屏区），因 .visually-hidden 缺定义泄漏成视口
 * 左下角的裸文字（三轮 UI 评审可见）；现在可见反馈走这里，announce 只留流程状态播报。
 * 连续 flash 同文案：先清再下一帧写入，动画与播报都能重触发（announce 同语义）。
 */
import { useCallback, useState } from 'react'

export function useFlash(): { text: string; flash: (text: string) => void; onEnd: () => void } {
  const [text, setText] = useState('')
  const flash = useCallback((next: string) => {
    if (next === '') return
    setText('')
    globalThis.requestAnimationFrame(() => { setText(next) })
  }, [])
  const onEnd = useCallback(() => { setText('') }, [])
  return { text, flash, onEnd }
}
