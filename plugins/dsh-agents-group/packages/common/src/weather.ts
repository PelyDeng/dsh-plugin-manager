/**
 * 通用天气查询。
 *
 * 数据来源是 Open-Meteo：**不需要 API Key**，所以群组不必引入凭据管理，也不会有密钥
 * 泄漏面。支持按省、市、区县名解析地点，再查当前天气与未来几天预报。
 *
 * 这个模块只做「取数 + 归一化」，不涉及工具注册与鉴权：那两件事随调用方（群组的通用
 * 工具注册）处理，方便单独测试取数逻辑。
 */

/** 解析后的地点。 */
export interface ResolvedPlace {
  /** 地点名，用于回显。 */
  readonly name: string
  /** 行政层级，例如「重庆市」或「四川省 成都市」。 */
  readonly region: string
  readonly latitude: number
  readonly longitude: number
  /** IANA 时区，例如 Asia/Shanghai。 */
  readonly timezone: string
}

/** 当前天气。 */
export interface CurrentWeather {
  readonly time: string
  readonly temperature: number
  readonly feelsLike: number
  readonly humidity: number
  readonly precipitation: number
  readonly windSpeed: number
  /** 天气现象的中文描述。 */
  readonly condition: string
}

/** 某一天的预报。 */
export interface DailyForecast {
  readonly date: string
  /** 天气现象的中文描述。 */
  readonly condition: string
  readonly max: number
  readonly min: number
  readonly precipitation: number
}

/** 一次天气查询的结果。 */
export interface WeatherReport {
  readonly place: ResolvedPlace
  readonly current: CurrentWeather
  readonly daily: readonly DailyForecast[]
}

/**
 * WMO 天气现象编码到中文。
 *
 * 只列 Open-Meteo 会返回的编码；遇到未知编码回落到「未知天气（编码 n）」，不猜。
 */
const WMO_CONDITIONS: Readonly<Record<number, string>> = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴大冰雹',
}

export function describeWeatherCode(code: unknown): string {
  if (typeof code !== 'number' || !Number.isFinite(code)) return '未知天气'
  return WMO_CONDITIONS[code] ?? `未知天气（编码 ${code}）`
}

/** 一次查询失败。带上可读原因，供工具层直接展示。 */
export class WeatherError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WeatherError'
  }
}

const GEOCODE_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'

/** 把 Open-Meteo 的行政层级拼成人类可读的地区串。 */
function regionOf(result: Record<string, unknown>): string {
  const parts = [result.admin1, result.admin2]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  const country = typeof result.country === 'string' ? result.country : ''
  const unique = [...new Set(parts)]
  const text = [...unique, country].filter(part => part !== '').join(' ')
  return text
}

/**
 * 解析地点名。
 *
 * 中国行政区划重名很常见（例如多个「朝阳区」），所以：
 * - 优先选 `country_code === 'CN'` 的结果，符合本工具的主要使用场景；
 * - 调用方可以用 `region` 参数进一步限定（匹配 admin1/admin2），避免落到同名异地。
 */
export async function resolvePlace(
  name: string,
  options: { readonly region?: string; readonly signal?: AbortSignal } = {},
): Promise<ResolvedPlace> {
  const query = name.trim()
  if (query === '') throw new WeatherError('请提供要查询的地点名称')

  const url = new URL(GEOCODE_ENDPOINT)
  url.searchParams.set('name', query)
  url.searchParams.set('count', '10')
  url.searchParams.set('language', 'zh')
  url.searchParams.set('format', 'json')

  let payload: { results?: unknown }
  try {
    const response = await fetch(url, options.signal === undefined ? {} : { signal: options.signal })
    if (!response.ok) throw new WeatherError(`地点解析服务返回 HTTP ${response.status}`)
    payload = await response.json() as { results?: unknown }
  } catch (error) {
    if (error instanceof WeatherError) throw error
    throw new WeatherError('地点解析服务暂时不可用，请稍后重试')
  }

  const list = Array.isArray(payload.results) ? payload.results as Record<string, unknown>[] : []
  if (list.length === 0) throw new WeatherError(`没有找到「${query}」，请换一个更完整的名称`)

  const wanted = options.region?.trim() ?? ''
  const matches = wanted === ''
    ? list
    : list.filter(item => {
      const text = `${String(item.admin1 ?? '')} ${String(item.admin2 ?? '')} ${String(item.name ?? '')}`
      return text.includes(wanted)
    })
  if (matches.length === 0) {
    throw new WeatherError(`没有找到「${query}」在「${wanted}」下的匹配地点，请核对行政区名称`)
  }

  // 国内结果优先；都是或都不是时保持服务返回的相关性顺序。
  const chosen = matches.find(item => item.country_code === 'CN') ?? matches[0]!
  const latitude = chosen.latitude
  const longitude = chosen.longitude
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    throw new WeatherError('地点解析结果缺少坐标，无法查询天气')
  }
  const placeName = typeof chosen.name === 'string' ? chosen.name : query
  return {
    name: placeName,
    region: regionOf(chosen),
    latitude,
    longitude,
    timezone: typeof chosen.timezone === 'string' ? chosen.timezone : 'auto',
  }
}

