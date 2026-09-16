import { describe, expect, it } from 'vitest'
import { applyEvent, applySnapshot, emptyTaskView, taskStateLabel } from '../src/task-projection.ts'

const snapshot = {
  id: 'butler-task-1',
  conversationId: 'butler-web-1',
  goal: '写一篇园区安全博客',
  state: 'running' as const,
  summary: '',
  error: '',
  finishedAt: null,
  subtasks: [
    { id: 's1', goal: '起草', state: 'running', agentId: 'blog', displayName: '博客', result: '草稿写到一半' },
    { id: 's2', goal: '配图说明', state: 'queued' },
  ],
}

describe('任务投影：快照基准', () => {
  it('快照整体替换投影并保留事件期累积的正文与思考', () => {
    // 等回话的子任务交回材料（result 落库）；回话后继续执行，状态迁移解除权威标记。
    let view = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'waiting_user' }] })
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', id: 's1', state: 'running', detail: '继续执行' })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', id: 's1', delta: '，又补了一段' })
    view = applyEvent(view, { type: 'subtask_thinking', taskId: 'butler-task-1', id: 's1', thinking: '想一下结构' })
    // 运行中的快照没有 result：事件期累积的正文与思考保留。
    view = applySnapshot(view, { ...snapshot, subtasks: [{ ...snapshot.subtasks[0], state: 'running', result: undefined }] })
    expect(view.taskId).toBe('butler-task-1')
    expect(view.subtasks[0].text).toBe('草稿写到一半，又补了一段')
    expect(view.subtasks[0].thinking).toBe('想一下结构')
    // 快照给了 result 时以权威为准：正文基准换成落库正文。
    view = applySnapshot(view, snapshot)
    expect(view.subtasks[0].text).toBe('草稿写到一半')
    expect(view.subtasks[0].base).toBe('草稿写到一半')
  })

  it('快照带回终态与汇总', () => {
    const view = applySnapshot(emptyTaskView(), { ...snapshot, state: 'external_pending', summary: '候选稿须在博客原对话选择采用' })
    expect(view.state).toBe('external_pending')
    expect(view.summary).toContain('选择采用')
  })
})

