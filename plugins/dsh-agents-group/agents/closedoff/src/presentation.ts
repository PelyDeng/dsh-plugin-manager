/** Pure projections from durable DSH events to the dedicated Web UI payloads. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { historyAssistantDeltas } from './assistant-stream.ts'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { redactJsonValue, redactVisibleText } from './redaction.ts'
import { TOOL_BY_NAME } from './specs.ts'
import { fencesFromResult, isFenceTool, type FencesPayload } from './fences.ts'

export interface ToolCard {
  callId: string
  name: string
  api: string
  status: 'run' | 'ok' | 'error'
  presentation: Pick<CardsPayload, 'tool' | 'group' | 'variant' | 'sourceLabel'>
}

export interface HistoryUser {
  role: 'user'
  text: string
  time: number
}

export interface HistoryAssistant {
  role: 'assistant'
  text: string
  thinking: string
  thinkingDone: boolean
  tools: ToolCard[]
  tracks: Record<string, { points: TrackPoint[]; vehicleNo: string; groups?: TrackDeviceGroup[] }>
  fences: Record<string, FencesPayload>
  media: Record<string, VehicleMediaItem[]>
  cards: Record<string, CardsPayload>
  time: number
  done: boolean
  finishReason?: string
  messageId?: string
  branchSeq?: number
  completedAt?: number
  runMs?: number
  ttftMs?: number
  usage?: TurnUsageSummary
}

export type HistoryEntry = HistoryUser | HistoryAssistant

export interface TurnUsageSummary {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

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

export interface CardsPayload {
  tool: string
  group: ResultGroup
  variant: 'summary' | 'records'
  sourceLabel: string
  state: 'loading' | 'data' | 'empty' | 'error'
  count: number
  shown: number
  note: string
  cards: { title: string; titleKey?: string; fields: { k: string; v: string; tone: string }[] }[]
}

export type ResultGroup = 'overview' | 'authorization' | 'access' | 'track' | 'reservation' | 'risk' | 'infrastructure' | 'other'

const LABELS: Record<string, string> = {
  carNum: '车牌', carNumb: '车牌', vehicleNo: '车牌', realName: '关联人员', userName: '姓名',
  sex: '性别', idCard: '身份证号', userPhone: '联系电话', companyName: '所属企业', sourceType: '申请来源',
  status: '状态', currentStatus: '当前状态', warningStatus: '状态',
  parkingStatus: '状态', validityStatus: '授权状态', beginTime: '开始', endTime: '结束',
  createDate: '提交时间', inDate: '入园时间', outDate: '出园时间', warningStartTime: '报警时间',
  name: '名称', deviceName: '设备', groupName: '设备组', title: '标题', parkingAreaName: '停车区',
  parkingGroupName: '停车组', deviceCode: '设备编号', code: '编号', warningLevel: '等级',
  carCategory: '车辆类型', carNumbColour: '车牌颜色', trailer: '挂车牌号',
  accessCount: '通行次数', inCount: '入园次数', outCount: '出园次数',
  violationCount: '违章次数', blackCount: '黑名单次数', address: '卡口', dateTime: '通行时间',
  type: '方向', startDate: '开始时间', endDate: '结束时间', violationTypeName: '违规类型', remark: '用途备注',
  validityBeginTime: '有效期开始', validityEndTime: '有效期结束', companyCheckStatus: '企业审核',
  submitBy: '提交人', submitUserPhone: '提交人电话', submitDate: '提交时间',
  inDeviceName: '入园设备', outDeviceName: '出园设备', planInTime: '计划入园', planOutTime: '计划出园',
  parkCheckStatus: '园区审核', reservationType: '预约类型', warningType: '事件类型',
  waybillNumber: '运单号', startingPoint: '起运地', trailerLicensePlate: '挂车牌号', electronicWaybill: '电子运单',
  typeCode: '进度阶段', time: '发生时间', checkStatus: '审核状态', checkDesc: '审核说明', checkTime: '审核时间',
  checkUserName: '审核人', checkUserPhone: '审核人电话', sampleCheck: '是否抽检',
  securityCheckResults: '抽检结果', securityCheckTime: '抽检时间', createBy: '检查人',
  checkItemName: '检查项', checkDescribe: '检查说明', checkMethod: '记录手段', checkResult: '检查结果',
  remarks: '备注',
  personInPark: '当前在园人员', personInToday: '今日入园人员', personNum: '人员预约',
  commonCarNum: '普通车预约', commonTruckNum: '普通货车预约', hazardousCarNum: '危化车预约',
  hazardousWasteCarNum: '危废车预约', pendingApprovalNum: '待审批', submittedNum: '已提交',
  device_id: '查询标识', start_time: '开始时间', time_len: '时长',
  todayPending: '今日待审', todayCompleted: '今日已完成', avgProcessMinutes: '平均处理分钟', passRate: '通过率',
  controlName: '控制区', controlType: '控制区类型', controlAreaCount: '控制区数量',
  abnormalInspectionCount: '异常巡检', alarmCount: '报警数量',
}

const TITLE_KEYS = new Set([
  'carNum', 'carNumb', 'vehicleNo', 'realName', 'userName', 'name', 'deviceName', 'groupName', 'title', 'address',
  'companyName', 'parkingAreaName', 'parkingGroupName', 'districtName',
  'typeCode', 'controlName',
])

const TOOL_FIELDS: Partial<Record<string, readonly string[]>> = {
  closedoff_vehicle_comprehensive_page: [
    'carNumb', 'validityStatus', 'carCategory', 'carNumbColour', 'trailer',
    'accessCount', 'inCount', 'outCount', 'violationCount', 'blackCount',
  ],
  closedoff_white_page: [
    'carNumb', 'realName', 'sex', 'idCard', 'userPhone', 'companyName', 'sourceType',
    'currentStatus', 'validityBeginTime', 'validityEndTime', 'companyCheckStatus', 'submitBy',
    'submitUserPhone', 'submitDate',
  ],
  closedoff_black_page: [
    'carNumb', 'realName', 'companyName', 'carCategory', 'status', 'remark',
    'validityBeginTime', 'validityEndTime', 'parkCheckStatus',
  ],
  closedoff_access_record_page: [
    'carNumb', 'realName', 'inDate', 'inDeviceName', 'outDate', 'outDeviceName', 'violationCount',
  ],
  closedoff_gate_records_by_car: ['address', 'dateTime', 'type', 'violationTypeName', 'remark'],
  closedoff_reservation_approval_page: [
    'carNumb', 'realName', 'companyName', 'reservationType', 'planInTime', 'planOutTime',
    'companyCheckStatus', 'parkCheckStatus', 'currentStatus',
  ],
  closedoff_reservation_completed_page: [
    'carNumb', 'realName', 'companyName', 'reservationType', 'planInTime', 'planOutTime',
    'companyCheckStatus', 'parkCheckStatus', 'currentStatus',
  ],
  closedoff_warning_page: [
    'title', 'warningType', 'warningLevel', 'warningStatus', 'warningStartTime', 'companyName', 'deviceName', 'carNum',
  ],
  closedoff_waybill_page: [
    'waybillNumber', 'electronicWaybill', 'startingPoint', 'carNumb', 'trailerLicensePlate', 'companyName', 'realName',
  ],
  closedoff_reservation_detail: ['typeCode', 'time'],
  closedoff_reservation_stats: ['todayPending', 'todayCompleted', 'avgProcessMinutes', 'passRate'],
  closedoff_today_reservation: [
    'personNum', 'commonCarNum', 'commonTruckNum', 'hazardousCarNum', 'hazardousWasteCarNum', 'pendingApprovalNum', 'submittedNum',
  ],
  closedoff_park_status: ['personInPark', 'personInToday'],
  closedoff_vehicle_stream: ['device_id', 'start_time', 'time_len'],
  closedoff_control_area_stats: ['controlType', 'controlAreaCount', 'abnormalInspectionCount', 'alarmCount'],
  closedoff_control_area_page: ['controlName', 'controlType', 'remarks'],
}

const OPAQUE_RESULT_FIELDS = new Set(['id', 'reservationId', 'districtId', 'bizDataId', 'groupId'])
const AUTO_CARD_BLOCKED_FIELDS = new Set([
  ...OPAQUE_RESULT_FIELDS,
  'oldData', 'newData', 'plottingConfigData', 'plottingData', 'specificData', 'deviceList', 'points', 'data',
])

const NESTED_PRESENTATION_FIELDS: Readonly<Partial<Record<string, Readonly<Record<string, readonly string[]>>>>> = {
  closedoff_reservation_detail: {
    specificData: [
      'carNumb', 'companyName', 'reservationType', 'planInTime', 'planOutTime', 'currentStatus',
      'checkStatus', 'checkDesc', 'checkUserName', 'checkUserPhone', 'checkTime',
      'validityBeginTime', 'validityEndTime', 'sampleCheck',
      'securityCheckResults', 'securityCheckTime', 'createBy',
      'checkItemName', 'checkDescribe', 'checkMethod', 'checkResult', 'remarks', 'createDate',
    ],
  },
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  closedoff_warning_page: '预警报警查询', closedoff_warning_detail: '预警报警详情',
  closedoff_warning_count: '预警数量统计', closedoff_warning_module_list: '报警模块列表',
  closedoff_warning_count_by_level: '报警等级统计', closedoff_reservation_approval_page: '预约审批待审',
  closedoff_reservation_completed_page: '预约审批记录', closedoff_reservation_stats: '预约审批统计',
  closedoff_reservation_detail: '预约详情', closedoff_change_record_page: '变更记录',
  closedoff_today_reservation: '今日预约', closedoff_vehicle_track: '车辆轨迹',
  closedoff_vehicle_location_page: '车辆定位', closedoff_vehicle_latest_positions: '在园车辆最新位置',
  closedoff_vehicle_stream: '车辆轨迹视频', closedoff_parking_area_page: '停车区',
  closedoff_parking_group_page: '停车组', closedoff_parking_space_page: '停车位',
  closedoff_parking_lot_list: '停车场列表', closedoff_gate_access_page: '门禁出入记录',
  closedoff_district_page: '园区区域', closedoff_checkpoint_devices: '出入口设备',
  closedoff_device_page: '轨迹设备组', closedoff_control_area_stats: '控制区统计',
  closedoff_control_area_page: '控制区/电子围栏', closedoff_plotting_config_one: '围栏标绘数据',
  closedoff_access_record_page: '通行记录', closedoff_gate_records_by_car: '车辆出入记录',
  closedoff_vehicle_comprehensive_page: '车辆综合查询', closedoff_vehicle_count: '车辆统计',
  closedoff_white_page: '白名单', closedoff_white_detail: '白名单详情',
  closedoff_black_page: '黑名单', closedoff_black_detail: '黑名单详情',
  closedoff_park_status: '园区实时状态', closedoff_company_base_info_page: '企业信息',
  closedoff_waybill_page: '电子运单',
}

const GROUPS: Readonly<Partial<Record<string, ResultGroup>>> = {
  closedoff_vehicle_comprehensive_page: 'overview', closedoff_vehicle_count: 'overview',
  closedoff_white_page: 'authorization', closedoff_white_detail: 'authorization',
  closedoff_black_page: 'authorization', closedoff_black_detail: 'authorization',
  closedoff_access_record_page: 'access', closedoff_gate_records_by_car: 'access', closedoff_gate_access_page: 'access',
  closedoff_vehicle_track: 'track', closedoff_vehicle_location_page: 'track',
  closedoff_vehicle_latest_positions: 'track', closedoff_vehicle_stream: 'track',
  closedoff_reservation_approval_page: 'reservation', closedoff_reservation_completed_page: 'reservation',
  closedoff_reservation_stats: 'reservation', closedoff_reservation_detail: 'reservation',
  closedoff_change_record_page: 'reservation', closedoff_today_reservation: 'reservation', closedoff_waybill_page: 'reservation',
  closedoff_warning_page: 'risk', closedoff_warning_detail: 'risk', closedoff_warning_count: 'risk',
  closedoff_warning_module_list: 'risk', closedoff_warning_count_by_level: 'risk',
  closedoff_parking_area_page: 'infrastructure', closedoff_parking_group_page: 'infrastructure',
  closedoff_parking_space_page: 'infrastructure', closedoff_parking_lot_list: 'infrastructure',
  closedoff_district_page: 'infrastructure', closedoff_checkpoint_devices: 'infrastructure',
  closedoff_device_page: 'infrastructure', closedoff_control_area_stats: 'infrastructure',
  closedoff_control_area_page: 'infrastructure', closedoff_plotting_config_one: 'infrastructure',
}

/** Reject presentation fields that are absent from the selected Tool result schema. */
export function validatePresentationSpecs(): void {
  for (const [tool, fields] of Object.entries(TOOL_FIELDS)) {
    if (fields === undefined) continue
    const spec = TOOL_BY_NAME.get(tool as `closedoff_${string}`)
    if (spec === undefined) throw new Error(`closedoff-assistant unknown presentation Tool "${tool}"`)
    const declared = new Set(spec.result.fields.map(([key]) => key))
    for (const field of fields) {
      if (!declared.has(field)) throw new Error(`closedoff-assistant unknown presentation field "${tool}.${field}"`)
    }
  }
  for (const [tool, nested] of Object.entries(NESTED_PRESENTATION_FIELDS)) {
    if (nested === undefined) continue
    const spec = TOOL_BY_NAME.get(tool as `closedoff_${string}`)
    if (spec === undefined) throw new Error(`closedoff-assistant unknown nested presentation Tool "${tool}"`)
    const declared = new Set(spec.result.fields.map(([key]) => key))
    for (const [parent, children] of Object.entries(nested)) {
      if (!declared.has(parent) || children.length === 0 || new Set(children).size !== children.length) {
        throw new Error(`closedoff-assistant invalid nested presentation field "${tool}.${parent}"`)
      }
    }
  }
}