/** 查询某个地点的当前天气与未来几天预报。 */
export async function fetchWeather(
  place: ResolvedPlace,
  options: { readonly days?: number; readonly signal?: AbortSignal } = {},
): Promise<WeatherReport> {
  const days = Math.min(Math.max(options.days ?? 3, 1), 7)
  const url = new URL(FORECAST_ENDPOINT)
  url.searchParams.set('latitude', String(place.latitude))
  url.searchParams.set('longitude', String(place.longitude))
  url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m')
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum')
  url.searchParams.set('timezone', place.timezone === '' ? 'auto' : place.timezone)
  url.searchParams.set('forecast_days', String(days))

  let payload: Record<string, unknown>
  try {
    const response = await fetch(url, options.signal === undefined ? {} : { signal: options.signal })
    if (!response.ok) throw new WeatherError(`天气服务返回 HTTP ${response.status}`)
    payload = await response.json() as Record<string, unknown>
  } catch (error) {
    if (error instanceof WeatherError) throw error
    throw new WeatherError('天气服务暂时不可用，请稍后重试')
  }

  const current = payload.current as Record<string, unknown> | undefined
  if (current === undefined) throw new WeatherError('天气服务没有返回当前天气')
  const daily = payload.daily as Record<string, unknown> | undefined
  const dates = Array.isArray(daily?.time) ? daily.time as string[] : []
  const maximums = Array.isArray(daily?.temperature_2m_max) ? daily.temperature_2m_max as unknown[] : []
  const minimums = Array.isArray(daily?.temperature_2m_min) ? daily.temperature_2m_min as unknown[] : []
  const codes = Array.isArray(daily?.weather_code) ? daily.weather_code as unknown[] : []
  const sums = Array.isArray(daily?.precipitation_sum) ? daily.precipitation_sum as unknown[] : []

  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN)

  return {
    place,
    current: {
      time: typeof current.time === 'string' ? current.time : '',
      temperature: number(current.temperature_2m),
      feelsLike: number(current.apparent_temperature),
      humidity: number(current.relative_humidity_2m),
      precipitation: number(current.precipitation),
      windSpeed: number(current.wind_speed_10m),
      condition: describeWeatherCode(current.weather_code),
    },
    daily: dates.map((date, index) => ({
      date,
      condition: describeWeatherCode(codes[index]),
      max: number(maximums[index]),
      min: number(minimums[index]),
      precipitation: number(sums[index]),
    })),
  }
}

/**
 * 把查询结果渲染成一段可读文本。
 *
 * 直接给模型和用户看，所以用中文整句而不是 JSON：模型不需要再从 JSON 里拼话，
 * 用户在对话里也能一眼读懂。
 */
export function formatWeatherReport(report: WeatherReport): string {
  const where = report.place.region === '' ? report.place.name : `${report.place.region} ${report.place.name}`
  const round = (value: number): string => (Number.isFinite(value) ? String(Math.round(value * 10) / 10) : '—')
  const lines = [
    `${where} 天气`,
    `当前：${report.current.condition}，气温 ${round(report.current.temperature)}°C（体感 ${round(report.current.feelsLike)}°C），湿度 ${round(report.current.humidity)}%，降水 ${round(report.current.precipitation)}mm，风速 ${round(report.current.windSpeed)}km/h`,
  ]
  if (report.daily.length > 0) {
    lines.push('预报：')
    for (const day of report.daily) {
      lines.push(`  ${day.date}：${day.condition}，${round(day.min)}~${round(day.max)}°C，降水 ${round(day.precipitation)}mm`)
    }
  }
  return lines.join('\n')
}
