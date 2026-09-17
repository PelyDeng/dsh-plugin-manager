/**
 * P3 判据①：⑦ 四条程序性校验的**正反用例**，以及自检四态的归约。
 *
 * 这里只测**纯函数**（`runSelfCheck` / `selfCheckState` / `toSelfCheck`）——它们不读时钟、
 * 不碰存储、不调用模型。端到端的行为（补交轮、超时预算、幂等、待答问题往返、真 `/reply` 链）
 * 在 `runtime-closure.test.ts`。
 *
 * 每条规则都给"该过"与"该拦"两侧；**另外**给"如实标未核验"的中间态——它既不是通过也不是
 * 不达标，把它压成布尔正是这一期要修掉的毛病。
 */
import { describe, expect, it } from 'vitest'
import type { ProjectedResult } from '../packages/runtime/src/definition.ts'
import { runSelfCheck, selfCheckState, toSelfCheck, type SelfCheckInput } from '../packages/runtime/src/selfcheck.ts'

/** 一份**材料**（位置型，不是内容）。 */
const ARTIFACT = { title: '候选稿', path: '/agents/blog/drafts/1', kind: 'draft' as const }

const input = (overrides: Partial<SelfCheckInput> = {}): SelfCheckInput => ({
  result: { status: 'completed', text: '写好了' },
  acceptance: undefined,
  reported: true,
  ...overrides,
})

const verdictOf = (value: SelfCheckInput, rule: string) =>
  runSelfCheck(value).findings.find(item => item.rule === rule)?.verdict

describe('规则 1：summary 非空', () => {
  it('有正文 → 通过', () => {
    expect(verdictOf(input(), 'summary')).toBe('ok')
  })

  it('正文是空串 → 不达标（**空结果是最容易被放过的失败**）', () => {
    expect(verdictOf(input({ result: { status: 'completed', text: '' } }), 'summary')).toBe('failed')
  })

  it('正文只有空白 → 也不达标（不是"看起来有内容"就算）', () => {
    expect(verdictOf(input({ result: { status: 'completed', text: '  \n\t ' } }), 'summary')).toBe('failed')
  })
})

describe('规则 2：自检必须真的通过（四态，不是"非 unverifiable 即通过"）', () => {
  it('passed → 通过', () => {
    expect(verdictOf(input({ selfCheck: { status: 'passed' } }), 'self-check')).toBe('ok')
  })

  it('failed → 不达标，且把执行方的说明带进 detail', () => {
    const value = input({ selfCheck: { status: 'failed', detail: '少了发布链接' } })
    expect(verdictOf(value, 'self-check')).toBe('failed')
    expect(runSelfCheck(value).failed).toBe(true)
    expect(runSelfCheck(value).findings.find(item => item.rule === 'self-check')?.detail).toContain('少了发布链接')
  })

  it('unverifiable → **未核验**，不计入不达标', () => {
    const value = input({ selfCheck: { status: 'unverifiable' } })
    expect(verdictOf(value, 'self-check')).toBe('unverified')
    expect(runSelfCheck(value).failed).toBe(false)
  })

  it('⚠️ 缺省 → **未核验，绝不是通过**（这是与主方案字面不同的关键一处）', () => {
    // 主方案原文"status !== 'unverifiable' 才算自检通过"按字面让缺省也满足 ⇒ 也算通过。
    // 异构期两个真实执行方都还没有读 selfCheck，按旧口径 = 所有交付都被标记为"自检通过"。
    expect(verdictOf(input(), 'self-check')).toBe('unverified')
    expect(runSelfCheck(input()).failed).toBe(false)
  })

  it('缺省 → absent（执行方没有自检能力）', () => {
    expect(selfCheckState(undefined)).toBe('absent')
  })

  it('⚠️ 状态名拼错 / 缺字段 / `null` / 非对象 → **damaged**（上游的 bug），不混进 absent', () => {
    // 混进 `absent` 会让"写错一个枚举值"变成一条关于**这个执行方能力**的断言，而且完全静默：
    // 协调方看到 `absent` 只会想"它没实现自检"，不会想到"它回报的形状是坏的"。
    // `null` 尤其必须在这里挡住：`typeof null === 'object'`，直接读 `.status` 会抛 `TypeError`，
    // 整轮以一条看不懂的异常 reject（红队实测过）。
    expect(selfCheckState({ status: 'PASSED' } as never)).toBe('damaged')
    expect(selfCheckState({} as never)).toBe('damaged')
    expect(selfCheckState(null as never)).toBe('damaged')
    expect(selfCheckState('absent' as never)).toBe('damaged')
    // 损坏同样按"未核验"处理：不猜、不降级成通过、也不计入不达标。
    expect(verdictOf(input({ selfCheck: { status: 'PASSED' } as never }), 'self-check')).toBe('unverified')
    expect(runSelfCheck(input({ selfCheck: null as never })).failed).toBe(false)
  })

  it('损坏与"缺省"在 detail 上分得开（不靠 status 猜）', () => {
    const damaged = runSelfCheck(input({ selfCheck: {} as never })).findings
      .find(item => item.rule === 'self-check')?.detail ?? ''
    const absent = runSelfCheck(input()).findings
      .find(item => item.rule === 'self-check')?.detail ?? ''
    expect(damaged).toContain('形状非法')
    expect(absent).toContain('没有回报自检结论')
    expect(damaged).not.toBe(absent)
  })
})

