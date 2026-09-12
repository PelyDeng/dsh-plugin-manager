/** Project saved WallLayer and PolygonLayer records into safe Cesium geometry. */
import { redactVisibleText } from './redaction.ts'

export interface FenceGeometry {
  name: string
  kind: 'wall' | 'polygon'
  positions: [number, number, number][]
  height: number
}

export interface FencesPayload {
  geometries: FenceGeometry[]
  note: string
}

/** Identify the two queries that return electronic-fence plotting records. */
export function isFenceTool(tool: string): boolean {
  return tool === 'closedoff_control_area_page' || tool === 'closedoff_plotting_config_one'
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function position(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const coordinates = [value[0], value[1], value[2] ?? 0]
  if (!coordinates.every(item => (typeof item === 'number' || typeof item === 'string' && item.trim() !== '') && Number.isFinite(Number(item)))) return undefined
  const [lon, lat, height] = coordinates.map(Number) as [number, number, number]
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return undefined
  return [lon, lat, height]
}

/** Preserve complete paths; malformed vertices invalidate a shape instead of joining across gaps. */
export function extractFences(value: unknown): FencesPayload {
  const data = record(value).data
  const rows = Array.isArray(data) ? data : data == null ? [] : [data]
  const geometries: FenceGeometry[] = []
  let unavailable = 0
  for (const item of rows) {
    const row = record(item)
    const config = record(row.plottingConfigData ?? row)
    const raw = typeof row.plottingConfigData === 'string' ? row.plottingConfigData : config.plottingData
    let parsed: unknown = raw
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw) } catch { unavailable += 1; continue }
    }
    const before = geometries.length
    let rejected = false
    const layers = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of layers) {
      const layer = record(item)
      const type = layer.type ?? layer.plotType
      if (type !== 'WallLayer' && type !== 'PolygonLayer') { rejected = true; continue }
      const details = type === 'WallLayer' ? layer.fences : layer.polygons
      for (const detail of Array.isArray(details) ? details : [layer]) {
        const shape = record(detail)
        if (!Array.isArray(shape.positions)) { rejected = true; continue }
        const positions = shape.positions.map(position)
        const minimum = type === 'WallLayer' ? 2 : 3
        if (positions.some(point => point === undefined) || new Set(positions.map(point => JSON.stringify(point?.slice(0, 2)))).size < minimum) { rejected = true; continue }
        const rawHeight = shape.height ?? layer.height ?? 0
        const height = Number(rawHeight)
        if ((typeof rawHeight !== 'number' && typeof rawHeight !== 'string') || !Number.isFinite(height) || height < 0) { rejected = true; continue }
        const name = [row.controlName, shape.name, config.plottingName].find(value => typeof value === 'string' && value.trim() !== '')
        geometries.push({
          name: typeof name === 'string' ? redactVisibleText(name) : '电子围栏',
          kind: type === 'WallLayer' ? 'wall' : 'polygon',
          positions: positions as [number, number, number][],
          height,
        })
      }
    }
    if (rejected || geometries.length === before) unavailable += 1
  }
  return {
    geometries,
    note: rows.length === 0 ? '未返回围栏标绘数据。' : unavailable > 0 ? `${unavailable} 条记录存在缺失、无效或暂不支持的标绘，相关边界无法在三维中展示。` : '',
  }
}

/** Prefer durable presentation data; old results may contain only a text projection. */
export function fencesFromResult(text: string, meta: unknown): FencesPayload {
  const value = record(meta).value
  if (value !== undefined) return extractFences(value)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { geometries: [], note: '此历史结果未保存可用的围栏边界，请重新查询。' } }
  const payload = extractFences(parsed)
  return payload.geometries.length > 0 ? payload : { ...payload, note: `${payload.note}如需重新获取标绘，请重新查询。` }
}