validatePresentationSpecs()

/** Return the stable browser grouping for one Tool lifecycle event. */
export function presentationDescriptor(tool: string): Pick<CardsPayload, 'tool' | 'group' | 'variant' | 'sourceLabel'> {
  return {
    tool,
    group: GROUPS[tool] ?? 'other',
    variant: tool === 'closedoff_vehicle_comprehensive_page' ? 'summary' : 'records',
    sourceLabel: SOURCE_LABELS[tool] ?? '业务查询',
  }
}

/** Build a stable empty-state payload for a successful query without displayable records. */
export function emptyCardsPayload(tool: string, note = ''): CardsPayload {
  return {
    ...presentationDescriptor(tool),
    state: 'empty',
    count: 0,
    shown: 0,
    note,
    cards: [],
  }
}

const VALUE_LABELS: Partial<Record<string, Record<string, string>>> = {
  validityStatus: { '-1': '无', '0': '白名单', '1': '预约', '2': '黑名单' },
  carCategory: { '2': '普通车', '3': '危化车', '4': '危废车', '5': '普通货车' },
  carNumbColour: { '0': '蓝牌' },
  gateRecordType: { '1': '出园', '2': '入园' },
  sex: { '1': '男', '2': '女' },
  sourceType: { '1': '个人申请', '2': '企业申请', '3': '园区申请' },
  currentStatus: { '0': '未生效', '1': '生效中', '2': '已过期' },
  checkStatus: { '0': '待审核', '1': '通过', '2': '不通过' },
  companyCheckStatus: { '0': '待审核', '1': '通过', '2': '不通过' },
  parkCheckStatus: { '0': '待审核', '1': '通过', '2': '不通过' },
  reservationType: { '1': '人员', '2': '普通车', '3': '危化车', '4': '危废车', '5': '货车' },
  typeCode: { '0': '发起预约', '1': '企业审批', '2': '园区审批', '3': '司机自检', '4': '园区抽查' },
  securityCheckResults: { '0': '不合格', '1': '合格' },
  checkResult: { '0': '不合格', '1': '合格' },
  checkMethod: { '1': '拍照', '2': '录像' },
  controlType: { '1': '核心控制区', '2': '关键控制区', '3': '一般控制区' },
  sampleCheck: { '0': '否', '1': '是' },
  warningStatus: { '0': '正在持续', '1': '已销警' },
  warningType: { '1': '预警', '2': '报警', '3': '事故', '4': '事件' },
}

