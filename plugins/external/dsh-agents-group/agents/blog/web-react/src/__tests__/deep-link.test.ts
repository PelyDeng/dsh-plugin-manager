/**
 * 深链接目标选择的等价单测（批 C1 删码时从 node --test 侧迁入：原用例钉的是旧
 * `web/chat.js` 的 `chatConversationTarget`，实现迁移到 `stores/conversation.ts` 后
 * 行为基准不变——URL 的 conversationId 优先，回落上次会话，两者皆无为空串）。
 */
import { describe, expect, it } from 'vitest'

const { chatConversationTarget } = await import('../stores/conversation.ts')

describe('native chat deep links', () => {
  it('select the requested conversation over a previous local conversation', () => {
    const path = '/blog?conversationId=' + encodeURIComponent('blog-chat-owned-id')
    expect(chatConversationTarget(new URL(path, 'https://example.invalid').search, 'previous-chat')).toBe('blog-chat-owned-id')
    expect(chatConversationTarget('', 'previous-chat')).toBe('previous-chat')
    expect(chatConversationTarget('', null)).toBe('')
    // 选择标识不授予访问权；非法和他人标识仍交给 activate 的原 HTTP 归属检查。
    expect(chatConversationTarget('?conversationId=unowned-id', null)).toBe('unowned-id')
  })
})
