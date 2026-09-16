/**
 * 状态文案：任务/子任务的展示映射以 `task-projection.ts` 的 `taskStateLabel` 为唯一来源，
 * 这里只补投影里没有、但会出现在**权威事件原文**里的英文 token
 * （task_protocol.yaml#subtask：派单用 `dispatched`、执行用 `executing`、成功用
 * `succeeded`；投影把 `executing` 归入运行中，所以这几个词只会在子任务状态原文与
 * 员工命令里出现）。界面与气泡都走这一层，避免同一个状态在任务本与员工面板里两种说法。
 */
import { taskStateLabel } from './task-projection.ts'

const EXTRA: Record<string, string> = {
  dispatched: '已派出',
  executing: '执行中',
  succeeded: '已完成',
}

export function stateLabel(state: string): string {
  return EXTRA[state] ?? taskStateLabel(state)
}
