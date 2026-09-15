/**
 * 工具结果里的文本可能是 JSON，也可能不是：解析失败就当没有。卡片构建与轨迹提取都用它。
 */

export function json(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}
