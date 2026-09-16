/**
 * 管家契约桩（本地验证专用，不进入发布包）：按契约 v1 形状提供 identity、会话、
 * 历史、快照、events SSE 与写端点（/chat、/reply、/stop）。
 *
 * 种子数据保持第一切片行为不回归：会话 1 挂一条持续推送增量的活跃轮，会话 2 是
 * 已完结的历史轮。写端点在这之外维护「动态轮」：提交创建一轮真实推进的事件
 * （计划、执行、等待、终态），事件同时推给写响应与只读订阅——两个入口看到同一条流。
 *
 * 幂等与并发：写端点按 requestId 记幂等（同 owner + 同类型 + 同 requestId 视为同一次
 * 提交）：同正文再提交回放**首次那一轮**（同一个 runId，不重新执行），换了正文回 409
 * idempotency_conflict；不需要 requestId 时每次都是新的一轮。事件日志每个会话只保留
 * 最近一轮（真实管家也按日志头判断能不能回放）：记录里的那一轮已经不是该会话的当前轮时
 * 没有过程可回放，按契约回 409——那一轮已有终态证据回 `run_already_finished`，只有受理、
 * 结果不明回 `run_result_unknown`，两种都**不重新执行**，客户端应带原凭据去读任务快照。
 * 同一会话同时只允许一轮在跑，冲突回 409 run_busy（另一个入口的第二轮提交由此被拒，
 * 而不是排队）。
 *
 * 正文落库节奏按契约建模：成员的增量先进事件日志，**只有确定写正文的落库迁移**
 * （succeeded / external_pending）才把这一轮的正文写进快照；换执行轮时这一轮的
 * 增量缓冲从头累计。因此「运行中重读快照拿不到正文」与「结束后补齐」都能真实复现。
 *
 * 场景标记（消息文本包含即触发，供端到端脚本复现错误形态）：
 *   #forbidden → 403；#run_busy → 409 run_busy；#version_conflict → 409 version_conflict；
 *   #result_unknown → 409 run_result_unknown（带原凭据）；#network → 首次断开连接；
 *   #hang → 永不回应（受理超时）；#external → 终态 external_pending；#fail → 终态 failed；
 *   #cut → 受理后写响应的事件流中断（这一轮在服务端继续跑，由只读订阅续上）；
 *   #trim → 执行中事件窗口左边缘右移并断开在场连接：续订游标落在窗口外，按契约回 reset；
 *   #late_stop → 本轮由别的入口先停掉，本入口的 /stop 迟到且只得到 accepted:false；
 *   #late_reply → 回复迟到：等待已被别的入口结束，管家按 not_waiting 拒绝这次回复；
 *   缺省 → 等待用户回复（waiting_user 后保持打开，/reply 继续、/stop 取消）。
 *
 * 桩控制口 `POST /butler/__fixture`（仅本地桩，真实管家没有这个入口）：给验收脚本
 * 驱动「另一个入口」与权限撤换用，形状见 handleFixture。
 *
 * 能力边界：幂等记录只在内存里，不模拟保留期（TTL）与跨重启持久化；「日志已经不可回放」
 * 只有两条途径——同会话开了下一轮（日志被覆盖）、或本轮在跑时被下一轮顶掉（状态
 * superseded）。本桩只在 summary 事件上记终态，所以被顶掉的轮按「没有终态证据」处理
 * （真实管家在那一轮收轮时可能已经算 finished）；两个码对客户端的含义一致：都不重新
 * 执行，都要带原凭据去读任务快照。事件窗口滚出（#trim）只影响续订游标，不改幂等判断。
 *
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
  /** 权限撤换（桩控制口）：非 200 时 identity 按该状态响应，复现登录失效。 */
  let identityStatus = 200
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
  /**
   * 本轮成员发言的缓冲（`taskId:subtaskId` → 文本）：只进事件日志，直到确定写正文的
   * 落库迁移（succeeded / external_pending）才写进快照的 result。换执行轮时从空开始。
   */
  const attemptLog = new Map()
  /** requestId → 首次受理的那一轮（同正文再提交回放它，不重复执行）。 */
  const idempotency = new Map()
  /** 已经断过一次连接的提交文本：同一份提交只断第一次（重试才走得到幂等回放）。 */
  const glitched = new Set()
  /** 让下一次事件流读取按该状态失败（复现断流后的离线提示与重试入口）。 */
  let eventsFailure = null
  /** 真正受理执行的轮次数与幂等重放次数：验收断言「两次请求、一次执行」用。 */
  let chatExecutions = 0
  let replyExecutions = 0
  let duplicateSubmits = 0

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

  /** 订阅者：写事件、断开连接，以及连接已经关掉时不再写；tag 用来只断开某一条流。 */
  const subscriberOf = (response, tag) => {
    const sub = {
      tag, closed: false,
      send: (value) => { if (!sub.closed) response.write('data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n') },
      drop: () => response.destroy(),
      end: () => { if (!sub.closed) response.end() },
    }
    response.on('close', () => { sub.closed = true })
    return sub
  }

  const push = (run, value) => { for (const sub of [...run.subscribers]) if (!sub.closed) sub.send(value) }
  const dropSubscribers = (run) => { for (const sub of [...run.subscribers]) sub.drop(); run.subscribers.clear() }
  const dropTagged = (run, tag) => {
    for (const sub of [...run.subscribers]) if (sub.tag === tag) { sub.drop(); run.subscribers.delete(sub) }
  }
  /** 本轮结束：在场的观察者拿到 [DONE] 并收线。 */
  const endSubscribers = (run) => {
    for (const sub of [...run.subscribers]) { if (sub.closed) continue; sub.send('[DONE]'); sub.end() }
    run.subscribers.clear()
  }

  const emit = (run, body) => {
    const event = { ...body, seq: ++run.seq, runId: run.runId, time: Date.now() }
    run.events.push(event)
    push(run, event)
    applyToTask(run, event)
    return event
  }

  const finishRun = (run, summaryBody) => {
    emit(run, summaryBody)
    run.state = summaryBody.state
    endSubscribers(run)
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

  const createRun = (conversationId, taskId, goal, markers = new Set()) => {
    const run = {
      runId: 'butler-run-dyn-' + String(++runCounter).padStart(3, '0'),
      taskId, goal, conversationId,
      state: 'running', seq: 0, startedAt: Date.now(),
      /** 事件日志窗口的左边缘：小于它的序号已经滚出（#trim 用它复现 reset）。 */
      windowStart: 1,
      markers,
      events: [], subscribers: new Set(), timers: new Set(),
    }
    // 新一轮替换会话的事件日志。在场的观察者跟着日志走：先拿到新轮的头（runId 变化），
    // 客户端据此按换轮恢复（probe → 重读快照 → 从 0 重放当前轮），不当成错误。
    const previous = runs.get(conversationId)
    if (previous !== undefined && previous.state === 'running') {
      const carried = [...previous.subscribers].filter(sub => !sub.closed)
      previous.subscribers.clear()
      for (const timer of previous.timers) clearTimeout(timer)
      previous.timers.clear()
      previous.state = 'superseded'
      for (const sub of carried) {
        run.subscribers.add(sub)
        sub.send({ type: 'run', runId: run.runId, state: 'running', taskId: run.taskId, startedAt: run.startedAt, finishedAt: null })
      }
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

  /**
   * 事件推进任务快照（/task 的数据源）。正文只在这两处写入：确定写正文的落库迁移
   * （succeeded / external_pending）把这一轮的增量写进 result；其余迁移不动正文
   * （普通失败/取消只写 error，旧 result 保留）。增量本身先进事件日志。
   */
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
      const previousState = subtask.state
      subtask.state = event.state ?? subtask.state
      if (event.detail !== undefined) subtask.detail = event.detail
      if (event.pending !== undefined) subtask.pending = { ...event.pending }
      if (event.artifacts !== undefined) subtask.artifacts = event.artifacts.map(a => ({ ...a }))
      if (event.conversationId !== undefined) subtask.conversationId = event.conversationId
      if (event.state === 'external_pending' || event.state === 'succeeded' || event.state === 'failed' || event.state === 'cancelled') subtask.finishedAt = Date.now()
      // 新的尝试开始：这一轮的增量缓冲从头累计（旧 result 按 COALESCE 保留）。
      if (event.state === 'running' && previousState !== 'running') attemptLog.delete(event.taskId + ':' + event.id)
      // 确定写正文的落库迁移：把这一轮的增量写进 result（旧 result 为空时沿用）。
      if (event.state === 'succeeded' || event.state === 'external_pending') {
        const log = attemptLog.get(event.taskId + ':' + event.id) ?? ''
        if (log !== '' || subtask.result === '') subtask.result = log || subtask.result
      }
    } else if (event.type === 'subtask_delta') {
      const key = event.taskId + ':' + event.id
      attemptLog.set(key, (attemptLog.get(key) ?? '') + (event.delta ?? ''))
    } else if (event.type === 'summary') {
      task.state = event.state ?? task.state
      task.summary = event.text ?? ''
      task.finishedAt = Date.now()
    } else if (event.type === 'error') {
      task.error = event.message ?? ''
    }
  }

  /** 消息里的场景标记（`#xxx`）。 */
  const markers = (message) => new Set(String(message).match(/#[a-z_]+/g) ?? [])

  /**
   * 幂等记录里的那一轮已经没有可回放的日志时按契约回的错误体：那一轮跑完了（有终态
   * 证据）回 `run_already_finished`，只有受理、结果不明（还没终态就换了轮／进程重启过）回
   * `run_result_unknown`。两种都**不重新执行**，因此带上原凭据供客户端去读任务快照。
   */
  const lostLogBody = (record) => {
    const run = record.run
    // 本桩只在 summary 事件上记终态：被下一轮顶掉的轮（superseded）没有终态证据。
    const finished = run !== undefined && run.state !== 'running' && run.state !== 'superseded'
    return {
      error: finished
        ? '这次提交已经处理过，那一轮也已经结束，无法再回放它的过程；请读取任务快照'
        : '这次提交已经受理过，但结果不明（被下一轮覆盖或服务在这里重启过）；不会重新执行，请读取任务快照确认',
      code: finished ? 'run_already_finished' : 'run_result_unknown',
      runId: run?.runId ?? '',
      conversationId: record.conversationId ?? '',
    }
  }
  /** 记录里的那一轮还是该会话的当前轮（事件日志头）时才能回放它的过程。 */
  const replayable = (record) => runs.get(record.conversationId) === record.run

  /** 把一轮事件按剧本演完：缺省走到等待用户回复后保持打开。 */
  const playRound = (run, message, replyOf) => {
    const text = message.replace(/#[a-z_]+/g, '').trim() || message
    if (run.markers.has('#cut')) {
      // 受理之后写响应的事件流被切断（这一轮在服务端继续跑）：客户端应转只读订阅
      // 从最后序号续上，绝不重新提交。
      schedule(run, 500, () => dropTagged(run, 'write'))
    }
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
    const plan = () => { run.taskId = taskId; emit(run, { type: 'plan', taskId, goal: text, note: '', subtasks: [{ id: 's1', goal: '起草并交回两个版本', agentId: 'blog', reason: '博客起草', displayName: '博客' }] }) }
    const delta = (part) => emit(run, { type: 'subtask_delta', taskId, id: 's1', agentId: 'blog', delta: part })
    if (run.markers.has('#trim')) {
      // 事件窗口滚出：早期事件真的离开日志（序号继续单调递增），在场连接一起断开。
      // 真实触发是日志超过上限之后，落后太多的游标续订时落在窗口之外——续订方应拿到
      // reset 并重读快照，而不是半轮事件。这一轮在滚出之后继续跑一段，让「如实提示
      // 可能不完整」和「本轮结束后按权威快照补齐」都能被观察到。
      schedule(run, 200, plan)
      schedule(run, 300, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'running', agentId: 'blog', displayName: '博客', detail: '开始处理' }))
      schedule(run, 450, () => delta('（草稿第 1 段：先列要点）'))
      schedule(run, 600, () => {
        const rolled = 30
        run.windowStart = run.seq + rolled + 1
        run.seq += rolled
        run.events = run.events.filter(event => event.seq >= run.windowStart)
        dropSubscribers(run)
      })
      schedule(run, 1400, () => delta('（草稿第 3 段：窗口滚出后继续写）'))
      schedule(run, 2100, () => delta('（草稿第 4 段：补齐说明）'))
      schedule(run, 2800, () => delta('（草稿第 5 段：收尾）'))
      if (run.markers.has('#done')) {
        schedule(run, 3400, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'succeeded', agentId: 'blog', displayName: '博客', detail: '完成' }))
        schedule(run, 3600, () => finishRun(run, { type: 'summary', taskId, text: '按目标完成。', state: 'completed', error: '' }))
        return
      }
      schedule(run, 3400, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'waiting_user', agentId: 'blog', displayName: '博客', detail: '两个版本你选哪个：A 简版 / B 详版？' }))
      return
    }
    schedule(run, 300, plan)
    schedule(run, 450, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'running', agentId: 'blog', displayName: '博客', detail: '开始处理' }))
    schedule(run, 650, () => delta('（草稿第 1 段：先列要点）'))
    schedule(run, 900, () => emit(run, { type: 'subtask_thinking', taskId, id: 's1', agentId: 'blog', thinking: '两个版本分别面向快速浏览与完整阅读。' }))
    schedule(run, 1150, () => delta('（草稿第 2 段：补齐说明）'))
    if (run.markers.has('#external')) {
      schedule(run, 1400, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'external_pending', agentId: 'blog', displayName: '博客', detail: '候选稿须在博客原对话选择采用', pending: { reason: '候选稿须在博客原对话选择采用', next: '采用之后可以再派一轮' }, artifacts: [{ kind: 'draft', title: '在博客查看并采用候选稿', path: '/blog?conversationId=stub' }], conversationId: 'stub-blog-conversation' }))
      schedule(run, 1600, () => finishRun(run, { type: 'summary', taskId, text: '材料已经交回，还有 1 件事要在外面办完。这一轮到此为止，想继续可以新开一轮。', state: 'external_pending', error: '' }))
      return
    }
    if (run.markers.has('#fail')) {
      schedule(run, 1400, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'failed', agentId: 'blog', displayName: '博客', detail: '没干成：资料不足' }))
      schedule(run, 1600, () => finishRun(run, { type: 'summary', taskId, text: '这一轮没有完成：资料不足。', state: 'failed', error: '资料不足' }))
      return
    }
    schedule(run, 1400, () => emit(run, { type: 'subtask', taskId, id: 's1', state: 'waiting_user', agentId: 'blog', displayName: '博客', detail: '两个版本你选哪个：A 简版 / B 详版？' }))
    // 等待中的轮保持打开：/reply 继续、/stop 取消、#wait_fail 由回复触发失败、#late_* 由竞态收尾。
  }

  /** 受理后的写响应：preamble（/chat 有）+ run 头 + 窗口内重放 + 后续事件 + [DONE]。 */
  const streamWriteResponse = (run, response, preamble) => {
    response.writeHead(200, SSE_HEADERS)
    const sub = subscriberOf(response, 'write')
    if (preamble !== undefined) sub.send(preamble)
    sub.send({ type: 'run', runId: run.runId, state: 'running', taskId: run.taskId, startedAt: run.startedAt, finishedAt: null })
    for (const event of run.events) if (event.seq >= run.windowStart) sub.send(event)
    if (run.state !== 'running') {
      sub.send('[DONE]')
      response.end()
      return
    }
    run.subscribers.add(sub)
  }

  /**
   * 只读订阅动态轮：游标落在窗口左边缘之外时**不补齐**，按契约给一条 `reset` 并结束流
   * （这是「你落后太多、重新取一次快照」的正常信号，不是错误）。窗口内则 run 头 +
   * 重放 after 之后的事件 + 后续事件。
   */
  const streamDynamicEvents = (run, response, after, preamble) => {
    response.writeHead(200, SSE_HEADERS)
    const sub = subscriberOf(response, 'events')
    if (after < run.windowStart - 1) {
      sub.send({ type: 'reset', runId: run.runId, seq: run.seq, windowStart: run.windowStart, reason: '这一轮的早期事件已经滚出窗口，请重新获取任务快照' })
      sub.send('[DONE]')
      response.end()
      return
    }
    if (preamble !== undefined) sub.send(preamble)
    sub.send({ type: 'run', runId: run.runId, state: run.state === 'running' ? 'running' : 'finished', taskId: run.taskId, startedAt: run.startedAt, finishedAt: run.state === 'running' ? null : Date.now() })
    for (const event of run.events) if (event.seq > after && event.seq >= run.windowStart) sub.send(event)
    if (run.state !== 'running') {
      sub.send('[DONE]')
      response.end()
      return
    }
    run.subscribers.add(sub)
  }

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(PREFIX + '/') && url.pathname !== PREFIX) return json(response, 404, { error: 'not found' })
    if (url.pathname === PREFIX + '/identity') {
      if (identityStatus !== 200) return json(response, identityStatus, { error: '请先登录', code: 'unauthorized' })
      return json(response, 200, { mode: 'authenticated', key: 'user:local-verify', label: '已登录（本地桩）', authPath: '/auth', routePrefix: PREFIX, contractVersion: 1 })
    }
    // 桩控制口（仅本地桩）：驱动「另一个入口」与权限撤换，见文件头说明。
    if (url.pathname === PREFIX + '/__fixture' && request.method === 'POST') {
      return handleFixture(await readBody(request), response)
    }
    // 登录失效：撤换之后所有受保护资源一起按 401 响应（identity 之外都不再放行）。
    if (identityStatus !== 200) return json(response, identityStatus, { error: '请先登录', code: 'unauthorized' })
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
          return json(response, 200, { run: { runId: run.runId, state: 'running', taskId: run.taskId, startedAt: run.startedAt, finishedAt: null, seq: run.seq, windowStart: run.windowStart } })
        }
        if (eventsFailure !== null && eventsFailure.remaining > 0 && (eventsFailure.conversationId === '' || eventsFailure.conversationId === conversationId)) {
          // 复现断流后的续订失败（服务端 5xx / 网络断）：客户端应落到断线提示并按有界退避重试。
          eventsFailure.remaining--
          return json(response, eventsFailure.status, { error: '事件流读取失败', code: 'http_error' })
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
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      if (message.trim() === '') return json(response, 400, { error: '消息不能为空', code: 'message_empty' })
      if (!CONVERSATION_PATTERN.test(conversationId)) return json(response, 400, { error: '不是牛马大总管的会话标识', code: 'conversation_invalid' })
      // 幂等：同一个 requestId 的同一份提交只执行一次，再提交回放**首次那一轮**。
      const seen = requestId === '' ? undefined : idempotency.get(requestId)
      if (seen !== undefined) {
        if (seen.message !== message || seen.conversationId !== conversationId) {
          return json(response, 409, { error: '这次提交的 requestId 已经用在另一份内容上，请修改内容后重新提交', code: 'idempotency_conflict' })
        }
        // 那一轮的事件日志已经被下一轮覆盖（或本轮被顶掉）：没有过程可回放，按契约回 409。
        if (!replayable(seen)) return json(response, 409, lostLogBody(seen))
        duplicateSubmits++
        return streamDynamicEvents(seen.run, response, 0, { type: 'conversation', conversationId })
      }
      if (message.includes('#forbidden')) return json(response, 403, { error: '请求来源不受信任', code: 'forbidden' })
      if (message.includes('#run_busy')) return json(response, 409, { error: '牛马大总管正在处理上一条消息，请先停止或等待完成', code: 'run_busy' })
      if (message.includes('#version_conflict')) return json(response, 409, { error: '这一轮已经更新到第 2 版，请按最新内容重新提交', code: 'version_conflict' })
      if (message.includes('#result_unknown')) {
        return json(response, 409, { error: '这次提交的结果不明，不会重新执行', code: 'run_result_unknown', runId: 'butler-run-unknown', conversationId })
      }
      if (message.includes('#network')) {
        const glitchKey = message.trim()
        if (!glitched.has(glitchKey)) {
          // 受理成立（这一轮在服务端跑起来、幂等占位落下），但响应没有送到：结果不明。
          // 客户端只能保留原正文手动重试；同 requestId 再提交由幂等分支回放**同一轮**。
          glitched.add(glitchKey)
          const run = createRun(conversationId, '', message, markers(message))
          if (requestId !== '') idempotency.set(requestId, { run, message, conversationId, kind: 'chat' })
          chatExecutions++
          ensureConversation(conversationId, message.replace(/#[a-z_]+/g, '').trim() || message)
          playRound(run, message, null)
          response.destroy()
          return
        }
      }
      if (message.includes('#hang')) return // 永不回应：受理超时由客户端处理
      // 种子活跃轮或动态运行轮占着这一会话：如实拒绝，不排队。
      if (conversationId === liveConversationId && !liveStopped) return json(response, 409, { error: '牛马大总管正在处理上一条消息，请先停止或等待完成', code: 'run_busy' })
      const existing = runs.get(conversationId)
      if (existing !== undefined && existing.state === 'running') return json(response, 409, { error: '牛马大总管正在处理上一条消息，请先停止或等待完成', code: 'run_busy' })
      const run = createRun(conversationId, '', message, markers(message))
      // 幂等占位在受理之前落下（与管家同序）：受理后同 requestId 再提交不会重跑。
      if (requestId !== '') idempotency.set(requestId, { run, message, conversationId, kind: 'chat' })
      chatExecutions++
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
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : ''
      if (!decideByAgent && text === '') return json(response, 400, { error: '请先写点内容，或者让它自己拿主意', code: 'reply_text_missing' })
      const task = tasks.get(taskId)
      if (task === undefined) return json(response, 404, { error: '任务不存在或无权访问', code: 'task_not_found' })
      const subtask = task.subtasks.find(s => s.id === subtaskId)
      if (subtask === undefined) return json(response, 404, { error: '这个子任务不存在', code: 'subtask_not_found' })
      const seen = requestId === '' ? undefined : idempotency.get(requestId)
      if (seen !== undefined) {
        if (seen.taskId !== taskId || seen.subtaskId !== subtaskId || seen.text !== text || seen.decideByAgent !== decideByAgent) {
          return json(response, 409, { error: '这次提交的 requestId 已经用在另一份内容上，请修改内容后重新提交', code: 'idempotency_conflict' })
        }
        // 同 /chat：那一轮已经不是该会话的当前轮时没有过程可回放，按契约回 409。
        if (!replayable(seen)) return json(response, 409, lostLogBody(seen))
        duplicateSubmits++
        return streamDynamicEvents(seen.run, response, 0)
      }
      /** 受理补话：同任务换执行轮，事件日志被新一轮替换。 */
      const accept = () => {
        if (text.includes('#expired')) return json(response, 409, { error: 'blog 的这次等待已经失效，请重新描述你的目标', code: 'waiting_expired' })
        if (subtask.state !== 'waiting_user') return json(response, 409, { error: '这位成员当前没有在等你回话', code: 'not_waiting' })
        const run = createRun(task.conversationId, taskId, task.goal, markers(text))
        emit(run, { type: 'user', text: decideByAgent ? '（你看着办）' : text })
        if (requestId !== '') idempotency.set(requestId, { run, conversationId: task.conversationId, taskId, subtaskId, text, decideByAgent, kind: 'reply' })
        replyExecutions++
        streamWriteResponse(run, response)
        playRound(run, decideByAgent ? '你看着办' : text, { subtaskId })
      }
      if (text.includes('#late_reply')) {
        // 迟到的回复：另一个入口先把这次等待结束掉，本入口的回复到达时已经不在等待。
        const round = runs.get(task.conversationId)
        if (round !== undefined) {
          schedule(round, 40, () => {
            emit(round, { type: 'subtask', taskId, id: subtaskId, state: 'cancelled', agentId: subtask.agentId, displayName: subtask.displayName, detail: '已按请求停止（另一个入口）' })
            finishRun(round, { type: 'summary', taskId, text: '这一轮已按请求停止。', state: 'cancelled', error: '' })
          })
        }
        setTimeout(accept, 250)
        return
      }
      accept()
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
      if (run.markers.has('#late_stop')) {
        // 迟到的停止：另一个入口先把这一轮停掉了，本入口的请求迟到、只得到幂等空操作。
        setTimeout(() => stopRound(run), 40)
        setTimeout(() => json(response, 200, { ok: true, accepted: false, reason: '这个任务已经不在执行了' }), 250)
        return
      }
      stopRound(run)
      return json(response, 200, { ok: true, accepted: true })
    }
    return json(response, 404, { error: 'not found', code: 'not_found' })
  }

  /** 把一轮按「已按请求停止」收尾（本入口的 /stop 与另一个入口的停止共用同一条路径）。 */
  const stopRound = (run) => {
    if (run.state !== 'running') return
    emit(run, { type: 'subtask', taskId: run.taskId, id: 's1', state: 'cancelled', agentId: 'blog', displayName: '博客', detail: '已按请求停止' })
    finishRun(run, { type: 'summary', taskId: run.taskId, text: '这一轮已按请求停止。', state: 'cancelled', error: '' })
  }

  /** 另一个入口在会话上动作：停止（在场观察者跟着同一份终态）或回复（同任务换执行轮）。 */
  const otherEntry = (conversationId, action) => {
    const run = runs.get(conversationId)
    if (run === undefined || run.state !== 'running') return { ok: false, reason: '现在没有正在执行的一轮' }
    if (action === 'stop') { stopRound(run); return { ok: true, runId: run.runId, state: run.state } }
    if (action === 'reply') {
      const task = tasks.get(run.taskId)
      const waiting = task?.subtasks.find(subtask => subtask.state === 'waiting_user')
      if (waiting === undefined) return { ok: false, reason: '这个会话没有在等回话的成员' }
      const next = createRun(conversationId, run.taskId, run.goal)
      emit(next, { type: 'user', text: '（另一个入口）就按第二版来' })
      playRound(next, '就按第二版来', { subtaskId: waiting.id })
      return { ok: true, runId: next.runId }
    }
    return { ok: false, reason: '不认识的另一个入口动作：' + action }
  }

  /**
   * 断开会话上在场的只读观察者，并让下一次续订失败一次：复现真实断流
   * （连接被回收 + 重连时服务端 5xx），客户端据此给出断线提示与重试入口。
   */
  const breakEvents = (conversationId) => {
    const run = runs.get(conversationId)
    if (run === undefined) return { ok: false, reason: '这个会话没有动态轮' }
    const dropped = [...run.subscribers].filter(sub => sub.tag === 'events').length
    dropTagged(run, 'events')
    // 只有真的断掉了观察连接，才让下一次续订失败：否则会把「还没订阅」也变成一次失败。
    if (dropped > 0) eventsFailure = { conversationId, status: 500, remaining: 1 }
    return { ok: true, dropped, runId: run.runId }
  }

  /**
   * 桩控制口（仅本地桩，真实管家没有这个入口）：给验收脚本驱动「另一个入口」、断流与权限撤换。
   *   { "identity": 401|200 }                                 → 撤换/恢复登录身份
   *   { "otherEntry": "stop"|"reply", "conversationId": "…" }  → 另一个入口在该会话上动作
   *   { "action": "breakEvents", … }                           → 断开观察连接并让下次续订失败一次
   *   { "conversationIndex": 0|1 }                             → 用种子会话下标代替 conversationId
   *   { "query": "stats" }                                     → 读执行/幂等计数
   */
  const handleFixture = (payload, response) => {
    if (payload.query === 'stats') {
      return json(response, 200, { ok: true, chatExecutions, replyExecutions, duplicateSubmits })
    }
    if (typeof payload.identity === 'number') {
      identityStatus = payload.identity
      return json(response, 200, { ok: true, identity: identityStatus })
    }
    const indexed = typeof payload.conversationIndex === 'number' ? conversations[payload.conversationIndex]?.id ?? '' : ''
    const conversationId = typeof payload.conversationId === 'string' && payload.conversationId !== '' ? payload.conversationId : indexed
    if (payload.action === 'breakEvents') return json(response, 200, breakEvents(conversationId))
    if (payload.otherEntry === undefined) return json(response, 400, { ok: false, reason: '缺少 action' })
    return json(response, 200, otherEntry(conversationId, payload.otherEntry))
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
