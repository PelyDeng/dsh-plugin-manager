/**
 * 裁决（`butler_verdict`）的判定口径：**D-2 的四态映射**与**证据核验**。
 *
 * 这里只测**纯函数**（`verdictDecisionFor` / `verdictEvidenceFound` / `selfCheckLabel`）——
 * 它们不读时钟、不碰存储、不调用模型。工具本身的行为（上下文判断、重复裁决、写后核验）
 * 要经模型驱动，属于另一层；这一层是它全部判断的落点。
 *
 * ⚠️ 三个同名的 "verdict" 在这里必须分清：输入里的 `selfCheck` 是**执行侧**的自检结论；
 * `dependencyVerdict` 是**依赖侧**"前置能不能派"的判定（不在本文件）；输出才是**裁决侧**的
 * 结论。写成一句话：**成员说自己干得怎么样 / 前置能不能派 / 牛马大总管采不采纳**。
 */
import { describe, expect, it } from 'vitest'
import { planReworkAttempts, selfCheckLabel, verdictDecisionFor, verdictEvidenceFound } from '../src/butler.ts'
import type { AgentArtifact } from '@dsh-plugin-manager/plugin-kit'

const ARTIFACT: AgentArtifact = { title: '候选稿', path: '/agents/blog/drafts/1', kind: 'draft' }

describe('证据核验：accept 的证据要真的来自那一步', () => {
  const base = { result: '在线 42 台', memberReturnText: '', artifacts: [] as readonly AgentArtifact[] }

  it('结果正文里出现（含片段）就算找到', () => {
    expect(verdictEvidenceFound('在线 42 台', base)).toBe(true)
    expect(verdictEvidenceFound('42', base)).toBe(true)
  })

  it('结果正文里没有 ⇒ 找不到（**这是它唯一能挡的那类：凭印象编证据**）', () => {
    expect(verdictEvidenceFound('在线 43 台', base)).toBe(false)
  })

  it('协作返回原文与材料位置（title / path / kind）也算来源', () => {
    expect(verdictEvidenceFound('在线 42 台', { ...base, result: '', memberReturnText: '在线 42 台' })).toBe(true)
    expect(verdictEvidenceFound('/agents/blog/drafts/1', { ...base, result: '', artifacts: [ARTIFACT] })).toBe(true)
    expect(verdictEvidenceFound('候选稿', { ...base, result: '', artifacts: [ARTIFACT] })).toBe(true)
    expect(verdictEvidenceFound('published', { ...base, result: '', artifacts: [ARTIFACT] })).toBe(false)
  })
})

describe('D-2：成员自检的四态映射到裁决', () => {
  const base = {
    requested: 'accept' as const,
    evidence: '在线 42 台',
    result: '在线 42 台',
    memberReturnText: '',
    artifacts: [] as readonly AgentArtifact[],
  }

  it('passed + 证据找得到 ⇒ accept（不算降级）', () => {
    const out = verdictDecisionFor({ ...base, selfCheck: { status: 'passed' } })
    expect(out).toMatchObject({ verdict: 'accept', downgraded: false })
    expect(out.why).toBe('')
  })

  it('passed 但证据找不到 ⇒ 降级 unverified，**不静默 accept**', () => {
    const out = verdictDecisionFor({ ...base, evidence: '在线 43 台', selfCheck: { status: 'passed' } })
    expect(out.verdict).toBe('unverified')
    expect(out.downgraded).toBe(true)
    expect(out.why).toContain('找不到')
  })

  it('passed 但没给证据 ⇒ 降级 unverified', () => {
    const out = verdictDecisionFor({ ...base, evidence: '', selfCheck: { status: 'passed' } })
    expect(out.verdict).toBe('unverified')
    expect(out.why).toContain('没有附证据')
  })

  it('unverifiable（成员说这一轮没有可核验的产出）⇒ 最多 unverified', () => {
    const out = verdictDecisionFor({ ...base, selfCheck: { status: 'unverifiable' } })
    expect(out.verdict).toBe('unverified')
    expect(out.downgraded).toBe(true)
    expect(out.why).toContain('没有可核验的产出')
  })

  it('absent / 缺省 ⇒ 同样最多 unverified（**缺省不等于通过**）', () => {
    expect(verdictDecisionFor({ ...base, selfCheck: { status: 'absent' } }).verdict).toBe('unverified')
    expect(verdictDecisionFor({ ...base, selfCheck: undefined }).verdict).toBe('unverified')
    // 即便证据是真的、找得到，没有自检能力也不能算"核验通过"。
    expect(verdictDecisionFor({ ...base, selfCheck: undefined }).why).toContain('缺省不等于通过')
  })

  it('failed ⇒ **强制 rework**，证据看都不看', () => {
    const out = verdictDecisionFor({ ...base, evidence: '', selfCheck: { status: 'failed' } })
    expect(out.verdict).toBe('rework')
    expect(out.why).toContain('自检不达标')
    // 模型自己就要求 rework 时不算"被降级"。
    expect(verdictDecisionFor({ ...base, requested: 'rework', selfCheck: { status: 'failed' } }).downgraded).toBe(false)
  })

  it('模型给的 rework / replace 在自检不是 failed 时原样保留', () => {
    expect(verdictDecisionFor({ ...base, requested: 'rework', selfCheck: { status: 'passed' } }).verdict).toBe('rework')
    expect(verdictDecisionFor({ ...base, requested: 'replace', selfCheck: { status: 'passed' } }).verdict).toBe('replace')
    // replace 不因为"没证据"而降级：它本来就不要采纳。
    expect(verdictDecisionFor({ ...base, requested: 'replace', evidence: '', selfCheck: undefined }).verdict).toBe('replace')
  })
})

