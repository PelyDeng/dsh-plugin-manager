/**
 * 管家契约桩（本地验证专用，不进入发布包）：按契约 v1 形状提供 identity、会话、
 * 历史、快照与 events SSE。提供两个会话：一个带持续推送增量的活跃轮，一个已完结
 * 的历史轮。只服务回环地址，数据全部自造，不涉及任何真实用户数据。
 */
import { createServer } from 'node:http'

const PREFIX = '/butler'

const conversations = [
  { id: 'butler-web-00000000-0000-4000-8000-000000000001', title: '园区安全博客', createdAt: 1757800000000, updatedAt: 1757803600000, taskCount: 1 },
  { id: 'butler-web-00000000-0000-4000-8000-000000000002', title: '上周的会议纪要', createdAt: 1757700000000, updatedAt: 1757703600000, taskCount: 1 },
]

const liveConversationId = conversations[0].id

function liveSnapshot(seq) {
  return {
    id: 'butler-task-live', conversationId: liveConversationId, goal: '写一篇园区安全博客并配上说明',
    state: 'running', summary: '', error: '', finishedAt: null,
    subtasks: [
      { id: 's1', goal: '起草博客', state: 'running', agentId: 'blog', displayName: '博客', result: '草稿正在写：' + '。'.repeat(Math.max(1, seq - 2)) },
    ],
  }
}

function doneSnapshot() {
  return {
    id: 'butler-task-done', conversationId: conversations[1].id, goal: '整理上周的会议纪要',
    state: 'completed', summary: '纪要已整理完成并归档。', error: '', finishedAt: 1757703600000,
    subtasks: [
      { id: 's1', goal: '汇总各组的进度', state: 'succeeded', agentId: 'example', displayName: 'example', result: '三组进度已汇总。' },
    ],
  }
}

/**
 * 管家桩的请求处理器；可挂到任何 Node HTTP 服务器上。
 * subscriptions 记录每次订阅的 after（断线/续订观察用）。
 */
export function createButlerHandler(subscriptions = []) {
  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(PREFIX + '/') && url.pathname !== PREFIX) return json(response, 404, { error: 'not found' })
    if (url.pathname === PREFIX + '/identity') {
      return json(response, 200, { mode: 'authenticated', key: 'user:local-verify', label: '已登录（本地桩）', authPath: '/auth', routePrefix: PREFIX, contractVersion: 1 })
    }
    if (url.pathname === PREFIX + '/conversations') return json(response, 200, { items: conversations })
    if (url.pathname === PREFIX + '/history') {
      const conversationId = url.searchParams.get('conversationId') ?? ''
      const items = [
        ...(conversationId === '' || conversationId === liveConversationId ? [{ id: 'butler-task-live', conversationId: liveConversationId, goal: '写一篇园区安全博客并配上说明', state: 'running', createdAt: 1757800000000, updatedAt: 1757803600000, subtaskTotal: 1, subtaskDone: 0 }] : []),
        ...(conversationId === '' || conversationId === conversations[1].id ? [{ id: 'butler-task-done', conversationId: conversations[1].id, goal: '整理上周的会议纪要', state: 'completed', createdAt: 1757700000000, updatedAt: 1757703600000, subtaskTotal: 1, subtaskDone: 1 }] : []),
      ]
      return json(response, 200, { items, total: items.length, nextOffset: null })
    }
    if (url.pathname === PREFIX + '/task') {
      const id = url.searchParams.get('id') ?? ''
      if (id === 'butler-task-live') return json(response, 200, liveSnapshot(3))
      if (id === 'butler-task-done') return json(response, 200, doneSnapshot())
      return json(response, 404, { error: '任务不存在或无权访问', code: 'not_found' })
    }
    if (url.pathname === PREFIX + '/events') {
      const conversationId = url.searchParams.get('conversationId') ?? ''
      if (conversationId === conversations[1].id) {
        if (url.searchParams.get('probe') === '1') return json(response, 200, { run: null })
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.write('data: ' + JSON.stringify({ type: 'run', runId: '', state: 'idle', taskId: '', startedAt: null, finishedAt: null }) + '\n\n')
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      if (conversationId !== liveConversationId) return json(response, 404, { error: '会话不存在或无权访问', code: 'not_found' })
      if (url.searchParams.get('probe') === '1') {
        return json(response, 200, { run: { runId: 'butler-run-live', state: 'running', taskId: 'butler-task-live', startedAt: 1757800000000, finishedAt: null, seq: 3, windowStart: 1 } })
      }
      const after = Number(url.searchParams.get('after') ?? '0')
      subscriptions.push({ after })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (event) => response.write('data: ' + JSON.stringify(event) + '\n\n')
      let seq = after
      if (after < 1) send({ type: 'run', runId: 'butler-run-live', state: 'running', taskId: 'butler-task-live', startedAt: 1757800000000, finishedAt: null })
      if (after < 2) send({ type: 'user', text: '帮我写一篇园区安全博客', time: 1757800001000, seq: ++seq, runId: 'butler-run-live' })
      if (after < 3) send({ type: 'chat', role: 'butler', text: '收到，我先安排博客起草。', time: 1757800002000, seq: ++seq, runId: 'butler-run-live' })
      // 持续推送增量，模拟正在执行的一轮；连接断开即停。
      let count = 0
      const timer = setInterval(() => {
        count++
        send({ type: 'subtask_delta', taskId: 'butler-task-live', id: 's1', agentId: 'blog', delta: '（继续写第' + count + '段）', seq: ++seq, runId: 'butler-run-live' })
        if (count % 4 === 0) send({ type: 'subtask_thinking', taskId: 'butler-task-live', id: 's1', agentId: 'blog', thinking: '第 ' + count + ' 次思考快照：组织一下段落。', seq: ++seq, runId: 'butler-run-live' })
      }, 700)
      request.on('close', () => clearInterval(timer))
      return
    }
    return json(response, 404, { error: 'not found', code: 'not_found' })
  }

  return (request, response) => { void handle(request, response) }
}

export async function startButlerStub() {
  const subscriptions = []
  const server = createServer(createButlerHandler(subscriptions))
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return {
    server,
    origin: 'http://127.0.0.1:' + server.address().port,
    subscriptions,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
