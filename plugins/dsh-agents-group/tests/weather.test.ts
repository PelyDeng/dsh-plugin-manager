/**
 * 通用天气查询的测试。
 *
 * 不访问真实网络：所有用例都注入替身 fetch，因为 CI 与离线开发都不该依赖外部服务。
 * 覆盖三件事：WMO 编码到中文的映射、可读文本渲染、以及地点解析的歧义处理
 * （重名行政区是这类查询最容易出的错）。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeWeatherCode,
  fetchWeather,
  formatWeatherReport,
  resolvePlace,
  WeatherError,
  type ResolvedPlace,
} from '../packages/common/src/weather.ts'

/** 用一次性的 fetch 替身，返回指定的 JSON。 */
function stubFetch(payload: unknown, ok = true, status = 200) {
  const spy = vi.fn(async () => ({
    ok,
    status,
    json: async () => payload,
  }) as unknown as Response)
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => { vi.unstubAllGlobals() })

describe('WMO 天气编码', () => {
  it('常见编码翻成中文', () => {
    expect(describeWeatherCode(0)).toBe('晴')
    expect(describeWeatherCode(3)).toBe('阴')
    expect(describeWeatherCode(61)).toBe('小雨')
    expect(describeWeatherCode(95)).toBe('雷阵雨')
  })

  it('未知编码如实说明而不猜', () => {
    // 猜一个「多云」会让用户拿到错信息；如实报编码才可追查。
    expect(describeWeatherCode(1234)).toBe('未知天气（编码 1234）')
    expect(describeWeatherCode(undefined)).toBe('未知天气')
    expect(describeWeatherCode('51')).toBe('未知天气')
  })
})

describe('地点解析', () => {
  it('解析出坐标、层级与中文地区名', async () => {
    stubFetch({
      results: [{
        name: '浦东新区', latitude: 31.22, longitude: 121.54, timezone: 'Asia/Shanghai',
        admin1: '上海市', admin2: '上海市', country: '中国', country_code: 'CN',
      }],
    })
    const place = await resolvePlace('浦东新区')
    expect(place.name).toBe('浦东新区')
    expect(place.latitude).toBeCloseTo(31.22)
    expect(place.timezone).toBe('Asia/Shanghai')
    // admin1 与 admin2 相同时不应重复显示
    expect(place.region).toBe('上海市 中国')
  })

  it('地名不存在时给出可读提示', async () => {
    stubFetch({ results: [] })
    await expect(resolvePlace('不存在的地方')).rejects.toThrow(WeatherError)
    await expect(resolvePlace('不存在的地方')).rejects.toThrow(/没有找到/)
  })

  it('空地名直接拒绝，不发请求', async () => {
    const spy = stubFetch({ results: [] })
    await expect(resolvePlace('   ')).rejects.toThrow(/请提供/)
    expect(spy).not.toHaveBeenCalled()
  })

  it('region 限定重名行政区', async () => {
    // 多个「朝阳区」是国内重名最典型的情形；不限定就会静默落到错的那个。
    stubFetch({
      results: [
        { name: '朝阳区', latitude: 39.92, longitude: 116.44, admin1: '北京市', country: '中国', country_code: 'CN' },
        { name: '朝阳区', latitude: 43.83, longitude: 125.29, admin1: '吉林省', admin2: '长春市', country: '中国', country_code: 'CN' },
      ],
    })
    const beijing = await resolvePlace('朝阳区', { region: '北京市' })
    expect(beijing.latitude).toBeCloseTo(39.92)
    expect(beijing.region).toContain('北京市')

    const changchun = await resolvePlace('朝阳区', { region: '长春市' })
    expect(changchun.latitude).toBeCloseTo(43.83)
    expect(changchun.region).toContain('长春市')
  })

  it('region 限定后无匹配时明确报错，不退回任意一个', async () => {
    stubFetch({ results: [{ name: '朝阳区', latitude: 39.92, longitude: 116.44, admin1: '北京市', country: '中国' }] })
    await expect(resolvePlace('朝阳区', { region: '广州市' })).rejects.toThrow(/核对行政区名称/)
  })

  it('优先国内结果', async () => {
    stubFetch({
      results: [
        { name: 'Springfield', latitude: 1, longitude: 1, country: 'United States', country_code: 'US' },
        { name: 'Springfield', latitude: 2, longitude: 2, country: '中国', country_code: 'CN' },
      ],
    })
    const place = await resolvePlace('Springfield')
    expect(place.latitude).toBe(2)
  })

  it('缺少坐标时如实报错，不返回半个地点', async () => {
    stubFetch({ results: [{ name: '某地', country_code: 'CN' }] })
    await expect(resolvePlace('某地')).rejects.toThrow(/缺少坐标/)
  })

  it('服务返回非 200 时给出可读错误', async () => {
    stubFetch({}, false, 503)
    await expect(resolvePlace('重庆')).rejects.toThrow(/HTTP 503/)
  })

  it('网络异常时给出可读错误而不是原始异常', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(resolvePlace('重庆')).rejects.toThrow(WeatherError)
    await expect(resolvePlace('重庆')).rejects.toThrow(/暂时不可用/)
  })
})

