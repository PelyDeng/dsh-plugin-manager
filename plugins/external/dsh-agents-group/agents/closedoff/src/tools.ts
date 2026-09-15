/** DSH tool definitions for the approved closed-off queries. */

import type { Context } from '@deepseek-ai/cordis'
import {
  defineTool,
  type ObjectValueSchemaSpec,
  type ParameterPropertySpec,
  type ParameterSchemaSpec,
  type ToolDefinition,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import type { ClosedoffGateway, JsonObject, JsonValue } from './gateway.ts'
import { extractFences, isFenceTool } from './fences.ts'
import {
  analyzeTrackByDeviceGroups,
  extractDeviceGroups,
  extractTrackPointsFromValue,
} from './presentation.ts'
import { redactJsonValue } from './redaction.ts'
import { TOOL_BY_NAME, TOOL_SPECS, type ToolParam, type ToolSpec } from './specs.ts'
import { createPluginTools, guardTool, type ToolAuthorizer, type ToolDescriptor } from '@dsh-plugin-manager/plugin-kit'

const DEFAULTED_DATE_KEYS = new Set([
  'beginTime', 'startTime', 'inDateBegin', 'outDateBegin', 'warningStartTimeBegin',
  'endTime', 'inDateEnd', 'outDateEnd', 'warningStartTimeEnd',
])

const DEVICE_MODEL_FIELDS = [
  'groupName', 'districtName', 'deviceName', 'deviceCode',
  'deviceType', 'status', 'lastHeartbeatTime', 'inOrOut',
] as const

type OutputObjectSchema = Omit<ObjectValueSchemaSpec, 'properties' | 'additionalProperties'> & {
  readonly properties: ParameterSchemaSpec
  readonly additionalProperties: false
}

const ENVELOPE_FIELDS = [
  'api', 'elapsedMs', 'ok', 'success', 'totalCount', 'pageIndex', 'pageSize', 'note', 'error', 'errCode', 'message',
] as const

const NESTED_MODEL_FIELDS: Partial<Record<ToolSpec['name'], Readonly<Record<string, readonly string[]>>>> = {
  closedoff_checkpoint_devices: {
    deviceList: ['deviceName', 'deviceCode', 'deviceType', 'status', 'inOrOut'],
  },
  closedoff_gate_records_by_car: {
    data: ['address', 'dateTime', 'type', 'violationTypeName', 'remark'],
  },
  closedoff_reservation_stats: {
    typeStats: ['person', 'normalCar', 'dangerCar', 'wasteCar', 'truck'],
  },
  closedoff_park_status: {
    vehicles: ['vehicleType', 'typeName', 'currentInPark', 'inToday', 'outToday', 'capacity'],
    goods: ['goodsType', 'typeName', 'inTons', 'outTons', 'typeCount'],
  },
}

const PRIMITIVE_ARRAY_MODEL_FIELDS: Partial<Record<ToolSpec['name'], readonly string[]>> = {
  closedoff_park_status: ['hazmatHourly', 'hazwasteHourly', 'normalHourly'],
}

const TODAY_TIMELINE_FIELDS = [
  'personNum', 'commonCarNum', 'commonTruckNum', 'hazardousCarNum', 'hazardousWasteCarNum',
] as const

const RESERVATION_INFO_MODEL_FIELDS = [
  'reservationType', 'reservationSource', 'reservationCategory', 'submitRealName', 'realName',
  'carNumb', 'trailerLicensePlate', 'companyName', 'planInTime', 'planOutTime', 'currentStatus',
  'validityBeginTime', 'validityEndTime', 'remark',
] as const

const RESERVATION_APPROVAL_MODEL_FIELDS = [
  'checkStatus', 'checkDesc', 'checkUserName', 'checkUserPhone', 'checkTime',
  'inDeviceNameList', 'outDeviceNameList', 'validityBeginTime', 'validityEndTime', 'sampleCheck',
] as const

const SECURITY_CHECK_ITEM_MODEL_FIELDS = [
  'companyName', 'checkItemName', 'checkDescribe', 'checkMethod', 'checkResult', 'remarks', 'createBy', 'createDate',
] as const

/** Stable tool names used by the Agent allowlist. */
export const TOOL_NAMES = Object.freeze(TOOL_SPECS.map(spec => spec.name))

/** Fail before registration if the approved catalog is internally inconsistent. */
export function validateToolSpecs(specs: readonly ToolSpec[] = TOOL_SPECS): void {
  const names = new Set<string>()
  for (const spec of specs) {
    if (names.has(spec.name)) throw new Error(`closedoff-assistant duplicate tool "${spec.name}"`)
    names.add(spec.name)
    if (!spec.name.startsWith('closedoff_')) throw new Error(`closedoff-assistant invalid tool name "${spec.name}"`)
    if (!spec.path.startsWith('/') || spec.path.includes('..')) throw new Error(`closedoff-assistant invalid API path "${spec.path}"`)
    if (spec.method !== 'GET' && spec.method !== 'POST') throw new Error(`closedoff-assistant invalid method for "${spec.name}"`)
    const parameterKeys = new Set(spec.params.map(param => param.key))
    for (const range of spec.timeRanges ?? []) {
      if (!parameterKeys.has(range.startKey) || !parameterKeys.has(range.endKey) || range.startKey === range.endKey) {
        throw new Error(`closedoff-assistant invalid time range for "${spec.name}"`)
      }
    }
    const resultFields = new Set<string>()
    if (spec.result.dataKind !== 'unknown' && spec.result.fields.length === 0) {
      throw new Error(`closedoff-assistant missing result fields for "${spec.name}"`)
    }
    for (const [key, description] of spec.result.fields) {
      if (key.trim() === '' || description.trim() === '' || resultFields.has(key)) {
        throw new Error(`closedoff-assistant invalid result field for "${spec.name}"`)
      }
      resultFields.add(key)
    }
    for (const [key, description] of spec.result.runtimeFields ?? []) {
      if (key.trim() === '' || description.trim() === '' || resultFields.has(key)) {
        throw new Error(`closedoff-assistant invalid runtime result field for "${spec.name}"`)
      }
      resultFields.add(key)
    }
    for (const [parent, children] of Object.entries(NESTED_MODEL_FIELDS[spec.name] ?? {})) {
      if (!spec.result.fields.some(([key]) => key === parent) || children.length === 0 || new Set(children).size !== children.length) {
        throw new Error(`closedoff-assistant invalid nested result field for "${spec.name}.${parent}"`)
      }
    }
    for (const parent of PRIMITIVE_ARRAY_MODEL_FIELDS[spec.name] ?? []) {
      if (!spec.result.fields.some(([key]) => key === parent)) {
        throw new Error(`closedoff-assistant invalid primitive-array result field for "${spec.name}.${parent}"`)
      }
    }
    if (spec.name === 'closedoff_today_reservation' && !spec.result.fields.some(([key]) => key === 'timeLine')) {
      throw new Error('closedoff-assistant missing today reservation timeline field')
    }
    if (spec.name === 'closedoff_reservation_detail' && !spec.result.fields.some(([key]) => key === 'specificData')) {
      throw new Error('closedoff-assistant missing reservation progress detail field')
    }
    if (spec.name === 'closedoff_device_page') {
      for (const key of DEVICE_MODEL_FIELDS) {
        if (!resultFields.has(key)) throw new Error(`closedoff-assistant undeclared device projection field "${key}"`)
      }
    }
  }
}

function recordSchema(spec: ToolSpec): ValueSchemaSpec {
  const properties: ParameterSchemaSpec = {}
  for (const [key, description] of spec.result.fields) properties[key] = { type: 'json', description }
  return { type: 'object', additionalProperties: true, properties }
}

function nullable(schema: ValueSchemaSpec): ValueSchemaSpec {
  return { oneOf: [schema, { type: 'null' }] }
}

function dataSchema(spec: ToolSpec): ValueSchemaSpec {
  const record = recordSchema(spec)
  switch (spec.result.dataKind) {
    case 'list': return nullable({ type: 'array', items: record })
    case 'object': return nullable(record)
    case 'paged-object': return nullable({
      type: 'object',
      additionalProperties: true,
      properties: {
        data: { type: 'array', items: record, description: '本页业务记录' },
        pageIndex: { type: 'json', description: '当前页码' },
        pageSize: { type: 'json', description: '每页条数' },
        totalCount: { type: 'json', description: '总记录数' },
        totalPages: { type: 'json', description: '总页数' },
      },
    })
    case 'unknown': return {
      type: 'json',
      description: `当前代码只能确认主要字段：${spec.result.fields.map(([key]) => key).join('、')}`,
    }
  }
}

function outputSchema(spec: ToolSpec): {
  oneOf: readonly [OutputObjectSchema, OutputObjectSchema, OutputObjectSchema]
} {
  const common = {
    api: { type: 'string' as const, const: spec.path, required: true as const },
    elapsedMs: { type: 'number' as const, required: true as const, description: '插件测得的调用耗时（毫秒）' },
  }
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...common,
          ok: { type: 'boolean', const: true, required: true },
          success: { type: 'json', description: '上游业务成功标记' },
          data: { ...dataSchema(spec), required: true },
          totalCount: { type: 'json', description: '上游总记录数' },
          pageIndex: { type: 'json', description: '上游当前页码' },
          pageSize: { type: 'json', description: '上游每页条数' },
          note: { type: 'string', description: '插件实际采用的时间范围说明' },
          ...(spec.name === 'closedoff_vehicle_track'
            ? { devices: { type: 'json' as const, description: '轨迹分析配套设备查询的完整结果' } }
            : {}),
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...common,
          ok: { type: 'boolean', const: false, required: true },
          error: { type: 'string', required: true, description: '传输、配置或本地处理错误' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...common,
          ok: { type: 'boolean', const: false, required: true },
          errCode: { type: 'json', required: true, description: '上游业务错误码' },
          message: { type: 'string', required: true, description: '上游业务错误信息' },
        },
      },
    ],
  }
}

