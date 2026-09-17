/**
 * 裁决链路的**端到端**：真的派活 → 真的收尾 → 真的裁决 → 真的落终态。
 *
 * 这个文件存在的理由是一条被误传了三批的判据降级理由："夹具驱动不起来主路径"。实测不成立：
 * 主路径（含汇总轮）早就能驱动，`tests/external-pending.test.ts` 就是先例。真正的问题是
 * **每一轮收尾都要模型再响应一次**，而 `rework` 会再收尾一次 —— 只驱动一次就等不到终态。
 * 可复用夹具见 `tests/helpers/butler-driver.ts`（它的文件头把这件事写清楚了）。
 *
 * 这里补的正是那三处"只有静态保证"的判据：D-1（409 可区分）、① 的接线（裁决出 `rework` 之后
 * 真的追加尝试）、`replace`（换成员重做）。
 */
import { describe, expect, it, vi } from 'vitest'
import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import type { ButlerAgentExecutor } from '../src/protocol.ts'
import { driveToTerminal, runPlannedTask, startButler } from './helpers/butler-driver.ts'

const draft = { kind: 'draft', title: '在博客查看候选稿', path: '/blog?conversationId=c-1' }

/** 永远成功的执行方。 */
const succeeded = (summary = '候选稿已交回'): ButlerAgentExecutor => ({
  protocol: 1,
  agentId: 'blog',
  capabilities: ['写作'],
  dispatch: async () => ({ status: 'succeeded', summary, artifacts: [draft] }),
})

describe('端到端：主路径与 D-1（重启重放被拒）', () => {
  it('单个子任务成功 ⇒ 汇总一轮 ⇒ 任务落 completed', async () => {
    const { driver, state } = await runPlannedTask({
      executor: succeeded(),
      plan: {
        acceptance: '一篇园区封闭化管理介绍',
        subtasks: [{ goal: '起草园区封闭化管理介绍', agentId: 'blog', acceptance: '一份 800 字以上的候选稿' }],
      },
    })
    try {
      // 判据一：真的落终态（不是停在 running/summarizing）。
      expect(state).toBe('completed')
      const record = driver.store.task(driver.actor, driver.taskId())!
      expect(record.subtasks[0]!.state).toBe('succeeded')
      // 判据二：汇总只跑了一轮 —— 多驱动一次就会变成 2，说明"按需驱动"没有多推。
      expect(driver.followups()).toBe(2)
    } finally { driver.close() }
  })

  it('D-1：派单抛 AccessError(409) 时子任务带固定前缀，且与普通失败分得开', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const replay: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => { throw new AccessError(409, '这一轮已经结算过（同一个请求标识）') },
    }
    const { driver, state } = await runPlannedTask({
      executor: replay,
      plan: { subtasks: [{ goal: '起草介绍', agentId: 'blog' }] },
    })
    try {
      // 判据一：这一轮**驱动得起来**（原文说"派单抛错会让 planTool.execute 挂住"，
      // 而 `planTool.execute` 根本不派单；派单在 `turnBody` 的第二段）。
      expect(state).not.toBe('running')
      const subtask = driver.store.task(driver.actor, driver.taskId())!.subtasks[0]!
      expect(subtask.state).toBe('failed')
      // 判据二：错误正文带固定前缀 —— 页面与汇总材料据此把它与"成员业务失败"分开。
      expect(subtask.error ?? '').toContain('重启重放被拒')
      // 判据三：打的是 warn 而不是 error（它不是服务端故障，不该进错误日志）。
      // ⚠️ 注意两处措辞**有意不同**：写给运维的 warn 说"被运行时拒绝重跑（不是失败）"，
      // 写给用户/汇总的 `detail` 说"重启重放被拒" —— 前者解释机制，后者解释这一轮怎么了。
      expect(warn.mock.calls.some(call => String(call[0]).includes('被运行时拒绝重跑'))).toBe(true)
      expect(error.mock.calls.some(call => String(call[0]).includes('被运行时拒绝重跑'))).toBe(false)
    } finally {
      warn.mockRestore(); error.mockRestore(); driver.close()
    }
  })

  it('对照：普通执行失败走原样路径，不带重放前缀（否则前缀就没有区分力）', async () => {
    const boom: ButlerAgentExecutor = {
      protocol: 1,
      agentId: 'blog',
      capabilities: ['写作'],
      dispatch: async () => { throw new Error('网关超时') },
    }
    const { driver } = await runPlannedTask({
      executor: boom,
      plan: { subtasks: [{ goal: '起草介绍', agentId: 'blog' }] },
    })
    try {
      const subtask = driver.store.task(driver.actor, driver.taskId())!.subtasks[0]!
      expect(subtask.state).toBe('failed')
      expect(subtask.error ?? '').toContain('网关超时')
      expect(subtask.error ?? '').not.toContain('重启重放被拒')
    } finally { driver.close() }
  })
})