describe('行政区划写法的兼容', () => {
  /** 数据源按专名匹配：带后缀查不到，去后缀才命中。 */
  function stubByQuery(map: Record<string, unknown>) {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = new URL(String(input))
      const name = url.searchParams.get('name') ?? ''
      calls.push(name)
      return { ok: true, status: 200, json: async () => map[name] ?? {} } as unknown as Response
    }))
    return calls
  }

  it('「重庆市」查不到时自动去掉后缀重试', async () => {
    // 真实数据源的行为：带行政后缀零结果，去掉才命中。
    const calls = stubByQuery({
      重庆: { results: [{ name: '重庆', latitude: 29.56, longitude: 106.55, admin1: '重庆市', country: '中国', country_code: 'CN', timezone: 'Asia/Shanghai' }] },
    })
    const place = await resolvePlace('重庆市')
    expect(calls).toContain('重庆市')
    expect(calls).toContain('重庆')
    expect(place.latitude).toBeCloseTo(29.56)
    // 按原样命中时不该多话；这里是去后缀才命中的，所以提示标准写法。
    expect(place.standardName).toBe('重庆')
  })

  it('原样就能命中时不提示标准写法', async () => {
    stubByQuery({
      浦东新区: { results: [{ name: '浦东新区', latitude: 31.22, longitude: 121.54, admin1: '上海市', country: '中国', country_code: 'CN' }] },
    })
    const place = await resolvePlace('浦东新区')
    expect(place.standardName).toBeUndefined()
  })

  it('region 也容忍后缀差异', async () => {
    // 使用者写「北京市」，数据里是「北京」；不该因此判为不匹配。
    stubByQuery({
      朝阳: { results: [{ name: '朝阳', latitude: 39.92, longitude: 116.44, admin1: '北京', country: '中国', country_code: 'CN' }] },
    })
    const place = await resolvePlace('朝阳区', { region: '北京市' })
    expect(place.latitude).toBeCloseTo(39.92)
  })

  it('查省级时回退到省会，并如实说明不是全省数据', async () => {
    // 数据源没有省级条目，这是它的固有限制；回退必须带口径说明，否则等于骗人。
    const calls = stubByQuery({
      成都: { results: [{ name: '成都', latitude: 30.57, longitude: 104.07, admin1: '四川', admin2: '成都市', country: '中国', country_code: 'CN' }] },
    })
    const place = await resolvePlace('四川省')
    expect(calls).toContain('四川')
    expect(calls).toContain('成都')
    expect(place.name).toBe('成都')
    expect(place.assumption).toContain('省会')
    expect(place.assumption).toContain('四川省')
    // 已经有口径说明了，不再叠一条标准写法提示。
    expect(place.standardName).toBeUndefined()
  })

  it('未知省份仍然明确报错，不回退到别的地方', async () => {
    stubByQuery({})
    await expect(resolvePlace('不存在的省')).rejects.toThrow(/没有找到/)
  })
})

