/**
 * 轨迹数据纯函数单测（批 1b）：对照旧 web/trajectory-data.js 的行为基准。
 * 点位字段别名、弧度兜底、时间格式化、摄像头筛选与在线判定、围栏点位拍平、
 * 服务端围栏 payload 形状守卫。
 */
import type { TrackPoint } from '../lib/types.ts'
import { describe, expect, it } from 'vitest'
import {
  asFencePayload,
  cameraName,
  cameraOnline,
  camerasFor,
  degree,
  fencePoints,
  fmtDT,
  geoPoint,
  vh,
  vlat,
  vlon,
  vt,
} from '../lib/trajectory-data.ts'

describe('点位字段别名（两套写法收敛）', () => {
  it('短写法 {lon,lat,h,t}', () => {
    const point = { lon: '102.7', lat: 25.04, h: 1892, t: '2026-09-25 08:00:00' } as unknown as TrackPoint
    expect(vlon(point)).toBe(102.7)
    expect(vlat(point)).toBe(25.04)
    expect(vh(point)).toBe(1892)
    expect(vt(point)).toBe('2026-09-25 08:00:00')
  })

  it('长写法 {longitude,latitude,height,pointTime}', () => {
    const point = { longitude: 102.71, latitude: '25.05', height: 1900, pointTime: 1782000000000 } as unknown as TrackPoint
    expect(vlon(point)).toBe(102.71)
    expect(vlat(point)).toBe(25.05)
    expect(vh(point)).toBe(1900)
    expect(vt(point)).toBe(1782000000000)
  })

  it('height 缺失退化为 0（旧 +p.height || 0）', () => {
    expect(vh({ lon: 1, lat: 1 } as unknown as TrackPoint)).toBe(0)
  })
})

describe('degree 弧度兜底（旧 degree 口径）', () => {
  it('合法度值原样', () => {
    expect(degree(102.7, false)).toBeCloseTo(102.7)
    expect(degree(25.04, true)).toBeCloseTo(25.04)
  })

  it('误存弧度换算成度', () => {
    expect(degree(1.79, false)).toBeCloseTo(1.79 * 180 / Math.PI)
    expect(degree(0.43, true)).toBeCloseTo(0.43 * 180 / Math.PI)
  })

  it('超界度值原样（不换算）', () => {
    expect(degree(200, false)).toBe(200)
    expect(degree(-95, true)).toBe(-95)
  })
})

describe('geoPoint 收敛', () => {
  it('输出 lon/lat/h/t 四元组', () => {
    const point = geoPoint({ lon: 1.79, lat: 0.43, h: 0, t: 1782000000000 } as unknown as TrackPoint)
    expect(point.lon).toBeCloseTo(1.79 * 180 / Math.PI)
    expect(point.lat).toBeCloseTo(0.43 * 180 / Math.PI)
    expect(point.h).toBe(0)
    expect(point.t).toBe(fmtDT(1782000000000))
    expect(point.t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })
})

describe('fmtDT', () => {
  it('毫秒时间戳格式化', () => {
    expect(fmtDT(1782000000000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('字符串原样', () => {
    expect(fmtDT('2026-09-25 08:00:00')).toBe('2026-09-25 08:00:00')
  })

  it('空值返回空串', () => {
    expect(fmtDT(undefined)).toBe('')
    expect(fmtDT('')).toBe('')
  })
})

describe('摄像头筛选（camerasFor/cameraOnline/cameraName）', () => {
  const group = {
    groupName: '北门设备组',
    devices: [
      { id: 'd1', name: '北门-01', deviceType: 6, status: 1, code: 'CAM-01' },
      { id: 'd2', name: '门禁-01', deviceType: 3, status: 1 },
      { id: 'd3', cameraCode: 'CAM-03', deviceType: '6', status: '0' },
    ],
  }

  it('只留 deviceType=6（数字与数字串都算）', () => {
    expect(camerasFor(group)).toHaveLength(2)
  })

  it('在线判定 status===1', () => {
    const cameras = camerasFor(group)
    expect(cameraOnline(cameras[0] ?? {})).toBe(true)
    expect(cameraOnline(cameras[1] ?? {})).toBe(false)
  })

  it('名称回退 name → code → cameraCode', () => {
    const cameras = camerasFor(group)
    expect(cameraName(cameras[0] ?? {})).toBe('北门-01')
    expect(cameraName(cameras[1] ?? {})).toBe('CAM-03')
    expect(cameraName({})).toBe('未命名摄像头')
  })
})

describe('fencePoints / asFencePayload', () => {
  it('边界点拍平成点位数组', () => {
    const points = fencePoints([
      { name: 'A', kind: 'wall', positions: [[102.7, 25.04, 1890], [102.71, 25.05, 1892]], height: 8 },
    ])
    expect(points).toEqual([
      { lon: 102.7, lat: 25.04, h: 1890 },
      { lon: 102.71, lat: 25.05, h: 1892 },
    ])
  })

  it('asFencePayload 守卫：geometries 非空才可视', () => {
    const payload = { geometries: [{ name: '核心区', kind: 'polygon', positions: [[1, 2, 3]], height: 0 }], note: '两段围栏' }
    expect(asFencePayload(payload)?.note).toBe('两段围栏')
    expect(asFencePayload({ name: '旧形状' })).toBeUndefined()
    expect(asFencePayload({ geometries: [] })).toBeUndefined()
    expect(asFencePayload(null)).toBeUndefined()
  })
})