function resultHint(spec: ToolSpec): string {
  if (spec.result.dataKind === 'unknown') {
    if (spec.result.fields.length === 0) return '返回结构待复核；当前代码没有可稳定依赖的业务字段。'
    const clues = spec.result.fields.slice(0, 6).map(([key]) => key).join('、')
    return `返回结构待复核；当前字段线索：${clues}${spec.result.fields.length > 6 ? '等' : ''}。`
  }
  const kind = spec.result.dataKind === 'list' ? '列表'
    : spec.result.dataKind === 'object' ? '对象'
      : spec.result.dataKind === 'paged-object' ? '分页对象'
        : '未知'
  const fields = spec.result.fields.slice(0, 6).map(([key]) => key).join('、')
  return `主要返回键（${kind}，当前代码快照）：${fields}${spec.result.fields.length > 6 ? '等' : ''}。`
}

function parameterNode(param: ToolParam): ParameterPropertySpec {
  const required = param.required && !DEFAULTED_DATE_KEYS.has(param.key) ? { required: true as const } : {}
  const annotations = { description: param.desc, ...required }
  switch (param.type) {
    case 'string': return { type: 'string', ...annotations, ...(param.enum === undefined ? {} : { enum: param.enum as readonly string[] }) }
    case 'integer': return { type: 'integer', ...annotations, ...(param.enum === undefined ? {} : { enum: param.enum as readonly number[] }) }
    case 'number': return { type: 'number', ...annotations, ...(param.enum === undefined ? {} : { enum: param.enum as readonly number[] }) }
    case 'boolean': return { type: 'boolean', ...annotations, ...(param.enum === undefined ? {} : { enum: param.enum as readonly boolean[] }) }
    case 'array': return {
      type: 'array',
      ...annotations,
      items: param.itemType === undefined ? { type: 'json' } : { type: param.itemType },
    }
  }
}