describe('端到端：裁决的动作面（① 追加尝试 / replace / 预算）', () => {
  it('① 的接线：汇总轮裁 rework ⇒ 真的追加一次尝试，supersedes 指向被裁那条', async () => {
    const { driver, state } = await runPlannedTask({
      executor: succeeded('第二版写好了'),
      plan: { subtasks: [{ goal: '起草介绍', agentId: 'blog', logicalId: 'g1', acceptance: '一份候选稿' }] },
      onSummarize: async (round, api) => {
        // 只在第一轮裁 rework：第二轮（新尝试跑完后的再收尾）不裁，于是这一轮正常落终态。
        if (round > 1) return
        await api.callTool('butler_verdict', {
          items: [{ subtaskId: 's1', verdict: 'rework', reason: '再改一版' }],
        })
      },
    })
    try {
      // 判据一：**动作真的发生了** —— 库里多了一条尝试（不是只把结论记在内存里）。
      const record = driver.store.task(driver.actor, driver.taskId())!
      expect(record.subtasks).toHaveLength(2)
      const retried = record.subtasks[1]!
      // 判据二：溯源与原目标同源（聚合按 logicalId 算，`supersedes` 指向被替代的那条）。
      expect(retried.supersedes).toBe('s1')
      expect(retried.logicalId).toBe('g1')
      // 判据三：新尝试真的被派出去了（不只是插了一行）。
      expect(retried.state).toBe('succeeded')
      // 判据四：追加之后**再收尾一次** ⇒ 终态按新尝试算。
      expect(state).toBe('completed')
    } finally { driver.close() }
  })

  it('预算用尽：连续裁 rework ⇒ 不无限追加，按 partial 如实收尾', async () => {
    let appended = 0
    const { driver, state } = await runPlannedTask({
      executor: {
        protocol: 1, agentId: 'blog', capabilities: ['写作'],
        dispatch: async () => { appended += 1; return { status: 'succeeded', summary: '写好了', artifacts: [draft] } },
      },
      plan: {
        acceptance: '一篇介绍',
        subtasks: [{ goal: '起草介绍', agentId: 'blog', logicalId: 'g1', acceptance: '一份候选稿' }],
      },
      // 每一轮都裁**最新那条尝试**：待裁决清单只含"已终结且这一轮还没裁过"的步骤，
      // 裁已裁过的会被工具明确拒绝（那是设计要的行为，所以这里必须挑对目标）。
      onSummarize: async (_round, api) => {
        const record = api.store.task(api.actor, api.taskId())!
        const target = record.subtasks.at(-1)!
        await api.callTool('butler_verdict', {
          items: [{ subtaskId: target.id, verdict: 'rework', reason: '还是不行' }],
        })
      },
    })
    try {
      // 判据：追加次数有界（不是每一轮都追加），且最终如实落 `partial`（"要重做但做不了"）。
      expect(appended).toBeGreaterThanOrEqual(1)
      expect(state).toBe('partial')
      expect(driver.store.task(driver.actor, driver.taskId())!.subtasks.length).toBeLessThanOrEqual(4)
    } finally { driver.close() }
  })
})

describe('端到端：§5.2 第一条消费点（任务级口径进汇总提示词）', () => {
  it('汇总提示词里带着任务级 acceptance 原文（此前是只写不读的字段）', async () => {
    const acceptance = '一篇已发布的博客文章链接，含标题与正文'
    const { driver } = await runPlannedTask({
      executor: succeeded(),
      plan: { acceptance, subtasks: [{ goal: '起草介绍', agentId: 'blog' }] },
    })
    try {
      // 汇总轮的提示词是**第二次** `followup`（第一次是派活轮）。
      const prompts = driver.followupArgs().map(value => JSON.stringify(value ?? ''))
      expect(prompts.length).toBeGreaterThanOrEqual(2)
      const summaryPrompt = prompts[prompts.length - 1]!
      expect(summaryPrompt).toContain(acceptance)
      expect(summaryPrompt).toContain('验收口径')
    } finally { driver.close() }
  })

  it('对照：没有声明口径时提示词里不出现那一段（不伪造一条口径）', async () => {
    const { driver } = await runPlannedTask({
      executor: succeeded(),
      plan: { subtasks: [{ goal: '起草介绍', agentId: 'blog' }] },
    })
    try {
      const prompts = driver.followupArgs().map(value => JSON.stringify(value ?? ''))
      const summaryPrompt = prompts[prompts.length - 1]!
      expect(summaryPrompt).not.toContain('验收口径')
    } finally { driver.close() }
  })
})
