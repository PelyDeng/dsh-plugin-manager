/**
 * 管家契约桩（本地验证专用，不进入发布包）：按契约 v1 形状提供 identity、会话、
 * 历史、快照、events SSE 与写端点（/chat、/reply、/stop）。
 *
 * 种子数据保持第一切片行为不回归：会话 1 挂一条持续推送增量的活跃轮，会话 2 是
 * 已完结的历史轮。写端点在这之外维护「动态轮」：提交创建一轮真实推进的事件
 * （计划、执行、等待、终态），事件同时推给写响应与只读订阅——两个入口看到同一条流。
 *
 * 场景标记（消息文本包含即触发，供端到端脚本复现错误形态）：
 *   #forbidden → 403；#run_busy → 409 run_busy；#version_conflict → 409 version_conflict；
 *   #result_unknown → 409 run_result_unknown（带原凭据）；#network → 首次断开连接；
 *   #hang → 永不回应（受理超时）；#external → 终态 external_pending；#fail → 终态 failed；
 *   缺省 → 等待用户回复（waiting_user 后保持打开，/reply 继续、/stop 取消）。
 * 只服务回环地址，数据全部自造，不涉及任何真实用户数据。
 */
import { createServer } from 'node:http'

const PREFIX = '/butler'
const CONVERSATION_PATTERN = /^butler-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
// 所有响应都带 connection: close：浏览器不为桩保持连接池，写请求不会被
// 「复用套接字上服务端断开」的浏览器自动重试救活——那会把「结果不明」变成 200。
const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' }

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
  /** 种子活跃轮是否已被 /stop 停止。 */
  let liveStopped = false
  /** #network 只断开第一次：之后的同 requestId 重试能走通「结果不明→手动重试成功」。 */
  let networkGlitchUsed = false
  let runCounter = 0
  let taskCounter = 0
  /** conversationId → 动态轮（含事件日志与订阅者）；终态后保留用于重放与快照。 */
  const runs = new Map()
  /** taskId → 任务快照（随事件推进）。 */
  const tasks = new Map()
  /** 已计入会话 taskCount 的任务：回复轮沿用同一任务，不重复计数。 */
  const countedTasks = new Set()
  /** 动态新建的会话（POST /chat 用新 UUID 开轮时登记）。 */
  const dynamicConversations = new Map()

  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
    response.end(JSON.stringify(body))
  }

  const readBody = async (request) => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return {}
    }
  }

  const emit = (run, body) => {
    const event = { ...body, seq: ++run.seq, runId: run.runId, time: Date.now() }
    run.events.push(event)
    for (const send of run.subscribers) send(event)
    applyToTask(run, event)
    return event
  }

  const finishRun = (run, summaryBody) => {
    emit(run, summaryBody)
    run.state = summaryBody.state
    for (const send of run.subscribers) send('[DONE]')
    run.subscribers.clear()
    const conversation = ensureConversation(run.conversationId, run.goal)
    conversation.updatedAt = Date.now()
    // 会话计数按任务数：回复轮沿用同一任务，不重复计数。
    if (run.taskId !== '' && !countedTasks.has(run.taskId)) {
      countedTasks.add(run.taskId)
      conversation.taskCount += 1
    }
  }

  const schedule = (run, delay, fn) => {
    const timer = setTimeout(() => { run.timers.delete(timer); if (run.state === 'running') fn() }, delay)
    run.timers.add(timer)
  }

  const createRun = (conversationId, taskId, goal) => {
    const run = {
      runId: 'butler-run-dyn-' + String(++runCounter).padStart(3, '0'),
      taskId, goal, conversationId,
      state: 'running', seq: 0, startedAt: Date.now(),
      events: [], subscribers: new Set(), timers: new Set(),
    }
    // 新一轮替换会话日志：旧轮的观察者按契约收到 [DONE] 结束。
    const previous = runs.get(conversationId)
    if (previous && previous.state === 'running') {
      for (const send of previous.subscribers) send('[DONE]')
      previous.subscribers.clear()
      for (const timer of previous.timers) clearTimeout(timer)
      previous.timers.clear()
      previous.state = 'superseded'
    }
    runs.set(conversationId, run)
    return run
  }

  const ensureConversation = (conversationId, title) => {
    // 种子会话直接沿用：不能为同一 id 再造一条动态记录，导航里会出现重复项。
    const seeded = conversations.find(c => c.id === conversationId)
    if (seeded !== undefined) return seeded
    let conversation = dynamicConversations.get(conversationId)
    if (conversation === undefined) {
      conversation = { id: conversationId, title, createdAt: Date.now(), updatedAt: Date.now(), taskCount: 0 }
      dynamicConversations.set(conversationId, conversation)
    }
    return conversation
  }

  /** 事件推进任务快照（/task 的数据源）；只维护桩内状态，不推断正文因果。 */
  const applyToTask = (run, event) => {
    if (event.taskId === undefined || event.taskId === '') return
    let task = tasks.get(event.taskId)
    if (event.type === 'plan') {
      task = {
        id: event.taskId, conversationId: run.conversationId, goal: event.goal ?? run.goal,
        state: 'running', summary: '', error: '', finishedAt: null,
        subtasks: (event.subtasks ?? []).map(s => ({ id: s.id, goal: s.goal ?? '', state: 'queued', agentId: s.agentId ?? '', displayName: s.displayName ?? s.agentId ?? s.id, result: '' })),
      }
      tasks.set(event.taskId, task)
      return
    }
    if (task === undefined) return
    if (event.type === 'subtask') {
      const subtask = task.subtasks.find(s => s.id === event.id)
      if (subtask === undefined) return
      subtask.state = event.state ?? subtask.state
      if (event.detail !== undefined) subtask.detail = event.detail
      if (event.pending !== undefined) subtask.pending = { ...event.pending }
      if (event.artifacts !== undefined) subtask.artifacts = event.artifacts.map(a => ({ ...a }))
      if (event.conversationId !== undefined) subtask.conversationId = event.conversationId
      if (event.state === 'external_pending' || event.state === 'succeeded' || event.state === 'failed' || event.state === 'cancelled') subtask.finishedAt = Date.now()
    } else if (event.type === 'subtask_delta') {
      const subtask = task.subtasks.find(s => s.id === event.id)
      if (subtask !== undefined) subtask.result += event.delta ?? ''
    } else if (event.type === 'summary') {
      task.state = event.state ?? task.state
      task.summary = event.text ?? ''
      task.finishedAt = Date.now()
    } else if (event.type === 'error') {
      task.error = event.message ?? ''
    }
  }

  /** 把一轮事件按剧本演完：缺省走到等待用户回复后保持打开。 */
  const playRound = (run, message, replyOf) => {
    const text = message.replace(/#[a-z_]+/g, '').trim() || message
    if (replyOf) {
      emit(run, { type: 'subtask', taskId: run.taskId, id: replyOf.subtaskId, state: 'running', agentId: 'blog', displayName: '博客', detail: '收到回复，继续执行' })
      schedule(run, 250, () => emit(run, { type: 'subtask_delta', taskId: run.taskId, id: replyOf.subtaskId, agentId: 'blog', delta: '（按你的选择定稿）' }))
      schedule(run, 500, () => emit(run, { type: 'subtask', taskId: run.taskId, id: replyOf.subtaskId, state: 'succeeded', agentId: 'blog', displayName: '博客', detail: '完成' }))
      schedule(run, 650, () => finishRun(run, { type: 'summary', taskId: run.taskId, text: '已按你的选择完成这一轮。', state: 'completed', error: '' }))
      return
    }
    emit(run, { type: 'user', text: message })
    schedule(run, 150, () => emit(run, { type: 'chat', role: 'butler', text: '收到，我先安排博客起草，写好两个版本给你选。' }))
    const taskId = 'butler-task-dyn-' + String(++taskCounter).padStart(3, '0')
    // 任务 id 在计划产生时才确定：轮的头部（probe、stop 精确匹配）从此对得上。
    schedule(run, 300, () => { run.taskId = taskId; emit(run, { type: 'plan', taskId, goal: text, note: '', subtasks: [{ id: 's1', goal: '起草并交回两个版本', agentId: 'blog', reason: '博客起草', displayName: '博客' }] }) })
    schedule(run, 450, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'running', agentId: 'blog', displayName: '博客', detail: '开始处理' }))
    schedule(run, 650, () => emit(run, { type: 'subtask_delta', taskId, id: 's1', agentId: 'blog', delta: '（草稿第 1 段：先列要点）' }))
    schedule(run, 900, () => emit(run, { type: 'subtask_thinking', taskId, id: 's1', agentId: 'blog', thinking: '两个版本分别面向快速浏览与完整阅读。' }))
    schedule(run, 1150, () => emit(run, { type: 'subtask_delta', taskId, id: 's1', agentId: 'blog', delta: '（草稿第 2 段：补齐说明）' }))
    if (message.includes('#external')) {
      schedule(run, 1400, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'external_pending', agentId: 'blog', displayName: '博客', detail: '候选稿须在博客原对话选择采用', pending: { reason: '候选稿须在博客原对话选择采用', next: '采用之后可以再派一轮' }, artifacts: [{ kind: 'draft', title: '在博客查看并采用候选稿', path: '/blog?conversationId=stub' }], conversationId: 'stub-blog-conversation' }))
      schedule(run, 1600, () => finishRun(run, { type: 'summary', taskId, text: '材料已经交回，还有 1 件事要在外面办完。这一轮到此为止，想继续可以新开一轮。', state: 'external_pending', error: '' }))
      return
    }
    if (message.includes('#fail')) {
      schedule(run, 1400, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'failed', agentId: 'blog', displayName: '博客', detail: '没干成：资料不足' }))
      schedule(run, 1600, () => finishRun(run, { type: 'summary', taskId, text: '这一轮没有完成：资料不足。', state: 'failed', error: '资料不足' }))
      return
    }
    schedule(run, 1400, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'waiting_user', agentId: 'blog', displayName: '博客', detail: '两个版本你选哪个：A 简版 / B 详版？' }))
    // 等待中的轮保持打开：/reply 继续、/stop 取消、#wait_fail 由回复触发失败。
  }

  /** 受理后的写响应：preamble（/chat 有）+ run 头 + 从 0 重放 + 后续事件 + [DONE]。 */
  const streamWriteResponse = (run, response, preamble) => {
    response.writeHead(200, SSE_HEADERS)
    const write = (value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
    if (preamble !== undefined) write(preamble)
    write({ type: 'run', runId: run.runId, state: 'running', taskId: run.taskId, startedAt: run.startedAt, finishedAt: null })
    for (const event of run.events) write(event)
    if (run.state !== 'running') {
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    const send = (value) => { value === '[DONE]' ? (response.write('data: [DONE]\n\n'), response.end()) : write(value) }
    run.subscribers.add(send)
    response.on('close', () => run.subscribers.delete(send))
  }

  /** 只读订阅动态轮：run 头 + 重放 after 之后的事件 + 后续事件。 */
  const streamDynamicEvents = (run, response, after) => {
    response.writeHead(200, SSE_HEADERS)
    const write = (value) => response.write('data: ' + JSON.stringify(value) + '\n\n')
    write({ type: 'run', runId: run.runId, state: run.state === 'running' ? 'running' : 'finished', taskId: run.taskId, startedAt: run.startedAt, finishedAt: run.state === 'running' ? null : Date.now() })
    for (const event of run.events) if (event.seq > after) write(event)
    if (run.state !== 'running') {
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    const send = (value) => { value === '[DONE]' ? (response.write('data: [DONE]\n\n'), response.end()) : write(value) }
    run.subscribers.add(send)
    response.on('close', () => run.subscribers.delete(send))
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(PREFIX + '/') && url.pathname !== PREFIX) return json(response, 404, { error: 'not found' })
    if (url.pathname === PREFIX + '/identity') {
      return json(response, 200, { mode: 'authenticated', key: 'user:local-verify', label: '已登录（本地桩）', authPath: '/auth', routePrefix: PREFIX, contractVersion: 1 })
    }
    if (url.pathname === PREFIX + '/conversations') {
      return json(response, 200, { items: [...conversations, ...dynamicConversations.values()] })
    }
    if (url.pathname === PREFIX + '/history') {
      const conversationId = url.searchParams.get('conversationId') ?? ''
      const dynamicItems = [...tasks.values()]
        .filter(task => conversationId === '' || task.conversationId === conversationId)
        .map(task => ({ id: task.id, conversationId: task.conversationId, goal: task.goal, state: task.state, createdAt: task.finishedAt ?? Date.now(), updatedAt: task.finishedAt ?? Date.now(), subtaskTotal: task.subtasks.length, subtaskDone: task.subtasks.filter(s => s.state === 'succeeded' || s.state === 'external_pending').length }))
      const items = [
        ...(conversationId === '' || conversationId === liveConversationId ? [{ id: 'butler-task-live', conversationId: liveConversationId, goal: '写一篇园区安全博客并配上说明', state: liveStopped ? 'cancelled' : 'running', createdAt: 1757800000000, updatedAt: 1757803600000, subtaskTotal: 1, subtaskDone: 0 }] : []),
        ...(conversationId === '' || conversationId === conversations[1].id ? [{ id: 'butler-task-done', conversationId: conversations[1].id, goal: '整理上周的会议纪要', state: 'completed', createdAt: 1757700000000, updatedAt: 1757703600000, subtaskTotal: 1, subtaskDone: 1 }] : []),
        ...dynamicItems,
      ]
      return json(response, 200, { items, total: items.length, nextOffset: null })
    }
    if (url.pathname === PREFIX + '/task') {
      const id = url.searchParams.get('id') ?? ''
      if (id === 'butler-task-live') {
        if (!liveStopped) return json(response, 200, liveSnapshot(3))
        return json(response, 200, { id: 'butler-task-live', conversationId: liveConversationId, goal: '写一篇园区安全博客并配上说明', state: 'cancelled', summary: '这一轮已按请求停止。', error: '', finishedAt: Date.now(), subtasks: [{ id: 's1', goal: '起草博客', state: 'cancelled', agentId: 'blog', displayName: '博客', result: '草稿正在写：。' }] })
      }
      if (id === 'butler-task-done') return json(response, 200, doneSnapshot())
      const task = tasks.get(id)
      if (task !== undefined) return json(response, 200, task)
      return json(response, 404, { error: '任务不存在或无权访问', code: 'not_found' })
    }
    if (url.pathname === PREFIX + '/events') {
      const conversationId = url.searchParams.get('conversationId') ?? ''
      if (conversationId !== liveConversationId && !runs.has(conversationId) && conversationId !== conversations[1].id) return json(response, 404, { error: '会话不存在或无权访问', code: 'not_found' })
      // 动态轮优先：会话 2 被写端点开过一轮后就按动态轮观察，不再回空闲。
      if (runs.has(conversationId)) {
        const run = runs.get(conversationId)
        if (url.searchParams.get('probe') === '1') {
          if (run.state !== 'running') return json(response, 200, { run: null })
          return json(response, 200, { run: { runId: run.runId, state: 'running', taskId: run.taskId, startedAt: run.startedAt, finishedAt: null, seq: run.seq, windowStart: 1 } })
        }
        subscriptions.push({ after: Number(url.searchParams.get('after') ?? '0') })
        return streamDynamicEvents(run, response, Number(url.searchParams.get('after') ?? '0'))
      }
      if (conversationId === conversations[1].id) {
        if (url.searchParams.get('probe') === '1') return json(response, 200, { run: null })
        response.writeHead(200, SSE_HEADERS)
        response.write('data: ' + JSON.stringify({ type: 'run', runId: '', state: 'idle', taskId: '', startedAt: null, finishedAt: null }) + '\n\n')
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
      if (url.searchParams.get('probe') === '1') {
        if (liveStopped) return json(response, 200, { run: null })
        return json(response, 200, { run: { runId: 'butler-run-live', state: 'running', taskId: 'butler-task-live', startedAt: 1757800000000, finishedAt: null, seq: 3, windowStart: 1 } })
      }
      const after = Number(url.searchParams.get('after') ?? '0')
      subscriptions.push({ after })
      response.writeHead(200, SSE_HEADERS)
      const send = (event) => response.write('data: ' + JSON.stringify(event) + '\n\n')
      let seq = after
      if (after < 1) send({ type: 'run', runId: 'butler-run-live', state: 'running', taskId: 'butler-task-live', startedAt: 1757800000000, finishedAt: null })
      if (after < 2) send({ type: 'user', text: '帮我写一篇园区安全博客', time: 1757800001000, seq: ++seq, runId: 'butler-run-live' })
      if (after < 3) send({ type: 'chat', role: 'butler', text: '收到，我先安排博客起草。', time: 1757800002000, seq: ++seq, runId: 'butler-run-live' })
      if (liveStopped) {
        send({ type: 'subtask', taskId: 'butler-task-live', id: 's1', state: 'cancelled', seq: ++seq, runId: 'butler-run-live', time: Date.now() })
        response.write('data: [DONE]\n\n')
        response.end()
        return
      }
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
    if (url.pathname === PREFIX + '/chat' && request.method === 'POST') {
      const payload = await readBody(request)
      const message = typeof payload.message === 'string' ? payload.message : ''
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : ''
      if (message.trim() === '') return json(response, 400, { error: '消息不能为空', code: 'message_empty' })
      if (!CONVERSATION_PATTERN.test(conversationId)) return json(response, 400, { error: '不是牛马大总管的会话标识', code: 'conversation_invalid' })
      if (message.includes('#forbidden')) return json(response, 403, { error: '请求来源不受信任', code: 'forbidden' })
      if (message.includes('#run_busy')) return json(response, 409, { error: '牛马大总管正在处理上一条消息，请先停止或等待完成', code: 'run_busy' })
      if (message.includes('#version_conflict')) return json(response, 409, { error: '这一轮已经更新到第 2 版，请按最新内容重新提交', code: 'version_conflict' })
      if (message.includes('#result_unknown')) {
        return json(response, 409, { error: '这次提交的结果不明，不会重新执行', code: 'run_result_unknown', runId: 'butler-run-unknown', conversationId })
      }
      if (message.includes('#network') && !networkGlitchUsed) {
        networkGlitchUsed = true
        response.destroy()
        return
      }
      if (message.includes('#hang')) return // 永不回应：受理超时由客户端处理
      // 种子活跃轮或动态运行轮占着这一会话：如实拒绝，不排队。
      if (conversationId === liveConversationId && !liveStopped) return json(response, 409, { error: '牛马大总管正在处理上一条消息，请先停止或等待完成', code: 'run_busy' })
      const existing = runs.get(conversationId)
      if (existing !== undefined && existing.state === 'running') return json(response, 409, { error: '牛马大总管正在处理上一条消息，请先停止或等待完成', code: 'run_busy' })
      const run = createRun(conversationId, '', message)
      // 会话在受理时登记：另一入口刷新会话列表立刻能看到它。
      ensureConversation(conversationId, message.replace(/#[a-z_]+/g, '').trim() || message)
      streamWriteResponse(run, response, { type: 'conversation', conversationId })
      playRound(run, message, null)
      return
    }
    if (url.pathname === PREFIX + '/reply' && request.method === 'POST') {
      const payload = await readBody(request)
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
      const subtaskId = typeof payload.subtaskId === 'string' ? payload.subtaskId : ''
      const decideByAgent = payload.decideByAgent === true
      const text = decideByAgent ? '' : (typeof payload.text === 'string' ? payload.text.trim() : '')
      if (!decideByAgent && text === '') return json(response, 400, { error: '请先写点内容，或者让它自己拿主意', code: 'reply_text_missing' })
      const task = tasks.get(taskId)
      if (task === undefined) return json(response, 404, { error: '任务不存在或无权访问', code: 'task_not_found' })
      const subtask = task.subtasks.find(s => s.id === subtaskId)
      if (subtask === undefined) return json(response, 404, { error: '这个子任务不存在', code: 'subtask_not_found' })
      if (text.includes('#expired')) return json(response, 409, { error: 'blog 的这次等待已经失效，请重新描述你的目标', code: 'waiting_expired' })
      if (subtask.state !== 'waiting_user') return json(response, 409, { error: '这位成员当前没有在等你回话', code: 'not_waiting' })
      // 受理补话：同任务换执行轮，事件日志被新一轮替换。
      const run = createRun(task.conversationId, taskId, task.goal)
      emit(run, { type: 'user', text: decideByAgent ? '（你看着办）' : text })
      streamWriteResponse(run, response)
      playRound(run, decideByAgent ? '你看着办' : text, { subtaskId })
      return
    }
    if (url.pathname === PREFIX + '/stop' && request.method === 'POST') {
      const payload = await readBody(request)
      const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : ''
      const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : ''
      const known = conversationId === liveConversationId || conversationId === conversations[1].id || dynamicConversations.has(conversationId)
      if (!CONVERSATION_PATTERN.test(conversationId) && !known) return json(response, 404, { error: '会话不存在或无权访问', code: 'not_found' })
      if (conversationId === liveConversationId) {
        if (liveStopped || taskId !== '' && taskId !== 'butler-task-live') {
          return json(response, 200, { ok: true, accepted: false, reason: '这个任务已经不在执行了' })
        }
        liveStopped = true
        return json(response, 200, { ok: true, accepted: true })
      }
      const run = runs.get(conversationId)
      if (run === undefined || run.state !== 'running') {
        return json(response, 200, { ok: true, accepted: false, reason: '现在没有正在执行的一轮' })
      }
      if (taskId !== '' && taskId !== run.taskId) {
        return json(response, 200, { ok: true, accepted: false, reason: '这个任务已经不在执行了' })
      }
      emit(run, { type: 'subtask', taskId: run.taskId, id: 's1', state: 'cancelled', agentId: 'blog', displayName: '博客', detail: '已按请求停止' })
      finishRun(run, { type: 'summary', taskId: run.taskId, text: '这一轮已按请求停止。', state: 'cancelled', error: '' })
      return json(response, 200, { ok: true, accepted: true })
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
