/**
 * 记录**归属规则**的验证。
 *
 * ## 这条规则为什么值得单独钉住
 *
 * `huiyu_library` 存在的理由是设计稿里那句话："生图要花钱，用户经常说'上次那张再给我来张
 * 差不多的'，能翻出来就别重画。"
 *
 * 而用户说这句话时，**往往已经开了新会话**。所以归属若按会话分，这个工具的核心用例直接失效
 * ——生过的图在新会话里查不到，于是又生成一遍，正是它要避免的浪费。
 *
 * 规则因此定为：**取会话的所有者**（运行时写在 `dsh_conversations` 上），使同一用户的所有会话
 * 共享一个素材库。反查不到时回落到会话级归属——退化成"看得少"，好过"用不了"。
 *
 * ## 写与读必须同源
 *
 * 记账与查询各写一份归属推导，会让刚生成的图查不到。所以两者都走 `ownerFor`，本文件断言它的
 * 三种情形，并核验"同一用户的两次不同会话得到同一个归属键"。
 */

import { describe, expect, it } from 'vitest'
import { ownerFor } from '../src/tools/context.ts'
import { ownerOf } from '../src/store.ts'
import type { HuiyuToolContext } from '../src/tools/context.ts'

/** 造一个只有存储面的上下文；`conversationOwner` 按给的映射应答。 */
function contextWith(answers: Readonly<Record<string, string | undefined>>, failing = false): HuiyuToolContext {
  return {
    store: {
      conversationOwner: async (sessionId: string) => {
        if (failing) throw new Error('反查失败')
        return answers[sessionId]
      },
    },
  } as unknown as HuiyuToolContext
}

/** 没有存储的上下文（未配置 PG）。 */
const noStore = {} as unknown as HuiyuToolContext

describe('归属规则', () => {
  it('会话有主时取会话的所有者——这是跨会话复用的关键', async () => {
    const context = contextWith({ 'huiyu-chat-a': 'user:alice' })
    expect(await ownerFor(context, 'huiyu-chat-a')).toBe('user:alice')
  })

  it('同一用户的两个会话得到同一个归属键（素材库共享）', async () => {
    // 这一条就是"新会话里还能翻出上次那张图"的形式化表述。
    const context = contextWith({ 'huiyu-chat-a': 'user:alice', 'huiyu-chat-b': 'user:alice' })
    const first = await ownerFor(context, 'huiyu-chat-a')
    const second = await ownerFor(context, 'huiyu-chat-b')
    expect(first).toBe(second)
    // 拆分后落库的两列也必须相同，否则查询仍然分家。
    expect(ownerOf(first)).toEqual(ownerOf(second))
    expect(ownerOf(first)).toEqual({ namespace: 'user', id: 'alice' })
  })

  it('不同用户得到不同归属键（不互相看到素材）', async () => {
    const context = contextWith({ 'huiyu-chat-a': 'user:alice', 'huiyu-chat-c': 'user:bob' })
    expect(await ownerFor(context, 'huiyu-chat-a')).not.toBe(await ownerFor(context, 'huiyu-chat-c'))
  })

  it('反查不到会话时回落到会话级归属，而不是报错', async () => {
    // 新会话的行可能还没落库（会话索引异步写）。此时画像退化成"只看得到本会话"，
    // 但功能仍可用——比整次调用失败好。
    const context = contextWith({})
    const owner = await ownerFor(context, 'huiyu-chat-new')
    expect(owner).toBe('huiyu:huiyu-chat-new')
    expect(ownerOf(owner)).toEqual({ namespace: 'huiyu', id: 'huiyu-chat-new' })
  })

  it('反查抛错时同样回落，不让整次调用失败', async () => {
    const context = contextWith({ 'huiyu-chat-a': 'user:alice' }, true)
    expect(await ownerFor(context, 'huiyu-chat-a')).toBe('huiyu:huiyu-chat-a')
  })

  it('连会话 id 都没有时给占位分组，不与真实会话混在一起', async () => {
    const context = contextWith({})
    expect(await ownerFor(context, '')).toBe('huiyu:unknown')
  })

  it('存储未配置时也能求归属（不抛错）', async () => {
    // 未就绪的成员仍会注册工具，它们在缺配置时要给稳定错误，而不是崩在归属推导上。
    expect(await ownerFor(noStore, 'huiyu-chat-a')).toBe('huiyu:huiyu-chat-a')
  })

  it('归属键拆开后是两列合法值（供 `huiyu_images` 的 owner_namespace/owner_id）', () => {
    for (const owner of ['user:alice', 'huiyu:huiyu-chat-a', 'huiyu:unknown']) {
      const { namespace, id } = ownerOf(owner)
      expect(namespace, `${owner} 的 namespace 为空`).not.toBe('')
      expect(id, `${owner} 的 id 为空`).not.toBe('')
    }
  })
})