function json(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function tone(value: string): string {
  if (/拒绝|不通过|报警|违停|黑名单|过期|事故|异常|离线/.test(value)) return 'red'
  if (/待审批|待审|审批中|预警|待停|未生效|待处理|待审核/.test(value)) return 'orange'
  if (/通过|已销警|生效|空余|完成|正常|在园|已启用/.test(value)) return 'green'
  return ''
}

function cardRows(tool: string, data: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(data) ? data : typeof data === 'object' && data !== null ? [data] : []
  return rows.flatMap((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    if (tool === 'closedoff_reservation_detail') {
      const code = Number(row.typeCode)
      const detail = typeof row.specificData === 'object' && row.specificData !== null && !Array.isArray(row.specificData)
        ? row.specificData as Record<string, unknown> : {}
      const items = code === 3 && Array.isArray(row.specificData)
        ? row.specificData.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
        : code === 4 && Array.isArray(detail.securityCheckList)
          ? detail.securityCheckList.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
          : []
      const selected: Record<string, unknown> = Object.fromEntries((NESTED_PRESENTATION_FIELDS.closedoff_reservation_detail?.specificData ?? [])
        .flatMap(key => detail[key] === undefined || typeof detail[key] === 'object' ? [] : [[key, detail[key]]]))
      if (items.length > 0) {
        const names = items.flatMap(item => typeof item.checkItemName === 'string' && item.checkItemName !== '' ? [item.checkItemName] : [])
        const results = items.flatMap(item => item.checkResult === undefined ? [] : [String(item.checkResult)])
        const methods = [...new Set(items.flatMap(item => item.checkMethod === undefined ? [] : [String(item.checkMethod)]))]
        const remarks = items.flatMap(item => typeof item.remarks === 'string' && item.remarks !== '' ? [item.remarks] : [])
        if (names.length > 0) selected.checkItemName = `${names.slice(0, 5).join('、')}${names.length > 5 ? `等 ${String(names.length)} 项` : ''}`
        if (results.length > 0) selected.checkResult = `合格 ${String(results.filter(item => item === '1').length)} 项，不合格 ${String(results.filter(item => item === '0').length)} 项`
        if (methods.length > 0) selected.checkMethod = methods.map(item => VALUE_LABELS.checkMethod?.[item] ?? item).join('、')
        if (remarks.length > 0) selected.remarks = remarks.slice(0, 3).join('；')
        const firstDate = items.find(item => item.createDate !== undefined)?.createDate
        if (firstDate !== undefined) selected.createDate = firstDate
      }
      return [{ typeCode: row.typeCode, time: row.time, ...selected }]
    }
    if (tool !== 'closedoff_gate_records_by_car') return [row]
    const details = Array.isArray(row.data)
      ? row.data.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
      : []
    return (details.length > 0 ? details : [{}]).map((detail) => {
      const merged = { ...row, ...detail }
      delete merged.data
      delete merged.startDate
      delete merged.endDate
      return merged
    })
  })
}

function renderedValue(tool: string, key: string, raw: unknown): string {
  const value = String(typeof raw === 'string' ? redactJsonValue(raw, key) : raw)
  const labels = tool === 'closedoff_gate_records_by_car' && key === 'type'
    ? VALUE_LABELS.gateRecordType
    : tool === 'closedoff_white_page' && key === 'companyCheckStatus'
      ? VALUE_LABELS.checkStatus
      : tool === 'closedoff_vehicle_comprehensive_page' && key === 'trailer' && value === '0'
        ? { '0': '无' }
    : VALUE_LABELS[key]
  return labels?.[value] ?? value
}

function fieldLabel(tool: string, key: string): string {
  return tool === 'closedoff_reservation_detail' && key === 'remarks' ? '检查备注' : LABELS[key] ?? key
}

function automaticFields(tool: string): readonly string[] {
  return TOOL_BY_NAME.get(tool as `closedoff_${string}`)?.result.fields
    .map(([key]) => key)
    .filter(key => !AUTO_CARD_BLOCKED_FIELDS.has(key)) ?? []
}

function automaticFieldLabel(tool: string, key: string): string {
  return TOOL_BY_NAME.get(tool as `closedoff_${string}`)?.result.fields.find(([candidate]) => candidate === key)?.[1] ?? key
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 会话事件里的正文块：同一段文字无论出现在回答、工具结果还是思考里都按同一口径取。 */
export function textBlocks(content: readonly unknown[]): string {
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

/** 同 {@link textBlocks}，取推理块。 */
export function reasoningBlocks(content: readonly unknown[]): string {
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'reasoning'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

/** Project a safe reasoning snapshot without releasing an unstable streaming tail. */
export function projectReasoning(raw: string, releaseTail: boolean, opaqueValues: readonly string[] = []): string {
  let visible = raw
  if (!releaseTail) {
    let end = 0
    for (const match of raw.matchAll(/[。！？；\n]/g)) end = (match.index ?? 0) + match[0].length
    visible = raw.slice(0, end)
  }
  let projected = redactVisibleText(visible)
  for (const value of [...opaqueValues].filter(item => item.length >= 6).sort((a, b) => b.length - a.length)) {
    projected = projected.replace(new RegExp(escapePattern(value), 'g'), '[内部标识已隐藏]')
  }
  projected = projected.replace(/(?:预约ID|记录ID|业务对象ID|设备组ID|\bID)\s*[:：=]\s*\d+/gi, match => `${match.replace(/\d+$/, '')}[内部标识已隐藏]`)
  if (!releaseTail && visible.length < raw.length) return projected === '' ? '正在生成…' : `${projected}\n正在生成…`
  return projected
}

/** Collect opaque result identifiers that must not appear in displayed reasoning. */
export function collectOpaqueResultValues(resultText: string, meta?: unknown): string[] {
  const root = json(resultText)
  const values = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const [key, child] of Object.entries(value)) {
      if (OPAQUE_RESULT_FIELDS.has(key) && (typeof child === 'string' || typeof child === 'number')) {
        const rendered = String(child).trim()
        if (rendered !== '') values.add(rendered)
      }
      visit(child)
    }
  }
  if (root !== undefined) visit(root.data)
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta) && 'value' in meta) {
    visit((meta as Record<string, unknown>).value)
  }
  return [...values]
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

/** Extract business card fields while excluding internal ids, media URLs, and nested transport data. */
export function extractCards(tool: string, resultText: string): CardsPayload | undefined {
  const root = json(resultText)
  if (root === undefined) return undefined
  const rows = cardRows(tool, root.data)
  const cards: CardsPayload['cards'] = []
  const automatic = TOOL_FIELDS[tool] === undefined
  const fieldsForTool = [
    ...(TOOL_FIELDS[tool] ?? automaticFields(tool)),
    ...Object.values(NESTED_PRESENTATION_FIELDS[tool] ?? {}).flat(),
  ]
  for (const row of rows) {
    const fields: { k: string; v: string; tone: string }[] = []
    let title = ''
    let titleKey: string | undefined
    for (const key of fieldsForTool) {
      const raw = row[key]
      if (raw === undefined || raw === null || typeof raw === 'object' || raw === '') continue
      const rendered = renderedValue(tool, key, raw)
      if (title === '' && TITLE_KEYS.has(key)) {
        title = rendered
        titleKey = key
        continue
      }
      fields.push({ k: automatic ? automaticFieldLabel(tool, key) : fieldLabel(tool, key), v: rendered, tone: tone(rendered) })
    }
    if (title === '' && fields.length > 0) title = SOURCE_LABELS[tool] ?? '业务记录'
    if (title !== '') cards.push({ title: title.slice(0, 24), ...(titleKey === undefined ? {} : { titleKey }), fields })
  }
  const count = typeof root.totalCount === 'number' ? root.totalCount : rows.length
  const hasRecords = rows.length > 0 || count > 0
  return {
    ...presentationDescriptor(tool),
    state: hasRecords ? 'data' : 'empty',
    count,
    shown: cards.length,
    note: typeof root.note === 'string'
      ? redactVisibleText(root.note)
      : hasRecords && cards.length === 0 ? '已返回数据，暂无适合卡片展示的字段' : '',
    cards,
  }
}

function messageText(content: readonly unknown[]): string {
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

function messageReasoning(content: readonly unknown[]): string {
  let result = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'reasoning'
      && 'text' in block && typeof block.text === 'string') result += block.text
  }
  return result
}

