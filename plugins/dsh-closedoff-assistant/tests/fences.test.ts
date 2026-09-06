import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { extractFences, fencesFromResult } from '../src/fences.ts'
import { createTool } from '../src/tools.ts'
import { TOOL_BY_NAME } from '../src/specs.ts'
import { Config } from '../src/config.ts'
import type { ClosedoffGateway } from '../src/gateway.ts'
import { projectHistory } from '../src/presentation.ts'
import { webTrajectory } from './web-source.ts'

const positions = [[107.1, 29.8, 300], [107.11, 29.8, 310], [107.11, 29.81, 320]]
const Cesium: typeof import('cesium') = createRequire(import.meta.url)('cesium')
const wall = { type: 'WallLayer', height: 40, fences: [{ name: '东区', positions }] }
const value = { ok: true, data: [{ controlName: '测试控制区', controlType: '3', plottingConfigData: { plottingData: JSON.stringify([wall]) } }], elapsedMs: 1 }

describe('electronic-fence presentation', () => {
  it('preserves every wall vertex and configured height from list and single-record queries', () => {
    const list = extractFences(value)
    expect(list).toEqual({ geometries: [{ name: '测试控制区', kind: 'wall', positions, height: 40 }], note: '' })
    expect(extractFences({ data: [{ ...value.data[0], plottingConfigData: JSON.stringify([wall]) }] })).toEqual(list)
    expect(extractFences({ data: { plottingData: wall } }).geometries[0]).toMatchObject({ name: '东区', positions })
    const radians = positions.map(([lon, lat, h]) => [lon! * Math.PI / 180, lat! * Math.PI / 180, h])
    expect(extractFences({ data: { plottingData: { type: 'WallLayer', positions: radians } } }).geometries[0]?.positions).toEqual(radians)
  })

  it('reports invalid and unsupported geometry without connecting across a missing vertex', () => {
    for (const invalid of [null, ['', 29], [107, true], [181, 29], ['NaN', 29]]) {
      const result = extractFences({ data: { plottingData: [wall, { type: 'WallLayer', positions: [positions[0], invalid, positions[2]] }] } })
      expect(result.geometries).toHaveLength(1)
      expect(result.note).toContain('1 条记录')
    }
    for (const plottingData of ['broken json', { type: 'PointLayer', points: [] }, { type: 'WallLayer', positions: [positions[0], positions[0]] }]) {
      expect(extractFences({ data: { plottingData } })).toMatchObject({ geometries: [], note: expect.stringContaining('1 条记录') })
    }
    expect(extractFences({ data: null }).note).toContain('未返回')
    expect(fencesFromResult('truncated', undefined).note).toContain('重新查询')
  })

  it('keeps raw plotting data in durable metadata and restores it after model summarization', () => {
    for (const name of ['closedoff_control_area_page', 'closedoff_plotting_config_one'] as const) {
      const spec = TOOL_BY_NAME.get(name)!
      const tool = createTool(spec, {} as ClosedoffGateway, Config({} as Config), () => {})
      const result = name === 'closedoff_control_area_page' ? value : { ...value, data: { plottingData: JSON.stringify(wall) } }
      const blocks = tool.output.render({}, result)
      const meta = tool.output.presentationMeta?.({}, result)
      expect(meta).toEqual({ api: spec.path, value: result })
      expect(JSON.stringify(blocks)).not.toContain('positions')
      expect(JSON.stringify(blocks)).toContain('可展示边界 1 个')
      const events = [
        { type: 'tool/call', time: 1, data: { callId: 'f1', name } },
        { type: 'tool/result', time: 2, data: { meta, message: { content: [{ toolCallId: 'f1', content: blocks }] } } },
      ] as unknown as SessionEvent[]
      expect(projectHistory(events)[0]).toMatchObject({ fences: { f1: { geometries: [{ positions, height: 40 }] } } })
    }
  })

  it('builds separate Cesium walls and closed polygons with the stored base elevations', () => {
    const start = webTrajectory.indexOf('  function addFenceContent(')
    const end = webTrajectory.indexOf('  function renderFenceList(', start)
    const add = new Function('geoPoint', `${webTrajectory.slice(start, end)}; return addFenceContent;`)((p: unknown) => p)
    const entities = new Cesium.EntityCollection()
    const fences = extractFences({ data: { plottingData: [wall, { type: 'PolygonLayer', polygons: [{ positions }] }] } }).geometries
    add({ entities }, Cesium, fences, 'f1')
    expect(entities.values).toHaveLength(2)
    const time = Cesium.JulianDate.now()
    expect(entities.values[0]?.wall?.minimumHeights?.getValue(time)).toEqual([300, 310, 320])
    expect(entities.values[0]?.wall?.maximumHeights?.getValue(time)).toEqual([340, 350, 360])
    expect(entities.values[0]?.polyline?.positions?.getValue(time)).toHaveLength(3)
    expect(entities.values[1]?.polygon?.hierarchy?.getValue(time).positions).toHaveLength(3)
    expect(entities.values[1]?.polyline?.positions?.getValue(time)).toHaveLength(4)
  })
})
