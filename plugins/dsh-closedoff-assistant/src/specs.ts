/** Approved read-only queries exposed to the business Agent. */
export type ToolParamType = 'string' | 'integer' | 'number' | 'boolean' | 'array'

/** One model argument accepted by a closed-off query. */
export interface ToolParam {
  readonly key: string
  readonly type: ToolParamType
  readonly required: boolean
  readonly desc: string
  readonly enum?: readonly (string | number | boolean)[]
  readonly itemType?: Exclude<ToolParamType, 'array'>
}

/** Observed cardinality of one gateway response's `data` field. */
export type ToolResultDataKind = 'list' | 'object' | 'paged-object' | 'unknown'

/** One analysis-relevant response field observed in source or a direct consumer. */
export type ToolResultField = readonly [key: string, description: string]

/** Compatibility-first description of one Tool's business result. */
export interface ToolResultSpec {
  readonly dataKind: ToolResultDataKind
  readonly fields: readonly ToolResultField[]
  /** Fields consumed by plugin presentation but omitted from model hints. */
  readonly runtimeFields?: readonly ToolResultField[]
}

/** One approved remote query and its model-facing selection and analysis guidance. */
export interface ToolSpec {
  readonly name: `closedoff_${string}`
  readonly desc: string
  readonly method: 'GET' | 'POST'
  readonly path: `/${string}`
  readonly maxDays?: number
  readonly timeRanges?: readonly { readonly startKey: string; readonly endKey: string }[]
  readonly pathParamKey?: string
  readonly params: readonly ToolParam[]
  readonly result: ToolResultSpec
}

const TIME_FMT = '，时间格式 yyyy-MM-dd HH:mm:ss'
const PAGE_TIP = '；pageSize 建议不超过 20 避免返回过大'
const R = {
  pageIndex: { key: 'pageIndex', type: 'integer', required: true, desc: '页码（从 1 开始）' },
  pageSize: { key: 'pageSize', type: 'integer', required: true, desc: '每页条数' },
} as const satisfies Record<string, ToolParam>