function toolResult(event: Extract<SessionEvent, { type: 'tool/result' }>): { callId: string; text: string; error: boolean } {
  const block = event.data.message.content[0]
  const text = messageText(block.content)
  return {
    callId: String(block.toolCallId),
    text,
    error: event.data.error !== undefined || (block.isError ?? false) || gatewayResultFailed(text),
  }
}

function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** Project exact DSH attempt-lifecycle accounting into the dedicated page fields. */
export function turnUsageSummary(events: readonly SessionEvent[]): TurnUsageSummary | undefined {
  const usage = deriveTurnTokenUsage(events)
  if (usage === undefined) return undefined
  return {
    inputTokens: usage.uncachedInputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

/** Whether a canonical gateway result represents a handled remote failure. */
export function gatewayResultFailed(resultText: string): boolean {
  return json(resultText)?.ok === false
}

function assistant(time: number): HistoryAssistant {
  return { role: 'assistant', text: '', thinking: '', thinkingDone: false, tools: [], tracks: {}, fences: {}, media: {}, cards: {}, time, done: false }
}

/** Rebuild the dedicated page history from the durable session log. */
export function projectHistory(events: readonly SessionEvent[], trackDeviceRadiusMeters = 100): HistoryEntry[] {
  const history: HistoryEntry[] = []
  const opaqueValues = [...new Set(events.flatMap(event => event.type === 'tool/result'
    ? collectOpaqueResultValues(toolResult(event).text, event.data.meta)
    : []))]
  let current: HistoryAssistant | undefined
  const tools = new Map<string, ToolCard>()
  const reasoningSteps = new Map<number, { raw: string; released: boolean }>()
  let deviceGroups: TrackDeviceGroup[] = []
  let turnStartAt: number | undefined
  let firstStep: number | undefined
  let firstStepStartAt: number | undefined
  let firstTokenAt: number | undefined
  let turnEvents: SessionEvent[] = []
  let finalMessageId: string | undefined
  const ensure = (time: number) => {
    if (current === undefined) {
      current = assistant(time)
      history.push(current)
    }
    return current
  }
  const updateThinking = (entry: HistoryAssistant, done = false) => {
    entry.thinking = [...reasoningSteps.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => projectReasoning(value.raw, done || value.released, opaqueValues))
      .filter(Boolean)
      .join('\n')
    entry.thinkingDone = done
  }

  for (const event of events) {
    if (event.type === 'turn/start') turnEvents = [event]
    else if (turnEvents.length > 0) turnEvents.push(event)
    for (const { time, step, chunk } of historyAssistantDeltas(event)) {
      const entry = ensure(time)
      if (step === firstStep && firstTokenAt === undefined && isTokenDelta(chunk)) firstTokenAt = time
      if (chunk.type === 'text-delta') entry.text += chunk.text
      else if (chunk.type === 'reasoning-delta') {
        const state = reasoningSteps.get(step) ?? { raw: '', released: false }
        state.raw += chunk.text
        reasoningSteps.set(step, state)
        updateThinking(entry)
      }
      else if (chunk.type === 'tool-call-delta' && !tools.has(String(chunk.id))) {
        const name = chunk.name ?? ''
        const card: ToolCard = { callId: String(chunk.id), name, api: '', status: 'run', presentation: presentationDescriptor(name) }
        tools.set(card.callId, card)
        entry.tools.push(card)
      }
    }
    switch (event.type) {
      case 'user/message': {
        if (event.data.source.kind !== 'user') break
        history.push({ role: 'user', text: messageText(event.data.content), time: event.time })
        current = undefined
        tools.clear()
        reasoningSteps.clear()
        deviceGroups = []
        break
      }
      case 'turn/start': {
        turnStartAt = event.time
        firstStep = undefined
        firstStepStartAt = undefined
        firstTokenAt = undefined
        finalMessageId = undefined
        break
      }
      case 'step/start': {
        if (firstStep === undefined) {
          firstStep = event.data.step
          firstStepStartAt = event.time
        }
        break
      }
      case 'assistant/message': {
        const entry = ensure(event.time)
        const text = messageText(event.data.message.content)
        if (text !== '') {
          entry.text = text
          finalMessageId = String(event.data.message.id)
        }
        const reasoning = messageReasoning(event.data.message.content)
        if (reasoning !== '') reasoningSteps.set(event.data.step, { raw: reasoning, released: true })
        updateThinking(entry)
        break
      }
      case 'tool/call': {
        const entry = ensure(event.time)
        const callId = String(event.data.callId)
        let card = tools.get(callId)
        if (card === undefined) {
          card = {
            callId, name: event.data.name, api: TOOL_BY_NAME.get(event.data.name as `closedoff_${string}`)?.path ?? '', status: 'run',
            presentation: presentationDescriptor(event.data.name),
          }
          tools.set(callId, card)
          entry.tools.push(card)
        } else {
          card.name = event.data.name
          card.api = TOOL_BY_NAME.get(event.data.name as `closedoff_${string}`)?.path ?? ''
          card.presentation = presentationDescriptor(event.data.name)
        }
        break
      }
      case 'tool/result': {
        const entry = ensure(event.time)
        const result = toolResult(event)
        const card = tools.get(result.callId)
        if (card === undefined) break
        card.status = result.error ? 'error' : 'ok'
        if (!result.error) {
          if (isFenceTool(card.name)) entry.fences[result.callId] = fencesFromResult(result.text, event.data.meta)
          const cards = extractCards(card.name, result.text)
          if (cards !== undefined && card.name !== 'closedoff_vehicle_track' && card.name !== 'closedoff_device_page' && card.name !== 'closedoff_vehicle_stream') entry.cards[result.callId] = cards
          if (card.name === 'closedoff_vehicle_track') {
            const points = extractTrackPointsFromResult(result.text, event.data.meta)
            const bundledGroups = extractTrackDeviceGroupsFromResult(event.data.meta)
            if (points.length > 0) entry.tracks[result.callId] = {
              points,
              vehicleNo: extractTrackVehicleNoFromResult(result.text, event.data.meta),
              ...((bundledGroups.length > 0 || deviceGroups.length > 0)
                ? { groups: filterDeviceGroupsNearTrack(bundledGroups.length > 0 ? bundledGroups : deviceGroups, points, trackDeviceRadiusMeters) }
                : {}),
            }
            else entry.cards[result.callId] = cards ?? emptyCardsPayload(card.name, '未返回可展示的轨迹点')
          } else if (card.name === 'closedoff_vehicle_stream') {
            const media = extractVehicleMediaFromResult(event.data.meta)
            if (media.length > 0) entry.media[result.callId] = media
            else if (cards !== undefined) entry.cards[result.callId] = cards
          } else if (card.name === 'closedoff_device_page') {
            const meta = event.data.meta
            const value = typeof meta === 'object' && meta !== null && !Array.isArray(meta) && 'value' in meta
              ? (meta as Record<string, unknown>).value
              : undefined
            deviceGroups = extractDeviceGroups(value)
            for (const track of Object.values(entry.tracks)) {
              track.groups = filterDeviceGroupsNearTrack(deviceGroups, track.points, trackDeviceRadiusMeters)
            }
          }
        }
        break
      }
      case 'turn/end': {
        if (current !== undefined) {
          current.done = true
          current.finishReason = event.data.reason.kind
          current.time = event.time
          current.branchSeq = event.seq
          current.completedAt = event.time
          if (finalMessageId !== undefined) current.messageId = finalMessageId
          if (turnStartAt !== undefined) current.runMs = Math.max(0, event.time - turnStartAt)
          if (firstStepStartAt !== undefined && firstTokenAt !== undefined) {
            current.ttftMs = Math.max(0, firstTokenAt - firstStepStartAt)
          }
          const turnUsage = turnUsageSummary(turnEvents)
          if (turnUsage !== undefined) current.usage = turnUsage
          updateThinking(current, true)
        }
        current = undefined
        tools.clear()
        reasoningSteps.clear()
        deviceGroups = []
        turnStartAt = undefined
        firstStep = undefined
        firstStepStartAt = undefined
        firstTokenAt = undefined
        turnEvents = []
        finalMessageId = undefined
        break
      }
    }
  }
  for (const entry of history) {
    if (entry.role === 'assistant') {
      entry.text = redactVisibleText(entry.text)
      if (!entry.done) updateThinking(entry)
    }
  }
  return history
}
