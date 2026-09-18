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
  dependencyVerdict,
  isTerminal,
  StateTransitionError,
  subtaskTransitionSources,
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

  /**
   * 老板把卡片办掉之后，这一步要能落到**真实终态**。
   *
   * 这一行曾经缺在迁移表里（`external_pending` 写成空数组），代价是一次生产事故：确认卡点掉了，
   * 上游那一步在库里纹丝不动，等它的下游永远留在队列里 —— "点了没反应"其实是"写入被丢掉了"。
   */
  it('等外部办的那一步，被办掉之后可以落成真实终态', () => {
    expect(canTransitionSubtask('external_pending', 'succeeded')).toBe(true)
    expect(canTransitionSubtask('external_pending', 'cancelled')).toBe(true)
    expect(canTransitionSubtask('external_pending', 'failed')).toBe(true)
    expect(canTransitionSubtask('external_pending', 'waiting_user')).toBe(true)
  })

  it('等外部办的那一步不能被"退回"到没派过的样子', () => {
    expect(canTransitionSubtask('external_pending', 'queued')).toBe(false)
    expect(canTransitionSubtask('external_pending', 'dispatched')).toBe(false)
    expect(canTransitionSubtask('external_pending', 'running')).toBe(false)
  })

  /**
   * 存储层的写入白名单**由迁移表生成**，不另抄一份。
   *
   * 抄出来的那一份会漂移：表里加了迁移、SQL 没跟上，条件 UPDATE 影响 0 行且不报错。
   * 所以"能迁到某个状态"这件事只能有一个来源 —— 这条断言钉住它。
   */
  it('写入白名单来自迁移表本身，逐条一致', () => {
    for (const to of SUBTASK_STATES) {
      const sources = subtaskTransitionSources(to)
      expect(sources).toContain(to)
      for (const from of SUBTASK_STATES) {
        expect(sources.includes(from), `${from} → ${to}`).toBe(canTransitionSubtask(from, to))
      }
    }
    // 出边加上了，白名单就得跟着说得出"external_pending 也能迁到 succeeded"。
    expect(subtaskTransitionSources('succeeded')).toContain('external_pending')
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

/**
 * 依赖就绪判定。
 *
 * 逐行照游戏侧 `design/02-机制/task_protocol.yaml#scheduling.ready_rules` 那张表驱动 ——
 * 两边各写一份实现迟早会分家，所以这张表本身就是判据：表变了，这里跟着红。
 *
 * ⚠️ 其中 `external_pending + requiresExternalAction` 这一行 2026-09-18 从 `fail` 改成了
 * `wait`（设计表同步改了，判据跟着改）：原来判失败，于是"等老板在卡片上点确认"被当成
 * "前置永远完不成"，把它后面排队的每一步全判死。现场是一次「删六篇草稿」——点掉第一张，
 * 其余五张永远停在失败。老板能点掉的状态不是终局。
 */
describe('依赖就绪判定与既定就绪表一致', () => {
  const rows: readonly {
    readonly upstream: 'succeeded' | 'external_pending' | 'unfinished' | 'failed_or_cancelled'
    readonly materialsReady: boolean
    readonly requiresExternalAction: boolean
    readonly action: 'dispatch' | 'wait' | 'fail'
  }[] = [
    { upstream: 'succeeded', materialsReady: true, requiresExternalAction: false, action: 'dispatch' },
    { upstream: 'succeeded', materialsReady: false, requiresExternalAction: false, action: 'fail' },
    { upstream: 'external_pending', materialsReady: true, requiresExternalAction: false, action: 'dispatch' },
    { upstream: 'external_pending', materialsReady: true, requiresExternalAction: true, action: 'wait' },
    { upstream: 'external_pending', materialsReady: false, requiresExternalAction: false, action: 'fail' },
    { upstream: 'unfinished', materialsReady: false, requiresExternalAction: false, action: 'wait' },
    { upstream: 'unfinished', materialsReady: true, requiresExternalAction: false, action: 'wait' },
    { upstream: 'unfinished', materialsReady: false, requiresExternalAction: true, action: 'wait' },
    { upstream: 'unfinished', materialsReady: true, requiresExternalAction: true, action: 'wait' },
    { upstream: 'failed_or_cancelled', materialsReady: false, requiresExternalAction: false, action: 'fail' },
  ]

  /** 表里的三种上游归并到本模块的状态取值：unfinished 覆盖四个「还没终结」的状态。 */
  const statesOf = (upstream: string): readonly SubtaskState[] => {
    if (upstream === 'unfinished') return ['queued', 'dispatched', 'running', 'waiting_user']
    if (upstream === 'failed_or_cancelled') return ['failed', 'cancelled']
    return [upstream as SubtaskState]
  }

  it('表里每一行都对得上', () => {
    for (const row of rows) {
      for (const upstream of statesOf(row.upstream)) {
        expect(
          dependencyVerdict({
            upstream, materialsReady: row.materialsReady, requiresExternalAction: row.requiresExternalAction,
          }),
          `${row.upstream}/${upstream} materialsReady=${String(row.materialsReady)} requiresExternalAction=${String(row.requiresExternalAction)}`,
        ).toBe(row.action)
      }
    }
  })

  it('上游还没终结时始终等待，不看另外两个事实', () => {
    // 「还没轮到」和「干不成」是两件事：这一步没派出去，员工就没有失败可言。
    for (const materialsReady of [true, false]) {
      for (const requiresExternalAction of [true, false]) {
        expect(dependencyVerdict({ upstream: 'waiting_user', materialsReady, requiresExternalAction })).toBe('wait')
      }
    }
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
