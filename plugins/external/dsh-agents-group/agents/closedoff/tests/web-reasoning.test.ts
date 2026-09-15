import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const server = readFileSync(fileURLToPath(new URL('../src/web.ts', import.meta.url)), 'utf8')

describe('business Web reasoning projection', () => {
  it('forwards throttled safe snapshots instead of raw reasoning deltas', () => {
    expect(server).toContain("send({ type: 'thinking_snapshot', text, done: thinkingDone })")
    expect(server).toContain('projectReasoning(value.raw, thinkingDone || value.released')
    expect(server).toContain('250 - (Date.now() - lastThinkingAt)')
    expect(server).toContain("else if (chunk.type === 'reasoning-delta')")
    expect(server).toContain("if (chunk.type === 'text-delta') finalText += chunk.text")
    expect(server).toContain("if (completeText !== '') {")
    expect(server).toContain('finalText = completeText')
    expect(server).toContain('finalMessageId = String(event.data.message.id)')
    expect(server).toContain("send({ type: 'delta', text: redactVisibleText(finalText) })")
    expect(server).not.toContain("send({ type: 'delta', text: chunk.text })")
    expect(server).not.toContain("send({ type: 'thinking_snapshot', text: chunk.text")
  })
})
