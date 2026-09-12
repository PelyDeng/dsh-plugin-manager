/**
 * 通用天气查询。
 *
 * 数据来源是 Open-Meteo：**不需要 API Key**，所以群组不必引入凭据管理，也不会有密钥
 * 泄漏面。支持按省、市、区县名解析地点，再查当前天气与未来几天预报。
 *
 * 这个模块只做「取数 + 归一化」，不涉及工具注册与鉴权：那两件事随调用方（群组的通用
 * 工具注册）处理，方便单独测试取数逻辑。
 */

/**
 * 省级行政区到省会的映射，用于「查某个省」的回退。
 *
 * 数据源只收录城镇，没有省级条目：查「四川」「新疆」「内蒙古」都是零结果。但省级是天气查询
 * 的常见入口，所以回退到省会给出一个代表点，并在结果里**明确写出这不是全省数据**。
 *
 * 这是数据源的固有限制，不是可以绕过的实现细节：省内南北温差可能很大，让使用者以为拿到
 * 了全省天气是错的。
 */
const PROVINCE_CAPITALS: Readonly<Record<string, string>> = {
  河北: '石家庄', 山西: '太原', 辽宁: '沈阳', 吉林: '长春', 黑龙江: '哈尔滨',
  江苏: '南京', 浙江: '杭州', 安徽: '合肥', 福建: '福州', 江西: '南昌',
  山东: '济南', 河南: '郑州', 湖北: '武汉', 湖南: '长沙', 广东: '广州',
  海南: '海口', 四川: '成都', 贵州: '贵阳', 云南: '昆明', 陕西: '西安',
  甘肃: '兰州', 青海: '西宁', 内蒙古: '呼和浩特', 广西: '南宁', 西藏: '拉萨',
  宁夏: '银川', 新疆: '乌鲁木齐',
}

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
  /**
   * 标准写法提示。
   *
   * 只在「按原样查不到、去掉行政后缀才命中」时给出。使用者的写法与数据源不一致时，
   * 与其让他猜为什么查不到，不如直接告诉他该用哪个写法。
   */
  readonly standardName?: string
  /**
   * 取数口径说明。
   *
   * 出现在「查的是省，但给的是省会的数据」这类情况下。必须在答复里如实说明，
   * 否则使用者会以为拿到了全省天气。
   */
  readonly assumption?: string
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
 * 查询词的候选顺序。
 *
 * Open-Meteo 的地理编码按**专名**匹配，带行政后缀反而查不到：「重庆市」「四川省」
 * 「成都市」「渝北区」都是零结果，去掉后缀的「重庆」「四川」「成都」「渝北」才命中。
 * 例外是「浦东新区」这类本身就是完整专名的名称，去掉后缀会变成查不到的「浦东新」。
 *
 * 所以先试原名，再依次去掉末尾的行政区划通名重试。实测这两步能覆盖直辖市、省、地级市、
 * 区县与新区等各种写法，用户按日常习惯写「重庆市」也能查到。
 */
function queryCandidates(query: string): string[] {
  const suffixes = ['特别行政区', '自治区', '自治州', '自治县', '地区', '盟', '市', '省', '区', '县', '旗']
  const candidates = [query]
  for (const suffix of suffixes) {
    if (query.length > suffix.length && query.endsWith(suffix)) {
      const stripped = query.slice(0, -suffix.length)
      if (stripped !== '' && !candidates.includes(stripped)) candidates.push(stripped)
    }
  }
  return candidates
}

/** 查一次地理编码。返回结果列表；服务不可用或返回非 200 时抛出可读错误。 */
async function geocode(query: string, signal: AbortSignal | undefined): Promise<Record<string, unknown>[]> {
  const url = new URL(GEOCODE_ENDPOINT)
  url.searchParams.set('name', query)
  url.searchParams.set('count', '10')
  url.searchParams.set('language', 'zh')
  url.searchParams.set('format', 'json')
  try {
    const response = await fetch(url, signal === undefined ? {} : { signal })
    if (!response.ok) throw new WeatherError(`地点解析服务返回 HTTP ${response.status}`)
    const payload = await response.json() as { results?: unknown }
    return Array.isArray(payload.results) ? payload.results as Record<string, unknown>[] : []
  } catch (error) {
    if (error instanceof WeatherError) throw error
    throw new WeatherError('地点解析服务暂时不可用，请稍后重试')
  }
}

