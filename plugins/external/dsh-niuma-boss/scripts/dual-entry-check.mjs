/**
 * 「第二入口同轮」直驱验证（不进入发布包）：复用 local-verify 的服务（真实构建产物
 * dist/index.mjs 的 apply() + 同站管家桩），用 node 直接按契约 v1 驱动 HTTP/SSE，
 * 固化评审手工复现的 9 步：
 *   1. POST /chat 受理（SSE 响应 + run 头）
 *   2. plan 事件给出 taskId
 *   3. probe 返回同一 runId / taskId，state=running
 *   4. 只读订阅从 0 重放同轮事件（第二入口视角）
 *   5. POST /reply 受理并继续执行（同任务换执行轮）
 *   6. reply 流内 summary completed + [DONE] 收尾
 *   7. /task 快照：任务 completed、子任务 succeeded
 *   8. 终态后 probe 返回 null（没有在跑的一轮）
 *   9. /history 补读：第二入口看到同一任务已完成
 * 逐步输出 PASS/FAIL，任何一步失败以非零码退出。
 *
 * 用法：先 pnpm build，再 node scripts/dual-entry-check.mjs（不修改 local-verify.mjs，
 * 只导入其 startVerifyServer，既有行为不受影响）。
 */
import assert from 'node:assert/strict'
import { startVerifyServer } from './local-verify.mjs'

const STEP_TIMEOUT_MS = 20_000
const MESSAGE = '整理一份双入口验证清单'
const REPLY_TEXT = '采用第二版'

const fixture = await startVerifyServer()
const origin = fixture.origin
const conversationId = 'butler-web-' + crypto.randomUUID()

/**
 * 读一条 SSE 响应：解析 data: 行，收到 [DONE] 或满足 stop 条件时提前结束并断开。
 * 超时按取消连接处理——随后断言会以缺事件失败，不悬挂。
 */
async function readEvents(response, stop = () => false, timeoutMs = STEP_TIMEOUT_MS) {
  const events = []
  let buffer = ''
  let settled = false
  const timer = setTimeout(() => { if (!settled) void response.body?.cancel().catch(() => {}) }, timeoutMs)
  try {
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data: ')) continue
        const payload = line.slice('data: '.length)
        if (payload === '[DONE]') { events.push('[DONE]'); settled = true; return events }
        const event = JSON.parse(payload)
        events.push(event)
        if (stop(event)) { settled = true; return events }
      }
    }
    return events
  } finally {
    clearTimeout(timer)
    // 提前退出或自然结束后都断开连接：等待中的轮保持打开，读端负责收摊。
    await response.body?.cancel().catch(() => {})
  }
}

const postJson = (path, body) => fetch(origin + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const steps = []
const step = (name, run) => steps.push({ name, run })

let runId = ''
let taskId = ''
let chatEvents = []
let replyEvents = []

step('chat 受理：SSE 响应与 run 头（runId）', async () => {
  const response = await postJson('/butler/chat', { conversationId, message: MESSAGE, requestId: 'dual-entry-chat-1' })
  assert.equal(response.status, 200, 'chat 未被受理：' + response.status)
  assert.ok((response.headers.get('content-type') ?? '').includes('text/event-stream'), 'chat 响应不是事件流')
  // 读到等待回话即止：这一轮在服务端继续留着（等待用户），连接由读端断开。
  chatEvents = await readEvents(response, event => event.type === 'subtask' && event.state === 'waiting_user')
  const runHead = chatEvents.find(event => event.type === 'run')
  assert.ok(runHead, '没有收到 run 头')
  assert.equal(runHead.state, 'running')
  runId = runHead.runId ?? ''
  assert.ok(runId !== '', 'run 头缺少 runId')
})

step('plan 事件给出 taskId', async () => {
  const plan = chatEvents.find(event => event.type === 'plan')
  assert.ok(plan, '这一轮没有出现 plan')
  taskId = plan.taskId ?? ''
  assert.ok(taskId !== '', 'plan 缺少 taskId')
})

step('probe：同 runId、同 taskId、state=running', async () => {
  const response = await fetch(origin + '/butler/events?conversationId=' + conversationId + '&probe=1')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.run?.runId, runId, 'probe 不是同一轮：' + String(body.run?.runId))
  assert.equal(body.run?.taskId, taskId, 'probe 的 taskId 与 plan 不一致')
  assert.equal(body.run?.state, 'running')
})

