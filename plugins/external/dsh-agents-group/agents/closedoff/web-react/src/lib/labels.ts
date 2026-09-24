/**
 * 结果分组与工具显示名（旧 web/labels.js 的 React 等价，纯数据）。
 * 内联图标族（IC）不搬：导航/装饰类换 web-common 的 Lucide Icon，
 * 回答操作区保留 DSH 官方 outline 形制（组件内 CSS mask）。
 */

/** 工具中文名称（业务人员可读）。 */
export const TOOL_LABELS: Record<string, string> = {
  closedoff_warning_page: '预警报警查询',
  closedoff_warning_detail: '预警报警详情',
  closedoff_warning_count: '预警数量统计',
  closedoff_warning_module_list: '报警模块列表',
  closedoff_warning_count_by_level: '报警等级统计',
  closedoff_reservation_approval_page: '预约审批待审',
  closedoff_reservation_completed_page: '预约审批记录',
  closedoff_reservation_stats: '预约审批统计',
  closedoff_reservation_detail: '预约详情',
  closedoff_change_record_page: '变更记录',
  closedoff_today_reservation: '今日预约',
  closedoff_vehicle_track: '车辆轨迹',
  closedoff_vehicle_location_page: '车辆定位',
  closedoff_vehicle_latest_positions: '在园车辆最新位置',
  closedoff_vehicle_stream: '车辆轨迹视频',
  closedoff_parking_area_page: '停车区',
  closedoff_parking_group_page: '停车组',
  closedoff_parking_space_page: '停车位',
  closedoff_parking_lot_list: '停车场列表',
  closedoff_gate_access_page: '门禁出入记录',
  closedoff_district_page: '园区区域',
  closedoff_checkpoint_devices: '出入口设备',
  closedoff_device_page: '轨迹设备组',
  closedoff_control_area_stats: '控制区统计',
  closedoff_control_area_page: '控制区/电子围栏',
  closedoff_plotting_config_one: '围栏标绘数据',
  closedoff_access_record_page: '通行记录',
  closedoff_gate_records_by_car: '车辆出入记录',
  closedoff_vehicle_comprehensive_page: '车辆综合查询',
  closedoff_vehicle_count: '车辆统计',
  closedoff_white_page: '白名单',
  closedoff_white_detail: '白名单详情',
  closedoff_black_page: '黑名单',
  closedoff_black_detail: '黑名单详情',
  closedoff_park_status: '园区实时状态',
  closedoff_company_base_info_page: '企业信息',
  closedoff_waybill_page: '电子运单',
}

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? '业务查询'
}

/** 结果分组：顺序即渲染顺序（旧 ensureResultSection 的插入排序口径）。 */
export const GROUP_ORDER = ['overview', 'authorization', 'access', 'track', 'reservation', 'risk', 'infrastructure', 'other'] as const

export type ResultGroup = (typeof GROUP_ORDER)[number]

export const GROUP_LABELS: Record<ResultGroup, string> = {
  overview: '车辆概览',
  authorization: '授权与名单',
  access: '通行记录',
  track: '轨迹与设备',
  reservation: '预约与运单',
  risk: '风险',
  infrastructure: '园区设施',
  other: '其他查询',
}

export function groupLabel(group: string): string {
  return GROUP_LABELS[(GROUP_ORDER as readonly string[]).includes(group) ? (group as ResultGroup) : 'other']
}

export function groupRank(group: string): number {
  const index = (GROUP_ORDER as readonly string[]).indexOf(group)
  return index === -1 ? (GROUP_ORDER as readonly string[]).indexOf('other') : index
}