function result(dataKind: ToolResultDataKind, ...fields: ToolResultField[]): ToolResultSpec {
  return { dataKind, fields }
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'closedoff_warning_page',
    desc: '预警报警分页查询。问“最近有什么报警/预警”“某车牌相关的报警”“还在持续的报警”等时使用。warningType: 1预警 2报警 3事故 4事件；warningStatus: 0正在持续 1已销警；deviceType: 1车闸 2人闸 3IP广播 4GDS 5报杆箱 6摄像头 7预约屏。未指定时间默认最近一月' + TIME_FMT + PAGE_TIP,
    method: 'POST', path: '/risk-warning/riskWarning/page',
    timeRanges: [{ startKey: 'warningStartTimeBegin', endKey: 'warningStartTimeEnd' }],
    result: result('unknown',
      ['id', '预警记录ID'], ['title', '标题'], ['warningType', '事件类型'],
      ['warningLevel', '等级'], ['warningStatus', '处置状态'], ['warningStartTime', '发生时间'],
      ['companyName', '企业'], ['deviceName', '设备'], ['carNum', '车牌']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'warningType', type: 'integer', required: false, desc: '类型 1预警 2报警 3事故 4事件', enum: [1, 2, 3, 4] },
      { key: 'companyId', type: 'string', required: false, desc: '公司ID' },
      { key: 'companyName', type: 'string', required: false, desc: '公司名称' },
      { key: 'title', type: 'string', required: false, desc: '标题' },
      { key: 'deviceType', type: 'integer', required: false, desc: '报警设备类型', enum: [1, 2, 3, 4, 5, 6, 7] },
      { key: 'deviceCode', type: 'string', required: false, desc: '报警设备编号' },
      { key: 'controlAreaId', type: 'string', required: false, desc: '控制区id' },
      { key: 'subModuleType', type: 'string', required: false, desc: '模块所属子类型' },
      { key: 'subModuleTypeName', type: 'string', required: false, desc: '模块所属子类型名称' },
      { key: 'carNum', type: 'string', required: false, desc: '车牌号' },
      { key: 'description', type: 'string', required: false, desc: '报警预警详细描述' },
      { key: 'keyWords', type: 'string', required: false, desc: '关键字' },
      { key: 'warningStatus', type: 'string', required: false, desc: '0正在持续 1已销警', enum: ['0', '1'] },
      { key: 'warningStartTimeBegin', type: 'string', required: false, desc: '报警开始时间起' + TIME_FMT },
      { key: 'warningStartTimeEnd', type: 'string', required: false, desc: '报警开始时间止' + TIME_FMT },
    ],
  },
  {
    name: 'closedoff_warning_detail',
    desc: '按 ID 查询单条预警报警详情（含处置/派发信息）。先通过 closedoff_warning_page 拿到 id 再查询。',
    method: 'GET', path: '/risk-warning/riskWarning/one',
    result: result('unknown',
      ['id', '预警记录ID'], ['title', '标题'], ['description', '事件描述'],
      ['warningLevel', '等级'], ['warningStatus', '处置状态'], ['warningStartTime', '发生时间'],
      ['companyName', '企业'], ['disposeUserName', '处置人'], ['disposeTime', '处置时间']),
    params: [{ key: 'id', type: 'string', required: true, desc: '预警记录ID' }],
  },
  {
    name: 'closedoff_warning_count',
    desc: '按预警状态统计报警数量（按公司/设备类型/模块维度过滤）。',
    method: 'GET', path: '/risk-warning/riskWarning/countByWarningStatus',
    result: result('unknown', ['warningStatus', '处置状态'], ['count', '数量']),
    params: [
      { key: 'companyCode', type: 'string', required: false, desc: '公司编码' },
      { key: 'backFlowAlarm', type: 'integer', required: false, desc: '是否回流设备 0否 1是', enum: [0, 1] },
      { key: 'deviceType', type: 'integer', required: false, desc: '设备类型', enum: [1, 2, 3, 4, 5, 6, 7] },
      { key: 'subModuleType', type: 'string', required: false, desc: '模块所属子类型' },
    ],
  },
  {
    name: 'closedoff_warning_module_list',
    desc: '预警报警模块列表查询（模块类型/子类型字典）。问“有哪些报警模块/类型”时使用。',
    method: 'GET', path: '/risk-warning/riskWarningModule/getList',
    result: result('unknown',
      ['moduleType', '模块类型'], ['moduleTypeName', '模块名称'],
      ['subModuleType', '子类型'], ['subModuleTypeName', '子类型名称']),
    params: [],
  },
  {
    name: 'closedoff_warning_count_by_level',
    desc: '按预警报警等级统计数量（红/橙/黄/蓝）。问“各级别报警有多少”时使用。',
    method: 'POST', path: '/risk-warning/riskWarning/countByWarningLevel',
    result: result('unknown',
      ['warningStatus', '统计状态'], ['redCount', '红色预警数'], ['orangeCount', '橙色预警数'],
      ['yellowCount', '黄色预警数'], ['blueCount', '蓝色预警数']),
    params: [],
  },
  {
    name: 'closedoff_reservation_approval_page',
    desc: '预约审批分页查询（企业/园区待审批）。问“今天有哪些待审批预约”“某企业的预约审批进度”“危化车预约待审”时使用。reservationType: 1人员 2普通车 3危化车 4危废车 5货车；status: 0企业待审批 1企业通过 2企业不通过 3园区待审批 4园区通过 5园区不通过 6已过期；approvePageType: 0企业待审批 1企业已审批 2园区待审批 3园区已审批；currentStatus: 0未生效 1生效中 2已过期。未指定时间默认最近一月' + TIME_FMT + PAGE_TIP,
    method: 'POST', path: '/closed-off/reservation/approvalPageV2',
    timeRanges: [{ startKey: 'beginTime', endKey: 'endTime' }],
    result: result('list',
      ['id', '预约ID'], ['reservationType', '预约类型'], ['carNumb', '车牌'],
      ['realName', '人员'], ['companyName', '企业'], ['planInTime', '计划入园时间'],
      ['planOutTime', '计划出园时间'], ['companyCheckStatus', '企业审核状态'],
      ['parkCheckStatus', '园区审核状态'], ['currentStatus', '当前状态']),
    params: [
      R.pageSize, R.pageIndex,
      { key: 'reservationType', type: 'integer', required: false, desc: '预约类型', enum: [1, 2, 3, 4, 5] },
      { key: 'approvePageType', type: 'integer', required: false, desc: '审批页面类型', enum: [0, 1, 2, 3] },
      { key: 'beginTime', type: 'string', required: false, desc: '开始时间' + TIME_FMT },
      { key: 'endTime', type: 'string', required: false, desc: '结束时间' + TIME_FMT },
      { key: 'keywords', type: 'string', required: false, desc: '关键字' },
      { key: 'status', type: 'integer', required: true, desc: '状态 0企业待审批 1企业通过 2企业不通过 3园区待审批 4园区通过 5园区不通过 6已过期', enum: [0, 1, 2, 3, 4, 5, 6] },
      { key: 'currentStatus', type: 'integer', required: false, desc: '当前状态 0未生效 1生效中 2已过期', enum: [0, 1, 2] },
      { key: 'companyId', type: 'string', required: false, desc: '企业ID' },
      { key: 'inDeviceCode', type: 'string', required: false, desc: '授权入口设备编码' },
      { key: 'outDeviceCode', type: 'string', required: false, desc: '授权出口设备编码' },
    ],
  },
  {
    name: 'closedoff_reservation_completed_page',
    desc: '已完成/已审批预约分页查询（含历史预约）。参数含义同 closedoff_reservation_approval_page，按 status 过滤不同审批阶段。未指定时间默认最近一月' + TIME_FMT + PAGE_TIP,
    method: 'POST', path: '/closed-off/reservation/completedPageV2',
    timeRanges: [{ startKey: 'beginTime', endKey: 'endTime' }],
    result: result('list',
      ['id', '预约ID'], ['reservationType', '预约类型'], ['carNumb', '车牌'],
      ['realName', '人员'], ['companyName', '企业'], ['planInTime', '计划入园时间'],
      ['planOutTime', '计划出园时间'], ['companyCheckStatus', '企业审核状态'],
      ['parkCheckStatus', '园区审核状态'], ['currentStatus', '当前状态']),
    params: [
      R.pageSize, R.pageIndex,
      { key: 'reservationType', type: 'integer', required: false, desc: '预约类型', enum: [1, 2, 3, 4, 5] },
      { key: 'approvePageType', type: 'integer', required: false, desc: '审批页面类型', enum: [0, 1, 2, 3] },
      { key: 'beginTime', type: 'string', required: false, desc: '开始时间' + TIME_FMT },
      { key: 'endTime', type: 'string', required: false, desc: '结束时间' + TIME_FMT },
      { key: 'keywords', type: 'string', required: false, desc: '关键字' },
      { key: 'status', type: 'integer', required: true, desc: '状态 0-6（含义同上）', enum: [0, 1, 2, 3, 4, 5, 6] },
      { key: 'currentStatus', type: 'integer', required: false, desc: '当前状态 0未生效 1生效中 2已过期', enum: [0, 1, 2] },
      { key: 'companyId', type: 'string', required: false, desc: '企业ID' },
      { key: 'inDeviceCode', type: 'string', required: false, desc: '授权入口设备编码' },
      { key: 'outDeviceCode', type: 'string', required: false, desc: '授权出口设备编码' },
    ],
  },
  {
    name: 'closedoff_reservation_stats',
    desc: '预约审批统计：今日待审数、今日已完成、平均处理时长、通过率、按类型（人员/普通车/危化车/危废车/货车）的待审数。问“今天预约审批情况”时使用。',
    method: 'GET', path: '/closed-off/reservation/statsV2',
    result: result('object',
      ['todayPending', '今日待审数'], ['todayCompleted', '今日已完成数'],
      ['avgProcessMinutes', '平均处理分钟数'], ['passRate', '通过率'], ['typeStats', '按预约类型的待审统计']),
    params: [],
  },
  {
    name: 'closedoff_reservation_detail',
    desc: '预约/车辆授权详情（按 id 查询预约进度信息）。问“某条预约的详情/进度”时使用。先通过审批分页工具拿到 id。',
    method: 'GET', path: '/closed-off/reservation/reservationProgressInfo/{id}', pathParamKey: 'id',
    result: result('list', ['typeCode', '进度类型'], ['time', '发生时间'], ['specificData', '该进度的业务明细']),
    params: [{ key: 'id', type: 'string', required: true, desc: '预约ID' }],
  },
  {
    name: 'closedoff_change_record_page',
    desc: '变更记录分页查询（按预约ID查变更记录）。问“某预约的变更记录/变更审批进度”时使用。',
    method: 'POST', path: '/closed-off/changeRecord/pageByReservationId',
    result: result('list',
      ['id', '变更记录ID'], ['reservationId', '预约ID'], ['companyName', '企业'],
      ['type', '变更类型'], ['oldData', '变更前数据'], ['newData', '变更后数据'],
      ['companyCheckStatus', '企业审核状态'], ['parkCheckStatus', '园区审核状态']),
    params: [{ key: 'reservationId', type: 'string', required: true, desc: '预约ID' }],
  },
  {
    name: 'closedoff_today_reservation',
    desc: '今日预约情况统计（人员/普通车/货车等各类数量）。问“今天有多少预约”时使用。companyId 可空，传某企业ID则只看该企业。',
    method: 'GET', path: '/closed-off/parkOverview/todayReservation',
    result: result('object',
      ['personNum', '人员预约数'], ['commonCarNum', '普通车预约数'],
      ['commonTruckNum', '普通货车预约数'], ['hazardousCarNum', '危化车预约数'],
      ['hazardousWasteCarNum', '危废车预约数'], ['pendingApprovalNum', '待审批数'],
      ['submittedNum', '已提交数'], ['timeLine', '分时段预约统计']),
    params: [{ key: 'companyId', type: 'string', required: false, desc: '企业ID（可空）' }],
  },
  {
    name: 'closedoff_vehicle_track',
    desc: '车辆历史轨迹与沿途设备组分析：返回某车牌在一段时间内的轨迹摘要、按路线先后排列的附近设备组和离散点驻留估算。问“某车今天走过的路线”“经过哪些设备组”“在哪里停留最久”时使用。因数据量大，未指定时间时默认且最多只查询最近 2 天' + TIME_FMT + '。回答时需说明实际查询范围。',
    method: 'GET', path: '/car/carLocation/historyTrack', maxDays: 2,
    timeRanges: [{ startKey: 'startTime', endKey: 'endTime' }],
    result: result('list', ['vehicleNo', '车牌'], ['points', '轨迹点列表']),
    params: [
      { key: 'vehicleNo', type: 'string', required: true, desc: '车牌号' },
      { key: 'startTime', type: 'string', required: false, desc: '开始时间' + TIME_FMT },
      { key: 'endTime', type: 'string', required: false, desc: '结束时间' + TIME_FMT },
    ],
  },
  {
    name: 'closedoff_vehicle_location_page',
    desc: '车辆历史定位列表查询：分页返回某时间段有过定位的车辆及类型。问“最近有哪些车在园内活动过”时使用。因数据量大，未指定时间时默认且最多只查询最近 2 天' + TIME_FMT + PAGE_TIP,
    method: 'GET', path: '/car/carLocation/vehiclePage', maxDays: 2,
    timeRanges: [{ startKey: 'startTime', endKey: 'endTime' }],
    result: result('paged-object', ['vehicleNo', '车牌'], ['carType', '车辆类型']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'carType', type: 'integer', required: false, desc: '车辆类型 2普通车 3危化车 4危废车 5普通货车', enum: [2, 3, 4, 5] },
      { key: 'vehicleNo', type: 'string', required: false, desc: '车牌号' },
      { key: 'startTime', type: 'string', required: false, desc: '开始时间' + TIME_FMT },
      { key: 'endTime', type: 'string', required: false, desc: '结束时间' + TIME_FMT },
    ],
  },
  {
    name: 'closedoff_vehicle_latest_positions',
    desc: '所有在园车辆的最新缓存位置列表（车牌/类型/摄像头编码/经纬高），不保证是瞬时实时坐标。只在用户明确询问“现在/当前/是否在园/在哪里”时使用；不要因“最近/历史/所有信息”自动调用。查某车时只分析目标车辆，并说明定位是缓存最新值。',
    method: 'GET', path: '/car/carLocation/latestInfoFromCache',
    result: result('unknown',
      ['vehicleNo', '车牌'], ['carType', '车辆类型'], ['cameraCode', '摄像头编码'],
      ['longitude', '经度'], ['latitude', '纬度'], ['height', '高度'], ['pointTime', '定位时间']),
    params: [],
  },
  {
    name: 'closedoff_vehicle_stream',
    desc: '车辆历史轨迹视频查询：返回某车牌某时间段抓拍视频流信息。问“某车的轨迹视频/抓拍画面”时使用。因数据量大，未指定时间时默认且最多只查询最近 2 天' + TIME_FMT,
    method: 'GET', path: '/car/carLocation/vehicleStream', maxDays: 2,
    timeRanges: [{ startKey: 'startTime', endKey: 'endTime' }],
    result: {
      ...result('list', ['device_id', '车辆或流查询标识'], ['start_time', '开始时间'], ['time_len', '时长']),
      runtimeFields: [['path', '媒体路径'], ['url', '播放地址']],
    },
    params: [
      { key: 'vehicleNo', type: 'string', required: true, desc: '车牌号' },
      { key: 'startTime', type: 'string', required: false, desc: '开始时间' + TIME_FMT },
      { key: 'endTime', type: 'string', required: false, desc: '结束时间' + TIME_FMT },
    ],
  },
  {
    name: 'closedoff_parking_area_page',
    desc: '停车区分页查询（含车位总数/已停数）。问“园区有哪些停车区”“重载区情况”时使用。parkingAreaAttribute: 1重载区 2空载区 3普通车' + PAGE_TIP,
    method: 'POST', path: '/hazardous-park/tParkingArea/page',
    result: result('unknown',
      ['id', '停车区ID'], ['parkingAreaName', '停车区名称'], ['parkingAreaAttribute', '停车区属性'],
      ['parkingSpaceCount', '车位总数'], ['parkedCount', '已停车位数']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'keyWords', type: 'string', required: false, desc: '关键字' },
      { key: 'parkingAreaAttribute', type: 'string', required: false, desc: '停车区属性', enum: ['1', '2', '3'] },
    ],
  },
  {
    name: 'closedoff_parking_group_page',
    desc: '停车组分页查询（含车位总数/已停/待停/火灾危险性分类）。问“某停车区有哪些停车组”“还有多少空位”时使用。fireRisk: 1液化烃 2非烃甲类 3乙类 4丙类 5丁类 6戊类' + PAGE_TIP,
    method: 'POST', path: '/hazardous-park/tParkingGroup/page',
    result: result('unknown',
      ['id', '停车组ID'], ['parkingGroupName', '停车组名称'], ['parkingAreaName', '停车区名称'],
      ['fireRisk', '火灾危险性分类'], ['parkingSpaceCount', '车位总数'],
      ['parkedCount', '已停数'], ['waitingCount', '待停数']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'keyWords', type: 'string', required: false, desc: '关键字' },
      { key: 'parkingAreaId', type: 'string', required: false, desc: '停车区ID' },
      { key: 'fireRisk', type: 'string', required: false, desc: '火灾危险性分类', enum: ['1', '2', '3', '4', '5', '6'] },
    ],
  },
  {
    name: 'closedoff_parking_space_page',
    desc: '停车位分页查询。问“某停车组有哪些车位”“违停车位有哪些”时使用。parkingStatus: 0待停 1已停 2空余 3违停；isItToxic: 0否 1是（毒性物资车位）' + PAGE_TIP,
    method: 'POST', path: '/hazardous-park/tParkingSpace/page',
    result: result('unknown',
      ['id', '停车位ID'], ['name', '停车位名称'], ['parkingAreaName', '停车区名称'],
      ['parkingGroupName', '停车组名称'], ['parkingStatus', '停放状态'],
      ['isItToxic', '是否毒性物资车位'], ['carNumb', '当前车辆']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'keyWords', type: 'string', required: false, desc: '关键字' },
      { key: 'parkingAreaId', type: 'string', required: false, desc: '停车区ID' },
      { key: 'parkingGroupId', type: 'string', required: false, desc: '停车组id' },
      { key: 'isItToxic', type: 'string', required: false, desc: '是否毒性物资车位', enum: ['0', '1'] },
      { key: 'parkingStatus', type: 'string', required: false, desc: '停放状态', enum: ['0', '1', '2', '3'] },
    ],
  },
  {
    name: 'closedoff_parking_lot_list',
    desc: '停车场列表查询。问“园区有哪些停车场”时使用。',
    method: 'GET', path: '/hazardous-park/parkingLot/list',
    result: result('unknown', ['id', '停车场ID'], ['name', '停车场名称']),
    params: [],
  },
  {
    name: 'closedoff_gate_access_page',
    desc: '门禁/卡口出入记录分页查询（人/车类型、出入园时间）。问“某车什么时候进的园区”“近期的门禁记录”时使用。未指定时间默认最近一月' + TIME_FMT + PAGE_TIP,
    method: 'POST', path: '/hazardous-park/gateAccessRecord/getPage',
    timeRanges: [
      { startKey: 'inDateBegin', endKey: 'inDateEnd' },
      { startKey: 'outDateBegin', endKey: 'outDateEnd' },
    ],
    result: result('unknown',
      ['carNumb', '车牌'], ['realName', '人员'], ['type', '通行对象类型'],
      ['inDeviceName', '入园设备'], ['inDate', '入园时间'],
      ['outDeviceName', '出园设备'], ['outDate', '出园时间']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'carNumb', type: 'string', required: false, desc: '车牌号' },
      { key: 'inDateBegin', type: 'string', required: false, desc: '入园时间起' + TIME_FMT },
      { key: 'inDateEnd', type: 'string', required: false, desc: '入园时间止' + TIME_FMT },
      { key: 'outDateBegin', type: 'string', required: false, desc: '出园时间起' + TIME_FMT },
      { key: 'outDateEnd', type: 'string', required: false, desc: '出园时间止' + TIME_FMT },
    ],
  },
  {
    name: 'closedoff_district_page',
    desc: '设备区域（园区道路/区域）分页查询。问“园区有哪些区域/道路”“某主干道信息”时使用' + PAGE_TIP,
    method: 'POST', path: '/closed-off/district/page',
    result: result('list',
      ['id', '区域ID'], ['districtName', '区域名称'], ['districtDesc', '区域描述'],
      ['districtType', '区域类型'], ['districtLevel', '区域等级'], ['carType', '允许车辆类型'],
      ['startTime', '管控开始时间'], ['endTime', '管控结束时间'], ['enabled', '是否启用']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'keyWords', type: 'string', required: false, desc: '关键字（可为空）' },
    ],
  },
  {
    name: 'closedoff_checkpoint_devices',
    desc: '授权出入口设备查询（按区域分组的出入口闸机/摄像头）。问“入口有哪些车闸”“出口摄像头”时使用。inOrOut: 1出 2入；deviceType: 1车闸 2人闸 3IP广播 4GDS 5报杆箱 6摄像头',
    method: 'POST', path: '/closed-off/device/getCheckPointDevice',
    result: result('list',
      ['districtId', '区域ID'], ['districtName', '区域名称'], ['deviceList', '区域下的设备列表']),
    params: [
      { key: 'inOrOut', type: 'integer', required: true, desc: '1出 2入', enum: [1, 2] },
      { key: 'deviceType', type: 'integer', required: true, desc: '设备类型', enum: [1, 2, 3, 4, 5, 6] },
    ],
  },
  {
    name: 'closedoff_device_page',
    desc: '设备分页列表（含设备组 groupId/groupName、设备名称/编号、设备组标绘点位）。仅在用户直接查询设备时使用；车辆轨迹工具会自行取得设备组用于地图和沿途分析，不要重复调用本工具。',
    method: 'POST', path: '/closed-off/device/page',
    result: {
      ...result('list',
      ['groupName', '设备组'], ['districtName', '所属区域'], ['deviceName', '设备名称'],
      ['deviceCode', '设备编号'], ['deviceType', '设备类型'], ['status', '在线状态'],
      ['lastHeartbeatTime', '最后心跳时间'], ['inOrOut', '出入口方向'], ['plottingConfigData', '设备组标绘数据']),
      runtimeFields: [
        ['id', '设备ID'], ['groupId', '设备组ID'], ['deviceIp', '设备IP'],
        ['videoAddress', '视频地址'], ['accessAddress', '备用视频地址'], ['cameraCode', '摄像头编码'],
      ],
    },
    params: [
      { key: 'pageIndex', type: 'integer', required: true, desc: '轨迹地图固定传 1' },
      { key: 'pageSize', type: 'integer', required: true, desc: '轨迹地图固定传 500' },
      { key: 'groupId', type: 'string', required: false, desc: '设备组ID（轨迹地图留空以查询全部）' },
      { key: 'deviceName', type: 'string', required: false, desc: '设备名称' },
      { key: 'deviceCode', type: 'string', required: false, desc: '设备编号' },
      { key: 'deviceType', type: 'integer', required: false, desc: '设备类型：1车闸 2人闸 3IP广播 4GDS 5报杆箱 6摄像头 7预约屏', enum: [1, 2, 3, 4, 5, 6, 7] },
    ],
  },
  {
    name: 'closedoff_control_area_stats',
    desc: '控制区类型统计：各类型控制区（1核心 2关键 3一般）数量、异常巡检数、报警数。问“各控制区情况/报警分布”时使用。',
    method: 'GET', path: '/closed-off/controlArea/getControlAreaTypeStatistics',
    result: result('list',
      ['controlType', '控制区类型'], ['controlAreaCount', '控制区数量'],
      ['abnormalInspectionCount', '异常巡检数'], ['alarmCount', '报警数']),
    params: [],
  },
  {
    name: 'closedoff_control_area_page',
    desc: '电子围栏/控制区分页查询（含名称、类型、标绘数据）。问“园区有哪些控制区/电子围栏”“核心控制区有哪些”时使用。controlType: 1核心控制区 2关键控制区 3一般控制区；controlName 支持模糊匹配' + PAGE_TIP,
    method: 'POST', path: '/closed-off/controlArea/page',
    result: result('list',
      ['id', '控制区ID'], ['controlName', '控制区名称'], ['controlType', '控制区类型'],
      ['remarks', '备注'], ['plottingConfigData', '三维标绘数据']),
    params: [
      R.pageSize, R.pageIndex,
      { key: 'controlName', type: 'string', required: false, desc: '控制区名称（支持模糊匹配）' },
      { key: 'controlType', type: 'string', required: false, desc: '控制区类型', enum: ['1', '2', '3'] },
    ],
  },
  {
    name: 'closedoff_plotting_config_one',
    desc: '电子围栏三维标绘数据获取（按围栏ID返回标绘JSON）。问“某控制区的围栏标绘/边界数据”时使用。bizDataId 为电子围栏ID（可从 closedoff_control_area_page 结果中获取）。',
    method: 'GET', path: '/system/plottingConfigData/one',
    result: result('object',
      ['id', '标绘记录ID'], ['bizDataId', '业务对象ID'], ['plottingData', '三维标绘JSON']),
    params: [{ key: 'bizDataId', type: 'string', required: true, desc: '电子围栏ID' }],
  },
  {
    name: 'closedoff_access_record_page',
    desc: '车辆/人员通行记录分页查询（入园/出园时间、设备、类型）。问“某车什么时候进园的”“近期的通行记录”时使用。typeList 数组: 1人 2普通车辆 3危化车 4危废车；inDeviceCode 为必填的入口设备编码，未知时可先用空字符串。未指定时间默认最近一月' + TIME_FMT + PAGE_TIP,
    method: 'POST', path: '/closed-off/accessRecord/page',
    timeRanges: [
      { startKey: 'inDateBegin', endKey: 'inDateEnd' },
      { startKey: 'outDateBegin', endKey: 'outDateEnd' },
    ],
    result: result('list',
      ['id', '通行记录ID'], ['type', '人车类型'], ['carNumb', '车牌'], ['realName', '人员'],
      ['companyName', '企业'], ['inDeviceName', '入园设备'], ['inDate', '入园时间'],
      ['outDeviceName', '出园设备'], ['outDate', '出园时间'], ['violationCount', '违章次数']),
    params: [
      R.pageSize, R.pageIndex,
      { key: 'inDeviceCode', type: 'string', required: true, desc: '入设备code（必填，未知可传空字符串）' },
      { key: 'outDeviceCode', type: 'string', required: false, desc: '出设备code' },
      { key: 'carNumb', type: 'string', required: false, desc: '车牌' },
      { key: 'inDateBegin', type: 'string', required: false, desc: '入园时间起' + TIME_FMT },
      { key: 'inDateEnd', type: 'string', required: false, desc: '入园时间止' + TIME_FMT },
      { key: 'outDateBegin', type: 'string', required: false, desc: '出园时间起' + TIME_FMT },
      { key: 'outDateEnd', type: 'string', required: false, desc: '出园时间止' + TIME_FMT },
      { key: 'typeList', type: 'array', itemType: 'integer', required: false, desc: '类型数组 1人 2普通车辆 3危化车 4危废车' },
    ],
  },
  {
    name: 'closedoff_gate_records_by_car',
    desc: '按车牌查询该车的出入记录（含闸机名称/时间）。问“某车的进出记录”时使用。',
    method: 'GET', path: '/closed-off/accessRecord/getGateRecordsByCarNum',
    result: result('list',
      ['startDate', '分段开始时间'], ['endDate', '分段结束时间'], ['data', '闸机记录列表'],
      ['address', '闸机或抓拍点'], ['dateTime', '通行时间'], ['type', '通行方向'],
      ['violationTypeName', '违规类型'], ['remark', '备注']),
    params: [{ key: 'carNum', type: 'string', required: true, desc: '车牌' }],
  },
  {
    name: 'closedoff_vehicle_comprehensive_page',
    desc: '车辆综合查询列表：按关键字分页查车辆（含黑白名单/预约/授权状态 validityStatus: -1否 0白名单 1预约 2黑名单）。问“某车牌的信息”“有哪些危化车”时使用' + PAGE_TIP,
    method: 'POST', path: '/closed-off/comprehensive/getVehicleComprehensivePage',
    result: result('list',
      ['id', '车辆ID'], ['carNumb', '车牌'], ['carCategory', '车辆类别'],
      ['carNumbColour', '车牌颜色'], ['trailer', '是否挂车'], ['validityStatus', '授权来源状态'],
      ['accessCount', '通行次数'], ['inCount', '入园次数'], ['outCount', '出园次数'],
      ['violationCount', '违章次数'], ['blackCount', '黑名单次数']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'keyword', type: 'string', required: false, desc: '关键字（车牌/企业等）' },
    ],
  },
  {
    name: 'closedoff_vehicle_count',
    desc: '车辆统计：车辆总数、黑名单数、预约数等统计。问“园区共有多少车辆”时使用。',
    method: 'POST', path: '/closed-off/comprehensive/getVehicleCount',
    result: result('list',
      ['carCategory', '车辆类别'], ['totalCount', '车辆总数'], ['blackListCount', '黑名单数'],
      ['whiteListCount', '白名单数'], ['reservationCount', '预约数']),
    params: [],
  },
  {
    name: 'closedoff_white_page',
    desc: '白名单分页查询（人员/车辆）。问“某车牌是否在白名单”“白名单有哪些”时使用。type: 1人 2车（必填）；sourceType: 1个人申请 2企业申请 3园区申请；currentStatus: 0未生效 1生效中 2已过期；companyCheckStatus 固定传 1' + TIME_FMT + PAGE_TIP,
    method: 'POST', path: '/closed-off/white/v2/page',
    result: result('list',
      ['id', '白名单ID'], ['type', '人车类型'], ['sourceType', '申请来源'],
      ['realName', '人员'], ['carNumb', '车牌'], ['carCategory', '车辆类别'],
      ['sex', '性别'], ['idCard', '身份证号'], ['userPhone', '联系电话'],
      ['companyName', '企业'], ['currentStatus', '当前状态'],
      ['validityBeginTime', '有效期开始'], ['validityEndTime', '有效期结束'],
      ['companyCheckStatus', '企业审核状态'], ['parkCheckStatus', '园区审核状态'],
      ['submitBy', '提交人'], ['submitUserPhone', '提交人电话'], ['submitDate', '提交时间']),
    params: [
      R.pageSize, R.pageIndex,
      { key: 'type', type: 'integer', required: true, desc: '白名单类型 1人 2车', enum: [1, 2] },
      { key: 'sourceType', type: 'integer', required: false, desc: '来源类型', enum: [1, 2, 3] },
      { key: 'currentStatus', type: 'integer', required: false, desc: '当前状态', enum: [0, 1, 2] },
      { key: 'realName', type: 'string', required: false, desc: '姓名' },
      { key: 'carCategory', type: 'string', required: false, desc: '车辆类别 2普通车 3危化车 4危废车 5普通货车' },
      { key: 'parkCheckStatus', type: 'integer', required: false, desc: '园区审核状态 0待审核 1通过 2拒绝', enum: [0, 1, 2] },
      { key: 'companyCheckStatus', type: 'integer', required: true, desc: '固定传 1', enum: [1] },
      { key: 'companyId', type: 'string', required: false, desc: '企业ID' },
      { key: 'keyWords', type: 'string', required: false, desc: '关键字' },
      { key: 'validityBeginTime', type: 'string', required: false, desc: '有效期开始' + TIME_FMT },
      { key: 'validityEndTime', type: 'string', required: false, desc: '有效期结束' + TIME_FMT },
      { key: 'inDeviceCode', type: 'string', required: false, desc: '授权入口设备编码' },
      { key: 'outDeviceCode', type: 'string', required: false, desc: '授权出口设备编码' },
    ],
  },
  {
    name: 'closedoff_white_detail',
    desc: '白名单详情查询（按 id）。问“某条白名单记录的详情”时使用。先通过 closedoff_white_page 拿到 id。',
    method: 'GET', path: '/closed-off/white/v2/one',
    result: result('object',
      ['id', '白名单ID'], ['type', '人车类型'], ['sourceType', '申请来源'],
      ['realName', '人员'], ['carNumb', '车牌'], ['companyName', '企业'], ['remark', '用途备注'],
      ['currentStatus', '当前状态'], ['validityBeginTime', '有效期开始'],
      ['validityEndTime', '有效期结束'], ['parkCheckStatus', '园区审核状态']),
    params: [{ key: 'id', type: 'string', required: true, desc: '白名单记录ID' }],
  },
  {
    name: 'closedoff_black_page',
    desc: '黑名单分页查询（人员/车辆）。问“某车是否被拉黑”“黑名单有哪些”时使用。参数含义同 closedoff_white_page' + TIME_FMT + PAGE_TIP,
    method: 'POST', path: '/closed-off/black/v2/page',
    result: result('list',
      ['id', '黑名单ID'], ['type', '人车类型'], ['realName', '人员'], ['carNumb', '车牌'],
      ['carCategory', '车辆类别'], ['companyName', '企业'], ['remark', '拉黑原因或备注'],
      ['status', '状态'], ['validityBeginTime', '有效期开始'],
      ['validityEndTime', '有效期结束'], ['parkCheckStatus', '园区审核状态']),
    params: [
      R.pageSize, R.pageIndex,
      { key: 'type', type: 'integer', required: true, desc: '黑名单类型 1人 2车', enum: [1, 2] },
      { key: 'sourceType', type: 'integer', required: false, desc: '来源类型', enum: [1, 2, 3] },
      { key: 'currentStatus', type: 'integer', required: false, desc: '当前状态', enum: [0, 1, 2] },
      { key: 'realName', type: 'string', required: false, desc: '姓名' },
      { key: 'carCategory', type: 'string', required: false, desc: '车辆类别' },
      { key: 'parkCheckStatus', type: 'integer', required: false, desc: '园区审核状态', enum: [0, 1, 2] },
      { key: 'companyCheckStatus', type: 'integer', required: true, desc: '固定传 1', enum: [1] },
      { key: 'companyId', type: 'string', required: false, desc: '企业ID' },
      { key: 'keyWords', type: 'string', required: false, desc: '关键字' },
      { key: 'validityBeginTime', type: 'string', required: false, desc: '有效期开始' + TIME_FMT },
      { key: 'validityEndTime', type: 'string', required: false, desc: '有效期结束' + TIME_FMT },
      { key: 'inDeviceCode', type: 'string', required: false, desc: '授权入口设备编码' },
      { key: 'outDeviceCode', type: 'string', required: false, desc: '授权出口设备编码' },
    ],
  },
  {
    name: 'closedoff_black_detail',
    desc: '黑名单详情查询（按 id）。问“某条黑名单记录的详情/拉黑原因”时使用。先通过 closedoff_black_page 拿到 id。',
    method: 'GET', path: '/closed-off/black/v2/one',
    result: result('object',
      ['id', '黑名单ID'], ['type', '人车类型'], ['realName', '人员'], ['carNumb', '车牌'],
      ['companyName', '企业'], ['remark', '拉黑原因或备注'], ['status', '状态'],
      ['validityBeginTime', '有效期开始'], ['validityEndTime', '有效期结束'],
      ['parkCheckStatus', '园区审核状态']),
    params: [{ key: 'id', type: 'string', required: true, desc: '黑名单记录ID' }],
  },
  {
    name: 'closedoff_park_status',
    desc: '园区实时状态总览（在园车辆按类型统计等）。问“园区现在整体情况”“在园车辆”时使用。',
    method: 'GET', path: '/closed-off/overviewV2/parkStatus',
    result: result('object',
      ['vehicles', '各车辆类型的在园、今日进出与容量统计'],
      ['personInPark', '当前在园人数'], ['personInToday', '今日入园人数'],
      ['goods', '各货物类型的进出吨数与品类数'],
      ['hazmatHourly', '危化车逐小时数量'], ['hazwasteHourly', '危废车逐小时数量'],
      ['normalHourly', '普通车辆逐小时数量']),
    params: [],
  },
  {
    name: 'closedoff_company_base_info_page',
    desc: '园区企业基础信息分页查询（企业ID/名称）。问“园区有哪些企业”“某企业的ID/名称”时使用。',
    method: 'POST', path: '/system/companyBaseInfo/page',
    result: result('unknown', ['id', '企业ID'], ['companyName', '企业名称'], ['companyCode', '企业编码']),
    params: [R.pageIndex, R.pageSize],
  },
  {
    name: 'closedoff_waybill_page',
    desc: '危化品电子运单分页查询（单号/起运地/车牌/企业）。问“某车的电子运单”“某企业的运单”时使用' + PAGE_TIP,
    method: 'POST', path: '/closed-off/reservationGoods/selDigitalWaybillPage',
    result: result('list',
      ['id', '运单ID'], ['reservationId', '预约ID'], ['electronicWaybill', '电子运单标识'],
      ['waybillNumber', '运单号'], ['startingPoint', '起运地'], ['carNumb', '车牌'],
      ['trailerLicensePlate', '挂车牌号'], ['companyName', '企业'], ['realName', '驾驶员']),
    params: [
      R.pageIndex, R.pageSize,
      { key: 'keyWords', type: 'string', required: false, desc: '关键字' },
    ],
  },
]

/** Tool lookup shared by execution and Web presentation. */
export const TOOL_BY_NAME = new Map(TOOL_SPECS.map(spec => [spec.name, spec] as const))