function parameterSchema(spec: ToolSpec): ParameterSchemaSpec {
  const schema: ParameterSchemaSpec = {}
  for (const param of spec.params) schema[param.key] = parameterNode(param)
  return schema
}

function formatTrackTime(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value
  const milliseconds = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{11,}$/.test(value)
      ? Number(value)
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN
  if (!Number.isFinite(milliseconds)) return undefined
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(milliseconds))
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${fields.year}-${fields.month}-${fields.day} ${fields.hour}:${fields.minute}:${fields.second}`
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds % 3600 / 60)
  const seconds = totalSeconds % 60
  return [
    ...(hours > 0 ? [`${String(hours)} 小时`] : []),
    ...(minutes > 0 ? [`${String(minutes)} 分钟`] : []),
    ...(seconds > 0 || (hours === 0 && minutes === 0) ? [`${String(seconds)} 秒`] : []),
  ].join(' ')
}

function renderTrackOutput(value: JsonValue, config: Config): { type: 'text'; text: string }[] {
  const root = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  const rows = Array.isArray(root.data) ? root.data : []
  const points = extractTrackPointsFromValue(value, Number.POSITIVE_INFINITY)
  if (points.length === 0) return [{ type: 'text', text: '轨迹查询完成，未返回可展示的轨迹点。' }]
  const firstRow = rows.find((row): row is JsonObject => typeof row === 'object' && row !== null && !Array.isArray(row))
  const vehicle = typeof firstRow?.vehicleNo === 'string' && firstRow.vehicleNo !== '' ? `车辆 ${firstRow.vehicleNo}；` : ''
  const times = points
    .map(point => point.t === undefined ? Number.NaN : /^\d{11,}$/.test(point.t) ? Number(point.t) : Date.parse(point.t))
    .filter(Number.isFinite)
  const range = times.length > 0
    ? `实际轨迹时间 ${formatTrackTime(Math.min(...times)) ?? '无法确认'} 至 ${formatTrackTime(Math.max(...times)) ?? '无法确认'}；`
    : ''
  const heights = points.map(point => point.h).filter(Number.isFinite)
  const height = heights.length > 0
    ? `高度约 ${Math.min(...heights).toFixed(1)} 至 ${Math.max(...heights).toFixed(1)} 米；`
    : ''
  const groups = extractDeviceGroups(root.devices)
  const analysis = analyzeTrackByDeviceGroups(
    points,
    groups,
    config.trackDeviceRadiusMeters,
    config.trackDwellMaxGapSeconds * 1000,
  )
  const devicesFailed = typeof root.devices === 'object' && root.devices !== null && !Array.isArray(root.devices) && root.devices.ok === false
  const groupSummary = devicesFailed
    ? '设备组查询失败，无法完成沿途设备组和驻留分析；'
    : analysis.groups.length === 0
      ? '轨迹附近未匹配到有有效标绘点的设备组；'
      : `轨迹附近设备组（按路线先后，共 ${String(analysis.groups.length)} 个）：${analysis.groups.map(group => group.groupName).join('、')}；`
  const endpoints = [
    ...(analysis.startGroup === undefined ? [] : [`起点附近：${analysis.startGroup.groupName}`]),
    ...(analysis.endGroup === undefined ? [] : [`终点附近：${analysis.endGroup.groupName}`]),
  ]
  const endpointSummary = endpoints.length === 0 ? '' : `${endpoints.join('；')}；`
  const staySummary = devicesFailed
    ? ''
    : analysis.longestStay === undefined
      ? '没有足够的连续定位点估算最长驻留位置；'
      : `最长驻留估算：${analysis.longestStay.group.groupName} 附近约 ${formatDuration(analysis.longestStay.durationMs)}；`
  const gapSummary = analysis.excludedGapCount === 0
    ? ''
    : `已排除 ${String(analysis.excludedGapCount)} 个超过 ${String(config.trackDwellMaxGapSeconds)} 秒的定位间隔；`
  return [{
    type: 'text',
    text: String(redactJsonValue(`轨迹数据已加载：${vehicle}轨迹点 ${String(points.length)} 个；${range}${height}${groupSummary}${endpointSummary}${staySummary}${gapSummary}完整点位和设备组已交给轨迹地图展示。请基于这些事实补充园区管理分析；设备组名称表示轨迹线附近点位，不等于设备实际识别到车辆，驻留时长是离散定位点的保守估算，需结合摄像头抓拍核验。`)),
  }]
}

function renderDeviceOutput(value: JsonValue): { type: 'text'; text: string }[] {
  const root = typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
  const rows = Array.isArray(root.data) ? root.data : []
  const data = rows.slice(0, 20).flatMap((row) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return []
    const summary: JsonObject = {}
    for (const key of DEVICE_MODEL_FIELDS) {
      const field = row[key]
      if (field !== undefined && field !== null && field !== '') summary[key] = field
    }
    return [summary]
  })
  const totalCount = typeof root.totalCount === 'number' ? root.totalCount : rows.length
  return [{
    type: 'text',
    text: JSON.stringify(redactJsonValue({
      ok: true,
      totalCount,
      shown: data.length,
      data,
      ...(rows.length > data.length ? { note: `仅向模型展示前 ${String(data.length)} 条设备摘要` } : {}),
    }), null, 2),
  }]
}

function projectNested(value: JsonValue, allowed: readonly string[]): JsonValue | undefined {
  if (Array.isArray(value)) {
    const items = value.flatMap(item => {
      const projected = projectNested(item, allowed)
      return projected === undefined ? [] : [projected]
    })
    return items
  }
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, JsonValue> = {}
  for (const key of allowed) {
    const field = value[key]
    if (field !== undefined) result[key] = redactJsonValue(field, key)
  }
  return result
}

function projectRecord(spec: ToolSpec, value: JsonValue): JsonValue | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const nested = NESTED_MODEL_FIELDS[spec.name] ?? {}
  const result: Record<string, JsonValue> = {}
  for (const [key] of spec.result.fields) {
    if (isFenceTool(spec.name) && (key === 'plottingData' || key === 'plottingConfigData')) continue
    const field = value[key]
    if (field === undefined) continue
    if (typeof field !== 'object' || field === null) result[key] = redactJsonValue(field, key)
    else {
      const primitiveArray = PRIMITIVE_ARRAY_MODEL_FIELDS[spec.name]?.includes(key) === true
      const projected = primitiveArray
        ? (Array.isArray(field) ? field
            .filter(item => typeof item === 'number' || typeof item === 'string' || typeof item === 'boolean' || item === null)
            .map(item => redactJsonValue(item, key)) : undefined)
        : spec.name === 'closedoff_reservation_detail' && key === 'specificData'
          ? projectReservationProgress(value.typeCode, field)
        : spec.name === 'closedoff_today_reservation' && key === 'timeLine'
          ? projectTodayTimeline(field)
          : nested[key] === undefined ? undefined : projectNested(field, nested[key])
      if (projected !== undefined) result[key] = projected
    }
  }
  return result
}

function projectReservationProgress(typeCode: JsonValue | undefined, value: JsonValue): JsonValue | undefined {
  const code = Number(typeCode)
  if (code === 0) return projectNested(value, RESERVATION_INFO_MODEL_FIELDS)
  if (code === 1 || code === 2) return projectNested(value, RESERVATION_APPROVAL_MODEL_FIELDS)
  if (code === 3) return Array.isArray(value) ? projectNested(value, SECURITY_CHECK_ITEM_MODEL_FIELDS) : undefined
  if (code !== 4 || typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const source = value as Record<string, JsonValue>
  const projected: Record<string, JsonValue> = {}
  for (const key of ['securityCheckResults', 'securityCheckTime', 'createBy'] as const) {
    if (source[key] !== undefined) projected[key] = redactJsonValue(source[key], key)
  }
  const items = source.securityCheckList
  if (Array.isArray(items)) projected.securityCheckList = projectNested(items, SECURITY_CHECK_ITEM_MODEL_FIELDS) ?? []
  return projected
}

function projectTodayTimeline(value: JsonValue): JsonValue | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const projected: Record<string, JsonValue> = {}
    for (const [hour, hourly] of Object.entries(item)) {
      if (!/^(?:[01]\d|2[0-3])$/.test(hour)) continue
      const detail = projectNested(hourly, TODAY_TIMELINE_FIELDS)
      if (detail !== undefined) projected[hour] = detail
    }
    return Object.keys(projected).length === 0 ? [] : [projected]
  })
}

function projectData(spec: ToolSpec, value: JsonValue): JsonValue {
  if (value === null) return null
  if (spec.result.dataKind === 'paged-object' && typeof value === 'object' && !Array.isArray(value)) {
    const rows = Array.isArray(value.data) ? value.data.flatMap(item => {
      const projected = projectRecord(spec, item)
      return projected === undefined ? [] : [projected]
    }) : []
    return {
      data: rows,
      ...Object.fromEntries(['pageIndex', 'pageSize', 'totalCount', 'totalPages'].flatMap(key => value[key] === undefined ? [] : [[key, value[key]]])),
    }
  }
  if (Array.isArray(value)) return value.flatMap(item => {
    const projected = projectRecord(spec, item)
    return projected === undefined ? [] : [projected]
  })
  return projectRecord(spec, value) ?? null
}

function projectModelOutput(spec: ToolSpec, value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return redactJsonValue(value)
  const result: Record<string, JsonValue> = {}
  for (const key of ENVELOPE_FIELDS) {
    const field = value[key]
    if (field !== undefined) result[key] = redactJsonValue(field, key)
  }
  if (value.data !== undefined) result.data = projectData(spec, value.data)
  return result
}

function renderOutput(spec: ToolSpec, value: JsonValue, config: Config): { type: 'text'; text: string }[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && value.ok === false) {
    return [{ type: 'text', text: JSON.stringify(projectModelOutput(spec, value), null, 2) }]
  }
  if (spec.name === 'closedoff_vehicle_track') return renderTrackOutput(value, config)
  if (spec.name === 'closedoff_device_page') return renderDeviceOutput(value)
  if (isFenceTool(spec.name)) {
    const fences = extractFences(value)
    return [{ type: 'text', text: JSON.stringify({
      ...projectModelOutput(spec, value) as JsonObject,
      mapSummary: `可展示边界 ${fences.geometries.length} 个。${fences.note}${fences.geometries.length > 0 ? '有效边界已交给页面生成三维视图；浏览器加载是否成功需以页面状态为准。' : '没有可生成三维视图的边界。'}`,
    }, null, 2) }]
  }
  return [{ type: 'text', text: JSON.stringify(projectModelOutput(spec, value), null, 2) }]
}

async function executeTool(
  spec: ToolSpec,
  gateway: ClosedoffGateway,
  config: Config,
  args: Readonly<JsonObject>,
  signal: AbortSignal,
): Promise<JsonObject> {
  if (spec.name !== 'closedoff_vehicle_track') return gateway.call(spec, args, signal)
  const deviceSpec = TOOL_BY_NAME.get('closedoff_device_page')
  if (deviceSpec === undefined) throw new Error('closedoff-assistant device tool is required for vehicle-track analysis')
  const [track, devices] = await Promise.all([
    gateway.call(spec, args, signal),
    gateway.call(deviceSpec, { pageIndex: 1, pageSize: 500 }, signal),
  ])
  return track.ok ? { ...track, devices } : track
}

function defineBusinessTool(spec: ToolSpec, gateway: ClosedoffGateway, config: Config): ToolDefinition {
  return defineTool({
    name: spec.name,
    description: `${spec.desc}\n${resultHint(spec)}`,
    parameters: parameterSchema(spec),
    timeoutMs: config.toolTimeoutMs,
    output: {
      schema: outputSchema(spec),
      render: (_args, value) => renderOutput(spec, value as JsonObject, config),
      ...(spec.name === 'closedoff_device_page' || spec.name === 'closedoff_vehicle_track' || spec.name === 'closedoff_vehicle_stream' || isFenceTool(spec.name)
        ? { presentationMeta: (_args: unknown, value: unknown) => ({ api: spec.path, value: value as JsonObject }) }
        : {}),
    },
    execute: async (args, execution) => executeTool(spec, gateway, config, args as JsonObject, execution.signal),
  })
}

/** Build one validated, authorized DSH tool around the shared gateway. */
export function createTool(spec: ToolSpec, gateway: ClosedoffGateway, config: Config, authorize: ToolAuthorizer): ToolDefinition {
  return guardTool(defineBusinessTool(spec, gateway, config), authorize)
}

/** Register approved queries through the common owner and return their actual catalog entries. */
export function registerTools(ctx: Context, gateway: ClosedoffGateway, config: Config, authorize: ToolAuthorizer, category: string): readonly ToolDescriptor[] {
  validateToolSpecs()
  const tools = createPluginTools(ctx, { permission: 'closedoff:access', authorize })
  // 分类由群组从清单注入：这是唯一权威来源，子包不自己写字符串，否则两处漂移会让本 Agent 的工具全部不可见
  return TOOL_SPECS.map(spec => tools.register(defineBusinessTool(spec, gateway, config), spec.displayName, category))
}
