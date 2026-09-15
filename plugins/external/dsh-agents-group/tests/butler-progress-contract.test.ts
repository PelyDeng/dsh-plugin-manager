/**
 * 跨插件契约：群组桥接上报的进度必须被牛马大总管真正消化。
 *
 * 两个插件不互相导入源码，靠事件名与字段对齐（字段名对齐的约定见 `butler-contract.test.ts`）。
 * 少一个下游真读的字段不会在任一方的类型检查里暴露：线上出现过的
 * `TypeError: Cannot read properties of undefined (reading 'replace')`（派活后立刻失败）
 * 就是这一类 —— 桥接把参与者的状态正文放进 `text`，而牛马大总管读的是必填的 `stage`，
 * 于是拿到 undefined 去压平空白，整轮子任务当场失败。
 *
 * 所以这里不测「桥接发了什么」，而是测「牛马大总管真的能消化」：把群组的桥接当执行方装进
 * 真实的子任务调度里跑一遍。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentParticipant } from '@dsh-agents-group/common'
import { AccessError, type Access } from '@dsh-plugin-manager/plugin-kit'
import { ButlerConsole, type ButlerEvent } from '../../dsh-butler-console/src/butler.ts'
import type { Config } from '../../dsh-butler-console/src/config.ts'
import type { ButlerAgentExecutor } from '../../dsh-butler-console/src/protocol.ts'
import type { TaskStore } from '../../dsh-butler-console/src/store.ts'
import { executorFor } from '../src/butler-bridge.ts'
import type { AgentManifest } from '../src/agents/registry.ts'

const manifest: AgentManifest = {
  id: 'closedoff',
  displayName: '封闭化管理智能助手',
  directory: 'closedoff',
  category: '封闭化园区',
  description: '园区业务查询、车辆轨迹',
}

const actor = { namespace: 'user' as const, userId: 'alice', sessionId: 'alice-login' }

/** 只实现本测试用到的两条通道：调度入口收集与插件目录。 */
function context(executor: unknown): Context {
  return {
    root: {
      emit(name: string, accept: (value: unknown) => void) {
        if (name === 'butler/executors') accept(executor)
        if (name === 'ecosystem/catalog') {
          accept({ protocol: 1, plugin: {
            id: manifest.id, packageName: 'dsh-closedoff', version: '1.0.0',
            displayName: manifest.displayName, description: manifest.description,
            entryPath: '/agents/closedoff', permissions: [], tools: [], category: 'agents',
          } })
        }
      },
    },
  } as unknown as Context
}

const input = {
  taskId: 'butler-task-1',
  subtaskId: 's1',
  goal: '查今天的通行记录',
  agentId: 'closedoff',
  displayName: manifest.displayName,
  taskGoal: '看看今天园区的情况',
  actor,
  signal: new AbortController().signal,
}

/**
 * 只伪装子任务调度真正用到的三个协作者（调度入口、状态库、配置）。
 *
 * 调度方法是内部的：从这里到页面之间隔着牛马大总管自己的会话与 SSE，没有更轻的公开入口
 * 能验证「执行方上报的进度会不会被消化」。所以这里直接驱动它。
 */
async function run(executor: ButlerAgentExecutor): Promise<ButlerEvent[]> {
  const store = { setSubtaskState: vi.fn() } as unknown as TaskStore
  const access = { mode: 'authenticated', ready() {}, resolve: () => undefined,
    assert() { throw new AccessError(503, '本测试不涉及鉴权') } } as unknown as Access
  const config = { subtaskTimeoutMs: 10_000, maxResultChars: 8000, maxMessageChars: 8000 } as Config
  const console_ = new ButlerConsole(context(executor), config, access, store, '')
  const dispatchSubtask = (console_ as unknown as {
    dispatchSubtask(value: typeof input): AsyncGenerator<ButlerEvent, unknown>
  }).dispatchSubtask.bind(console_)
  const events: ButlerEvent[] = []
  for await (const event of dispatchSubtask(input)) events.push(event)
  return events
}

/** 参与者替身：按封闭化参与者实际的上报形状报进度，然后交回结论。 */
function participantReporting(reports: readonly unknown[]): AgentParticipant {
  return {
    protocol: 1, id: 'closedoff', displayName: manifest.displayName, description: '',
    assertAccess: () => {},
    run: async (request: { onProgress: (progress: unknown) => void }) => {
      for (const report of reports) request.onProgress(report as never)
      return { status: 'completed', conversationId: 'closedoff-web-1', text: '今天共有 12 辆车入园。' }
    },
  } as unknown as AgentParticipant
}

/** 群组桥接当执行方：走真实的参与者 → 执行入口翻译。 */
const bridged = (reports: readonly unknown[]) => run(executorFor(manifest, participantReporting(reports)))

/** 不经过桥接的执行方，用来验证牛马大总管对别的插件漏字段是否还撑得住。 */
function bare(updates: readonly unknown[]): ButlerAgentExecutor {
  return {
    protocol: 1, agentId: 'closedoff',
    async dispatch(request) {
      for (const update of updates) request.onProgress?.(update as never)
      return { status: 'succeeded', summary: '今天共有 12 辆车入园。' }
    },
  }
}

describe('群组桥接上报的进度能被牛马大总管消化', () => {
  it('参与者的状态正文成为页面上的状态行，而不是把整轮打成失败', async () => {
    const events = await bridged([
      { kind: 'status', text: '封闭化智能体已接单。', conversationId: 'closedoff-web-1' },
      { kind: 'status', text: '正在执行：车辆轨迹查询。' },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'subtask', state: 'succeeded' })
    const details = events.filter(event => event.type === 'subtask').map(event => event.detail)
    expect(details).toContain('正在执行：车辆轨迹查询。')
    expect(details.some(detail => detail.includes('undefined'))).toBe(false)
  })

  it('增量与思考快照不打断状态行，也不会多出一条空状态', async () => {
    const events = await bridged([
      { kind: 'status', text: '封闭化智能体已接单。', conversationId: 'closedoff-web-1' },
      { kind: 'delta', delta: '今天共有 ' },
      { kind: 'thinking', thinking: '先看通行记录。\n正在生成…' },
      { kind: 'delta', delta: '12 辆车入园。' },
    ])
    expect(events.at(-1)).toMatchObject({ type: 'subtask', state: 'succeeded' })
    // 只有「已接单」那条状态行会点亮链路；增量与思考各走自己的事件，不再多出状态。
    expect(events.filter(event => event.type === 'subtask' && event.state === 'running')).toHaveLength(1)
    expect(events.filter(event => event.type === 'subtask_delta').map(event => event.delta))
      .toEqual(['今天共有 ', '12 辆车入园。'])
    expect(events.filter(event => event.type === 'subtask_thinking').map(event => event.thinking))
      .toEqual(['先看通行记录。\n正在生成…'])
  })

  it('别的执行方漏了 stage 时按空状态行处理，不把整轮打成失败', async () => {
    // 跨插件事件载荷是边界：一个展示字段缺值应该退化成「干活中」，而不是一句 TypeError。
    const events = await run(bare([{ kind: 'status', detail: '正在翻资料' }]))
    expect(events.at(-1)).toMatchObject({ type: 'subtask', state: 'succeeded' })
    expect(events.filter(event => event.type === 'subtask').map(event => event.detail)).toContain('正在翻资料')
  })
})
