/**
 * 页面用的常量表：工具名与结果分组的显示名、分组顺序，以及各处要用的内联图标。
 *
 * 纯数据，不依赖页面状态；页面脚本都从这里取。
 */

// 工具中文名称（业务人员可读）
export var TOOL_LABELS = {
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
};

export var GROUP_ORDER = ['overview', 'authorization', 'access', 'track', 'reservation', 'risk', 'infrastructure', 'other'];
export var GROUP_LABELS = {
  overview: '车辆概览', authorization: '授权与名单', access: '通行记录', track: '轨迹与设备',
  reservation: '预约与运单', risk: '风险', infrastructure: '园区设施', other: '其他查询',
};

export var IC = {
  calendar: '<svg class="ic" viewBox="0 0 24 24"><path d="M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>',
  track: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 21s7-6.3 7-11a7 7 0 0 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  route: '<svg class="ic" viewBox="0 0 24 24"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h6a2 2 0 0 0 2-2V7a2 2 0 0 1 2-2"/></svg>',
  bell: '<svg class="ic" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  park: '<svg class="ic" viewBox="0 0 24 24"><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/></svg>',
  chart: '<svg class="ic" viewBox="0 0 24 24"><path d="M6 20V10M12 20V4M18 20v-7"/></svg>',
  list: '<svg class="ic" viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  camera: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 7h3l2-2h6l2 2h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  send: '<svg class="ic" viewBox="0 0 24 24"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>',
  stop: '<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  user: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  locate: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>',
};
