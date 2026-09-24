/**
 * 轨迹视图的纯函数（旧 web/trajectory-data.js 的 React 等价）：点位字段别名、
 * 时间格式化、坐标换算、设备组统计、摄像头筛选、围栏点位。
 *
 * 不碰 DOM 也不碰 Cesium，node 单测直接对照旧实现行为。
 * 点位字段两套写法（{lon,lat,h,t} 与 {longitude,latitude,height,pointTime}）在
 * 这里收敛成一处；设备组字段同样宽松读取（groupName/name）。
 */
import type { FenceGeometry, TrackDeviceGroup, TrackPoint } from './types.ts'

type LooseRecord = Record<string, unknown>

function num(value: unknown): number {
  return Number(value)
}

export function vlon(p: TrackPoint): number {
  return p.lon !== undefined ? num(p.lon) : num((p as LooseRecord).longitude)
}

export function vlat(p: TrackPoint): number {
  return p.lat !== undefined ? num(p.lat) : num((p as LooseRecord).latitude)
}

export function vh(p: TrackPoint): number {
  if (p.h !== undefined) return num(p.h)
  const h = num((p as LooseRecord).height)
  return Number.isFinite(h) ? h : 0
}

export function vt(p: TrackPoint | undefined): unknown {
  if (p === undefined) return undefined
  return p.t !== undefined ? p.t : (p as LooseRecord).pointTime
}

/** 时间展示：毫秒时间戳格式化成 yyyy-MM-dd HH:mm:ss，其余原样。 */
export function fmtDT(v: unknown): string {
  if (!v) return ''
  const n = typeof v === 'number' ? v : num(v)
  if (!Number.isNaN(n) && n > 1e11) {
    const d = new Date(n)
    const p = (x: number): string => (x < 10 ? '0' : '') + x
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  return String(v)
}

/** 设备组内的设备总数（旧 groupDevCount）。 */
export function groupDevCount(groups: readonly TrackDeviceGroup[]): number {
  let n = 0
  for (const group of groups) {
    const devices = group.devices
    if (Array.isArray(devices)) n += devices.length
  }
  return n
}

/** 组内可播放的摄像头（deviceType === 6，旧 camerasFor）。 */
export function camerasFor(group: TrackDeviceGroup): LooseRecord[] {
  const devices = Array.isArray(group.devices) ? group.devices : []
  return devices.filter(device => num((device as LooseRecord).deviceType) === 6) as LooseRecord[]
}

/** 摄像头在线（status === 1，旧 cameraOnline）。 */
export function cameraOnline(camera: LooseRecord): boolean {
  return num(camera.status) === 1
}

/** 摄像头显示名（旧 cameraName 口径：name → code → cameraCode）。 */
export function cameraName(camera: LooseRecord): string {
  const name = camera.name ?? camera.code ?? camera.cameraCode
  return typeof name === 'string' && name !== '' ? name : '未命名摄像头'
}

/** 设备组显示名（groupName → name → 「设备组」，宽松字段读取）。 */
export function groupNameOf(group: TrackDeviceGroup): string {
  const name = group.groupName ?? group.name
  return typeof name === 'string' && name !== '' ? name : '设备组'
}

/**
 * 度分坐标兜底：|值| 超出经纬度合法域时按「误存弧度」换算成度（旧 degree）。
 * latitude=true 时合法域为 ±(π/2+0.01)，否则 ±(π+0.01)。
 */
export function degree(value: number, latitude: boolean): number {
  const limit = latitude ? Math.PI / 2 + 0.01 : Math.PI + 0.01
  return Math.abs(value) <= limit ? value * 180 / Math.PI : value
}

export interface GeoPoint {
  lon: number
  lat: number
  h: number
  t: string
}

/** 点位 → 展示坐标（弧度兜底换算 + 高度 + 格式化时间，旧 geoPoint）。 */
export function geoPoint(p: TrackPoint): GeoPoint {
  return {
    lon: degree(vlon(p), false),
    lat: degree(vlat(p), true),
    h: vh(p),
    t: fmtDT(vt(p)),
  }
}

/** 围栏标绘：每段几何的 positions（[lon,lat,h]）拍平成点位数组（旧 fencePoints）。 */
export function fencePoints(geometries: readonly FenceGeometry[]): TrackPoint[] {
  return (geometries ?? []).flatMap(fence =>
    fence.positions.map(p => ({ lon: p[0], lat: p[1], h: p[2] })),
  )
}

/** 服务端围栏 payload 的形状守卫（FencePayload 数据面透传，消费面在此收窄）。 */
export function asFencePayload(payload: unknown): { geometries: FenceGeometry[]; note: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const geometries = (payload as LooseRecord).geometries
  if (!Array.isArray(geometries) || geometries.length === 0) return undefined
  const note = (payload as LooseRecord).note
  return {
    geometries: geometries as FenceGeometry[],
    note: typeof note === 'string' ? note : '',
  }
}
