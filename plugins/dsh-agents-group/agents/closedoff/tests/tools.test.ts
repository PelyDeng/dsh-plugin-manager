import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.ts'
import type { ClosedoffGateway } from '../src/gateway.ts'
import { TOOL_SPECS, type ToolSpec } from '../src/specs.ts'
import { createTool } from '../src/tools.ts'

const deviceSpec: ToolSpec = {
  name: 'closedoff_device_page',
  displayName: '查询设备',
  desc: 'devices',
  method: 'POST',
  path: '/device/page',
  result: { dataKind: 'list', fields: [['deviceName', '设备名称']] },
  params: [],
}

const trackSpec: ToolSpec = {
  name: 'closedoff_vehicle_track',
  displayName: '车辆轨迹分析',
  desc: 'track',
  method: 'POST',
  path: '/track',
  result: { dataKind: 'list', fields: [['vehicleNo', '车牌'], ['points', '轨迹点']] },
  params: [],
}

const config = {
  toolTimeoutMs: 1,
  trackDeviceRadiusMeters: 100,
  trackDwellMaxGapSeconds: 300,
} as Config

describe('device tool output', () => {
  it('rejects an unauthorized execution before touching the gateway', async () => {
    const call = vi.fn()
    const authorize = vi.fn(() => { throw new Error('permission denied') })
    const tool = createTool(deviceSpec, { call } as unknown as ClosedoffGateway, config, authorize)
    await expect(tool.execute({}, { signal: new AbortController().signal } as never)).rejects.toThrow('permission denied')
    expect(call).not.toHaveBeenCalled()
  })

  it('does not release a result if authorization was revoked during the gateway request', async () => {
    let allowed = true
    const agent = {}
    const call = vi.fn(async () => { allowed = false; return { ok: true, data: [], api: '/device/page', elapsedMs: 1 } })
    const authorize = vi.fn((actual: object | undefined) => { expect(actual).toBe(agent); if (!allowed) throw new Error('revoked') })
    const tool = createTool(deviceSpec, { call } as unknown as ClosedoffGateway, config, authorize)
    await expect(tool.execute({}, { agent, signal: new AbortController().signal } as never)).rejects.toThrow('revoked')
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('builds a specific output contract for every approved Tool', () => {
    const tools = TOOL_SPECS.map(spec => createTool(spec, {} as ClosedoffGateway, config, () => {}))

    // 数量与名字唯一性由 specs.test.ts 断言（一次覆盖 37 个且名字不重复）；
    // 这里再断言一次数量没有额外保护，只多一处改动时要跟着改的地方。
    expect(tools.every(tool => 'oneOf' in tool.output.schema)).toBe(true)
    expect(tools.every(tool => tool.description.includes('当前'))).toBe(true)
  })

  it('describes the result fields without repeating answer-process instructions', () => {
    const tool = createTool(deviceSpec, {} as ClosedoffGateway, config, () => {})

    expect(tool.description).toContain('devices')
    expect(tool.description).toContain('主要返回键（列表，当前代码快照）：deviceName')
    expect(tool.description).not.toContain('最终回答必须覆盖')
    expect(tool.description).not.toContain('结构化卡片不能代替分析')
  })

  it('validates the stable envelope without rejecting null data or future record fields', () => {
    const schema = createTool(deviceSpec, {} as ClosedoffGateway, config, () => {}).output.schema

    expect(validateJsonSchemaValue(schema, {
      api: '/device/page', ok: true, data: [{ deviceName: '南门摄像头', futureField: 1 }], elapsedMs: 3,
    })).toEqual([])
    expect(validateJsonSchemaValue(schema, {
      api: '/device/page', ok: true, data: null, elapsedMs: 3,
    })).toEqual([])
    expect(validateJsonSchemaValue(schema, {
      api: '/device/page', ok: false, errCode: '1001', message: '登录失效', elapsedMs: 3,
    })).toEqual([])
    expect(validateJsonSchemaValue(schema, {
      api: '/device/page', ok: false, error: 'network failed', elapsedMs: 3,
    })).toEqual([])
    expect(validateJsonSchemaValue(schema, {
      api: '/device/page', ok: true, data: { deviceName: '错误基数' }, elapsedMs: 3,
    })).not.toEqual([])
  })

  it('returns a bounded device summary to the model without internal ids or media addresses', () => {
    const tool = createTool(deviceSpec, {} as ClosedoffGateway, config, () => {})
    const rendered = tool.output.render({}, {
      api: '/device/page', ok: true, elapsedMs: 2, totalCount: 1,
      data: [{
        id: 'internal-id', groupName: '南门设备组', deviceName: '南门摄像头',
        deviceCode: 'CAM-1', deviceType: 6, status: 1, videoAddress: 'secret-stream',
      }],
    })
    const text = rendered[0]?.type === 'text' ? rendered[0].text : ''

    expect(text).toContain('南门摄像头')
    expect(text).toContain('CAM-1')
    expect(text).not.toContain('internal-id')
    expect(text).not.toContain('secret-stream')
  })

  it('keeps gateway failures as canonical JSON for error projection', () => {
    const tool = createTool(deviceSpec, {} as ClosedoffGateway, config, () => {})

    expect(tool.output.render({}, {
      api: '/device/page',
      ok: false,
      message: '业务接口失败',
      elapsedMs: 5,
    })).toEqual([{
      type: 'text',
      text: '{\n  "api": "/device/page",\n  "elapsedMs": 5,\n  "ok": false,\n  "message": "业务接口失败"\n}',
    }])
  })

  it('projects only declared fields and redacts sensitive values for the model', () => {
    const spec: ToolSpec = {
      name: 'closedoff_test_query',
      displayName: '测试查询',
      desc: 'test',
      method: 'POST',
      path: '/test',
      result: {
        dataKind: 'list',
        fields: [['id', '后续查询ID'], ['userPhone', '联系电话'], ['idCard', '身份证号'], ['name', '名称']],
      },
      params: [],
    }
    const tool = createTool(spec, {} as ClosedoffGateway, config, () => {})
    const rendered = tool.output.render({}, {
      api: '/test', ok: true, elapsedMs: 2,
      data: [{ id: 'opaque-id', userPhone: '13800138000', idCard: '110101199001011234', name: '示例', unknown: 'drop-me' }],
    })
    const text = rendered[0]?.type === 'text' ? rendered[0].text : ''

    expect(JSON.parse(text)).toEqual({
      api: '/test', ok: true, elapsedMs: 2,
      data: [{ id: 'opaque-id', userPhone: '138****8000', idCard: '110101********1234', name: '示例' }],
    })
    expect(text).not.toContain('drop-me')
  })

  it('preserves warning module dictionary fields without inventing pagination or alarm counts', () => {
    const spec = TOOL_SPECS.find(item => item.name === 'closedoff_warning_module_list')!
    const tool = createTool(spec, {} as ClosedoffGateway, config, () => {})
    const data = [
      { id: 'module-fixture-1', name: '车辆报警', code: 'vehicle-fixture' },
      { id: 'module-fixture-2', name: '人员报警', code: 'person-fixture' },
    ]
    const value = {
      api: spec.path, ok: true, elapsedMs: 2,
      data: data.map(row => ({ ...row, secret: 'must-not-reach-model' })),
    }
    const rendered = tool.output.render({}, value)
    const text = rendered[0]?.type === 'text' ? rendered[0].text : ''

    expect(validateJsonSchemaValue(tool.output.schema, value)).toEqual([])
    expect(JSON.parse(text)).toEqual({ api: spec.path, ok: true, elapsedMs: 2, data })
    expect(text).not.toContain('must-not-reach-model')
    expect(spec.result.dataKind).toBe('list')
    expect(spec.params).toEqual([])
    expect(tool.description).toContain('无分页参数')
    expect(tool.description).toContain('模块条数，不是报警数量')
    const schema = JSON.stringify(tool.output.schema)
    for (const label of ['模块字典记录ID', '模块名称', '模块编码']) expect(schema).toContain(label)
    for (const key of ['moduleType', 'moduleTypeName', 'subModuleType', 'subModuleTypeName']) expect(schema).not.toContain(`"${key}"`)
  })

  it('gives the model a concise readable track summary and preserves full presentation data', () => {
    const tool = createTool(trackSpec, {} as ClosedoffGateway, config, () => {})
    const value = {
      ok: true,
      data: [{
        vehicleNo: '渝D37920',
        points: [
          { longitude: 106, latitude: 29, height: 336.9, pointTime: 1788324093371 },
          { longitude: 106.0001, latitude: 29, height: 338.1, pointTime: 1788324153371 },
          { longitude: 106.002, latitude: 29, height: 391.8, pointTime: 1788324213371 },
        ],
      }],
      devices: {
        ok: true,
        data: [
          {
            id: 'camera-a', groupId: 'group-a', groupName: '南门设备组', deviceName: '南门摄像头',
            plottingConfigData: { plottingData: JSON.stringify([{ points: [{ position: [106, 29, 336.9] }] }]) },
          },
          {
            id: 'camera-b', groupId: 'group-b', groupName: '仓储区设备组', deviceName: '仓储区摄像头',
            plottingConfigData: { plottingData: JSON.stringify([{ points: [{ position: [106.002, 29, 391.8] }] }]) },
          },
        ],
      },
    }

    expect(tool.output.render({}, value)).toEqual([{
      type: 'text',
      text: '轨迹数据已加载：车辆 渝D37920；轨迹点 3 个；实际轨迹时间 2026-09-02 12:41:33 至 2026-09-02 12:43:33；高度约 336.9 至 391.8 米；轨迹附近设备组（按路线先后，共 2 个）：南门设备组、仓储区设备组；起点附近：南门设备组；终点附近：仓储区设备组；最长驻留估算：南门设备组 附近约 1 分钟；完整点位和设备组已交给轨迹地图展示。请基于这些事实补充园区管理分析；设备组名称表示轨迹线附近点位，不等于设备实际识别到车辆，驻留时长是离散定位点的保守估算，需结合摄像头抓拍核验。',
    }])
    expect(tool.output.presentationMeta?.({}, value)).toEqual({ api: '/track', value })
    expect(validateJsonSchemaValue(tool.output.schema, {
      api: '/track', ok: true, data: [{ vehicleNo: '渝D37920', points: [{ longitude: '106', latitude: 29 }] }],
      devices: { ok: false, errCode: 500, message: '设备查询失败', elapsedMs: 1 }, elapsedMs: 2,
    })).toEqual([])
  })

  it('loads devices as part of one vehicle-track execution', async () => {
    const call = vi.fn(async (spec: ToolSpec, _input: unknown) => spec.name === 'closedoff_vehicle_track'
      ? { api: '/track', ok: true, elapsedMs: 1, data: [] }
      : { api: '/device/page', ok: true, elapsedMs: 1, data: [{ groupId: 'group-a' }] })
    const tool = createTool(trackSpec, { call } as unknown as ClosedoffGateway, config, () => {})

    const result = await tool.execute({ vehicleNo: '渝D37920' }, { signal: new AbortController().signal } as never)

    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[1]?.[1]).toEqual({ pageIndex: 1, pageSize: 500 })
    expect(result).toMatchObject({
      ok: true,
      devices: { ok: true, data: [{ groupId: 'group-a' }] },
    })
  })

  it('keeps the proven nested park overview and dynamic reservation timeline for model analysis', () => {
    const parkSpec = TOOL_SPECS.find(spec => spec.name === 'closedoff_park_status')!
    const park = createTool(parkSpec, {} as ClosedoffGateway, config, () => {}).output.render({}, {
      api: parkSpec.path, ok: true, elapsedMs: 1,
      data: {
        personInPark: 3, personInToday: 8,
        vehicles: [{ vehicleType: 'hazmat', typeName: '危化车辆', currentInPark: 2, inToday: 4, outToday: 2, capacity: 30, secret: 'drop' }],
        goods: [{ goodsType: 'hazmat', typeName: '危化品', inTons: 12.5, outTons: 6, typeCount: 2 }],
        hazmatHourly: [0, 1, 2], hazwasteHourly: [0, 0, 1], normalHourly: [2, 'https://private.invalid/hourly', 4],
      },
    })
    const parkValue = JSON.parse(park[0]?.type === 'text' ? park[0].text : '')
    expect(parkValue.data).toMatchObject({
      vehicles: [{ typeName: '危化车辆', currentInPark: 2 }],
      goods: [{ typeName: '危化品', inTons: 12.5 }],
      hazmatHourly: [0, 1, 2],
    })
    expect(JSON.stringify(parkValue)).not.toContain('secret')
    expect(parkValue.data.normalHourly).toEqual([2, '[地址已隐藏]', 4])

    const todaySpec = TOOL_SPECS.find(spec => spec.name === 'closedoff_today_reservation')!
    const today = createTool(todaySpec, {} as ClosedoffGateway, config, () => {}).output.render({}, {
      api: todaySpec.path, ok: true, elapsedMs: 1,
      data: { personNum: 1, timeLine: [{ '09': { personNum: 1, commonCarNum: 2, unknown: 9 } }, { invalid: { personNum: 99 } }] },
    })
    const todayValue = JSON.parse(today[0]?.type === 'text' ? today[0].text : '')
    expect(todayValue.data.timeLine).toEqual([{ '09': { personNum: 1, commonCarNum: 2 } }])
  })

  it('projects all five reservation progress payloads with type-specific allowlists', () => {
    const spec = TOOL_SPECS.find(item => item.name === 'closedoff_reservation_detail')!
    const rendered = createTool(spec, {} as ClosedoffGateway, config, () => {}).output.render({}, {
      api: spec.path, ok: true, elapsedMs: 1,
      data: [
        { typeCode: 0, time: '2026-09-04 08:00:00', specificData: { carNumb: '渝A00000', reservationType: 3, companyName: '示例企业', submitUserPhone: '13800138000', internal: 'drop' } },
        { typeCode: 1, time: '2026-09-04 08:10:00', specificData: { checkStatus: 1, checkDesc: '企业通过', checkUserName: '审核员', checkUserPhone: '13800138000', unknown: 'drop' } },
        { typeCode: 2, time: '2026-09-04 08:20:00', specificData: { checkStatus: 1, validityBeginTime: '2026-09-04 09:00:00', validityEndTime: '2026-09-04 18:00:00' } },
        { typeCode: 3, time: '2026-09-04 08:30:00', specificData: [{ checkItemName: '灭火器', checkMethod: '1', checkResult: '1', checkFile: '/media/play?token=x', remarks: '正常' }] },
        { typeCode: 4, time: '2026-09-04 08:40:00', specificData: { securityCheckResults: '0', securityCheckTime: '2026-09-04 08:39:00', createBy: '候检员', securityCheckList: [{ checkItemName: '静电接地', checkResult: '0', checkFile: 'https://private.invalid/a' }], hidden: 'drop' } },
      ],
    })
    const value = JSON.parse(rendered[0]?.type === 'text' ? rendered[0].text : '')

    expect(value.data).toEqual([
      { typeCode: 0, time: '2026-09-04 08:00:00', specificData: { reservationType: 3, carNumb: '渝A00000', companyName: '示例企业' } },
      { typeCode: 1, time: '2026-09-04 08:10:00', specificData: { checkStatus: 1, checkDesc: '企业通过', checkUserName: '审核员', checkUserPhone: '138****8000' } },
      { typeCode: 2, time: '2026-09-04 08:20:00', specificData: { checkStatus: 1, validityBeginTime: '2026-09-04 09:00:00', validityEndTime: '2026-09-04 18:00:00' } },
      { typeCode: 3, time: '2026-09-04 08:30:00', specificData: [{ checkItemName: '灭火器', checkMethod: '1', checkResult: '1', remarks: '正常' }] },
      { typeCode: 4, time: '2026-09-04 08:40:00', specificData: { securityCheckResults: '0', securityCheckTime: '2026-09-04 08:39:00', createBy: '候检员', securityCheckList: [{ checkItemName: '静电接地', checkResult: '0' }] } },
    ])
  })

  it('keeps vehicle media in presentation metadata but not model-visible text', () => {
    const spec = TOOL_SPECS.find(item => item.name === 'closedoff_vehicle_stream')!
    const tool = createTool(spec, {} as ClosedoffGateway, config, () => {})
    const value = {
      api: spec.path, ok: true, elapsedMs: 1,
      data: [{ device_id: 'vehicle-key', start_time: '2026-09-04 09:00:00', time_len: 12, path: '/media/secret.flv', url: 'wss://private.invalid/live' }],
    }
    const rendered = tool.output.render({}, value)
    const text = rendered[0]?.type === 'text' ? rendered[0].text : ''

    expect(text).toContain('vehicle-key')
    expect(text).not.toContain('private.invalid')
    expect(text).not.toContain('/media/secret.flv')
    expect(tool.output.presentationMeta?.({}, value)).toEqual({ api: spec.path, value })
  })
})
