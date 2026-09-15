/**
 * 轨迹视图纯函数的用例。
 *
 * 这些函数原本埋在 `trajectory.js` 里，只有把它拆成模块才测得动：点位字段有新旧两套写法、
 * 时间戳与字符串混用、经纬度可能是弧度也可能是度——都是「看着对、边界错」的地方。
 */
import { describe, expect, it } from 'vitest'
import { cameraName, cameraOnline, camerasFor, degree, fencePoints, fmtDT, geoPoint, groupDevCount, vh, vlat, vlon, vt } from '../web/trajectory-data.js'

describe('trajectory point fields', () => {
  it('accepts both field spellings and always returns numbers for coordinates', () => {
    expect(vlon({ lon: '118.5' })).toBe(118.5)
    expect(vlon({ longitude: 118.5 })).toBe(118.5)
    expect(vlat({ lat: '32.1' })).toBe(32.1)
    expect(vlat({ latitude: 32.1 })).toBe(32.1)
    // 缺高度按 0；给了字符串也要变成数字。
    expect(vh({})).toBe(0)
    expect(vh({ height: '15' })).toBe(15)
    expect(vh({ h: 0 })).toBe(0)
  })

  it('keeps the point time as given', () => {
    expect(vt({ t: 1700000000000 })).toBe(1700000000000)
    expect(vt({ pointTime: '2026-09-13 08:00:00' })).toBe('2026-09-13 08:00:00')
    expect(vt({})).toBeUndefined()
  })

  it('formats epoch milliseconds and passes other values through', () => {
    // 期望值按本地时区推导：写死时区会让这条用例在别的机器上红。
    const stamp = new Date(2026, 8, 13, 8, 0, 0).getTime()
    const pad = value => (value < 10 ? '0' : '') + value
    const shown = new Date(stamp)
    expect(fmtDT('')).toBe('')
    expect(fmtDT(undefined)).toBe('')
    expect(fmtDT('2026-09-13 08:00')).toBe('2026-09-13 08:00')
    // 只有够大的毫秒数才当作时间戳：小数字按原样返回，避免把编号渲染成 1970 年。
    expect(fmtDT(1234)).toBe('1234')
    expect(fmtDT(stamp)).toBe(`${shown.getFullYear()}-${pad(shown.getMonth() + 1)}-${pad(shown.getDate())} ${pad(shown.getHours())}:${pad(shown.getMinutes())}:${pad(shown.getSeconds())}`)
  })

  it('converts radians to degrees but leaves values that are already degrees', () => {
    expect(degree(Math.PI, false)).toBeCloseTo(180, 6)
    expect(degree(Math.PI / 2, true)).toBeCloseTo(90, 6)
    // 超出量程的值按「已经是度」处理（后端两种都出现过）。
    expect(degree(118.5, false)).toBe(118.5)
    expect(degree(32.1, true)).toBe(32.1)
  })

  it('builds a display point from either spelling', () => {
    // 弧度换算有浮点误差（π*180/π 不是精确的 180），所以按精度比较。
    expect(geoPoint({ longitude: Math.PI, latitude: Math.PI / 2, height: 12, pointTime: 1700000000000 }))
      .toEqual({ lon: expect.closeTo(180, 6), lat: expect.closeTo(90, 6), h: 12, t: fmtDT(1700000000000) })
    // 没有点位时间时显示为空串（fmtDT 对空值返回空串，而不是 undefined）。
    expect(geoPoint({ lon: 118.5, lat: 32.1 })).toEqual({ lon: 118.5, lat: 32.1, h: 0, t: '' })
  })
})

describe('device groups and cameras', () => {
  const group = {
    groupName: '东门',
    devices: [
      { deviceType: 6, status: 1, name: '东门-1' },
      { deviceType: '6', status: 0, code: 'CAM-2' },
      { deviceType: 1, name: '车闸' },
      { deviceType: 6, status: 2, cameraCode: 'CAM-3' },
    ],
  }

  it('counts devices and keeps only cameras', () => {
    expect(groupDevCount([group, { devices: [{ deviceType: 6 }] }])).toBe(5)
    expect(groupDevCount([{}])).toBe(0)
    expect(camerasFor(group)).toHaveLength(3)
    expect(camerasFor({})).toEqual([])
  })

  it('reads online state and falls back through the name fields', () => {
    expect(cameraOnline({ status: 1 })).toBe(true)
    expect(cameraOnline({ status: '1' })).toBe(true)
    expect(cameraOnline({ status: 0 })).toBe(false)
    expect(cameraName({ name: '东门-1' })).toBe('东门-1')
    expect(cameraName({ code: 'CAM-2' })).toBe('CAM-2')
    expect(cameraName({ cameraCode: 'CAM-3' })).toBe('CAM-3')
    expect(cameraName({})).toBe('未命名摄像头')
  })
})

describe('fence plotting', () => {
  it('flattens every geometry into points and tolerates an empty payload', () => {
    expect(fencePoints([{ positions: [[118, 32, 0], [118.1, 32.1, 5]] }, { positions: [[119, 33, 1]] }]))
      .toEqual([{ lon: 118, lat: 32, h: 0 }, { lon: 118.1, lat: 32.1, h: 5 }, { lon: 119, lat: 33, h: 1 }])
    expect(fencePoints([])).toEqual([])
    expect(fencePoints(undefined)).toEqual([])
  })
})