/**
 * 解析地点名。
 *
 * 中国行政区划重名很常见（例如多个「朝阳区」），所以：
 * - 优先选 `country_code === 'CN'` 的结果，符合本工具的主要使用场景；
 * - 调用方可以用 `region` 参数进一步限定（匹配 admin1/admin2），避免落到同名异地。
 *
 * 命中后会把「原名查不到、去后缀才查到」的情况写进 `standardName`，让使用者知道该用哪个
 * 写法 —— 上一轮真实查询里「重庆市」查不到但「重庆」可以，这个差异必须让使用者看见。
 */
export async function resolvePlace(
  name: string,
  options: { readonly region?: string; readonly signal?: AbortSignal } = {},
): Promise<ResolvedPlace> {
  const query = name.trim()
  if (query === '') throw new WeatherError('请提供要查询的地点名称')

  // 逐个候选尝试；记住真正命中的那个，用于判断是否需要提示标准写法。
  let list: Record<string, unknown>[] = []
  let used = query
  for (const candidate of queryCandidates(query)) {
    list = await geocode(candidate, options.signal)
    if (list.length > 0) { used = candidate; break }
  }
  /**
   * 省级回退。
   *
   * 数据源没有省级条目，查「四川」这类名称会零结果。省级是常见入口，所以回退到省会取一个
   * 代表点，并把口径写进 `assumption` —— 省内温差可能很大，不说明就等于骗人。
   */
  let assumption: string | undefined
  if (list.length === 0) {
    const province = queryCandidates(query).map(candidate => PROVINCE_CAPITALS[candidate]).find(capital => capital !== undefined)
    if (province !== undefined) {
      list = await geocode(province, options.signal)
      if (list.length > 0) {
        used = province
        assumption = `数据源没有「${query}」的省级数据，这里给的是省会「${province}」的情况；省内其他城市可能明显不同。`
      }
    }
  }
  if (list.length === 0) throw new WeatherError(`没有找到「${query}」，请换一个更完整的名称`)

  const wanted = options.region?.trim() ?? ''
  // region 也按同一套候选匹配：用户写「北京市」而结果里是「北京」时不该判为不匹配。
  const regionCandidates = queryCandidates(wanted)
  const matches = wanted === ''
    ? list
    : list.filter(item => {
      const text = `${String(item.admin1 ?? '')} ${String(item.admin2 ?? '')} ${String(item.name ?? '')}`
      return regionCandidates.some(candidate => text.includes(candidate))
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
  const region = regionOf(chosen)
  // 只有当查询词与数据源的标准专名**不相等**时才提示写法，例如「重庆市」与「重庆」。
  // 用相等判断而不是字符串包含：「重庆市」的 region 里本来就含「重庆市」，用包含判断会
  // 误判成「写法已经对了」而漏掉提示。
  // 省级回退已由 assumption 说明口径，不再叠一条。
  const standardName = assumption !== undefined || query === placeName ? undefined : placeName
  return {
    name: placeName,
    region,
    latitude,
    longitude,
    timezone: typeof chosen.timezone === 'string' ? chosen.timezone : 'auto',
    ...(standardName === undefined ? {} : { standardName }),
    ...(assumption === undefined ? {} : { assumption }),
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
  // 地点名与所属行政区相同时不重复写，例如「重庆市 中国 重庆」只留「重庆市 中国」。
  const { name, region } = report.place
  const where = region === '' || region.includes(name) ? (region === '' ? name : region) : `${region} ${name}`
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
  if (report.place.standardName !== undefined) {
    lines.push(`提示：数据源的标准写法是「${report.place.standardName}」，下次可以直接这样写。`)
  }
  if (report.place.assumption !== undefined) {
    lines.push(`说明：${report.place.assumption}`)
  }
  return lines.join('\n')
}
