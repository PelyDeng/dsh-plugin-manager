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
import { selfCheckLabel, verdictDecisionFor, verdictEvidenceFound } from '../src/butler.ts'
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