describe('规则 3：口径-产物自洽（口径非空 ⇒ 材料非空）', () => {
  it('没有声明口径 → 未核验（**豁免判据是"这一步是否真的收到非空口径"**）', () => {
    expect(verdictOf(input({ acceptance: undefined }), 'acceptance-artifacts')).toBe('unverified')
    expect(verdictOf(input({ acceptance: '   ' }), 'acceptance-artifacts')).toBe('unverified')
  })

  it('有口径且交回了材料 → 通过', () => {
    const value = input({ acceptance: '一份 800 字以上的候选稿', result: { status: 'completed', text: '写好了', artifacts: [ARTIFACT] } })
    expect(verdictOf(value, 'acceptance-artifacts')).toBe('ok')
  })

  it('有口径却一条材料都没有 → 不达标', () => {
    const value = input({ acceptance: '一份 800 字以上的候选稿' })
    expect(verdictOf(value, 'acceptance-artifacts')).toBe('failed')
    expect(runSelfCheck(value).failed).toBe(true)
  })

  it('artifacts 是空数组同样不达标（空数组与"没给"在这里是一回事）', () => {
    const value = input({ acceptance: '一份候选稿', result: { status: 'completed', text: '写好了', artifacts: [] } })
    expect(verdictOf(value, 'acceptance-artifacts')).toBe('failed')
  })

  it('detail 如实说明强度：只说"没有交回任何材料"，不宣称"交错了种类"', () => {
    const detail = runSelfCheck(input({ acceptance: '一份候选稿' })).findings.find(item => item.rule === 'acceptance-artifacts')?.detail ?? ''
    expect(detail).toContain('没有交回任何材料')
    // 逐 kind 对照在当前契约下不可实现（自由文本 vs 固定英文枚举），detail 不能暗示它做过。
    expect(detail).not.toContain('kind')
  })
})

describe('规则 4：调过交活工具', () => {
  it('调过 → 通过', () => {
    expect(verdictOf(input({ reported: true }), 'report-called')).toBe('ok')
  })

  it('没调 → **未核验，不是不达标**（§4.3：没调工具不等于失败，用投影兜底）', () => {
    const value = input({ reported: false })
    expect(verdictOf(value, 'report-called')).toBe('unverified')
    expect(runSelfCheck(value).failed).toBe(false)
  })
})

