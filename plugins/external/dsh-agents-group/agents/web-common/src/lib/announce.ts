/**
 * 关键状态播报（方案 6.2）：写入专门的礼貌 live 区域，只报提交、等待、停止和收尾
 * 这类有意义的变化；正文增量绝不进这里，避免逐 token 打断屏幕阅读器。
 * 清空后下一帧再写，保证同名变化也能再次触发播报（旧 dom.js announce 同语义）。
 */
export function announce(text: string): void {
  if (text === '') return
  const node = document.getElementById('sr-status')
  if (node === null) return
  node.textContent = ''
  globalThis.requestAnimationFrame(() => { node.textContent = text })
}