describe('自检结论渲染给模型看', () => {
  it('四态各自说清，**缺省不说成通过**', () => {
    expect(selfCheckLabel({ status: 'passed' })).toContain('通过')
    expect(selfCheckLabel({ status: 'failed', detail: '少了发布链接' })).toContain('少了发布链接')
    expect(selfCheckLabel({ status: 'failed' })).toContain('不达标')
    expect(selfCheckLabel({ status: 'unverifiable' })).toContain('没有可核验的产出')
    expect(selfCheckLabel({ status: 'absent' })).toContain('缺省不等于通过')
    expect(selfCheckLabel(undefined)).toContain('缺省不等于通过')
  })
})

/**
 * 设计 §5.4 第 2 步：有 `rework` / `replace` 且预算允许 ⇒ **追加尝试、回调度**。
 *
 * 这里测的是"追加哪些"的**计划**（纯函数）；追加的**动作**（写库 / 派单 / 回调度）在
 * `ButlerConsole#applyReworkAttempts`，它由 `tests/acceptance-field.test.ts` 里一条直调用例覆盖。
 * 主线定案 D-3：预算按 `logicalId` **读时聚合**、不做 0.5 折算。
 */
describe('追加尝试的计划（设计 §5.4 第 2 步）', () => {
  const step = (over: Record<string, unknown> = {}) => ({
    id: 's1', logicalId: 'g1', goal: '写稿', agentId: 'blog', state: 'failed' as const,
    acceptance: '一份候选稿', artifacts: [] as readonly AgentArtifact[], result: '第一版',
    memberReturnText: '', verdict: '' as const,
    ...over,
  })

  it('rework ⇒ 追加一条：沿用 logicalId、supersedes 指向被裁的那条、口径沿用原步', () => {
    const plan = planReworkAttempts({
      decided: [{ subtaskId: 's1', verdict: 'rework', requested: 'rework' }],
      subtasks: [step()],
      baseCount: 1,
    })
    expect(plan.appended).toEqual([{
      id: 's2', goal: '写稿', agentId: 'blog', logicalId: 'g1', supersedes: 's1', acceptance: '一份候选稿',
    }])
    expect(plan.exhausted).toEqual([])
  })

  it('replace ⇒ 换给 newAgentId，logicalId 不变（还是同一个目标在重做）', () => {
    const plan = planReworkAttempts({
      decided: [{ subtaskId: 's1', verdict: 'replace', requested: 'replace', newAgentId: 'editor' }],
      subtasks: [step()],
      baseCount: 1,
    })
    expect(plan.appended.map(item => [item.agentId, item.logicalId, item.supersedes]))
      .toEqual([['editor', 'g1', 's1']])
  })

  it('⚠️ 预算按 logicalId **读时聚合**：同目标已有上限条数 ⇒ 不再追加，并如实记 exhausted', () => {
    const plan = planReworkAttempts({
      decided: [{ subtaskId: 's2', verdict: 'rework', requested: 'rework' }],
      subtasks: [step(), step({ id: 's2', supersedes: 's1' })],
      baseCount: 2,
    })
    expect(plan.appended).toEqual([])
    // **不是静默丢弃**：调用方要按它落 `partial` 并把"预算用尽"说给用户。
    expect(plan.exhausted).toEqual(['s2'])
  })

  it('不同目标各自计数：g1 用尽不影响 g2', () => {
    const plan = planReworkAttempts({
      decided: [
        { subtaskId: 's2', verdict: 'rework', requested: 'rework' },
        { subtaskId: 's3', verdict: 'rework', requested: 'rework' },
      ],
      subtasks: [step(), step({ id: 's2', supersedes: 's1' }), step({ id: 's3', logicalId: 'g2' })],
      baseCount: 3,
    })
    expect(plan.appended.map(item => item.logicalId)).toEqual(['g2'])
    expect(plan.exhausted).toEqual(['s2'])
  })

  it('`accept` 与降级出来的 `unverified` 都不追加（后者不是重做）', () => {
    const plan = planReworkAttempts({
      decided: [
        { subtaskId: 's1', verdict: 'accept', requested: 'accept' },
        { subtaskId: 's2', verdict: 'unverified', requested: 'accept' },
      ],
      subtasks: [step(), step({ id: 's2' })],
      baseCount: 2,
    })
    expect(plan.appended).toEqual([])
    expect(plan.exhausted).toEqual([])
  })

  it('没有 logicalId 时退回按 id 计数（不会把不同目标误并成一个）', () => {
    const plan = planReworkAttempts({
      decided: [{ subtaskId: 's1', verdict: 'rework', requested: 'rework' }],
      subtasks: [step({ logicalId: '' })],
      baseCount: 1,
    })
    expect(plan.appended.map(item => item.logicalId)).toEqual(['s1'])
  })

  it('编号接着库里已有的条数往后排', () => {
    const plan = planReworkAttempts({
      decided: [
        { subtaskId: 's1', verdict: 'rework', requested: 'rework' },
        { subtaskId: 's2', verdict: 'rework', requested: 'rework' },
      ],
      subtasks: [step(), step({ id: 's2', logicalId: 'g2' })],
      baseCount: 7,
    })
    expect(plan.appended.map(item => item.id)).toEqual(['s8', 's9'])
  })
})
