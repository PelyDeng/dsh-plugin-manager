/**
 * 非安全上下文（HTTP 内网部署）的剪贴板回退：textarea + execCommand('copy')。
 * 旧 web/app.js writeClipboard 的等价迁移（评审三审 P1#2：navigator.clipboard
 * 在非 localhost 的 HTTP 页面上为 undefined，无回退时复制按钮恒失败）。
 */
export function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  document.body.append(area)
  area.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  area.remove()
  return ok
}
