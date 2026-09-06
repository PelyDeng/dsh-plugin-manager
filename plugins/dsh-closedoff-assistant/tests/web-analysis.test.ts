import { describe, expect, it } from 'vitest'
import { webSource as web } from './web-source.ts'

function loadFinishReasonMessage(): (reason: string, hasResult: boolean) => string {
  const source = web.match(/function finishReasonMessage\(reason, hasResult\) \{[\s\S]*?\n  \}\n\n  function applyFinishReason/)?.[0]
    .replace(/\n\n  function applyFinishReason$/, '')
  if (source === undefined) throw new Error('finishReasonMessage source not found')
  return Function(`${source}; return finishReasonMessage`)() as (reason: string, hasResult: boolean) => string
}

describe('assistant analysis rendering', () => {
  it('keeps concise analysis while removing duplicate Markdown tables when structured results exist', () => {
    expect(web).toContain('function stripMarkdownTables(text)')
    expect(web).toContain('if (inCode) { kept.push(lines[i]); continue; }')
    expect(web).toContain('ast.hasStructured ? stripMarkdownTables(ast.accumulated) : ast.accumulated')
    expect(web).toContain('结论与建议')
    expect(web).toContain('results-container')
    expect(web).toContain('ensureResultSection')
    expect(web).toContain('function finishReasonMessage(reason, hasResult)')
    expect(web).toContain("aborted: '本轮回答已停止，内容可能不完整。'")
    expect(web).toContain("interrupted: '本轮回答因运行中断而未完成。'")
    expect(web).toContain("'max-tokens': '本轮回答达到输出上限，内容可能不完整。'")
    expect(web).toContain("blocked: '本轮请求被阻止，尚未执行或继续。'")
    expect(web).toContain("error: '本轮回答发生错误，未能完整结束。'")
    expect(web).toContain("if (reason === 'error' && ast.terminalTone === 'error' && ast.terminalMessage !== '') return")
    expect(web).toContain("ast.turnStatus.setAttribute('role', ast.terminalTone === 'error' ? 'alert' : 'status')")
    expect(web).toContain('applyFinishReason(astObj, obj.reason)')
    expect(web).toContain('applyFinishReason(ast, m.finishReason)')
    expect(web).toContain("if (p.state === 'data' || p.state === 'empty')")
    expect(web).toContain("terminalMessage: '', terminalTone: ''")
    expect(web).not.toContain('ast.accumulated = \'本轮在汇总结论时被中断')
  })

  it('separates display-safe reasoning from always-visible Tool progress', () => {
    expect(web).toContain('turn-process')
    expect(web).toContain('reasoning-row')
    expect(web).toContain('tool-progress')
    expect(web).toContain("case 'thinking_snapshot'")
    expect(web).toContain('updateThinking(astObj')
    expect(web).toContain('已完成 ')
    expect(web).toContain('m.thinking')
    expect(web).toContain("mask-image: url('icon-think-outline-14.svg')")
    expect(web).toContain("mask-image: url('icon-api-outline-14.svg')")
    expect(web).toContain('width: calc(100% - 50px)')
    expect(web).not.toContain("p.state === 'empty' || !p.cards.length")
  })

  it('keeps scrolling inside the app panels instead of the document root', () => {
    expect(web).toContain('html, body { height: 100%; overflow: hidden; }')
    expect(web).toContain('#messages { flex: 1; overflow-y: auto;')
  })

  it('distinguishes completed, interrupted, and result-preserving terminal states', () => {
    const message = loadFinishReasonMessage()

    expect(message('completed', true)).toBe('')
    expect(message('aborted', false)).not.toContain('上方查询结果已保留')
    for (const reason of ['aborted', 'interrupted', 'max-tokens', 'blocked', 'error']) {
      expect(message(reason, true)).toContain('上方查询结果已保留')
    }
  })

  it('describes cached vehicle locations without claiming zero-latency coordinates', () => {
    expect(web).toContain("closedoff_vehicle_latest_positions: '在园车辆最新位置'")
    expect(web).not.toContain('在园车辆实时坐标')
  })
})