describe('任务投影：事件语义', () => {
  it('run 头部记录轮次状态与任务 id（计划前 taskId 为空）', () => {
    let view = emptyTaskView('c1')
    view = applyEvent(view, { type: 'run', runId: 'r1', state: 'running', taskId: '' })
    expect(view.runState).toBe('running')
    expect(view.taskId).toBe('')
    view = applyEvent(view, { type: 'run', runId: 'r1', state: 'idle' })
    expect(view.runState).toBe('idle')
  })

  it('plan 建立子任务列表，subtask 迁移状态并记录等待原因', () => {
    let view = emptyTaskView('c1')
    view = applyEvent(view, { type: 'plan', taskId: 't1', goal: '改简历', subtasks: [
      { id: 's1', goal: '改写', agentId: 'blog', displayName: '博客' },
      { id: 's2', goal: '校对', agentId: 'example' },
    ] })
    expect(view.taskId).toBe('t1')
    expect(view.subtasks.map(s => [s.id, s.state])).toEqual([['s1', 'queued'], ['s2', 'queued']])
    view = applyEvent(view, { type: 'subtask', taskId: 't1', id: 's1', state: 'waiting_user', detail: '要不要加项目经历？' })
    expect(view.subtasks[0].state).toBe('waiting_user')
    expect(view.subtasks[0].note).toBe('要不要加项目经历？')
    view = applyEvent(view, { type: 'subtask', taskId: 't1', id: 's1', state: 'external_pending', pending: { reason: '候选稿须在博客原对话选择采用' } })
    expect(view.subtasks[0].pending?.reason).toContain('选择采用')
  })

  it('增量追加、落定替换、思考覆盖，三者不弄反', () => {
    // 事件带的 taskId 必须与快照一致：换了 taskId 就是换任务，旧子任务正文不作数。
    let view = applySnapshot(emptyTaskView(), { ...snapshot, subtasks: [{ ...snapshot.subtasks[0], result: undefined }] })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', id: 's1', delta: 'A' })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', id: 's1', delta: 'B' })
    expect(view.subtasks[0].text).toBe('AB')
    view = applyEvent(view, { type: 'subtask_thinking', taskId: 'butler-task-1', id: 's1', thinking: '第一版' })
    view = applyEvent(view, { type: 'subtask_thinking', taskId: 'butler-task-1', id: 's1', thinking: '第二版' })
    expect(view.subtasks[0].thinking).toBe('第二版')
    view = applyEvent(view, { type: 'chat', role: 'butler', text: '先看草稿' })
    view = applyEvent(view, { type: 'chat_delta', text: '……' })
    expect(view.butlerText).toBe('先看草稿……')
  })

  it('大总管的思考快照是覆盖语义，正文落定后标记结束', () => {
    let view = emptyTaskView('c1')
    view = applyEvent(view, { type: 'chat_thinking', role: 'butler', thinking: '先看通行记录。\n正在生成…' })
    expect(view.butlerThinking).toBe('先看通行记录。\n正在生成…')
    expect(view.butlerThinkingDone).toBe(false)
    // 覆盖而不是追加：第二段快照整段替换。
    view = applyEvent(view, { type: 'chat_thinking', role: 'butler', thinking: '先看通行记录。\n再核对危化车。' })
    expect(view.butlerThinking).toBe('先看通行记录。\n再核对危化车。')
    // 正文落定 = 这一轮说完了：思考保留可展开，但不再标「还在想」。
    view = applyEvent(view, { type: 'chat', role: 'butler', text: '今天 12 辆车入园。' })
    expect(view.butlerText).toBe('今天 12 辆车入园。')
    expect(view.butlerThinkingDone).toBe(true)
  })

  it('换执行轮时上一轮的思考不续到这一轮', () => {
    let view = emptyTaskView('c1')
    view = applyEvent(view, { type: 'run', runId: 'r1', state: 'running', taskId: 'butler-task-1' })
    view = applyEvent(view, { type: 'chat_thinking', role: 'butler', thinking: '第一轮的思路' })
    view = applyEvent(view, { type: 'chat', role: 'butler', text: '第一轮的结论' })
    expect(view.butlerThinkingDone).toBe(true)
    view = applyEvent(view, { type: 'run', runId: 'r2', state: 'running', taskId: 'butler-task-1' })
    expect(view.butlerThinking).toBe('')
    expect(view.butlerThinkingDone).toBe(false)
  })

  it('summary 落终态；error 只记录不推算', () => {
    let view = applySnapshot(emptyTaskView(), snapshot)
    view = applyEvent(view, { type: 'summary', taskId: 'butler-task-1', text: '完成', state: 'completed' })
    expect(view.state).toBe('completed')
    expect(view.summary).toBe('完成')
    view = applyEvent(view, { type: 'error', message: '网络抖动' })
    expect(view.error).toBe('网络抖动')
    expect(view.state).toBe('completed')
  })

  it('不认识的事件类型原样返回', () => {
    const view = applySnapshot(emptyTaskView(), snapshot)
    expect(applyEvent(view, { type: 'user', text: '你好' })).toBe(view)
  })

  it('展示映射覆盖契约状态', () => {
    expect(taskStateLabel('external_pending')).toBe('待外部处理')
    expect(taskStateLabel('waiting_user')).toBe('等你回话')
    expect(taskStateLabel('')).toBe('尚未生成任务')
    expect(taskStateLabel('weird')).toBe('weird')
  })

  it('换任务时旧终态、汇总与同号子任务正文全部作废', () => {
    // 旧任务收到终态与新子任务正文。
    let view = applySnapshot(emptyTaskView(), snapshot)
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', id: 's1', delta: '写完了' })
    view = applyEvent(view, { type: 'summary', taskId: 'butler-task-1', text: '完成', state: 'completed' })
    view = applyEvent(view, { type: 'chat', role: 'butler', text: '这一轮收尾' })
    // 新一轮计划：taskId 不同，管家子任务编号同样从 s1 重新计数。
    view = applyEvent(view, { type: 'plan', taskId: 'butler-task-2', goal: '新目标', subtasks: [
      { id: 's1', goal: '新第一步', agentId: 'blog', displayName: '博客' },
    ] })
    expect(view.taskId).toBe('butler-task-2')
    expect(view.state).toBe('running')
    expect(view.summary).toBe('')
    expect(view.butlerText).toBe('')
    expect(view.subtasks).toHaveLength(1)
    expect(view.subtasks[0].text).toBe('')
    expect(view.subtasks[0].goal).toBe('新第一步')
  })

  it('同任务换执行轮：保留权威快照与子任务，只作废轮内发言与错误', () => {
    // 权威快照已有 s1、s2（管家回复轮沿用 taskId 生成新 runId）。
    let view = applySnapshot(emptyTaskView(), snapshot)
    view = applyEvent(view, { type: 'chat', role: 'butler', text: '上一轮发言' })
    view = applyEvent(view, { type: 'run', runId: 'run-1', state: 'finished', taskId: 'butler-task-1' })
    // 新执行轮：taskId 不变，只清轮内字段。
    view = applyEvent(view, { type: 'run', runId: 'run-2', state: 'running', taskId: 'butler-task-1' })
    expect(view.lastRunId).toBe('run-2')
    expect(view.taskId).toBe('butler-task-1')
    expect(view.butlerText).toBe('')
    expect(view.subtasks.map(s => s.id)).toEqual(['s1', 's2'])
    // 新轮的追加计划只带新增 s3：按 id 合并，快照的 s1/s2 不丢（F3 复现路径）。
    view = applyEvent(view, { type: 'plan', taskId: 'butler-task-1', subtasks: [
      { id: 's3', goal: '新增步骤', agentId: 'example', displayName: 'example' },
    ] })
    expect(view.subtasks.map(s => s.id)).toEqual(['s1', 's2', 's3'])
    expect(view.subtasks[0].state).toBe('running')
  })

  it('换轮到新任务（taskId 变化）才整体重置投影', () => {
    let view = applySnapshot(emptyTaskView(), snapshot)
    view = applyEvent(view, { type: 'summary', taskId: 'butler-task-1', text: '旧轮结束', state: 'completed' })
    view = applyEvent(view, { type: 'chat', role: 'butler', text: '旧任务发言' })
    // 新任务的 run 头：整体作废，等新计划的子任务从零开始。
    view = applyEvent(view, { type: 'run', runId: 'run-2', state: 'running', taskId: 'butler-task-2' })
    expect(view.taskId).toBe('butler-task-2')
    expect(view.state).toBe('')
    expect(view.summary).toBe('')
    expect(view.butlerText).toBe('')
    expect(view.subtasks).toHaveLength(0)
  })

  it('恢复重放真实历史（含 plan/running）：已落库正文不重复计入', () => {
    // 页面刷新重进：s1 已在同一轮里跑完并落库（result=AB），s2 还在执行。重放顺序是
    // 真实的 run → plan → s1 running → delta A → delta B → s1 succeeded。
    let view = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'succeeded', result: 'AB' }] },
      Date.now(), { runId: 'run-1', seq: 5 })
    view = applyEvent(view, { type: 'run', runId: 'run-1', state: 'running', taskId: 'butler-task-1' })
    view = applyEvent(view, { type: 'plan', taskId: 'butler-task-1', runId: 'run-1', seq: 1, subtasks: [
      { id: 's1', goal: '起草', agentId: 'blog', displayName: '博客' },
    ] })
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', runId: 'run-1', id: 's1', state: 'running', seq: 2 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'A', seq: 3 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'B', seq: 4 })
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', runId: 'run-1', id: 's1', state: 'succeeded', seq: 5 })
    expect(view.subtasks[0].text).toBe('AB')
    expect(view.subtasks[0].coverage).toEqual({ runId: 'run-1', boundary: 5, through: 5 })
    // 边界之后的增量属于恢复后的新事件，照常累积。
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'C', seq: 6 })
    expect(view.subtasks[0].text).toBe('ABC')
  })

  it('回复轮已 running 且保留上一轮 result：新增正文不被吞掉', () => {
    // prepareReply 先把子任务置为 running，落库用 COALESCE，上一轮的 AB 仍在快照里。
    // 重放新轮的 running 事件没有状态变化，新增的 C 必须计入。
    let view = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'running', result: 'AB' }] },
      Date.now(), { runId: 'run-2', seq: 2 })
    expect(view.subtasks[0].text).toBe('AB')
    expect(view.subtasks[0].coverage.through).toBe(-1)
    view = applyEvent(view, { type: 'run', runId: 'run-2', state: 'running', taskId: 'butler-task-1' })
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', runId: 'run-2', id: 's1', state: 'running', seq: 1 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-2', id: 's1', delta: 'C', seq: 2 })
    expect(view.subtasks[0].text).toBe('ABC')
  })

  it('轮内再次活跃：覆盖边界推进到落库迁移处，新尝试的增量继续累积', () => {
    // 恢复时快照已是 running（第二次尝试），基准正文是上一轮的 AB；重放先给出第一次
    // 尝试的历史增量与 succeeded，再给出第二次尝试的增量。
    let view = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'running', result: 'AB' }] },
      Date.now(), { runId: 'run-1', seq: 5 })
    view = applyEvent(view, { type: 'plan', taskId: 'butler-task-1', runId: 'run-1', seq: 1, subtasks: [
      { id: 's1', goal: '起草', agentId: 'blog', displayName: '博客' },
    ] })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'A', seq: 2 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'B', seq: 3 })
    // 覆盖边界还没推进：历史增量先按普通增量显示。
    expect(view.subtasks[0].text).toBe('ABAB')
    // 落库迁移到达（序号在恢复边界以内）：基准正文覆盖到它，历史增量退出正文。
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', runId: 'run-1', id: 's1', state: 'succeeded', seq: 4 })
    expect(view.subtasks[0].text).toBe('AB')
    expect(view.subtasks[0].coverage.through).toBe(4)
    // 再次活跃后的新尝试在边界之后：增量继续累积。
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', runId: 'run-1', id: 's1', state: 'running', seq: 5 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'C', seq: 6 })
    expect(view.subtasks[0].text).toBe('ABC')
  })

  it('无法证明的落库形态：保留增量并标记可能重复，不按文本相似删字', () => {
    // waiting_user 既可能是结果落库（applyMemberResult），也可能只是进度上报（2142 行只改
    // 状态）。事件载荷分不出来，所以不能用「增量等于/前缀匹配基准正文」推断因果：
    // 新内容完全可能恰好与旧正文相同或同前缀，这里旧正文 AB、本轮新增 A。
    let view = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'waiting_user', result: 'AB' }] },
      Date.now(), { runId: 'run-1', seq: 5 })
    view = applyEvent(view, { type: 'plan', taskId: 'butler-task-1', runId: 'run-1', seq: 1, subtasks: [
      { id: 's1', goal: '起草', agentId: 'blog', displayName: '博客' },
    ] })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'A', seq: 2 })
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', runId: 'run-1', id: 's1', state: 'waiting_user', seq: 3 })
    expect(view.subtasks[0].text).toBe('ABA')
    expect(view.subtasks[0].uncertain).toBe(true)
    expect(view.subtasks[0].coverage.through).toBe(-1)
    // 增量与旧正文完全相同时也一样：保留（可能重复），不当作已落库证据。
    let same = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'failed', result: 'AB' }] },
      Date.now(), { runId: 'run-2', seq: 3 })
    same = applyEvent(same, { type: 'run', runId: 'run-2', state: 'running', taskId: 'butler-task-1' })
    same = applyEvent(same, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-2', id: 's1', delta: 'AB', seq: 1 })
    same = applyEvent(same, { type: 'subtask', taskId: 'butler-task-1', runId: 'run-2', id: 's1', state: 'failed', seq: 2 })
    expect(same.subtasks[0].text).toBe('ABAB')
    expect(same.subtasks[0].uncertain).toBe(true)
  })

  it('可证明的落库形态（succeeded/external_pending）才推进覆盖边界', () => {
    // 同样的重放：succeeded 一定写了正文，因此历史增量退出正文，正文保持 AB。
    let view = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'succeeded', result: 'AB' }] },
      Date.now(), { runId: 'run-1', seq: 3 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'A', seq: 1 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'B', seq: 2 })
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', runId: 'run-1', id: 's1', state: 'succeeded', seq: 3 })
    expect(view.subtasks[0].text).toBe('AB')
    expect(view.subtasks[0].uncertain).toBe(false)
    expect(view.subtasks[0].coverage.through).toBe(3)
  })

  it('事件窗口滚出：incomplete 置位；只有能证明属于本轮的结果才补齐', () => {
    let view = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'running', result: undefined }] },
      Date.now(), { runId: 'run-1', seq: 4, truncated: true })
    expect(view.incomplete).toBe(true)
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'BC', seq: 4 })
    expect(view.subtasks[0].text).toBe('BC')
    // 本轮结束，但快照只留下上一轮的旧 result（普通失败/取消）：片段保留、提示保留。
    const stale = applySnapshot(view, { ...snapshot, subtasks: [{ ...snapshot.subtasks[0], state: 'failed', result: 'AB' }] },
      Date.now(), { runId: 'run-1', seq: 4, final: true })
    expect(stale.subtasks[0].text).toBe('ABBC')
    expect(stale.incomplete).toBe(true)
    // 换成本轮真正落库的 succeeded：正文替换为权威值，提示清除。
    view = applySnapshot(view, { ...snapshot, subtasks: [{ ...snapshot.subtasks[0], state: 'succeeded', result: 'ABC' }] },
      Date.now(), { runId: 'run-1', seq: 4, final: true })
    expect(view.incomplete).toBe(false)
    expect(view.subtasks[0].text).toBe('ABC')
    // 还有其它子任务没有正文来源时，同样不敢清除提示。
    const partial = applySnapshot(view, { ...snapshot, subtasks: [
      { ...snapshot.subtasks[0], state: 'succeeded', result: 'ABC' },
      { id: 's2', goal: '配图说明', state: 'queued' },
    ] }, Date.now(), { runId: 'run-1', seq: 4, final: true })
    expect(partial.incomplete).toBe(false)
  })

  it('全部正文滚出且补取仍为空：不完整提示继续保留', () => {
    // 正文全部随窗口滚出、快照也没有 result：界面显示为空，但「空」不是
    // 「本来没有产生过正文」的证据。
    let view = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'running', result: undefined }] },
      Date.now(), { runId: 'run-1', seq: 4, truncated: true })
    expect(view.subtasks[0].text).toBe('')
    expect(view.incomplete).toBe(true)
    // 普通失败后的补取：快照仍只有 error、没有 result，提示不能被清掉。
    const failed = applySnapshot(view, { ...snapshot, state: 'failed',
      subtasks: [{ ...snapshot.subtasks[0], state: 'failed', result: undefined }] },
      Date.now(), { runId: 'run-1', seq: 4, final: true })
    expect(failed.subtasks[0].text).toBe('')
    expect(failed.incomplete).toBe(true)
    // 取消同理。
    const cancelled = applySnapshot(view, { ...snapshot, state: 'cancelled',
      subtasks: [{ ...snapshot.subtasks[0], state: 'cancelled', result: undefined }] },
      Date.now(), { runId: 'run-1', seq: 4, final: true })
    expect(cancelled.incomplete).toBe(true)
    // 从未派发的子任务确实没有正文，不算缺口：全为 queued 时才允许清提示。
    const untouched = applySnapshot(emptyTaskView('butler-web-1'), { ...snapshot,
      subtasks: [{ ...snapshot.subtasks[0], state: 'queued', result: undefined }] },
      Date.now(), { runId: 'run-1', seq: 4, truncated: true })
    const done = applySnapshot(untouched, { ...snapshot, state: 'completed',
      subtasks: [{ ...snapshot.subtasks[0], state: 'queued', result: undefined }] },
      Date.now(), { runId: 'run-1', seq: 4, final: true })
    expect(done.incomplete).toBe(false)
  })

  it('换执行轮后覆盖边界重新锚定，新轮增量从头计入', () => {
    // 上一轮的正文（含未落库的增量）保留为基准，但序号从 1 重新计数，旧边界不沿用。
    let view = applySnapshot(emptyTaskView(), { ...snapshot, subtasks: [{ ...snapshot.subtasks[0], result: undefined }] },
      Date.now(), { runId: 'run-1', seq: 1 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-1', id: 's1', delta: 'A', seq: 2 })
    expect(view.subtasks[0].text).toBe('A')
    view = applyEvent(view, { type: 'run', runId: 'run-2', state: 'running', taskId: 'butler-task-1' })
    expect(view.subtasks[0].coverage).toEqual({ runId: 'run-2', boundary: -1, through: -1 })
    expect(view.subtasks[0].base).toBe('A')
    view = applySnapshot(view, { ...snapshot, subtasks: [{ ...snapshot.subtasks[0], result: undefined }] },
      Date.now(), { runId: 'run-2', seq: 2 })
    view = applyEvent(view, { type: 'subtask_delta', taskId: 'butler-task-1', runId: 'run-2', id: 's1', delta: 'B', seq: 1 })
    expect(view.subtasks[0].text).toBe('AB')
  })

  it('同一任务的追加计划按 id 合并，保留已有子任务与状态', () => {
    let view = applySnapshot(emptyTaskView(), snapshot)
    view = applyEvent(view, { type: 'subtask', taskId: 'butler-task-1', id: 's1', state: 'succeeded', detail: '已交回' })
    // 补充产生的追加计划只带新增条目 s2。
    view = applyEvent(view, { type: 'plan', taskId: 'butler-task-1', subtasks: [
      { id: 's2', goal: '新追加', agentId: 'example', displayName: 'example' },
    ] })
    expect(view.subtasks.map(s => [s.id, s.state])).toEqual([['s1', 'succeeded'], ['s2', 'queued']])
    expect(view.subtasks[0].note).toBe('已交回')
  })

  it('换任务后的快照不再沿用旧任务的管家发言与累积正文', () => {
    let view = applySnapshot(emptyTaskView(), snapshot)
    view = applyEvent(view, { type: 'chat', role: 'butler', text: '旧任务发言' })
    view = applySnapshot(view, { ...snapshot, id: 'butler-task-2', subtasks: [{ id: 's1', goal: '起草', state: 'running' }] })
    expect(view.butlerText).toBe('')
    expect(view.subtasks[0].text).toBe('')
  })
})
