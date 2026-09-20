/**
 * butler.ts 导出面双面快照（拆分设计 v2 §5）。
 *
 * 拆分后 src/butler.ts 只剩类与留守锚点，顶层符号住在 src/butler/ 八个域文件、经
 * re-export 维持原导出面——本插件 30+ 测试与 dsh-agents-group 4 个跨插件测试都从
 * '../src/butler.ts' import。双面锁：
 *
 * - **值面**：动态 import 的模块键集合（运行时真实可用面）；
 * - **类型面**：源码文本的 `export (type|interface)` 清单——动态 import 不含 type，
 *   漏 re-export 时值面不红，要拖到群组仓编译才爆，所以文本面单独锁。
 *
 * 增删符号是有意变更：更新这里的清单，并在提交说明里带上消费方（测试/群组）的同步改动。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../src/butler.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

const VALUE_EXPORTS = [
  'ACCEPTANCE_EMPTY_WORDS', 'ACCEPTANCE_LOCATOR', 'ACCEPTANCE_MIN_CHARS', 'ACCEPTANCE_NOUN', 'ACCEPTANCE_QUANTITY',
  'ATTACHMENT_SECTION_TITLE', 'ButlerConsole', 'DISPATCH_MESSAGE_LIMIT', 'MAX_ATTEMPTS_PER_LOGICAL', 'REPLAY_REJECTED_PREFIX',
  'SUMMARY_PROMPT_GOAL', 'SUMMARY_PROMPT_RESULTS', 'THINKING_TAIL', 'TRANSCRIPT_LEAD_EVENTS', 'TRANSCRIPT_MAX_ITEMS',
  'TRANSCRIPT_SCAN_CHUNK', 'WAITING_EXPIRED', 'WAITING_EXPIRED_TASK', 'WAITING_STOPPED', 'WAITING_STOPPED_TASK',
  'acceptanceOf', 'briefFor', 'claimedByOthers', 'clip', 'describeThrown', 'digestOf', 'dispatchBrief', 'dispatchFailureDetail',
  'effectiveSubtasks', 'isReplayRejection', 'memberReturnOf', 'ownPendingActions', 'planReworkAttempts', 'progressQueue',
  'reportOf', 'requireAcceptance', 'selfCheckLabel', 'stackOf', 'subtaskResultText', 'summaryTextOf', 'supplementPrompt',
  'taskAcceptanceFinding', 'textOf', 'thinkingSnapshot', 'verdictDecisionFor', 'verdictEvidenceFound', 'visibleError',
]

const TYPE_EXPORTS = [
  'ButlerEvent', 'ButlerInnerEvent', 'ButlerMemberCard', 'CancelOutcome', 'Conversation', 'PlanSubmission', 'PlannedSubtask',
  'PreparedAction', 'PreparedReply', 'PreparedSupplement', 'PreparedTurn', 'ReworkAttemptPlan', 'RunHooks', 'RunWatch',
  'SettleTaskInput', 'Settlement', 'StartedRun', 'SubtaskOutcome', 'SupplementRequest', 'TranscriptItem', 'TranscriptPage',
  'Turn', 'TurnOutcome', 'VerdictContext', 'VerdictDecision', 'WaitingMember',
]

describe('butler.ts 导出面快照（拆分批 2 的 re-export 守卫）', () => {
  it('值导出面与快照一致（运行时键集合）', async () => {
    const mod = await import('../src/butler.ts')
    expect(Object.keys(mod).sort()).toEqual([...VALUE_EXPORTS].sort())
  })

  it('类型导出面与快照一致（文本扫描；动态 import 不含 type）', () => {
    const declared = new Set<string>()
    for (const match of source.matchAll(/^export (?:type|interface) ([A-Za-z_$]+)/gm)) declared.add(match[1]!)
    for (const match of source.matchAll(/^export type \{ ([^}]+) \} from/gm)) for (const name of match[1]!.split(',')) declared.add(name.trim())
    expect([...declared].sort()).toEqual([...TYPE_EXPORTS].sort())
  })

  it('跨插件消费的关键符号在位（dsh-agents-group 4 个测试直接 import）', async () => {
    const mod = await import('../src/butler.ts')
    expect(mod.ButlerConsole).toBeTypeOf('function')
    expect(mod.visibleError).toBeTypeOf('function')
    expect(mod.effectiveSubtasks).toBeTypeOf('function')
    expect(mod.planReworkAttempts).toBeTypeOf('function')
    expect(mod.reportOf).toBeTypeOf('function')
    expect(mod.REPLAY_REJECTED_PREFIX).toBeTypeOf('string')
  })
})
