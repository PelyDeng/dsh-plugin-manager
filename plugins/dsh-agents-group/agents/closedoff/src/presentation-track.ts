/**
 * 轨迹与设备组：从工具结果里取出点位、按设备分组，并按「点到轨迹线段的最短距离」筛出沿途设备组。
 *
 * 距离阈值属于部署配置，默认值只适用于当前园区；筛选逻辑与坐标换算放在一起，便于按真实轨迹复核。
 */

import { json } from './presentation-shared.ts'


export interface TrackPoint {
  lon: number
  lat: number
  h: number
  t?: string
}

export interface TrackDevice {
  id: string
  name: string
  code: string
  status?: number
  deviceType?: number
  deviceIp?: string
  videoAddress?: string
  accessAddress?: string
  cameraCode?: string
  lastHeartbeatTime?: string
}

export interface TrackDeviceGroup {
  groupId: string
  groupName: string
  lon: number
  lat: number
  h: number
  devices: TrackDevice[]
}

export interface TrackAnalysis {
  groups: TrackDeviceGroup[]
  startGroup?: TrackDeviceGroup
  endGroup?: TrackDeviceGroup
  longestStay?: { group: TrackDeviceGroup; durationMs: number }
  excludedGapCount: number
}

export interface VehicleMediaItem {
  deviceId: string
  startTime: string
  timeLength: string
  mediaUrl: string
}

function presentationValue(meta: unknown): unknown {
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) && 'value' in meta
    ? (meta as Record<string, unknown>).value
    : undefined
}

/** Extract camera/location points from one canonical vehicle-track value. */
export function extractTrackPointsFromValue(value: unknown, maxPoints = 800): TrackPoint[] {
  const data = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).data
    : undefined
  const rows = Array.isArray(data) ? data : []
  const points: TrackPoint[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || !('points' in row) || !Array.isArray(row.points)) continue
    for (const point of row.points) {
      if (typeof point !== 'object' || point === null) continue
      const source = point as Record<string, unknown>
      const lon = Number(source.longitude)
      const lat = Number(source.latitude)
      const h = Number(source.height ?? 0)
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(h)) continue
      const pointTime = source.pointTime
      points.push({
        lon,
        lat,
        h,
        ...((typeof pointTime === 'string' || typeof pointTime === 'number') ? { t: String(pointTime) } : {}),
      })
    }
  }
  if (points.length <= maxPoints) return points
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * (points.length - 1) / (maxPoints - 1))]!)
}

/** Extract camera/location points from one rendered vehicle-track result. */
export function extractTrackPoints(resultText: string): TrackPoint[] {
  return extractTrackPointsFromValue(json(resultText))
}

/** Prefer durable presentation metadata when the model-facing result was truncated or summarized. */
export function extractTrackPointsFromResult(resultText: string, meta: unknown): TrackPoint[] {
  const fromMeta = extractTrackPointsFromValue(presentationValue(meta))
  return fromMeta.length > 0 ? fromMeta : extractTrackPoints(resultText)
}

/** Read vehicle numbers from the same result that supplies the displayed points; empty means unavailable. */
export function extractTrackVehicleNoFromResult(resultText: string, meta: unknown): string {
  const value = extractTrackPointsFromValue(presentationValue(meta)).length > 0 ? presentationValue(meta) : json(resultText)
  if (typeof value !== 'object' || value === null || !('data' in value) || !Array.isArray(value.data)) return ''
  const numbers = value.data.flatMap((row: unknown) => {
    if (typeof row !== 'object' || row === null || !('vehicleNo' in row) || typeof row.vehicleNo !== 'string') return []
    const number = row.vehicleNo.trim()
    return number ? [number] : []
  })
  return [...new Set(numbers)].join(' / ')
}

function plottedPosition(row: Record<string, unknown>): [number, number, number] | undefined {
  const configs = [row.plottingConfigData, ...(Array.isArray(row.plottingConfigDataList) ? row.plottingConfigDataList : [])]
  if (row.plottingData !== undefined) configs.push({ plottingData: row.plottingData })
  for (const config of configs) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) continue
    const raw = (config as Record<string, unknown>).plottingData
    let layers: unknown = raw
    if (typeof raw === 'string') {
      try { layers = JSON.parse(raw) as unknown } catch { continue }
    }
    if (!Array.isArray(layers)) continue
    for (const layer of layers) {
      if (typeof layer !== 'object' || layer === null || !Array.isArray((layer as Record<string, unknown>).points)) continue
      for (const point of (layer as { points: unknown[] }).points) {
        if (typeof point !== 'object' || point === null) continue
        const position = (point as Record<string, unknown>).position
        if (!Array.isArray(position) || position.length < 2) continue
        const lon = Number(position[0])
        const lat = Number(position[1])
        const h = Number(position[2] ?? 0)
        if (Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(h)) return [lon, lat, h]
      }
    }
  }
  return undefined
}

