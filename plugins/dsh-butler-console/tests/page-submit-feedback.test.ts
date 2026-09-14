/**
 * A 批「可信反馈与操作」的前端检查。
 *
 * 视图代次是真实的异步时序行为，用替身 api 跑一遍：先点 A 再点 B、A 响应更晚时，
 * 只允许渲染 B（方案 I09）。其余项（去罐头、eventsHead 调用、停止不再本地断流）
 * 做源码级守卫——静态匹配只能证明约束存在，浏览器交互验证见验收记录的未验证范围。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

function pick(name: string): string {
  const body = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0]
  if (body === undefined) throw new Error(`${name} 源码未找到`)
  return body
}

describe('视图切换的异步归属（I09）', () => {
  it('先点 A 再点 B、A 响应更晚时，只渲染 B 的记录', async () => {
    const rendered: string[] = []
    const state = { streaming: false, viewToken: 0, conversationId: null, bubbles: { clear() {} }, asks: { clear() {} } }
    const el = { thread: { scrollTop: 0, scrollHeight: 0 } }
    const recordOf = (id: string) => ({ id, conversationId: `conv-${id}` })
    const api = {
      // A 的历史回包故意晚到：这正是乱序场景。
      history: async ({ conversationId }: { conversationId: string }) => {
        if (conversationId === 'conv-a') await new Promise(resolve => { setTimeout(resolve, 30) })
        return { items: [{ id: `task-${conversationId}` }] }
      },
      task: async (id: string) => recordOf(id),
    }
    const noop = () => {}
    const openConversation = Function(
      'state', 'el', 'api', 'make', 'append', 'clear', 'threadInner', 'resetRail',
      'renderWelcome', 'renderTaskRecord', 'rememberConversation', 'refreshChatList',
      `${pick('openConversation')} return openConversation`,
    )(state, el, api, noop, noop, noop, noop, noop, noop, (record: { id: string }) => { rendered.push(record.id) }, noop, noop) as
      (id: string) => Promise<void>

    const first = openConversation('conv-a')
    const second = openConversation('conv-b')
    await Promise.all([first, second])

    expect(rendered).toEqual(['task-conv-b'])
  })
})

describe('A 批源码守卫', () => {
  it('计划事件不再编造任务数量与派发事实（S02）', () => {
    const planCase = source.slice(source.indexOf("case 'plan':"), source.indexOf("case 'subtask':"))
    expect(planCase).toContain('planNote(event)')
    expect(planCase).not.toContain('已经喊人')
    expect(planCase).not.toContain('拆成三份')
  })

  it('接续检查使用独立导出的 eventsHead，失败可见（S04）', () => {
    expect(source).not.toMatch(/api\.eventsHead/u)
    expect(source).toMatch(/await eventsHead\(/u)
    expect(source).toContain('接续检查失败')
  })

  it('停止不再先本地断流，停止对象绑定点击时的会话（I04）', () => {
    const stopListener = source.slice(source.indexOf("el.stop.addEventListener"), source.indexOf('el.at?.addEventListener'))
    expect(stopListener).not.toContain('state.abort?.abort()')
    expect(stopListener).toContain('const conversationId = state.conversationId')
    expect(stopListener).toContain('outcome.accepted')
    expect(stopListener).toContain('停止请求没送到')
  })

  it('右栏失败记录入口与历史入口共用执行中保护（I08）', () => {
    const openTask = pick('openTask')
    expect(openTask).toContain('if (state.streaming) return')
    expect(openTask).toContain('state.viewToken')
  })
})

describe('补缺轮守卫（代码核对发现的三处缺口）', () => {
  const serverSource = readFileSync(fileURLToPath(new URL('../src/butler.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
  const webSource = readFileSync(fileURLToPath(new URL('../src/web.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

  it('占位在受理后转为「正在理解目标」，内容或异常到达才撤掉（缺口 2）', () => {
    expect(source).toContain("note.textContent = '正在理解目标…'")
    expect(source).toMatch(/event\.type === 'conversation'/u)
    // conversation 元事件不再直接撤占位：撤掉只发生在非 user 事件分支。
    expect(source).toContain('else if (event.type !== \'user\')')
  })

  it('接续探测回包后复核视图代次与执行状态（缺口 3）', () => {
    const resume = pick('resumeLiveTurn')
    expect(resume).toContain('tokenAtProbe')
    expect(resume).toMatch(/tokenAtProbe !== state\.viewToken \|\| state\.streaming/u)
  })

  it('互斥不允许回话接管活着的回合（缺口 1）', () => {
    const prepareReply = serverSource.slice(serverSource.indexOf('private prepareReply'), serverSource.indexOf('private async *replyBody'))
    expect(prepareReply).toContain('这一轮还在执行')
    // claimNow 不再有按 kind 的接管分支。
    const claim = serverSource.slice(serverSource.indexOf('private claimNow'), serverSource.indexOf('private releaseClaim'))
    expect(claim).not.toContain('holder.kind === \'turn\'')
  })

  it('S01 区分应用入队与 HTTP 写出，且入队记录带 runId/seq/时间', () => {
    expect(serverSource).toContain("'butler-stream server-enqueue'")
    // 入队观测在 push 之后（拿得到本条 seq）。
    const enqueueAt = serverSource.indexOf("'butler-stream server-enqueue'")
    const pushAt = serverSource.lastIndexOf('log.push(event)', enqueueAt)
    expect(pushAt).toBeGreaterThan(-1)
    expect(enqueueAt).toBeGreaterThan(pushAt)
    expect(webSource).toContain("'butler-stream server-write'")
    expect(webSource).toMatch(/seq: logged\.seq/u)
  })

  it('取消态子任务不再触发 classList.add 空串（浏览器验证发现）', () => {
    expect(source).not.toMatch(/classList\.add\([^)]*\?\s*'bubble--fail'\s*:\s*''/u)
  })
})
