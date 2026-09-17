import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webSource as web } from './web-source.ts'

const server = readFileSync(fileURLToPath(new URL('../src/web.ts', import.meta.url)), 'utf8')
const assets = readFileSync(fileURLToPath(new URL('../scripts/copy-web-assets.mjs', import.meta.url)), 'utf8')

describe('official DSH answer actions', () => {
  it('renders the official action order and responsive metadata pills', () => {
    const copy = web.indexOf("actionButton('icon-copy'")
    const like = web.indexOf("actionButton('icon-like'")
    const dislike = web.indexOf("actionButton('icon-dislike'")
    const branch = web.indexOf("actionButton('icon-branch'")
    const usage = web.indexOf("statButton('icon-database'")
    const time = web.indexOf("statButton('icon-clock'")

    expect([copy, like, dislike, branch, usage, time].every(index => index >= 0)).toBe(true)
    expect(copy).toBeLessThan(like)
    expect(like).toBeLessThan(dislike)
    expect(dislike).toBeLessThan(branch)
    expect(branch).toBeLessThan(usage)
    expect(usage).toBeLessThan(time)
    expect(web).toContain('.answer-action { width: 28px; padding: 6px; }')
    expect(web).toContain('@media (max-width: 480px)')
    expect(web).toContain('.answer-stat-label { display: none; }')
    expect(web).toContain("button.setAttribute('aria-haspopup', 'dialog')")
    expect(web).toContain("popover.setAttribute('role', 'dialog')")
    expect(web).toContain("var left = Math.max(margin, Math.min(buttonRect.left, window.innerWidth - popoverRect.width - margin))")
  })

  it('copies, persists feedback, branches, and restores metadata', () => {
    expect(web).toContain("postJson(routePath('/feedback')")
    expect(web).toContain("postJson(routePath('/branch')")
    expect(web).toContain('applyTurnMeta(astObj, obj.meta, null, true)')
    expect(web).toContain('feedbackByMessage[m.messageId]')
    expect(web).toContain('!j.feedbackUnavailable')
    expect(web).toContain("icon.className = 'answer-icon icon-check'")
    expect(server).toContain("path: `${config.routePrefix}/feedback`")
    expect(server).toContain("path: `${config.routePrefix}/branch`")
    expect(server).toContain('ctx.messageFeedback.put')
    expect(server).toContain('ctx.messageFeedback.delete')
    expect(server).toContain('feedbackUnavailable = true')
    expect(server).toContain('catch {')
    // P4：分支不再走业务管理器（`manager.fork(...)` 与被删的 `agent.ts` 一起消失），改为
    // 运行时的会话生命周期。断的仍是同一件事——**服务端真的接了这条路由并带着 atSeq 分支**，
    // 而不是只把按钮画在页面上。
    expect(server).toContain('runtimeOf(deps).lifecycle.fork(source, SessionSeq(atSeq), actor)')
    expect(server).toContain('turnUsageSummary(turnEvents)')
  })

  it('packages every source icon used by the action row', () => {
    for (const icon of ['copy', 'check', 'like', 'dislike', 'branch', 'database', 'clock']) {
      expect(web).toContain(`icon-${icon}-outline-16.svg`)
      expect(assets).toContain(`icon-${icon}-outline-16.svg`)
    }
  })
})