describe('预报查询', () => {
  const place: ResolvedPlace = { name: '重庆市', region: '重庆市 中国', latitude: 29.56, longitude: 106.55, timezone: 'Asia/Shanghai' }

  it('归一化当前天气与逐日预报', async () => {
    stubFetch({
      current: { time: '2026-09-12T17:45', temperature_2m: 26, apparent_temperature: 28.2, relative_humidity_2m: 68, precipitation: 0.1, wind_speed_10m: 10.1, weather_code: 51 },
      daily: { time: ['2026-09-12', '2026-09-13'], weather_code: [51, 3], temperature_2m_max: [27.2, 30], temperature_2m_min: [21.5, 22], precipitation_sum: [1.2, 0] },
    })
    const report = await fetchWeather(place, { days: 2 })
    expect(report.place).toBe(place)
    expect(report.current.temperature).toBe(26)
    expect(report.current.condition).toBe('小毛毛雨')
    expect(report.daily).toHaveLength(2)
    expect(report.daily[0]?.condition).toBe('小毛毛雨')
    expect(report.daily[1]?.condition).toBe('阴')
    expect(report.daily[1]?.max).toBe(30)
  })

  it('天数被夹在 1 到 7 之间', async () => {
    stubFetch({ current: { time: '', weather_code: 0 }, daily: { time: [] } })
    // 越界输入不应导致请求参数非法。
    await fetchWeather(place, { days: 999 })
    const url = String((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0]?.[0])
    expect(url).toContain('forecast_days=7')
  })

  it('缺少 current 时明确报错', async () => {
    stubFetch({ daily: { time: [] } })
    await expect(fetchWeather(place)).rejects.toThrow(/没有返回当前天气/)
  })

  it('缺失的数值渲染成占位符而不是 NaN', async () => {
    stubFetch({ current: { time: '' }, daily: { time: ['2026-09-12'], weather_code: [], temperature_2m_max: [], temperature_2m_min: [] } })
    const report = await fetchWeather(place)
    const text = formatWeatherReport(report)
    expect(text).not.toContain('NaN')
    expect(text).toContain('—')
  })
})

describe('可读渲染', () => {
  it('给出地区、当前天气与逐日预报', () => {
    const timezone: ResolvedPlace = { name: '渝北区', region: '重庆市 中国', latitude: 29.7, longitude: 106.6, timezone: 'Asia/Shanghai' }
    const text = formatWeatherReport({
      place: timezone,
      current: { time: 't', temperature: 26.04, feelsLike: 28.2, humidity: 68, precipitation: 0, windSpeed: 10.1, condition: '晴' },
      daily: [{ date: '2026-09-12', condition: '多云', max: 30.5, min: 21.55, precipitation: 1.25 }],
    })
    expect(text).toContain('重庆市 中国 渝北区 天气')
    expect(text).toContain('当前：晴')
    expect(text).toContain('26°C')
    expect(text).toContain('2026-09-12：多云')
    expect(text).toContain('21.6~30.5°C')
  })

  it('没有地区信息时只用地点名', () => {
    const bare: ResolvedPlace = { name: '某地', region: '', latitude: 1, longitude: 1, timezone: 'auto' }
    const text = formatWeatherReport({ place: bare, current: { time: '', temperature: 1, feelsLike: 1, humidity: 1, precipitation: 0, windSpeed: 0, condition: '晴' }, daily: [] })
    expect(text.startsWith('某地 天气')).toBe(true)
    expect(text).not.toContain('预报：')
  })
})
