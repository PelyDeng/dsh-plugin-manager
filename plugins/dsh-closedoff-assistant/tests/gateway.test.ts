import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../src/config.ts'
import type { ClosedoffEnvironment } from '../src/env.ts'
import { ClosedoffGateway } from '../src/gateway.ts'
import type { ToolSpec } from '../src/specs.ts'

const config: Config = {
  accessMode: 'standalone', publicOrigin: '', authRecheckMs: 1000,
  reasoningEffort: 'low',
  terrainUrl: 'https://maps.example.test/terrain',
  tilesetUrl: 'https://maps.example.test/tileset.json',
  tilesetHeight: 60,
  trackDeviceRadiusMeters: 100,
  trackDwellMaxGapSeconds: 300,
  routePrefix: '/closedoff-qa',
  requestTimeoutMs: 20_000,
  toolTimeoutMs: 45_000,
  turnTimeoutMs: 480_000,
  maxPageSize: 500,
  maxQueryRangeDays: 30,
  maxRequestBodyBytes: 65_536,
  maxResponseBodyBytes: 2_097_152,
  maxActiveConversations: 50,
}

const environment: ClosedoffEnvironment = {
  baseUrl: 'https://closedoff.example.test/root/',
  credentials: {
    openClientId: 'open-id',
    openClientSecret: 'open-secret',
    appCode: 'app-code',
    appClientId: 'app-id',
    appClientSecret: 'app-secret',
    username: 'operator',
  },
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('ClosedoffGateway', () => {
  it('authenticates twice and applies an exact two-day vehicle range', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 3, 12, 0, 0))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: 'open-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { tokenValue: 'business-token', tokenTimeout: 3600 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new ClosedoffGateway(config, environment)
    const spec: ToolSpec = {
      name: 'closedoff_vehicle_track',
      displayName: '车辆轨迹分析',
      desc: 'track',
      method: 'GET',
      path: '/car/carLocation/historyTrack',
      result: { dataKind: 'list', fields: [['vehicleNo', '车牌']] },
      maxDays: 2,
      timeRanges: [{ startKey: 'startTime', endKey: 'endTime' }],
      params: [
        { key: 'vehicleNo', type: 'string', required: true, desc: 'plate' },
        { key: 'startTime', type: 'string', required: false, desc: 'start' },
        { key: 'endTime', type: 'string', required: false, desc: 'end' },
      ],
    }

    const result = await gateway.call(spec, { vehicleNo: '赣A00001' }, new AbortController().signal)

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const businessUrl = fetchMock.mock.calls[2]?.[0] as URL
    expect(businessUrl.pathname).toBe('/root/car/carLocation/historyTrack')
    expect(businessUrl.searchParams.get('vehicleNo')).toBe('赣A00001')
    expect(businessUrl.searchParams.get('startTime')).toBe('2026-09-01 12:00:00')
    expect(businessUrl.searchParams.get('endTime')).toBe('2026-09-03 12:00:00')
    expect(JSON.stringify(fetchMock.mock.calls[2])).not.toContain('app-secret')
  })

  it('preserves supplied times and does not add the unused ingress range', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: 'open-token' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { tokenValue: 'business-token', tokenTimeout: 3600 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [] })))
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new ClosedoffGateway(config, environment)
    const spec: ToolSpec = {
      name: 'closedoff_gate_access_page',
      displayName: '门禁出入记录',
      desc: 'access records',
      method: 'POST',
      path: '/access',
      result: { dataKind: 'list', fields: [['carNumb', '车牌']] },
      timeRanges: [
        { startKey: 'inDateBegin', endKey: 'inDateEnd' },
        { startKey: 'outDateBegin', endKey: 'outDateEnd' },
      ],
      params: [
        { key: 'inDateBegin', type: 'string', required: false, desc: 'in start' },
        { key: 'inDateEnd', type: 'string', required: false, desc: 'in end' },
        { key: 'outDateBegin', type: 'string', required: false, desc: 'out start' },
        { key: 'outDateEnd', type: 'string', required: false, desc: 'out end' },
      ],
    }

    await gateway.call(spec, {
      outDateBegin: '2026-09-02 10:15:30',
      outDateEnd: '2026-09-02 11:45:00',
    }, new AbortController().signal)

    const request = fetchMock.mock.calls[2]?.[1] as RequestInit
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>
    expect(payload).toEqual({
      outDateBegin: '2026-09-02 10:15:30',
      outDateEnd: '2026-09-02 11:45:00',
    })
  })

  it('rejects an invalid supplied date instead of normalizing it', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new ClosedoffGateway(config, environment)
    const spec: ToolSpec = {
      name: 'closedoff_vehicle_track',
      displayName: '车辆轨迹分析',
      desc: 'track',
      method: 'GET',
      path: '/track',
      result: { dataKind: 'list', fields: [['vehicleNo', '车牌']] },
      timeRanges: [{ startKey: 'startTime', endKey: 'endTime' }],
      params: [
        { key: 'startTime', type: 'string', required: false, desc: 'start' },
        { key: 'endTime', type: 'string', required: false, desc: 'end' },
      ],
    }

    const result = await gateway.call(spec, {
      startTime: '2026-02-31 10:00:00',
      endTime: '2026-03-01 10:00:00',
    }, new AbortController().signal)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('startTime is not a valid date and time')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects oversized pages without touching the network', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const gateway = new ClosedoffGateway(config, environment)
    const spec: ToolSpec = {
      name: 'closedoff_example',
      displayName: '查询示例',
      desc: 'example',
      method: 'GET',
      path: '/example',
      result: { dataKind: 'unknown', fields: [] },
      params: [{ key: 'pageSize', type: 'integer', required: true, desc: 'page size' }],
    }

    const result = await gateway.call(spec, { pageSize: 501 }, new AbortController().signal)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('pageSize')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
