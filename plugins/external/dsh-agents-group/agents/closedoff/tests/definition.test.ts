/**
 * `createClosedoffDefinition` 的逐条验收：每个钩子都必须与旧实现（`participant.ts` /
 * `presentation.ts` / `redaction.ts`）**同一套行为**，而且钩子被改坏时必须变红。
 *
 * 这里刻意不碰真宿主、真网关、真模型：声明本身是**纯函数**——给一份配置、一个网关替身、
 * 一段人设，它就该返回一份完整的 `AgentDefinition`。唯一的假对象是一个只提供
 * `ctx.effect` / `ctx.tools.register` 的注册面（`tools` 钩子真的会往那里注册工具）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolAuthorizer } from '@dsh-plugin-manager/plugin-kit'
import { describe, expect, it } from 'vitest'
import type { ResultContext } from '../../../packages/runtime/src/definition.ts'
import { Config as ConfigSchema, type Config } from '../src/config.ts'
import { createClosedoffDefinition } from '../src/definition.ts'
import type { ClosedoffGateway } from '../src/gateway.ts'
import { TOOL_BY_NAME, TOOL_SPECS } from '../src/specs.ts'

const PERSONA = '你是封闭化助手。'
const CATEGORY = 'agents'
const INJECTED_CATEGORY = 'agents-closedoff-test'

/** 装配侧拿到的配置：Schema 默认值 + 测试覆盖。 */
function configOf(overrides: Partial<Config> = {}): Config {
  return { ...ConfigSchema({} as Config), ...overrides }
}

/** 工具注册面：`createPluginTools` 只碰 `ctx.effect` 与 `ctx.tools.register` 两个面。 */
function registrationHost() {
  const registered: { readonly name: string }[] = []
  const ctx = {
    effect: (execute: () => unknown) => {
      const disposable = execute()
      return async () => { void disposable }
    },
    tools: { register: (tool: { readonly name: string }) => { registered.push(tool); return () => {} } },
  } as unknown as Context
  return { ctx, registered }
}

function definitionOf(overrides: {
  readonly config?: Partial<Config>
  readonly authorize?: ToolAuthorizer
  readonly category?: string
} = {}) {
  return createClosedoffDefinition({
    gateway: {} as unknown as ClosedoffGateway,
    config: configOf(overrides.config),
    persona: PERSONA,
    authorize: overrides.authorize ?? (() => {}),
    category: overrides.category ?? CATEGORY,
  })
}

/** 结果投影的输入：只有历史与派单请求，存储可以不注入。 */
function resultContext(conversationId: string, finalText: string): ResultContext {
  return {
    history: { messages: [], conversationId, finalText },
    request: { message: '查一下这辆车' },
    storage: undefined,
  }
}

