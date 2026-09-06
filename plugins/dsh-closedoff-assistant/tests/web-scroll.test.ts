import { describe, expect, it } from 'vitest'
import { webSource as web } from './web-source.ts'

describe('answer scroll following', () => {
  it('pauses when the user scrolls up and resumes after returning to the bottom', () => {
    expect(web).toContain('var followBottom = true;')
    expect(web).toContain('if (!followBottom) return;')
    expect(web).toContain('m.scrollHeight - m.scrollTop - m.clientHeight <= 24')
    expect(web).toContain("$('#messages').addEventListener('scroll'")
    expect(web).toContain('followBottom = isNearBottom(this);')
  })

  it('starts following again when the user sends a new question', () => {
    expect(web).toMatch(/followBottom = true;\s+addUser\(q\);/)
  })
})
