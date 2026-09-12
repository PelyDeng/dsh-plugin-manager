/**
 * 群组的通用工具。
 *
 * 「通用工具」是约定好的公共集：每个 Agent 都能调用，不受「只允许调用自己标签的工具」
 * 限制。因此这里的工具必须满足两个条件 —— 不依赖任何单一 Agent 的业务数据，也不需要
 * 单独的凭据。天气查询正是这样的工具。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { fetchWeather, formatWeatherReport, resolvePlace, WeatherError } from '@dsh-agents-group/common'

/** 工具名。带 `common_` 前缀，一眼能看出它属于通用集。 */
export const WEATHER_TOOL_NAME = 'common_weather'

/**
 * 通用天气查询工具。
 *
 * 支持按省、市、区县名查询。重名行政区（例如多个「朝阳区」）用 `region` 参数限定，
 * 避免静默落到同名异地 —— 那是这类查询最容易出的错。
 */
export const weatherTool = defineTool({
  name: WEATHER_TOOL_NAME,
  description: '查询中国各省、市、区县的当前天气与未来几天预报。地点填城市或区县名；同名行政区用 region 限定。',
  parameters: {
    location: { type: 'string', required: true, description: '地点名称，例如「重庆市」「朝阳区」「浦东新区」。' },
    region: { type: 'string', description: '用于消歧的上级行政区，例如「北京市」或「四川省」。同名区县较多时建议填写。' },
    days: { type: 'integer', description: '预报天数，1 到 7，默认 3。' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        place: { type: 'string', required: true },
        report: { type: 'string', required: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.report }],
  },
  execute: async (args, exec) => {
    const place = await resolvePlace(args.location, {
      ...(args.region === undefined ? {} : { region: args.region }),
      signal: exec.signal,
    })
    const days = typeof args.days === 'number' ? args.days : 3
    const report = await fetchWeather(place, { days, signal: exec.signal })
    const where = place.region === '' ? place.name : `${place.region} ${place.name}`
    return { place: where, report: formatWeatherReport(report) }
  },
})

/** 便于测试与诊断：确认这个工具属于通用集。 */
export function isWeatherToolFailure(error: unknown): error is WeatherError {
  return error instanceof WeatherError
}
