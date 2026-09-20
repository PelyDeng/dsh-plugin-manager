/**
 * 页面事件覆盖测试。
 *
 * 服务端把 `ButlerEvent` 逐条写进 SSE，页面按 `type` 分发。少写一个分支的后果是静默的：
 * 事件照发、页面照旧，用户只会觉得「怎么没反应」—— 成员的流式正文与思考快照都栽在这上面过。
 * 所以这里把两边的清单对起来：服务端能发的每一种事件，页面都必须有对应分支。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { webSource } from './helpers/web-source.ts'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

/**
 * 服务端事件类型：`ButlerEvent` 里每个成员的 `readonly type: '...'` 字面量。
 *
 * 到 `ButlerInnerEvent` 为止：那是编排内部传递的值（例如汇总正文），不发往页面。
 */
function serverEventTypes(): string[] {
  const source = read('../src/butler.ts')
  const union = source.slice(source.indexOf('export type ButlerEvent ='), source.indexOf('type ButlerInnerEvent ='))
  const types = [...union.matchAll(/readonly type: '([a-z_]+)'/g)].map(match => match[1]!)
  return [...new Set(types)].sort()
}

/** 页面已处理的事件类型：`handleEvent` 里的 `case '...'`。 */
function handledEventTypes(): string[] {
  const source = webSource()
  const handler = source.slice(source.indexOf('function handleEvent'))
  const body = handler.slice(0, handler.indexOf('\n}\n'))
  return [...new Set([...body.matchAll(/case '([a-z_]+)':/g)].map(match => match[1]!))].sort()
}

describe('牛马聊天群页面的事件分发', () => {
  it('服务端每种事件在页面上都有分支', () => {
    const handled = new Set(handledEventTypes())
    const missing = serverEventTypes().filter(type => !handled.has(type))
    expect(missing).toEqual([])
  })

  it('清单本身不是空的，两边都真的读到了', () => {
    // 事件类型改了写法而正则失配时，上面那条会「因为两边都空」而假装通过。
    expect(serverEventTypes()).toContain('subtask_delta')
    expect(serverEventTypes()).toContain('subtask_thinking')
    expect(handledEventTypes()).toContain('subtask_thinking')
  })
})