step('只读订阅重放：第二入口从 0 收到同轮事件', async () => {
  const response = await fetch(origin + '/butler/events?conversationId=' + conversationId + '&after=0')
  assert.equal(response.status, 200)
  const replay = await readEvents(response, event => event.type === 'subtask' && event.state === 'waiting_user')
  const head = replay.find(event => event.type === 'run')
  assert.equal(head?.runId, runId, '重放的头不是同一轮')
  assert.equal(replay.find(event => event.type === 'plan')?.taskId, taskId, '重放缺 plan')
  assert.ok(replay.some(event => event.type === 'user' && event.text === MESSAGE), '重放缺 user 消息')
  assert.ok(replay.some(event => event.type === 'subtask' && event.state === 'waiting_user'), '重放没有推进到等待回话')
})

step('reply 受理并继续执行（同任务换执行轮）', async () => {
  const response = await postJson('/butler/reply', { taskId, subtaskId: 's1', text: REPLY_TEXT, requestId: 'dual-entry-reply-1' })
  assert.equal(response.status, 200, 'reply 未被受理：' + response.status)
  replyEvents = await readEvents(response) // 读到 [DONE] 自然收尾
  const head = replyEvents.find(event => event !== '[DONE]' && event.type === 'run')
  assert.ok(head, 'reply 没有收到 run 头')
  assert.notEqual(head.runId, runId, '回复应是同任务的新执行轮')
  assert.equal(head.taskId, taskId)
})

step('reply 流内 summary completed + [DONE] 收尾', async () => {
  const doneAt = replyEvents.indexOf('[DONE]')
  assert.ok(doneAt > 0, 'reply 流没有 [DONE]')
  const summary = replyEvents.slice(0, doneAt).find(event => event !== '[DONE]' && event.type === 'summary')
  assert.ok(summary, 'reply 流没有 summary')
  assert.equal(summary.taskId, taskId)
  assert.equal(summary.state, 'completed')
})

step('快照：任务 completed、子任务 succeeded、正文含回复轮定稿', async () => {
  const response = await fetch(origin + '/butler/task?id=' + encodeURIComponent(taskId))
  assert.equal(response.status, 200)
  const snapshot = await response.json()
  assert.equal(snapshot.id, taskId)
  assert.equal(snapshot.state, 'completed')
  assert.equal(snapshot.subtasks[0]?.state, 'succeeded')
  assert.ok((snapshot.subtasks[0]?.result ?? '').includes('（按你的选择定稿）'), '快照正文缺回复轮增量')
})

step('终态后 probe 返回 null（没有在跑的一轮）', async () => {
  const response = await fetch(origin + '/butler/events?conversationId=' + conversationId + '&probe=1')
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.run, null, '终态后 probe 仍报告运行中：' + JSON.stringify(body.run))
})

step('history 补读：第二入口看到同一任务已完成', async () => {
  const response = await fetch(origin + '/butler/history?conversationId=' + conversationId)
  assert.equal(response.status, 200)
  const body = await response.json()
  const item = body.items.find(entry => entry.id === taskId)
  assert.ok(item, '历史里没有这个任务')
  assert.equal(item.state, 'completed')
  assert.equal(item.subtaskDone, 1)
})

let failed = 0
for (const [index, entry] of steps.entries()) {
  try {
    await entry.run()
    console.log(`[${index + 1}/${steps.length}] PASS ${entry.name}`)
  } catch (error) {
    failed++
    console.log(`[${index + 1}/${steps.length}] FAIL ${entry.name} — ${error instanceof Error ? error.message : String(error)}`)
  }
}
await fixture.close()
console.log(failed === 0 ? `dual-entry-check：全部 ${steps.length} 步通过` : `dual-entry-check：${failed}/${steps.length} 步失败`)
process.exit(failed === 0 ? 0 : 1)
