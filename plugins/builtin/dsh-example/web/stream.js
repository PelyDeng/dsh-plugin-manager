/** Decode SSE across UTF-8 and network boundaries; EOF without done is an interruption. */
export async function readEvents(response, receive) {
  if (!response.body) throw new Error('浏览器不支持流式响应')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  try {
    while (true) {
      const part = await reader.read()
      buffer += decoder.decode(part.value, { stream: !part.done })
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
        if (!data) continue
        const event = JSON.parse(data)
        receive(event)
        if (event.type === 'done') done = true
      }
      if (part.done) break
    }
    if (!done) throw new Error('连接已中断，请检查登录状态或新建对话。')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