describe('封闭化助手的 AgentDefinition', () => {
  it('身份与配置：id / displayName / description / persona / config 都是业务那一份', () => {
    const definition = definitionOf()
    expect(definition.id).toBe('closedoff')
    expect(definition.displayName).toBe('封闭化管理智能助手')
    expect(definition.description).toBe('通过原有只读业务工具查询园区、通行与车辆信息，返回脱敏分析和原生会话。')
    expect(definition.persona).toBe(PERSONA)
    // `config` 必须是**业务 schema**（运行时用它校验 `mount()` 收到的原始配置），不是空壳。
    expect(definition.config({} as Config)).toMatchObject({ routePrefix: '/closedoff-qa', trackDeviceRadiusMeters: 100 })
    // 封闭化的实时通道是增量。
    expect(definition.liveMode).toBe('delta')
  })

  it('redact 就是 redaction 的 redactVisibleText', () => {
    const definition = definitionOf()
    expect(definition.redact?.('详情见 https://park.test/live/a.m3u8 ，联系电话 13812345678'))
      .toBe('详情见 [地址已隐藏] ，联系电话 138****5678')
  })

  it('tools 钩子把工具真的注册进 ctx，并原样使用注入的分类标签', () => {
    const host = registrationHost()
    const definition = definitionOf({ category: INJECTED_CATEGORY })
    const tools = definition.tools({ ctx: host.ctx, storage: undefined, conversationId: undefined })

    // 目录条目与**真正注册进去**的工具一一对应：不是"声明了却没注册"。
    expect(tools).toHaveLength(TOOL_SPECS.length)
    expect(host.registered.map(tool => tool.name)).toEqual(TOOL_SPECS.map(spec => spec.name))
    // 分类只有群组注入这一个来源：这里写错，本 Agent 的工具会对它全部不可见。
    expect(tools.every(tool => tool.category === INJECTED_CATEGORY)).toBe(true)
    expect(tools.every(tool => tool.name.startsWith('closedoff_'))).toBe(true)
  })

  it('opaqueFromToolResult 从结果正文里真的提取出 opaque 值（安全钩子）', () => {
    const hook = definitionOf().opaqueFromToolResult
    expect(hook).toBeDefined()
    const internal = 'bd7f5c2e-91aa-4f30-9c31-8ee0a5d0c001'
    const resultText = JSON.stringify({ ok: true, data: { reservationId: internal, id: 42, carNumb: '渝A12345' } })

    // ⚠️ 运行时传进来的 `resultText` **已经是纯文本**（`participant.ts` 用 `textOf(block.content)`
    // 取好了）。所以这条断言正是"钩子不许再套一层 `textBlocks`"的判据：那样写会把正文丢空
    // （`textBlocks` 期望的是内容块数组），opaque 集合只剩 `meta` 那一半，而且是**静默**失效。
    expect(hook?.(resultText, undefined)).toEqual([internal, '42'])
    // `meta` 那一半也照旧：结构化值里的 opaque 字段同样要收。
    expect(hook?.('', { value: { data: { districtId: 'district-9' } } })).toEqual(['district-9'])
    // 非 JSON 正文不臆造标识。
    expect(hook?.('查询失败：服务不可用', undefined)).toEqual([])
  })

  it('stageText：工具名认得出时给业务名，认不出时给兜底文案，非 tool/call 不编文案', () => {
    const hook = definitionOf().stageText
    expect(hook).toBeDefined()
    const call = (name: string): SessionEvent =>
      ({ type: 'tool/call', time: 1, seq: 1, data: { callId: 'call-1', name } }) as unknown as SessionEvent

    const known = 'closedoff_white_page'
    expect(hook?.(call(known))).toBe(`正在执行：${TOOL_BY_NAME.get(known)?.displayName ?? ''}`)
    // 认不出的工具（别的 Agent 的、或还没进目录的）：兜底文案。
    expect(hook?.(call('closedoff_not_registered'))).toBe('正在执行封闭化业务查询。')
    expect(hook?.(call('dsh_tool_read'))).toBe('正在执行封闭化业务查询。')
    // 其余事件类型不由业务编文案：返回 undefined，交给运行时自己的口径。
    expect(hook?.({ type: 'tool/result', time: 2, seq: 2, data: {} } as unknown as SessionEvent)).toBeUndefined()
    expect(hook?.({ type: 'user/message', time: 3, seq: 3, data: {} } as unknown as SessionEvent)).toBeUndefined()
  })

  it('projectReasoning 把 releaseTail 与 opaqueValues 原样交给页面那套投影', () => {
    const hook = definitionOf().projectReasoning
    expect(hook).toBeDefined()
    const internal = 'bd7f5c2e-91aa'
    // opaque 值被替换成占位符（安全钩子的下半段：收上来的值真的用于隐藏）。
    expect(hook?.(`这条 ${internal} 是关键。`, { opaqueValues: [internal], releaseTail: true }))
      .toBe('这条 [内部标识已隐藏] 是关键。')
    // 未收尾：压住不稳定的尾巴，并如实标"正在生成…"。
    expect(hook?.('第一句已经稳定。第二句还没写完', { opaqueValues: [], releaseTail: false }))
      .toBe('第一句已经稳定。\n正在生成…')
    // 已收尾：尾巴照常发布。
    expect(hook?.('第一句已经稳定。第二句还没写完', { opaqueValues: [], releaseTail: true }))
      .toBe('第一句已经稳定。第二句还没写完')
  })

  it('projectResult 只负责 completed 那一支：正文脱敏、材料固定一条会话链接', async () => {
    const hook = definitionOf({ config: { routePrefix: '/closedoff-qa' } }).projectResult
    expect(hook).toBeDefined()
    const conversationId = 'closedoff-web-1f0f7f74-6f2e-4a6e-9a4c-2a1a5c1f0b11'
    const projected = await hook?.(resultContext(
      conversationId,
      '渝A12345 当前在园。联系电话 13812345678，轨迹见 https://park.test/track/a.m3u8',
    ))

    expect(projected?.status).toBe('completed')
    expect(projected?.text).toBe('渝A12345 当前在园。联系电话 138****5678，轨迹见 [地址已隐藏]')
    // 材料必须**显式给出**：为 `undefined` 时运行时会补一条 `title: '查看会话'` 的通用材料，
    // 侧栏标题与路径都会跟着变。标题必须与运行时那条**逐字相同**——同一张卡片上接单状态行
    // （运行时给）与交付材料（本钩子给）指向同一个会话，两边文案不同就是两个标签指同一件事。
    expect(projected?.artifacts).toEqual([{
      kind: 'conversation',
      title: '查看会话',
      path: `/closedoff-qa?conversationId=${conversationId}`,
    }])
    // 会话 id 进 URL 前要编码（业务 id 实际上只有 `[\\w-]`，但这里不靠"实际上"）。
    const odd = await hook?.(resultContext('closedoff-web-#1', '好的'))
    expect(odd?.artifacts?.[0]?.path).toBe(`/closedoff-qa?conversationId=${encodeURIComponent('closedoff-web-#1')}`)
    // 取消 / 失败的文案**不由它负责**（运行时只在 completed 时调用它）：空正文在这里如实投影成空，
    // 由运行时补自己的兜底文案。
    expect((await hook?.(resultContext(conversationId, '')))?.text).toBe('')
  })

  it('projectHistory 转发 trackDeviceRadiusMeters：半径外的设备组必须被过滤掉', () => {
    // 一条沿 lat=29 从 lon=106 走到 106.01 的轨迹，加一个在纬度方向偏 0.002°（约 222 米）的设备组。
    // 半径 100 米时它必须被滤掉、500 米时必须留下——这就是"半径真的被转发进去"的判据：
    // 钩子如果把第二个参数丢了（回落到默认 100），500 米那一次必红。
    const events = [
      { type: 'tool/call', time: 1, seq: 1, data: { callId: 'track-1', name: 'closedoff_vehicle_track' } },
      {
        type: 'tool/result',
        time: 2,
        seq: 2,
        data: {
          message: { content: [{ toolCallId: 'track-1', content: [{ type: 'text', text: '{"ok":true}' }] }] },
          meta: {
            api: '/track',
            value: {
              ok: true,
              data: [{
                vehicleNo: '渝A12345',
                points: [
                  { longitude: 106, latitude: 29, height: 0, pointTime: 1788324093371 },
                  { longitude: 106.01, latitude: 29, height: 0, pointTime: 1788324153371 },
                ],
              }],
              devices: {
                data: [{
                  id: 'camera-far',
                  groupId: 'group-far',
                  groupName: '远处的立杆',
                  deviceName: '摄像头09',
                  plottingConfigData: { plottingData: JSON.stringify([{ points: [{ position: [106.005, 29.002, 0] }] }]) },
                }],
              },
            },
          },
        },
      },
    ] as unknown as SessionEvent[]

    const near = definitionOf({ config: { trackDeviceRadiusMeters: 500 } }).projectHistory?.(events)
    expect(near?.[0]).toMatchObject({
      role: 'assistant',
      tracks: { 'track-1': { vehicleNo: '渝A12345', groups: [{ groupId: 'group-far', groupName: '远处的立杆' }] } },
    })

    const far = definitionOf({ config: { trackDeviceRadiusMeters: 100 } }).projectHistory?.(events)
    expect(far?.[0]).toMatchObject({ role: 'assistant', tracks: { 'track-1': { vehicleNo: '渝A12345', groups: [] } } })
    // 轨迹点本身不受半径影响：过滤的是设备组，不是轨迹。
    expect(far?.[0]).toMatchObject({ tracks: { 'track-1': { points: [{ lon: 106, lat: 29 }, { lon: 106.01, lat: 29 }] } } })
  })
})