/** Aggregate the all-device query into one plotted marker per device group. */
export function extractDeviceGroups(value: unknown): TrackDeviceGroup[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const rows = (value as Record<string, unknown>).data
  if (!Array.isArray(rows)) return []
  const groups = new Map<string, TrackDeviceGroup & { deviceIds: Set<string> }>()
  for (const item of rows) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const groupId = typeof row.groupId === 'string' ? row.groupId.trim() : ''
    if (groupId === '') continue
    let group = groups.get(groupId)
    const position = plottedPosition(row)
    if (group === undefined) {
      group = {
        groupId,
        groupName: typeof row.groupName === 'string' && row.groupName.trim() !== '' ? row.groupName.trim() : '未命名设备组',
        lon: position?.[0] ?? Number.NaN,
        lat: position?.[1] ?? Number.NaN,
        h: position?.[2] ?? Number.NaN,
        devices: [],
        deviceIds: new Set<string>(),
      }
      groups.set(groupId, group)
    } else if (!Number.isFinite(group.lon) && position !== undefined) {
      [group.lon, group.lat, group.h] = position
    }
    const id = typeof row.id === 'string' ? row.id : ''
    const code = typeof row.deviceCode === 'string' ? row.deviceCode : ''
    const key = id || code
    if (key === '' || group.deviceIds.has(key)) continue
    group.deviceIds.add(key)
    group.devices.push({
      id,
      name: typeof row.deviceName === 'string' && row.deviceName !== '' ? row.deviceName : code || '未命名设备',
      code,
      ...(typeof row.status === 'number' ? { status: row.status } : {}),
      ...(typeof row.deviceType === 'number' ? { deviceType: row.deviceType } : {}),
      ...(typeof row.deviceIp === 'string' && row.deviceIp !== '' ? { deviceIp: row.deviceIp } : {}),
      ...(typeof row.videoAddress === 'string' && row.videoAddress !== '' ? { videoAddress: row.videoAddress } : {}),
      ...(typeof row.accessAddress === 'string' && row.accessAddress !== '' ? { accessAddress: row.accessAddress } : {}),
      ...(typeof row.cameraCode === 'string' && row.cameraCode !== '' ? { cameraCode: row.cameraCode } : {}),
      ...((typeof row.lastHeartbeatTime === 'string' || typeof row.lastHeartbeatTime === 'number')
        ? { lastHeartbeatTime: String(row.lastHeartbeatTime) }
        : {}),
    })
  }
  return [...groups.values()]
    .filter(group => Number.isFinite(group.lon) && Number.isFinite(group.lat) && Number.isFinite(group.h))
    .map(({ deviceIds: _deviceIds, ...group }) => group)
}

function coordinateDegrees(value: number, latitude: boolean): number {
  const radianLimit = latitude ? Math.PI / 2 : Math.PI
  return Math.abs(value) <= radianLimit ? value * 180 / Math.PI : value
}

function distanceToSegmentMeters(group: TrackDeviceGroup, start: TrackPoint, end: TrackPoint): number {
  const groupLat = coordinateDegrees(group.lat, true)
  const groupLon = coordinateDegrees(group.lon, false)
  const metersPerLongitudeDegree = 111_320 * Math.cos(groupLat * Math.PI / 180)
  const x1 = (coordinateDegrees(start.lon, false) - groupLon) * metersPerLongitudeDegree
  const y1 = (coordinateDegrees(start.lat, true) - groupLat) * 110_540
  const x2 = (coordinateDegrees(end.lon, false) - groupLon) * metersPerLongitudeDegree
  const y2 = (coordinateDegrees(end.lat, true) - groupLat) * 110_540
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / lengthSquared))
  return Math.hypot(x1 + ratio * dx, y1 + ratio * dy)
}

function nearestGroup(
  groups: readonly TrackDeviceGroup[],
  point: TrackPoint,
  maxDistanceMeters: number,
): TrackDeviceGroup | undefined {
  let nearest: TrackDeviceGroup | undefined
  let nearestDistance = maxDistanceMeters
  for (const group of groups) {
    const distance = distanceToSegmentMeters(group, point, point)
    if (distance <= nearestDistance) {
      nearest = group
      nearestDistance = distance
    }
  }
  return nearest
}

