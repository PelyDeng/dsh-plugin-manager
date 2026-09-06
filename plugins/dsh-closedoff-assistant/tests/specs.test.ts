import { describe, expect, it } from 'vitest'
import { TOOL_SPECS } from '../src/specs.ts'
import { validateToolSpecs } from '../src/tools.ts'

describe('approved tool catalog', () => {
  it('contains 37 unique read-only queries', () => {
    expect(() => validateToolSpecs()).not.toThrow()
    expect(TOOL_SPECS).toHaveLength(37)
    expect(new Set(TOOL_SPECS.map(spec => spec.name)).size).toBe(37)
    expect(TOOL_SPECS.every(spec => spec.method === 'GET' || spec.method === 'POST')).toBe(true)
    expect(TOOL_SPECS.every(spec => spec.result.dataKind === 'unknown' || spec.result.fields.length > 0)).toBe(true)
    expect(TOOL_SPECS.every(spec => new Set(spec.result.fields.map(([key]) => key)).size === spec.result.fields.length)).toBe(true)
    expect(TOOL_SPECS).toContainEqual(expect.objectContaining({
      name: 'closedoff_device_page', method: 'POST', path: '/closed-off/device/page',
    }))
    expect(TOOL_SPECS.find(spec => spec.name === 'closedoff_device_page')?.result.runtimeFields?.map(([key]) => key)).toEqual([
      'id', 'groupId', 'deviceIp', 'videoAddress', 'accessAddress', 'cameraCode',
    ])
    expect(TOOL_SPECS.find(spec => spec.name === 'closedoff_white_page')?.result.fields.map(([key]) => key)).toEqual(expect.arrayContaining([
      'sex', 'idCard', 'userPhone', 'submitBy', 'submitUserPhone', 'submitDate',
    ]))
    expect(TOOL_SPECS.find(spec => spec.name === 'closedoff_vehicle_stream')?.result.runtimeFields?.map(([key]) => key)).toEqual(['path', 'url'])
  })

  it('records evidence-sensitive data cardinality instead of inferring it from endpoint names', () => {
    expect(TOOL_SPECS.find(spec => spec.name === 'closedoff_vehicle_location_page')?.result.dataKind).toBe('paged-object')
    expect(TOOL_SPECS.find(spec => spec.name === 'closedoff_reservation_detail')?.result.dataKind).toBe('list')
    expect(TOOL_SPECS.find(spec => spec.name === 'closedoff_warning_page')?.result.dataKind).toBe('unknown')
    expect(TOOL_SPECS.find(spec => spec.name === 'closedoff_vehicle_latest_positions')?.result.dataKind).toBe('unknown')
    expect(TOOL_SPECS.find(spec => spec.name === 'closedoff_warning_count_by_level')?.result.fields.map(([key]) => key)).toEqual([
      'warningStatus', 'redCount', 'orangeCount', 'yellowCount', 'blueCount',
    ])
  })

  it('rejects a catalog with an unsafe path', () => {
    const unsafe = TOOL_SPECS.map((spec, index) => index === 0 ? { ...spec, path: '/../secret' as `/${string}` } : spec)
    expect(() => validateToolSpecs(unsafe)).toThrow('invalid API path')
  })
})
