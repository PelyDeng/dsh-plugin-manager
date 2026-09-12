/**
 * 任务状态机测试。
 *
 * 这一层决定了页面能显示什么状态，所以重点验证：结束态不可再迁移、非法迁移被拒绝、
 * 相同状态幂等。状态名与设计文档第 4 节必须一致。
 */
import { describe, expect, it } from 'vitest'
import {
  assertSubtaskTransition,
  assertTaskTransition,
  canTransitionSubtask,
  canTransitionTask,
  isTerminal,
  StateTransitionError,
  type SubtaskState,
  type TaskState,
} from '../src/task-model.ts'

const SUBTASK_STATES: SubtaskState[] = ['queued', 'dispatched', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled']
const TASK_STATES: TaskState[] = ['queued', 'running', 'waiting_user', 'summarizing', 'completed', 'failed', 'cancelled']

describe('子任务状态机', () => {
  it('覆盖设计文档里的全部状态', () => {
    expect(SUBTASK_STATES).toEqual(['queued', 'dispatched', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled'])
  })

  it('允许一次正常执行从排队走到成功', () => {
    expect(canTransitionSubtask('queued', 'dispatched')).toBe(true)
    expect(canTransitionSubtask('dispatched', 'running')).toBe(true)
    expect(canTransitionSubtask('running', 'succeeded')).toBe(true)
  })

  it('允许跳过 running：executor 可能直接给出结果，没有中间进度', () => {
    expect(canTransitionSubtask('dispatched', 'succeeded')).toBe(true)
  })

  it('等待用户之后可以继续执行，也可以被取消', () => {
    expect(canTransitionSubtask('waiting_user', 'running')).toBe(true)
    expect(canTransitionSubtask('waiting_user', 'cancelled')).toBe(true)
  })

  it('结束态之间不能互相迁移', () => {
    for (const from of ['succeeded', 'failed', 'cancelled'] as SubtaskState[]) {
      for (const to of SUBTASK_STATES) {
        expect(canTransitionSubtask(from, to)).toBe(from === to)
      }
    }
  })

  it('不能从排队直接跳到成功，避免跳过真实派发', () => {
    expect(canTransitionSubtask('queued', 'succeeded')).toBe(false)
  })

  it('相同状态幂等，重复事件不会报错', () => {
    for (const state of SUBTASK_STATES) expect(canTransitionSubtask(state, state)).toBe(true)
  })

  it('非法迁移抛出带双方状态的错误', () => {
    expect(() => assertSubtaskTransition('succeeded', 'running')).toThrow(StateTransitionError)
    try {
      assertSubtaskTransition('succeeded', 'running')
    } catch (error) {
      expect((error as StateTransitionError).subject).toBe('subtask')
      expect((error as StateTransitionError).from).toBe('succeeded')
      expect((error as StateTransitionError).to).toBe('running')
      expect((error as StateTransitionError).code).toBe('BUTLER_STATE_TRANSITION')
    }
  })
})

describe('任务状态机', () => {
  it('允许从执行中进入汇总，再完成', () => {
    expect(canTransitionTask('running', 'summarizing')).toBe(true)
    expect(canTransitionTask('summarizing', 'completed')).toBe(true)
  })

  it('允许没有子任务时直接完成', () => {
    expect(canTransitionTask('running', 'completed')).toBe(true)
  })

  it('用户可以停止执行中或等待中的任务', () => {
    expect(canTransitionTask('running', 'cancelled')).toBe(true)
    expect(canTransitionTask('waiting_user', 'cancelled')).toBe(true)
    expect(canTransitionTask('summarizing', 'cancelled')).toBe(true)
  })

  it('结束态之间不能互相迁移', () => {
    for (const from of ['completed', 'failed', 'cancelled'] as TaskState[]) {
      for (const to of TASK_STATES) expect(canTransitionTask(from, to)).toBe(from === to)
    }
  })

  it('不能从排队直接完成', () => {
    expect(canTransitionTask('queued', 'completed')).toBe(false)
  })

  it('相同状态幂等', () => {
    for (const state of TASK_STATES) expect(canTransitionTask(state, state)).toBe(true)
  })

  it('非法任务迁移抛出错误', () => {
    expect(() => assertTaskTransition('completed', 'running')).toThrow(StateTransitionError)
  })
})

describe('结束态判定', () => {
  it('识别子任务和任务的结束态', () => {
    expect(isTerminal('succeeded')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('running')).toBe(false)
    expect(isTerminal('waiting_user')).toBe(false)
    expect(isTerminal('summarizing')).toBe(false)
  })
})