function pointTime(point: TrackPoint): number | undefined {
  if (point.t === undefined) return undefined
  const value = /^\d{11,}$/.test(point.t) ? Number(point.t) : Date.parse(point.t)
  return Number.isFinite(value) ? value : undefined
}

/** Derive ordered nearby groups and a conservative continuous-stay estimate from discrete points. */
export function analyzeTrackByDeviceGroups(
  points: readonly TrackPoint[],
  groups: readonly TrackDeviceGroup[],
  maxDistanceMeters: number,
  maxSampleGapMs: number,
): TrackAnalysis {
  const nearby = filterDeviceGroupsNearTrack(groups, points, maxDistanceMeters)
    .map(group => ({
      group,
      segment: points.length < 2 ? 0 : points.slice(1).reduce((best, point, index) => {
        const distance = distanceToSegmentMeters(group, points[index]!, point)
        return distance < best.distance ? { index, distance } : best
      }, { index: 0, distance: Number.POSITIVE_INFINITY }).index,
    }))
    .sort((left, right) => left.segment - right.segment)
    .map(item => item.group)
  const startGroup = points[0] === undefined ? undefined : nearestGroup(nearby, points[0], maxDistanceMeters)
  const endPoint = points.at(-1)
  const endGroup = endPoint === undefined ? undefined : nearestGroup(nearby, endPoint, maxDistanceMeters)
  const result: TrackAnalysis = {
    groups: nearby,
    excludedGapCount: 0,
    ...(startGroup === undefined ? {} : { startGroup }),
    ...(endGroup === undefined ? {} : { endGroup }),
  }
  let activeGroup: TrackDeviceGroup | undefined
  let activeDuration = 0
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!
    const end = points[index]!
    const startTime = pointTime(start)
    const endTime = pointTime(end)
    const duration = startTime === undefined || endTime === undefined ? Number.NaN : endTime - startTime
    if (!(duration > 0) || duration > maxSampleGapMs) {
      if (duration > maxSampleGapMs) result.excludedGapCount += 1
      activeGroup = undefined
      activeDuration = 0
      continue
    }
    const startGroup = nearestGroup(nearby, start, maxDistanceMeters)
    const endGroup = nearestGroup(nearby, end, maxDistanceMeters)
    if (startGroup === undefined || startGroup.groupId !== endGroup?.groupId) {
      activeGroup = undefined
      activeDuration = 0
      continue
    }
    activeDuration = activeGroup?.groupId === startGroup.groupId ? activeDuration + duration : duration
    activeGroup = startGroup
    if (result.longestStay === undefined || activeDuration > result.longestStay.durationMs) {
      result.longestStay = { group: startGroup, durationMs: activeDuration }
    }
  }
  return result
}

/** Extract the device response bundled into vehicle-track presentation metadata. */
export function extractTrackDeviceGroupsFromResult(meta: unknown): TrackDeviceGroup[] {
  const value = presentationValue(meta)
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('devices' in value)) return []
  return extractDeviceGroups((value as Record<string, unknown>).devices)
}

/** Extract playable vehicle-capture media from durable presentation metadata. */
export function extractVehicleMediaFromResult(meta: unknown): VehicleMediaItem[] {
  const value = presentationValue(meta)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const data = (value as Record<string, unknown>).data
  if (!Array.isArray(data)) return []
  return data.flatMap((row) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return []
    const source = row as Record<string, unknown>
    const mediaUrl = typeof source.url === 'string' && source.url !== ''
      ? source.url
      : typeof source.path === 'string' ? source.path : ''
    if (mediaUrl === '') return []
    return [{
      deviceId: String(source.device_id ?? ''),
      startTime: String(source.start_time ?? ''),
      timeLength: String(source.time_len ?? ''),
      mediaUrl,
    }]
  }).slice(0, 50)
}

/** Keep plotted device groups close enough to at least one trajectory segment. */
export function filterDeviceGroupsNearTrack(
  groups: readonly TrackDeviceGroup[],
  points: readonly TrackPoint[],
  maxDistanceMeters: number,
): TrackDeviceGroup[] {
  if (points.length === 0) return []
  return groups.filter((group) => {
    if (points.length === 1) return distanceToSegmentMeters(group, points[0]!, points[0]!) <= maxDistanceMeters
    for (let index = 1; index < points.length; index += 1) {
      if (distanceToSegmentMeters(group, points[index - 1]!, points[index]!) <= maxDistanceMeters) return true
    }
    return false
  })
}

