import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { analyzeTrackByDeviceGroups, collectOpaqueResultValues, extractCards, extractDeviceGroups, extractTrackPoints, extractVehicleMediaFromResult, filterDeviceGroupsNearTrack, gatewayResultFailed, projectHistory, projectReasoning } from '../src/presentation.ts'
import { TOOL_SPECS } from '../src/specs.ts'
import { extractTrackVehicleNoFromResult } from '../src/presentation.ts'

describe('Web projections', () => {
  it('keeps vehicle identity with its point source and handles old results without a plate', () => {
    const point = { longitude: 106, latitude: 29 }
    const result = JSON.stringify({ data: [{ vehicleNo: '渝A12345', points: [point] }] })
    expect(extractTrackVehicleNoFromResult(result, undefined)).toBe('渝A12345')
    expect(extractTrackVehicleNoFromResult(result, { value: { data: [{ vehicleNo: ' 渝B67890 ', points: [point] }] } })).toBe('渝B67890')
    expect(extractTrackVehicleNoFromResult(result, { value: { data: [{ points: [point] }] } })).toBe('')
    expect(extractTrackVehicleNoFromResult('{truncated', undefined)).toBe('')
  })

  it('limits and normalizes trajectory points', () => {
    const points = extractTrackPoints(JSON.stringify({
      data: [{ points: [
        { longitude: '115.123', latitude: 28.456, height: 7, pointTime: '2026-09-03 10:00:00' },
        { longitude: 'not-a-number', latitude: 28.5, height: 8 },
      ] }],
    }))
    expect(points).toEqual([{ lon: 115.123, lat: 28.456, h: 7, t: '2026-09-03 10:00:00' }])
  })

  it('samples long trajectories while preserving both endpoints', () => {
    const source = Array.from({ length: 1001 }, (_, index) => ({ longitude: 106 + index / 10_000, latitude: 29, height: index }))
    const points = extractTrackPoints(JSON.stringify({ data: [{ points: source }] }))
    expect(points).toHaveLength(800)
    expect(points[0]?.h).toBe(0)
    expect(points.at(-1)?.h).toBe(1000)
  })

  it('restores a trajectory from presentation metadata when model text was truncated', () => {
    const events = [
      {
        type: 'tool/call',
        time: 1,
        data: { callId: 'track-1', name: 'closedoff_vehicle_track' },
      },
      {
        type: 'tool/result',
        time: 2,
        data: {
          message: {
            content: [{
              toolCallId: 'track-1',
              content: [{ type: 'text', text: '{\n  "api": "/track",\n  "data": [ /* truncated */' }],
            }],
          },
          meta: {
            api: '/track',
            value: {
              ok: true,
              data: [{ vehicleNo: '渝A12345', points: [{ longitude: 1.8532, latitude: 0.5622, height: 483.3, pointTime: 1788324093371 }] }],
              devices: {
                ok: true,
                data: [{
                  id: 'camera-1', groupId: 'group-1', groupName: '轨迹附近设备组', deviceName: '摄像头01',
                  plottingConfigData: {
                    plottingData: JSON.stringify([{ points: [{ position: [1.8532, 0.5622, 483.3] }] }]),
                  },
                }],
              },
            },
          },
        },
      },
    ] as unknown as SessionEvent[]

    const history = projectHistory(events)

    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      role: 'assistant',
      tracks: {
        'track-1': {
          vehicleNo: '渝A12345',
          points: [{ lon: 1.8532, lat: 0.5622, h: 483.3, t: '1788324093371' }],
          groups: [{ groupId: 'group-1', groupName: '轨迹附近设备组' }],
        },
      },
    })
  })

  it('groups plotted devices by device group and keeps every child device', () => {
    const groups = extractDeviceGroups({
      data: [
        {
          id: 'camera-1', groupId: 'pole-1', groupName: '1号立杆', deviceName: '摄像头01', deviceCode: '011', status: 1,
          deviceType: 6, deviceIp: '10.0.0.11', videoAddress: 'wss://video.example.test/live/011.flv',
          cameraCode: 'camera-011', lastHeartbeatTime: '2026-09-03 15:00:00',
          plottingConfigData: {
            plottingData: JSON.stringify([{ points: [{ position: [1.8532, 0.5622, 483.3] }] }]),
          },
        },
        {
          id: 'camera-2', groupId: 'pole-1', groupName: '1号立杆', deviceName: '摄像头02', deviceCode: '012', status: 0,
          accessAddress: 'ws://10.0.0.12/live/012.flv',
          plottingConfigData: {
            plottingData: JSON.stringify([{ points: [{ position: [1.8532, 0.5622, 483.3] }] }]),
          },
        },
        {
          id: 'camera-3', groupId: 'pole-2', groupName: '2号立杆', deviceName: '摄像头03', deviceCode: '013', status: 1,
          plottingConfigData: {
            plottingData: JSON.stringify([{ points: [{ position: [1.854, 0.563, 490] }] }]),
          },
        },
        { id: 'unplotted', groupId: 'pole-3', groupName: '无坐标组', deviceName: '摄像头04' },
      ],
    })

    expect(groups).toEqual([
      {
        groupId: 'pole-1', groupName: '1号立杆', lon: 1.8532, lat: 0.5622, h: 483.3,
        devices: [
          {
            id: 'camera-1', name: '摄像头01', code: '011', status: 1, deviceType: 6,
            deviceIp: '10.0.0.11', videoAddress: 'wss://video.example.test/live/011.flv',
            cameraCode: 'camera-011', lastHeartbeatTime: '2026-09-03 15:00:00',
          },
          { id: 'camera-2', name: '摄像头02', code: '012', status: 0, accessAddress: 'ws://10.0.0.12/live/012.flv' },
        ],
      },
      {
        groupId: 'pole-2', groupName: '2号立杆', lon: 1.854, lat: 0.563, h: 490,
        devices: [{ id: 'camera-3', name: '摄像头03', code: '013', status: 1 }],
      },
    ])
  })

  it('keeps only device groups within the configured distance from the trajectory line', () => {
    const groups = [
      { groupId: 'near', groupName: '近点', lon: 106.005, lat: 29.0003, h: 0, devices: [] },
      { groupId: 'far', groupName: '远点', lon: 106.005, lat: 29.002, h: 0, devices: [] },
      { groupId: 'radian', groupName: '弧度点', lon: 106.008 * Math.PI / 180, lat: 29 * Math.PI / 180, h: 0, devices: [] },
    ]

    expect(filterDeviceGroupsNearTrack(groups, [
      { lon: 106, lat: 29, h: 0 },
      { lon: 106.01, lat: 29, h: 0 },
    ], 100).map(group => group.groupId)).toEqual(['near', 'radian'])
  })

  it('orders nearby groups and estimates the longest continuous stay conservatively', () => {
    const groups = [
      { groupId: 'end', groupName: '终点组', lon: 106.002, lat: 29, h: 0, devices: [] },
      { groupId: 'start', groupName: '起点组', lon: 106, lat: 29, h: 0, devices: [] },
    ]
    const analysis = analyzeTrackByDeviceGroups([
      { lon: 106, lat: 29, h: 0, t: '1788324093371' },
      { lon: 106.0001, lat: 29, h: 0, t: '1788324153371' },
      { lon: 106.002, lat: 29, h: 0, t: '1788324213371' },
      { lon: 106.002, lat: 29, h: 0, t: '1788324813371' },
    ], groups, 100, 300_000)

    expect(analysis.groups.map(group => group.groupName)).toEqual(['起点组', '终点组'])
    expect(analysis.startGroup?.groupName).toBe('起点组')
    expect(analysis.endGroup?.groupName).toBe('终点组')
    expect(analysis.longestStay).toMatchObject({ group: { groupName: '起点组' }, durationMs: 60_000 })
    expect(analysis.excludedGapCount).toBe(1)
  })

  it('projects business fields without technical records', () => {
    const payload = extractCards('closedoff_warning_page', JSON.stringify({
      data: [{ title: '车辆越界', companyName: '示例企业', warningStatus: '报警', privateField: 'must-not-render' }],
    }))
    expect(payload?.cards[0]?.title).toBe('车辆越界')
    expect(payload?.cards[0]?.fields).toEqual(expect.arrayContaining([
      { k: '所属企业', v: '示例企业', tone: '' },
      { k: '状态', v: '报警', tone: 'red' },
    ]))
    expect(JSON.stringify(payload)).not.toContain('must-not-render')
  })

  it('shows warning module names and codes while keeping dictionary ids and unknown fields out of cards', () => {
    const payload = extractCards('closedoff_warning_module_list', JSON.stringify({
      data: [
        { id: 'module-fixture-1', name: '车辆报警', code: 'vehicle-fixture', secret: 'must-not-render' },
        { id: 'module-fixture-2', name: '人员报警', code: 'person-fixture' },
      ],
    }))

    expect(payload).toMatchObject({
      group: 'risk', sourceLabel: '报警模块列表', state: 'data', count: 2, shown: 2, note: '',
      cards: [
        { title: '车辆报警', titleKey: 'name', fields: [{ k: '模块编码', v: 'vehicle-fixture', tone: '' }] },
        { title: '人员报警', titleKey: 'name', fields: [{ k: '模块编码', v: 'person-fixture', tone: '' }] },
      ],
    })
    expect(JSON.stringify(payload)).not.toContain('module-fixture-')
    expect(JSON.stringify(payload)).not.toContain('must-not-render')
  })

  it('renders informative cards for common statistics and control-area queries', () => {
    const cases = [
      ['closedoff_control_area_page', { data: [{ controlName: '核心罐区', controlType: '1', remarks: '重点巡检' }] }],
      ['closedoff_control_area_stats', { data: [{ controlType: 1, controlAreaCount: 3, abnormalInspectionCount: 1, alarmCount: 2 }] }],
      ['closedoff_warning_module_list', { data: [{ id: 'module-fixture', name: '车辆报警', code: 'vehicle-fixture' }] }],
      ['closedoff_reservation_stats', { data: { todayPending: 4, todayCompleted: 12, avgProcessMinutes: 8, passRate: '92%' } }],
    ] as const

    for (const [tool, result] of cases) {
      const payload = extractCards(tool, JSON.stringify(result))
      expect(payload?.state).toBe('data')
      expect(payload?.cards.length).toBeGreaterThan(0)
      expect(payload?.cards.every(card => card.title !== '记录' && card.fields.length > 0)).toBe(true)
    }

    expect(extractCards('closedoff_control_area_page', JSON.stringify(cases[0][1]))?.cards[0]).toEqual({
      title: '核心罐区',
      titleKey: 'controlName',
      fields: [
        { k: '控制区类型', v: '核心控制区', tone: '' },
        { k: '备注', v: '重点巡检', tone: '' },
      ],
    })
  })

  it('keeps automatic card fallback inside every Tool result schema', () => {
    const blocked = new Set(['id', 'reservationId', 'districtId', 'bizDataId', 'groupId', 'oldData', 'newData', 'plottingConfigData', 'plottingData', 'specificData', 'deviceList', 'points', 'data'])
    for (const spec of TOOL_SPECS) {
      const record = Object.fromEntries(spec.result.fields.map(([key]) => [key, blocked.has(key) ? '{"private":true}' : `value-${key}`]))
      Object.assign(record, Object.fromEntries((spec.result.runtimeFields ?? []).map(([key]) => [key, 'runtime-private'])), { unknownSentinel: 'unknown-private' })
      const payload = extractCards(spec.name, JSON.stringify({ totalCount: 1, data: [record] }))
      expect(payload?.state, spec.name).toBe('data')
      expect(payload?.count, spec.name).toBe(1)
      expect(payload?.cards.every(card => card.title !== '' && card.title !== '记录'), spec.name).toBe(true)
      const serialized = JSON.stringify(payload)
      expect(serialized, spec.name).not.toContain('runtime-private')
      expect(serialized, spec.name).not.toContain('unknown-private')
      expect(serialized, spec.name).not.toContain('{"private":true}')
    }
  })

  it('keeps data truth when a result has no safe card fields', () => {
    expect(extractCards('closedoff_plotting_config_one', JSON.stringify({
      totalCount: 1,
      data: [{ id: 'record-private', bizDataId: 'business-private', plottingData: '{"points":[1,2,3]}' }],
    }))).toMatchObject({
      state: 'data', count: 1, shown: 0, cards: [], note: '已返回数据，暂无适合卡片展示的字段',
    })
  })

  it('uses the owning Tool schema description for automatic field labels', () => {
    expect(extractCards('closedoff_parking_area_page', JSON.stringify({
      data: [{ parkingAreaName: '示例停车区', parkingAreaAttribute: '1', parkingSpaceCount: 20, parkedCount: 8 }],
    }))?.cards[0]).toEqual({
      title: '示例停车区',
      titleKey: 'parkingAreaName',
      fields: [
        { k: '停车区属性', v: '1', tone: '' },
        { k: '车位总数', v: '20', tone: '' },
        { k: '已停车位数', v: '8', tone: '' },
      ],
    })
  })

  it('projects vehicle comprehensive counters and business enums', () => {
    const payload = extractCards('closedoff_vehicle_comprehensive_page', JSON.stringify({
      data: [{
        carNumb: '浙A00000', validityStatus: 0, carCategory: 3, carNumbColour: '黄色',
        accessCount: 8, inCount: 4, outCount: 4, violationCount: 1, blackCount: 0,
        trailer: '浙A0000挂', id: 'private-id',
      }],
    }))

    expect(payload?.cards[0]).toEqual({
      title: '浙A00000',
      titleKey: 'carNumb',
      fields: [
        { k: '授权状态', v: '白名单', tone: '' },
        { k: '车辆类型', v: '危化车', tone: '' },
        { k: '车牌颜色', v: '黄色', tone: '' },
        { k: '挂车牌号', v: '浙A0000挂', tone: '' },
        { k: '通行次数', v: '8', tone: '' },
        { k: '入园次数', v: '4', tone: '' },
        { k: '出园次数', v: '4', tone: '' },
        { k: '违章次数', v: '1', tone: '' },
        { k: '黑名单次数', v: '0', tone: '' },
      ],
    })
    expect(JSON.stringify(payload)).not.toContain('private-id')
  })

  it('projects nested gate records as informative cards', () => {
    const payload = extractCards('closedoff_gate_records_by_car', JSON.stringify({
      data: [{
        startDate: '2026-08-07 10:47:37',
        endDate: null,
        data: [
          {
            id: 'private-id', address: 'C区卡口1-入口', dateTime: '2026-08-07 10:47:37',
            type: 2, headPicUrl: 'https://private.invalid/image.jpg', violationTypeName: null, remark: null,
          },
          {
            id: 'private-id-2', address: 'C区卡口1-出口', dateTime: '2026-08-07 10:57:22',
            type: 1, headPicUrl: 'https://private.invalid/image-2.jpg', violationTypeName: null, remark: null,
          },
        ],
      }],
    }))

    expect(payload?.count).toBe(2)
    expect(payload?.cards).toEqual([
      {
        title: 'C区卡口1-入口',
        titleKey: 'address',
        fields: [
          { k: '通行时间', v: '2026-08-07 10:47:37', tone: '' },
          { k: '方向', v: '入园', tone: '' },
        ],
      },
      {
        title: 'C区卡口1-出口',
        titleKey: 'address',
        fields: [
          { k: '通行时间', v: '2026-08-07 10:57:22', tone: '' },
          { k: '方向', v: '出园', tone: '' },
        ],
      },
    ])
    expect(JSON.stringify(payload)).not.toContain('private-id')
    expect(JSON.stringify(payload)).not.toContain('private.invalid')
  })

  it('projects the complete whitelist business detail used by the UI', () => {
    const payload = extractCards('closedoff_white_page', JSON.stringify({
      totalCount: 1,
      data: [{
        id: 'internal-id', carNumb: '浙A00000', realName: '刘某', sex: 1,
        idCard: '110101199001011234', userPhone: '13800138000', companyName: '示例园区',
        sourceType: 3, currentStatus: 1,
        validityBeginTime: '2026-08-01 00:00:00', validityEndTime: '2099-08-01 23:59:59',
        companyCheckStatus: 1, submitBy: '提交人', submitUserPhone: '13900139000',
        submitDate: '2026-08-07 17:04:35', faceUrl: 'https://private.invalid/face.jpg',
      }],
    }))

    expect(payload?.cards[0]?.fields).toEqual([
      { k: '关联人员', v: '刘某', tone: '' },
      { k: '性别', v: '男', tone: '' },
      { k: '身份证号', v: '110101********1234', tone: '' },
      { k: '联系电话', v: '138****8000', tone: '' },
      { k: '所属企业', v: '示例园区', tone: '' },
      { k: '申请来源', v: '园区申请', tone: '' },
      { k: '当前状态', v: '生效中', tone: 'green' },
      { k: '有效期开始', v: '2026-08-01 00:00:00', tone: '' },
      { k: '有效期结束', v: '2099-08-01 23:59:59', tone: '' },
      { k: '企业审核', v: '通过', tone: 'green' },
      { k: '提交人', v: '提交人', tone: '' },
      { k: '提交人电话', v: '139****9000', tone: '' },
      { k: '提交时间', v: '2026-08-07 17:04:35', tone: '' },
    ])
    expect(JSON.stringify(payload)).not.toContain('internal-id')
    expect(JSON.stringify(payload)).not.toContain('private.invalid')
  })

  it('preserves an empty result as a structured card block', () => {
    expect(extractCards('closedoff_black_page', JSON.stringify({ totalCount: 0, data: [] }))).toEqual({
      tool: 'closedoff_black_page', group: 'authorization', variant: 'records', sourceLabel: '黑名单',
      state: 'empty', count: 0, shown: 0, note: '', cards: [],
    })
  })

  it('does not color negative and pending states as successful', () => {
    const payload = extractCards('closedoff_white_page', JSON.stringify({
      data: [{ carNumb: '渝A00000', currentStatus: 0, companyCheckStatus: 2 }],
    }))
    expect(payload?.cards[0]?.fields).toEqual(expect.arrayContaining([
      { k: '当前状态', v: '未生效', tone: 'orange' },
      { k: '企业审核', v: '不通过', tone: 'red' },
    ]))
  })

  it('recognizes handled gateway failures for live and restored tool status', () => {
    expect(gatewayResultFailed('{"ok":false,"message":"业务接口失败"}')).toBe(true)
    expect(gatewayResultFailed('{"ok":true,"data":[]}')).toBe(false)
  })

  it('projects all five reservation progress stages from their real response forms', () => {
    const payload = extractCards('closedoff_reservation_detail', JSON.stringify({
      data: [
        { typeCode: 0, time: '2026-09-04 08:00:00', specificData: { carNumb: '渝A00000', companyName: '示例企业', reservationType: 3, internalValue: 'drop-me' } },
        { typeCode: 1, time: '2026-09-04 08:10:00', specificData: { checkStatus: 1, checkDesc: '企业通过', checkUserName: '企业审核员' } },
        { typeCode: 2, time: '2026-09-04 08:20:00', specificData: { checkStatus: 1, checkDesc: '园区通过', validityBeginTime: '2026-09-04 10:00:00', validityEndTime: '2026-09-04 18:00:00' } },
        { typeCode: 3, time: '2026-09-04 08:30:00', specificData: [{ checkItemName: '灭火器', checkMethod: '1', checkResult: '1', remarks: '正常' }, { checkItemName: '静电接地', checkMethod: '2', checkResult: '0' }] },
        { typeCode: 4, time: '2026-09-04 08:40:00', specificData: { securityCheckResults: '0', securityCheckTime: '2026-09-04 08:39:00', createBy: '候检员', securityCheckList: [{ checkItemName: '防护用品', checkResult: '1' }] } },
      ],
    }))

    expect(payload?.cards.map(card => card.title)).toEqual(['发起预约', '企业审批', '园区审批', '司机自检', '园区抽查'])
    expect(payload?.cards[0]?.fields).toEqual(expect.arrayContaining([
      { k: '车牌', v: '渝A00000', tone: '' },
      { k: '预约类型', v: '危化车', tone: '' },
    ]))
    expect(payload?.cards[1]).toMatchObject({
      fields: expect.arrayContaining([
        { k: '审核状态', v: '通过', tone: 'green' },
        { k: '审核说明', v: '企业通过', tone: 'green' },
      ]),
    })
    expect(payload?.cards[3]?.fields).toEqual(expect.arrayContaining([
      { k: '检查项', v: '灭火器、静电接地', tone: '' },
      { k: '检查结果', v: '合格 1 项，不合格 1 项', tone: '' },
      { k: '记录手段', v: '拍照、录像', tone: '' },
    ]))
    expect(payload?.cards[4]?.fields).toEqual(expect.arrayContaining([
      { k: '抽检结果', v: '不合格', tone: '' },
      { k: '检查项', v: '防护用品', tone: '' },
    ]))
    expect(JSON.stringify(payload)).not.toContain('drop-me')
  })

  it('extracts vehicle media only from presentation metadata', () => {
    expect(extractVehicleMediaFromResult({
      value: { data: [{ device_id: 'vehicle-key', start_time: '2026-09-04 09:00:00', time_len: 12, url: 'wss://private.invalid/live' }] },
    })).toEqual([{
      deviceId: 'vehicle-key', startTime: '2026-09-04 09:00:00', timeLength: '12', mediaUrl: 'wss://private.invalid/live',
    }])
  })

  it('restores only display-safe reasoning and redacts sensitive assistant text', () => {
    const events = [
      {
        type: 'tool/result', time: 0,
        data: { message: { content: [{ toolCallId: 'lookup-1', content: [{ type: 'text', text: '{"data":[{"reservationId":"abcdef123456"}]}' }] }] } },
      },
      {
        type: 'assistant/attempt', time: 1, data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '核对预约ID: abcdef123456。联系电话 13800138000。' } }] } },
      {
        type: 'assistant/attempt', time: 2, data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 2, chunk: { type: 'text-delta', index: 1, text: '联系电话 13800138000，详情 https://private.invalid/a' } }] } },
      { type: 'turn/end', time: 3, data: { reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]

    const serialized = JSON.stringify(projectHistory(events))

    expect(serialized).toContain('thinking')
    expect(serialized).toContain('thinkingDone')
    expect(serialized).not.toContain('abcdef123456')
    expect(serialized).toContain('[内部标识已隐藏]')
    expect(serialized).toContain('138****8000')
    expect(serialized).toContain('[地址已隐藏]')
  })

  it('holds unstable reasoning tails and redacts every sensitive split', () => {
    const sensitive = ['13800138000', '500101199001011234', 'https://private.invalid/play?token=secret']
    for (const value of sensitive) {
      for (let index = 1; index < value.length; index += 1) {
        const first = projectReasoning(`正在核对 ${value.slice(0, index)}`, false)
        expect(first).not.toContain(value.slice(0, index))
        const complete = projectReasoning(`正在核对 ${value}。`, true)
        expect(complete).not.toContain(value)
      }
    }
    expect(projectReasoning('第一步已完成。第二步仍在生成', false)).toBe('第一步已完成。\n正在生成…')
    expect(projectReasoning('预约ID: abcdef123456。', true, ['abcdef123456'])).toBe('预约ID: [内部标识已隐藏]。')
    expect(collectOpaqueResultValues(JSON.stringify({ data: [{ id: 'abc', reservationId: 'reservation-1' }] }))).toEqual(['abc', 'reservation-1'])
  })

  it('joins reasoning steps without marking the turn done at an assistant message', () => {
    const active = projectHistory([
      { type: 'assistant/attempt', time: 1, data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '第一步。' } }] } },
      { type: 'assistant/message', time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '第一步完成。' }] } } },
      { type: 'assistant/attempt', time: 3, data: { turn: 1, step: 2, stream: [{ type: 'chunk', time: 3, chunk: { type: 'reasoning-delta', index: 0, text: '第二步仍在生成' } }] } },
    ] as unknown as SessionEvent[])[0]
    expect(active).toMatchObject({ role: 'assistant', thinkingDone: false, thinking: '第一步完成。\n正在生成…' })

    const completed = projectHistory([
      { type: 'assistant/attempt', time: 1, data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'reasoning-delta', index: 0, text: '第一步。' } }] } },
      { type: 'assistant/message', time: 2, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '第一步完成。' }] } } },
      { type: 'assistant/attempt', time: 3, data: { turn: 1, step: 2, stream: [{ type: 'chunk', time: 3, chunk: { type: 'reasoning-delta', index: 0, text: '第二步完成' } }] } },
      { type: 'turn/end', time: 4, data: { reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[])[0]
    expect(completed).toMatchObject({ role: 'assistant', thinkingDone: true, thinking: '第一步完成。\n第二步完成' })
  })

  it('uses the durable assistant message when text chunks are unavailable', () => {
    const events = [
      {
        type: 'assistant/message', time: 1,
        data: { message: { content: [{ type: 'text', text: '最终结论 13800138000' }] } },
      },
      { type: 'turn/end', time: 2, data: { reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]

    expect(projectHistory(events)[0]?.text).toBe('最终结论 138****8000')
  })

  it('preserves an interrupted turn reason when query results exist without a final answer', () => {
    const events = [
      { type: 'tool/call', time: 1, data: { callId: 'track-1', name: 'closedoff_vehicle_track' } },
      {
        type: 'tool/result', time: 2,
        data: {
          message: { content: [{ toolCallId: 'track-1', content: [{ type: 'text', text: '{"ok":true,"data":[]}' }] }] },
        },
      },
      { type: 'turn/end', time: 3, data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
    ] as unknown as SessionEvent[]

    expect(projectHistory(events)[0]).toMatchObject({
      role: 'assistant', text: '', done: true, finishReason: 'aborted',
    })
  })

  it('restores the official action-row metadata from one completed turn', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: 101, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '查询车辆' }] } },
      { type: 'step/start', seq: 2, time: 110, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 3, time: 111, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message', seq: 4, time: 160,
        data: {
          turn: 1,
          step: 1,
          message: { id: 'message-1', source: { provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text: '查询完成' }] },
          stream: [{ type: 'chunk', time: 120, chunk: { type: 'text-delta', index: 0, text: '查询完成' } }],
          usage: { inputTokens: 120, outputTokens: 30, totalTokens: 180, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 8 },
        },
      },
      { type: 'step/end', seq: 5, time: 200, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 260, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]

    expect(projectHistory(events)[1]).toMatchObject({
      role: 'assistant',
      text: '查询完成',
      time: 260,
      done: true,
      finishReason: 'completed',
      messageId: 'message-1',
      branchSeq: 6,
      completedAt: 260,
      runMs: 160,
      ttftMs: 10,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 180,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 8,
      },
    })
  })

  it('includes every billed retry attempt in restored turn usage', () => {
    const events = [
      { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 110, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/attempt', seq: 2, time: 120, data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 120, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 } } }] } },
      { type: 'llm/retry', seq: 3, time: 130, data: { turn: 1, step: 1 } },
      { type: 'llm/retry-started', seq: 4, time: 140, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 5, time: 141, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message', seq: 6, time: 160,
        data: {
          turn: 1,
          step: 1,
          message: { id: 'message-2', source: { provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text: '完成' }] },
          stream: [{ type: 'chunk', time: 150, chunk: { type: 'text-delta', index: 0, text: '完成' } }],
          usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23, cacheReadTokens: 0, cacheWriteTokens: 0 },
        },
      },
      { type: 'step/end', seq: 7, time: 170, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 8, time: 180, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]

    expect(projectHistory(events)[0]).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  // 从 `tests/assistant-stream.test.ts` 迁入（盘点文档 R2：该用例只调 `projectHistory`，
  // 与实时通道无关，属于判据③要保的逐字等价行为）。断言未改。
  it.each(['completed', 'aborted', 'error'])('restores %s embedded streams without changing durable branch offsets', reason => {
    const events = [
      { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 110, data: { step: 1, turn: 1 } },
      { type: reason === 'completed' ? 'assistant/message' : 'assistant/attempt', seq: 2, time: 180, data: {
        turn: 1, step: 1,
        stream: [
          { type: 'chunk', time: 120, chunk: { type: 'reasoning-delta', index: 0, text: '查询完成。' } },
          { type: 'chunk', time: 130, chunk: { type: 'tool-call-delta', index: 1, id: 'call', name: 'closedoff_vehicle_track', argumentsDelta: '{}' } },
          { type: 'chunk', time: 150, chunk: { type: 'text-delta', index: 2, text: '已返回' } },
        ],
        ...(reason === 'completed' ? { message: { id: 'answer', source: { provider: 'deepseek', model: 'test' }, content: [{ type: 'text', text: '已返回完整结果' }, { type: 'reasoning', text: '查询完成。' }] } } : {}),
      } },
      { type: 'turn/end', seq: 3, time: 200, data: { reason: { kind: reason } } },
    ] as unknown as SessionEvent[]
    expect(projectHistory(events)[0]).toMatchObject({
      text: reason === 'completed' ? '已返回完整结果' : '已返回',
      thinking: '查询完成。', thinkingDone: true, done: true,
      finishReason: reason, ttftMs: 10, runMs: 100, branchSeq: 3,
      tools: [{ callId: 'call', name: 'closedoff_vehicle_track' }],
    })
  })
})
