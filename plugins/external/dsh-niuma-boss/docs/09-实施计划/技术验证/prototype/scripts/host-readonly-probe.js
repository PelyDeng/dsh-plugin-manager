// 在已登录的 https://dsh.pelycloud.com/butler 页面的浏览器控制台运行。
// 只发同源 GET；不读取 Cookie，不输出身份、会话标识、标题或正文。
(async () => {
  const report = { checkedAt: new Date().toISOString(), result: 'failed', requests: [], businessWrites: 0 }
  const failures = ['wrong_origin', 'http_rejected', 'invalid_identity', 'invalid_conversations', 'invalid_conversation_id', 'invalid_probe']
  async function read(label, path) {
    const response = await fetch(path, { method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(8000) })
    report.requests.push({ endpoint: label, status: response.status })
    if (response.status !== 200) throw new Error('http_rejected')
    return response.json()
  }
  try {
    if (location.origin !== 'https://dsh.pelycloud.com') throw new Error('wrong_origin')
    const identity = await read('identity', '/butler/identity')
    const validPrefix = typeof identity?.routePrefix === 'string' && /^\/[a-z0-9][a-z0-9/-]*$/.test(identity.routePrefix)
    report.identity = { authenticated: identity?.mode === 'authenticated', identityPresent: typeof identity?.key === 'string' && !!identity.key, contractVersion: Number.isSafeInteger(identity?.contractVersion) ? identity.contractVersion : null, routePrefix: validPrefix ? identity.routePrefix : null }
    if (!report.identity.authenticated || !report.identity.identityPresent || report.identity.contractVersion !== 1 || !validPrefix) throw new Error('invalid_identity')
    const conversations = await read('conversations', identity.routePrefix + '/conversations')
    if (!Array.isArray(conversations.items)) throw new Error('invalid_conversations')
    report.conversations = { count: conversations.items.length }
    if (!conversations.items.length) {
      report.result = 'partial'
      report.eventsProbe = { executed: false, reason: 'no_existing_conversation' }
    } else {
      const id = conversations.items[0]?.id
      if (typeof id !== 'string' || !/^butler-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('invalid_conversation_id')
      const probe = await read('events?probe=1', identity.routePrefix + '/events?conversationId=' + encodeURIComponent(id) + '&probe=1')
      if (!probe || !Object.hasOwn(probe, 'run') || (probe.run !== null && (!Number.isSafeInteger(probe.run?.seq) || probe.run.seq < 0))) throw new Error('invalid_probe')
      report.eventsProbe = { executed: true, runPresent: probe.run !== null, cursorPresent: probe.run !== null }
      report.result = 'passed'
    }
  } catch (error) {
    report.error = failures.includes(error.message) ? error.message : 'network_or_response_error'
  }
  report.boundary = '仅身份、会话目录和SSE探测；未验证业务写入、POST Origin保护、实际事件流或游戏双入口'
  console.log(JSON.stringify(report, null, 2))
})()