describe('汇总：回报给协调方的 selfCheck', () => {
  it('四条全通过 → passed', () => {
    const value = input({ acceptance: '一份候选稿', selfCheck: { status: 'passed' }, result: { status: 'completed', text: '写好了', artifacts: [ARTIFACT] } })
    expect(toSelfCheck(runSelfCheck(value))).toEqual({ status: 'passed' })
  })

  it('执行方声明「这一轮没有可核验的产出」→ unverifiable（并带上原因）', () => {
    const summary = toSelfCheck(runSelfCheck(input({ selfCheck: { status: 'unverifiable' } })))
    expect(summary.status).toBe('unverifiable')
    expect(summary.detail ?? '').not.toBe('')
  })

  it('⚠️ 执行方**没有自检能力**（缺省）→ absent，**不得**折成 unverifiable', () => {
    // 这正是 P3 评审 P-2：只有三态时两者都被折成 `unverifiable`，协调方只能读 `detail`
    // 文本才能分清「执行方说这一轮没有可核验的产出」与「执行方根本没有自检能力」——而文本
    // 不能当判据。**这条用例是那个区分的唯一覆盖**：把 `toSelfCheck` 里
    // `outcome.selfCheck === 'absent'` 那一支改回 `unverifiable`，它必须变红。
    const summary = toSelfCheck(runSelfCheck(input()))
    expect(summary.status).toBe('absent')
    // 未核验的具体原因仍然要写清楚：`absent` 只回答"谁没有自检能力"，不回答"这一轮为什么没核验"。
    expect(summary.detail ?? '').not.toBe('')
  })

  it('显式 `absent` 与整个字段缺省归到同一态（协调方不必分两种写法）', () => {
    expect(selfCheckState({ status: 'absent' })).toBe('absent')
    expect(toSelfCheck(runSelfCheck(input({ selfCheck: { status: 'absent' } }))).status).toBe('absent')
  })

  it('损坏（damaged）对外也报 absent，但 detail 说的是"形状非法"', () => {
    // 协调方视角：`absent` 与 `damaged` 都是"没有可用的自检结论"；区别留在 `detail` 与
    // `SelfCheckOutcome.selfCheck` 里（能力缺省 vs 上游 bug），运行时另外对 damaged 发一次告警。
    const summary = toSelfCheck(runSelfCheck(input({ selfCheck: null as never })))
    expect(summary.status).toBe('absent')
    expect(summary.detail ?? '').toContain('形状非法')
  })

  it('`unverifiable` 优先于 `absent` 的只是"这一轮的性质"：有自检能力时照实报 unverifiable', () => {
    // 反向对照：只有**执行方这一侧**是 absent 才报 absent。执行方报了 unverifiable（有自检
    // 能力、这一轮没有可核验产出）时报 unverifiable —— 两条分支必须真的分开。
    expect(toSelfCheck(runSelfCheck(input({ selfCheck: { status: 'unverifiable' } }))).status).toBe('unverifiable')
    expect(toSelfCheck(runSelfCheck(input({ selfCheck: { status: 'passed' } }))).status).toBe('unverifiable')
  })

  it('有不达标 → failed（且优先于未核验）', () => {
    const value = input({ acceptance: '一份候选稿', result: { status: 'completed', text: '写好了', artifacts: [ARTIFACT] }, selfCheck: { status: 'failed', detail: '口径没对上' } })
    expect(toSelfCheck(runSelfCheck(value)).status).toBe('failed')
  })

  it('`failed` 与 `unverifiable` 是两回事：只有前者进 `outcome.failed`', () => {
    expect(runSelfCheck(input({ selfCheck: { status: 'failed' } })).failed).toBe(true)
    expect(runSelfCheck(input({ selfCheck: { status: 'unverifiable' } })).failed).toBe(false)
    expect(runSelfCheck(input()).failed).toBe(false)
  })
})

describe('纯函数性质', () => {
  it('同样的输入给同样的输出，且不改写输入', () => {
    const value = input({ acceptance: '一份候选稿' })
    const snapshot = JSON.stringify(value)
    const first: ProjectedResult = value.result
    expect(runSelfCheck(value)).toEqual(runSelfCheck(value))
    expect(JSON.stringify(value)).toBe(snapshot)
    expect(value.result).toBe(first)
  })
})
