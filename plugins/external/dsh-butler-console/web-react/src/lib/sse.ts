/**
 * SSE 解析（自 web/stream.js 原样迁移，TS 化）。
 *
 * 只处理服务端实际会发的形状：`data: <json>` 加空行分隔，以及结束标记 `data: [DONE]`。
 * 按块读取而不是按行，是为了让跨块的半个事件也能正确拼回来。
 */

/**
 * 读取 fetch 响应体上的 SSE 事件流。
 *
 * @param response 一个 text/event-stream 响应
 * @param signal 用于中断读取
 */
export async function* readEventStream<T = unknown>(response: Response, signal?: AbortSignal): AsyncGenerator<T> {
  if (response.body === null) throw new Error('服务端没有返回事件流')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 事件之间用空行分隔；最后一段不完整的留给下一次读取。
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const payload = dataOf(chunk)
        if (payload === '[DONE]') return
        if (payload !== null) {
          try {
            yield JSON.parse(payload) as T
          } catch {
            // 单个事件解析失败不应该中断整轮对话，跳过它继续读。
          }
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
    const tail = dataOf(buffer)
    if (tail !== null && tail !== '[DONE]') {
      try { yield JSON.parse(tail) as T } catch { /* 同上的容错。 */ }
    }
  } finally {
    if (signal?.aborted === true) reader.cancel().catch(() => {})
    reader.releaseLock?.()
  }
}

/** 从一块 SSE 文本里取出 data 字段拼起来的内容。 */
function dataOf(chunk: string): string | null {
  const parts: string[] = []
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data:')) parts.push(line.slice(5).trimStart())
  }
  return parts.length === 0 ? null : parts.join('\n')
}
