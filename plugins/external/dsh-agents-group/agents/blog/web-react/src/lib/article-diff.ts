/**
 * 文章正文行级对比（旧 web/article-diff.js 的逐行等价迁移，纯数据函数）。
 *
 * 语义照旧（旧文件头注）：长文的对比工作量有界——中间超大改动段不做逐行 LCS
 * （n*m>1_000_000 时整段按「整删+整增」分组），首尾相同行先收敛。产出是分组行：
 * kind = same / added / removed，每组的 lines 是连续行文本。
 */

export interface DiffRow {
  kind: 'same' | 'added' | 'removed'
  lines: string[]
}

export function articleDiff(before = '', after = ''): DiffRow[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const rows: DiffRow[] = []
  const add = (kind: DiffRow['kind'], text: string): void => {
    const last = rows.at(-1)
    if (last !== undefined && last.kind === kind) last.lines.push(text)
    else rows.push({ kind, lines: [text] })
  }
  let start = 0
  let endA = a.length
  let endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) {
    add('same', a[start] ?? '')
    start++
  }
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const n = endA - start
  const m = endB - start
  if (n === 0 || m === 0 || n * m > 1_000_000) {
    for (let i = start; i < endA; i++) add('removed', a[i] ?? '')
    for (let j = start; j < endB; j++) add('added', b[j] ?? '')
  } else {
    const lengths: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lengths[i]![j] = a[start + i] === b[start + j] ? 1 + lengths[i + 1]![j + 1]! : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) {
        add('same', a[start + i] ?? '')
        i++
        j++
      } else if (i < n && (j === m || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
        add('removed', a[start + i] ?? '')
        i++
      } else {
        add('added', b[start + j] ?? '')
        j++
      }
    }
  }
  for (let k = endA; k < a.length; k++) add('same', a[k] ?? '')
  return rows
}
