/**
 * 时间展示的全局唯一点（评审 A6：此前三份逐字重复、契约已分叉）。
 * 当天只显示时分，跨天带月-日；无效与缺省输入返回空串。
 */
export function formatClock(value?: number): string {
  if (value === undefined || value === 0) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date().toDateString()) return clock
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${clock}`
}
