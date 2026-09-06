---
description: "封闭化助手 37 个只读 Tool、业务网关接口、参数、响应、认证、配置和提示词的调用参考。"
kind: "package-reference"
---

# 封闭化查询 Tool 与业务接口调用手册

## 摘要

本文供需要复用封闭化查询能力的 AI、Agent 或集成程序使用。文档以当前插件源码为准，覆盖 37 个只读 Tool、对应 HTTP 地址、参数、统一认证流程、返回值归一化、配置文件和提示词规则。

本文不会记录真实凭据、token 或生产响应。示例中的 `<业务网关>`、`<客户端 ID>`、`<记录 ID>`、`<车牌号>` 等均为占位符。

本文中的请求是根据当前源码和测试核对的集成模板；本次没有使用真实凭据向正式业务网关执行请求。接口 `data` 的完整字段仍应由业务系统 OpenAPI、后端 DTO 或脱敏实测响应确认。

## 目录

- [先确认调用层级](#先确认调用层级)
- [配置文件与源码位置](#配置文件与源码位置)
- [两阶段认证](#两阶段认证)
- [业务接口统一调用规则](#业务接口统一调用规则)
- [统一响应格式](#统一响应格式)
- [37 个 Tool 总表](#37-个-tool-总表)
- [Tool 详细参数与提示词](#tool-详细参数与提示词)
- [车辆轨迹的特殊执行逻辑](#车辆轨迹的特殊执行逻辑)
- [通过 DSH 专用页面调用 Agent](#通过-dsh-专用页面调用-agent)
- [给另一个 AI 的建议系统提示词](#给另一个-ai-的建议系统提示词)
- [调用检查清单](#调用检查清单)

## 先确认调用层级

当前实现有三个不同层级，不能混为一谈：

1. **业务 HTTP 接口**：另一个程序可以完成两阶段认证后，直接请求 `{CLOSEDOFF_BASE_URL}<接口路径>`。
2. **DSH Tool**：37 个 `closedoff_*` Tool 注册在 DSH 进程内部，由 Agent Loop 调用；插件没有公开“按 Tool 名直接调用”的 REST 路由。
3. **专用 Agent 页面接口**：外部客户端可以向 `/closedoff-qa/chat` 发送自然语言，接收 SSE。Agent 根据提示词选择 Tool、调用业务接口并生成分析。

如果另一个 AI 平台支持自定义函数或 Tool，最接近当前行为的做法是：把本文中的 Tool 名、说明和参数 Schema 注册给该平台，再由统一执行器完成认证和 HTTP 请求。如果只需要原始数据，也可以绕过 DSH Tool，直接调用业务 HTTP 接口；此时必须自行实现时间范围、token 缓存、失败重试和结果分析规则。

## 配置文件与源码位置

以下地址均相对于 `dsh-closedoff-assistant/` 插件包根目录：

| 文件 | 用途 |
| --- | --- |
| `env.conf.example` | 业务网关和两阶段认证字段模板 |
| `env.conf` | 当前部署使用的真实配置；不得复制到公开文档或不受控系统 |
| `cordis.patch.yml` | 将插件插入 DSH `web` profile，并设置地图及轨迹分析参数 |
| `src/config.ts` | 所有插件配置字段、校验范围和默认值的源文件 |
| `src/specs.ts` | 37 个 Tool 的名称、提示词、HTTP 方法、路径、参数和返回字段契约的唯一目录 |
| `src/gateway.ts` | 两阶段认证、GET/POST 组包、时间范围、token、超时和响应归一化 |
| `src/tools.ts` | DSH Tool Schema、公共回答提示、轨迹特殊执行逻辑 |
| `persona.txt` | Agent 的中文回答、Tool 选择、时间范围和重试纪律 |

从模板创建部署配置：

```powershell
Copy-Item env.conf.example env.conf
```

`env.conf` 字段：

```dotenv
CLOSEDOFF_BASE_URL=https://<业务网关>/
CLOSEDOFF_OPEN_CLIENT_ID=<阶段一客户端 ID>
CLOSEDOFF_OPEN_CLIENT_SECRET=<阶段一客户端密钥>
CLOSEDOFF_APP_CODE=<阶段二应用编码>
CLOSEDOFF_APP_CLIENT_ID=<阶段二客户端 ID>
CLOSEDOFF_APP_CLIENT_SECRET=<阶段二客户端密钥>
CLOSEDOFF_USERNAME=<阶段二用户名>
```

可以用 `CLOSEDOFF_ENV_CONF` 指定其他配置文件；未设置时，插件读取包根目录的 `env.conf`。`CLOSEDOFF_BASE_URL` 必须是有效 HTTPS URL。缺少字段、空字段或仍为 `REPLACE_ME` 时，插件会启动失败。

`cordis.patch.yml` 当前暴露的部署变量：

| 环境变量 | 插件字段 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `CLOSEDOFF_TERRAIN_URL` | `terrainUrl` | 重庆地形服务地址 | Cesium 地形 |
| `CLOSEDOFF_TILESET_URL` | `tilesetUrl` | 涪陵 3D Tiles 地址 | 园区模型 `tileset.json` |
| `CLOSEDOFF_TILESET_HEIGHT` | `tilesetHeight` | `60` | 模型沿椭球法向高度偏移，单位米 |
| `CLOSEDOFF_TRACK_DEVICE_RADIUS_METERS` | `trackDeviceRadiusMeters` | `100` | 轨迹附近设备组筛选半径，单位米 |
| `CLOSEDOFF_TRACK_DWELL_MAX_GAP_SECONDS` | `trackDwellMaxGapSeconds` | `300` | 驻留估算允许的最大相邻采样间隔，单位秒 |

`src/config.ts` 还定义以下配置；如需覆盖，应在 Cordis 插件 `config` 中明确配置，而不是把它们当成现成环境变量：

| 字段 | 默认值 | 允许范围 | 作用 |
| --- | ---: | ---: | --- |
| `routePrefix` | `/closedoff-qa` | 小写字母、数字和连字符组成的绝对路径 | 专用页面及 API 前缀 |
| `requestTimeoutMs` | `20000` | `1000`–`120000` | 每次认证或业务 HTTP 请求超时 |
| `toolTimeoutMs` | `45000` | `1000`–`600000` | 单个 DSH Tool 执行超时 |
| `turnTimeoutMs` | `480000` | `1000`–`1800000` | 一次专用页面 Agent 回合超时 |
| `maxPageSize` | `500` | `1`–`1000` | Tool 接受的 `pageSize` 上限 |
| `maxQueryRangeDays` | `30` | `1`–`366` | 普通时间查询最大天数；轨迹类另限 2 天 |
| `maxRequestBodyBytes` | `65536` | `1024`–`1048576` | 专用页面 JSON 请求体上限，不是业务接口响应上限 |
| `maxResponseBodyBytes` | `2097152` | `1024`–`16777216` | 每个业务网关响应体上限 |
| `maxActiveConversations` | `50` | `1`–`500` | 进程内活动 Agent handle 上限 |

完整 Cordis 配置示例：

```yaml
- insert:
    - id: closedoff-assistant
      name: dsh-closedoff-assistant
      config:
        terrainUrl: https://<地形服务>/
        tilesetUrl: https://<三维瓦片服务>/tileset.json
        tilesetHeight: 60
        trackDeviceRadiusMeters: 100
        trackDwellMaxGapSeconds: 300
        routePrefix: /closedoff-qa
        requestTimeoutMs: 20000
        toolTimeoutMs: 45000
        turnTimeoutMs: 480000
        maxPageSize: 500
        maxQueryRangeDays: 30
        maxRequestBodyBytes: 65536
        maxResponseBodyBytes: 2097152
        maxActiveConversations: 50
```

实际包中的 `cordis.patch.yml` 只显式设置地图、轨迹筛选和 `routePrefix`；其余字段使用 `src/config.ts` 默认值。

## 两阶段认证

### 第一步：取得开放平台 accessToken

```http
POST {CLOSEDOFF_BASE_URL}/system/openApi/public/getAccessToken
Content-Type: application/json

{
  "clientId": "<CLOSEDOFF_OPEN_CLIENT_ID>",
  "clientSecret": "<CLOSEDOFF_OPEN_CLIENT_SECRET>"
}
```

成功响应必须满足：根节点是 JSON 对象、`success` 不为 `false`、`data` 是非空字符串。`data` 即第一阶段 `accessToken`。

### 第二步：取得业务 Bearer token

```http
POST {CLOSEDOFF_BASE_URL}/openApi/oauth2/obtainAccessTokenWithClientInfo?accessToken=<第一阶段 accessToken>
Content-Type: application/json

{
  "appCode": "<CLOSEDOFF_APP_CODE>",
  "clientId": "<CLOSEDOFF_APP_CLIENT_ID>",
  "clientSecret": "<CLOSEDOFF_APP_CLIENT_SECRET>",
  "username": "<CLOSEDOFF_USERNAME>"
}
```

成功响应的 `data` 必须包含：

```json
{
  "tokenValue": "<业务 token>",
  "tokenTimeout": 3600
}
```

`tokenTimeout` 单位按当前实现作为秒处理。插件在 `tokenTimeout - 120 秒` 时将 token 视为过期；当有效期小于 120 秒时，至少缓存 1 秒。并发登录共享同一个 Promise，避免重复登录。

### 第三步：调用业务接口

所有业务接口统一携带：

```http
Authorization: Bearer <tokenValue>
```

当业务响应 `success=false` 且 `errCode` 为 `1001` 或 `1003` 时，插件清空 token、重新完成认证，并且只重试该业务请求一次。其他失败不会自动换参数重查。

## 业务接口统一调用规则

### URL 与参数组装

- `GET`：非空参数写入 query string；数组用逗号连接；路径参数先执行 URL 编码。
- `POST`：只把 Tool 参数目录中声明且值不为 `undefined`、`null`、空字符串的字段写入 JSON body。
- 未在 Tool 参数目录声明的输入不会发送给业务接口。
- `POST` 即使没有参数，也发送 `{}`。
- 所有接口路径都是固定白名单，模型不能传入任意 URL。

GET 示例：

```bash
curl -G 'https://<业务网关>/closed-off/accessRecord/getGateRecordsByCarNum' \
  -H 'Authorization: Bearer <tokenValue>' \
  --data-urlencode 'carNum=<车牌号>'
```

POST 示例：

```bash
curl 'https://<业务网关>/closed-off/comprehensive/getVehicleComprehensivePage' \
  -X POST \
  -H 'Authorization: Bearer <tokenValue>' \
  -H 'Content-Type: application/json' \
  -d '{"pageIndex":1,"pageSize":20,"keyword":"<车牌号>"}'
```

### 时间范围处理

- 时间格式严格为 `yyyy-MM-dd HH:mm:ss`，例如 `2026-09-04 08:30:00`。
- 普通 Tool 默认最大范围为最近 `30` 天；`closedoff_vehicle_track`、`closedoff_vehicle_location_page`、`closedoff_vehicle_stream` 最大为最近 `2` 天。
- 没有提供任何时间字段时，只补齐该 Tool 声明的第一组起止字段。
- 提供某一组的开始或结束任一字段时，插件补齐并限制这一组。
- 结束时间缺失或晚于当前时间时，使用当前时间。
- 开始时间缺失、早于允许范围或晚于结束时间时，使用 `结束时间 - 最大天数`。
- 同时支持入园和出园时间的接口，只处理用户实际填写的字段组；两组都未填写时默认补第一组，即入园时间。
- 被默认或截断时，归一化结果增加中文 `note`。

注意：这里的“最近一月”在代码中是 `30` 天，不是自然月。

### 当前已知参数不一致

`closedoff_access_record_page.inDeviceCode` 在 Tool Schema 中是必填字段，提示词称“未知可传空字符串”；但是 POST 组包会删除空字符串。因此 `"inDeviceCode":""` 最终不会进入 HTTP body。调用方不能依赖空字符串满足上游必填校验；应优先先查询设备编码，或确认上游接口允许省略该字段。

## 统一响应格式

### 业务接口原始响应

业务接口通常返回：

```json
{
  "success": true,
  "errCode": null,
  "message": null,
  "totalCount": 1,
  "pageSize": 20,
  "pageIndex": 1,
  "data": []
}
```

各接口的 `data` 字段由业务系统拥有。插件按 `src/specs.ts` 中的 `result` 声明当前可确认的列表、对象或内嵌分页对象基数，以及少量分析所需主要字段；对象允许额外字段，已知字段也允许缺省，字段值暂不按旧 DTO 收紧类型。没有对应后端源码、前端直接消费或脱敏实测证据的接口使用 `unknown`，不做伪精确校验。为控制每轮固定提示成本，Native Tool description 最多展示前 6 个字段名；`output.render` 再按标准 envelope、`result.fields` 和登记过的嵌套字段执行 fail-closed 投影，未知附加字段不会进入模型消息。

DSH Native Agent 收到的 Tool 定义只包含名称、说明和入参，不直接包含 `output.schema`。因此插件从同一个 `result` 声明生成 Tool description 中的“主要返回”提示；`output.schema` 用于运行时结果校验，并可供 PTC 工具 SDK 投影。新增或调整字段时只修改 `src/specs.ts`，不能分别手写两份字段目录。

本次核对日期为 2026-09-04，依据后端 `4f17bc2ce77ef755f2726bc91cee461964d21914` 和前端 `7318355ecefd6ccbedc20ad8cd74433d331e2976`。当前 37 个 Tool 没有已证明的 `dataKind` 变化；新增的 `dataId`、`dataSource` 未进入主要字段，白名单分页补充了源码已证明的个人与提交字段并在投影时脱敏。后端最新设备消息逻辑会按 AI 直播可用性在 `accessAddress` 与 `videoAddress` 二选一写入播放地址；两者已经登记为页面运行字段，不进入模型字段提示。这些 Schema 是当前代码的兼容描述，不替代正式 OpenAPI；下次前后端更新后仍需重新核对。

### DSH Tool 成功结果

插件把成功响应归一化为：

```json
{
  "api": "/closed-off/comprehensive/getVehicleComprehensivePage",
  "ok": true,
  "success": true,
  "data": [],
  "totalCount": 0,
  "pageIndex": 1,
  "pageSize": 20,
  "note": "未指定开始时间，默认最近 30 天",
  "elapsedMs": 123
}
```

其中 `totalCount`、`pageIndex`、`pageSize`、`note` 只在有值时出现。业务成功响应根节点中的其他字段不会进入 Tool 结果，但 `data` 原样保留。

### DSH Tool 业务失败结果

```json
{
  "api": "/<接口路径>",
  "ok": false,
  "errCode": 1234,
  "message": "业务接口返回的失败消息",
  "elapsedMs": 123
}
```

### DSH Tool 传输或本地校验失败结果

```json
{
  "api": "/<接口路径>",
  "ok": false,
  "error": "gateway HTTP 500",
  "elapsedMs": 123
}
```

可能的 `error` 包括日期格式错误、无效日期、`pageSize` 超限、缺少路径参数、HTTP 非 2xx、非 JSON 响应、响应过大、超时或取消。

## 37 个 Tool 总表

| # | Tool | HTTP | 路径 | 主要结果 |
| ---: | --- | --- | --- | --- |
| 1 | `closedoff_warning_page` | POST | `/risk-warning/riskWarning/page` | 预警、报警、事故、事件分页记录 |
| 2 | `closedoff_warning_detail` | GET | `/risk-warning/riskWarning/one` | 单条预警及处置、派发详情 |
| 3 | `closedoff_warning_count` | GET | `/risk-warning/riskWarning/countByWarningStatus` | 按状态过滤后的报警数量 |
| 4 | `closedoff_warning_module_list` | GET | `/risk-warning/riskWarningModule/getList` | 报警模块及子类型字典 |
| 5 | `closedoff_warning_count_by_level` | POST | `/risk-warning/riskWarning/countByWarningLevel` | 红、橙、黄、蓝等级数量 |
| 6 | `closedoff_reservation_approval_page` | POST | `/closed-off/reservation/approvalPageV2` | 待审批及各阶段预约分页 |
| 7 | `closedoff_reservation_completed_page` | POST | `/closed-off/reservation/completedPageV2` | 已完成、已审批预约分页 |
| 8 | `closedoff_reservation_stats` | GET | `/closed-off/reservation/statsV2` | 今日待审、完成、时长、通过率、类型统计 |
| 9 | `closedoff_reservation_detail` | GET | `/closed-off/reservation/reservationProgressInfo/{id}` | 预约进度详情 |
| 10 | `closedoff_change_record_page` | POST | `/closed-off/changeRecord/pageByReservationId` | 指定预约的变更记录 |
| 11 | `closedoff_today_reservation` | GET | `/closed-off/parkOverview/todayReservation` | 今日各预约类型数量 |
| 12 | `closedoff_vehicle_track` | GET | `/car/carLocation/historyTrack` | 历史轨迹、附近设备组和驻留估算 |
| 13 | `closedoff_vehicle_location_page` | GET | `/car/carLocation/vehiclePage` | 有历史定位的车辆分页 |
| 14 | `closedoff_vehicle_latest_positions` | GET | `/car/carLocation/latestInfoFromCache` | 在园车辆缓存最新位置 |
| 15 | `closedoff_vehicle_stream` | GET | `/car/carLocation/vehicleStream` | 车辆历史轨迹视频或抓拍流信息 |
| 16 | `closedoff_parking_area_page` | POST | `/hazardous-park/tParkingArea/page` | 停车区及车位统计 |
| 17 | `closedoff_parking_group_page` | POST | `/hazardous-park/tParkingGroup/page` | 停车组、停放统计和火灾风险分类 |
| 18 | `closedoff_parking_space_page` | POST | `/hazardous-park/tParkingSpace/page` | 停车位及停放状态 |
| 19 | `closedoff_parking_lot_list` | GET | `/hazardous-park/parkingLot/list` | 停车场列表 |
| 20 | `closedoff_gate_access_page` | POST | `/hazardous-park/gateAccessRecord/getPage` | 卡口出入记录分页 |
| 21 | `closedoff_district_page` | POST | `/closed-off/district/page` | 园区道路、设备区域分页 |
| 22 | `closedoff_checkpoint_devices` | POST | `/closed-off/device/getCheckPointDevice` | 指定出入方向和类型的卡口设备 |
| 23 | `closedoff_device_page` | POST | `/closed-off/device/page` | 设备、设备组和标绘点位分页 |
| 24 | `closedoff_control_area_stats` | GET | `/closed-off/controlArea/getControlAreaTypeStatistics` | 控制区类型、异常巡检和报警统计 |
| 25 | `closedoff_control_area_page` | POST | `/closed-off/controlArea/page` | 电子围栏、控制区分页及标绘信息 |
| 26 | `closedoff_plotting_config_one` | GET | `/system/plottingConfigData/one` | 指定业务对象的三维标绘 JSON |
| 27 | `closedoff_access_record_page` | POST | `/closed-off/accessRecord/page` | 人员、车辆通行记录分页 |
| 28 | `closedoff_gate_records_by_car` | GET | `/closed-off/accessRecord/getGateRecordsByCarNum` | 指定车牌的闸机出入记录 |
| 29 | `closedoff_vehicle_comprehensive_page` | POST | `/closed-off/comprehensive/getVehicleComprehensivePage` | 车辆综合、名单、预约和授权状态 |
| 30 | `closedoff_vehicle_count` | POST | `/closed-off/comprehensive/getVehicleCount` | 车辆总数、名单数、预约数等统计 |
| 31 | `closedoff_white_page` | POST | `/closed-off/white/v2/page` | 人员或车辆白名单分页 |
| 32 | `closedoff_white_detail` | GET | `/closed-off/white/v2/one` | 单条白名单详情 |
| 33 | `closedoff_black_page` | POST | `/closed-off/black/v2/page` | 人员或车辆黑名单分页 |
| 34 | `closedoff_black_detail` | GET | `/closed-off/black/v2/one` | 单条黑名单详情及拉黑原因 |
| 35 | `closedoff_park_status` | GET | `/closed-off/overviewV2/parkStatus` | 园区当前在园车辆等总览 |
| 36 | `closedoff_company_base_info_page` | POST | `/system/companyBaseInfo/page` | 园区企业 ID 和名称分页 |
| 37 | `closedoff_waybill_page` | POST | `/closed-off/reservationGoods/selDigitalWaybillPage` | 危化品电子运单分页 |

## Tool 详细参数与提示词

下面的“Tool 提示词”来自当前 `src/specs.ts` 中交给模型的用途说明，并按文档格式整理，业务含义和枚举保持一致。统一回答规则只在 `persona.txt` 中定义，不再向 37 个 Tool description 重复追加。

表格中“必填”指 Tool 参数 Schema 的要求。时间字段虽然可能由网关补齐，但本文仍按当前 Tool 定义标注。

### 预警报警

#### 1. `closedoff_warning_page`

- 请求：`POST /risk-warning/riskWarning/page`
- Tool 提示词：预警报警分页查询。问“最近有什么报警/预警”“某车牌相关的报警”“还在持续的报警”等时使用。`warningType`：1预警、2报警、3事故、4事件；`warningStatus`：0正在持续、1已销警；`deviceType`：1车闸、2人闸、3IP广播、4GDS、5报杆箱、6摄像头、7预约屏。未指定时间默认最近 30 天。
- 结果关注点：记录标题、类型、级别、状态、企业、设备、车牌、描述、发生时间；空结果也要明确说明。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageIndex` | integer | 是 | 页码，从 1 开始 |
| `pageSize` | integer | 是 | 每页条数，Tool 提示建议不超过 20 |
| `warningType` | integer | 否 | `1`预警、`2`报警、`3`事故、`4`事件 |
| `companyId` / `companyName` | string | 否 | 公司 ID / 公司名称 |
| `title` | string | 否 | 标题 |
| `deviceType` | integer | 否 | `1`–`7`，含义见上方提示词 |
| `deviceCode` | string | 否 | 报警设备编号 |
| `controlAreaId` | string | 否 | 控制区 ID |
| `subModuleType` / `subModuleTypeName` | string | 否 | 模块子类型 / 名称 |
| `carNum` | string | 否 | 车牌号 |
| `description` / `keyWords` | string | 否 | 详细描述 / 关键字 |
| `warningStatus` | string | 否 | `0`持续、`1`已销警 |
| `warningStartTimeBegin` / `warningStartTimeEnd` | string | 否 | 报警开始时间范围 |

#### 2. `closedoff_warning_detail`

- 请求：`GET /risk-warning/riskWarning/one?id=<预警记录ID>`
- 参数：`id:string`，必填。
- Tool 提示词：按 ID 查询单条预警报警详情，包含处置和派发信息；先用 `closedoff_warning_page` 取得 `id`。
- 结果关注点：事件原始信息、当前状态、处置过程和派发信息。

#### 3. `closedoff_warning_count`

- 请求：`GET /risk-warning/riskWarning/countByWarningStatus`
- Tool 提示词：按预警状态统计报警数量，可按公司、设备类型和模块过滤。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `companyCode` | string | 否 | 公司编码 |
| `backFlowAlarm` | integer | 否 | `0`否、`1`是 |
| `deviceType` | integer | 否 | `1`–`7` |
| `subModuleType` | string | 否 | 模块子类型 |

#### 4. `closedoff_warning_module_list`

- 请求：`GET /risk-warning/riskWarningModule/getList`
- 参数：无。
- Tool 提示词：查询预警报警模块列表及模块类型、子类型字典；用户问“有哪些报警模块/类型”时使用。

#### 5. `closedoff_warning_count_by_level`

- 请求：`POST /risk-warning/riskWarning/countByWarningLevel`，body 为 `{}`。
- 参数：无。
- Tool 提示词：按预警报警等级统计红、橙、黄、蓝数量；用户问“各级别报警有多少”时使用。

### 预约审批

#### 6. `closedoff_reservation_approval_page`

- 请求：`POST /closed-off/reservation/approvalPageV2`
- Tool 提示词：查询企业或园区待审批预约。适用于“今天有哪些待审批预约”“某企业的预约审批进度”“危化车预约待审”。预约类型：1人员、2普通车、3危化车、4危废车、5货车；审批状态：0企业待审批、1企业通过、2企业不通过、3园区待审批、4园区通过、5园区不通过、6已过期；页面类型：0企业待审批、1企业已审批、2园区待审批、3园区已审批；当前状态：0未生效、1生效中、2已过期。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageSize` / `pageIndex` | integer | 是 | 分页 |
| `reservationType` | integer | 否 | `1`–`5`，含义见上 |
| `approvePageType` | integer | 否 | `0`–`3`，含义见上 |
| `beginTime` / `endTime` | string | 否 | 时间范围，默认最近 30 天 |
| `keywords` | string | 否 | 关键字 |
| `status` | integer | 是 | `0`–`6`，审批状态 |
| `currentStatus` | integer | 否 | `0`未生效、`1`生效中、`2`已过期 |
| `companyId` | string | 否 | 企业 ID |
| `inDeviceCode` / `outDeviceCode` | string | 否 | 授权入口 / 出口设备编码 |

#### 7. `closedoff_reservation_completed_page`

- 请求：`POST /closed-off/reservation/completedPageV2`
- Tool 提示词：查询已完成或已审批的历史预约；参数含义与审批分页相同，按 `status` 过滤审批阶段。
- 参数：与 `closedoff_reservation_approval_page` 完全相同，包括必填的 `pageSize`、`pageIndex`、`status`。

#### 8. `closedoff_reservation_stats`

- 请求：`GET /closed-off/reservation/statsV2`
- 参数：无。
- Tool 提示词：查询预约审批统计，包括今日待审数、今日已完成、平均处理时长、通过率，以及人员、普通车、危化车、危废车、货车的待审数。

#### 9. `closedoff_reservation_detail`

- 请求：`GET /closed-off/reservation/reservationProgressInfo/{id}`；`id` 作为 URL 路径参数并执行 URL 编码。
- 参数：`id:string`，必填。
- Tool 提示词：查询预约或车辆授权进度详情；先用审批分页工具取得 `id`。

`data` 为进度列表，每项的 `specificData` 结构由 `typeCode` 决定。模型与卡片只投影下表中已确认的字段：

| `typeCode` | 阶段 | `specificData` 结构与主要字段 |
| --- | --- | --- |
| `0` | 发起预约 | 对象；车牌、企业、预约类型、计划进出园时间、当前状态、有效期 |
| `1` | 企业审批 | 对象；审核状态、说明、人员、时间、有效期、是否抽检 |
| `2` | 园区审批 | 与企业审批相同 |
| `3` | 司机自检 | 自检项数组；项目、说明、方式、结果、备注、创建时间 |
| `4` | 园区抽查 | 抽查结果对象；结果、时间、创建人，以及嵌套的自检项数组 |

未知 `typeCode` 或未登记的嵌套属性不会进入模型结果。手机号等个人字段即使属于已登记结构，也会在投影前脱敏。

#### 10. `closedoff_change_record_page`

- 请求：`POST /closed-off/changeRecord/pageByReservationId`
- 参数：`reservationId:string`，必填。
- Tool 提示词：按预约 ID 查询变更记录或变更审批进度。

#### 11. `closedoff_today_reservation`

- 请求：`GET /closed-off/parkOverview/todayReservation`
- 参数：`companyId:string`，可选；为空时查询园区，填写时限定企业。
- Tool 提示词：查询今日人员、普通车、货车等各类预约数量；用户问“今天有多少预约”时使用。

### 车辆定位、轨迹与视频

#### 12. `closedoff_vehicle_track`

- 请求：`GET /car/carLocation/historyTrack`
- Tool 提示词：查询车辆历史轨迹与沿途设备组分析，返回某车牌在一段时间内的轨迹摘要、按路线先后排列的附近设备组和离散点驻留估算。适用于“某车今天走过的路线”“经过哪些设备组”“在哪里停留最久”。未指定时间时默认且最多查询最近 2 天，回答必须说明实际查询范围。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `vehicleNo` | string | 是 | 车牌号 |
| `startTime` / `endTime` | string | 否 | 最大 2 天的轨迹时间范围 |

业务轨迹 `data` 中，当前投影代码确认使用以下字段：

```json
[
  {
    "vehicleNo": "<车牌号>",
    "carType": 2,
    "points": [
      {
        "longitude": 106.0,
        "latitude": 29.0,
        "height": 350.0,
        "pointTime": "2026-09-04 08:30:00"
      }
    ]
  }
]
```

这不是完整业务响应 Schema，只是当前代码实际读取的轨迹字段。Tool 执行时还会自动调用一次 `closedoff_device_page`，详见[车辆轨迹的特殊执行逻辑](#车辆轨迹的特殊执行逻辑)。

#### 13. `closedoff_vehicle_location_page`

- 请求：`GET /car/carLocation/vehiclePage`
- Tool 提示词：分页返回某时间段有过定位的车辆及类型；用户问“最近有哪些车在园内活动过”时使用。未指定时间默认且最多查询最近 2 天。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageIndex` / `pageSize` | integer | 是 | 分页 |
| `carType` | integer | 否 | `2`普通车、`3`危化车、`4`危废车、`5`普通货车 |
| `vehicleNo` | string | 否 | 车牌号 |
| `startTime` / `endTime` | string | 否 | 最大 2 天 |

#### 14. `closedoff_vehicle_latest_positions`

- 请求：`GET /car/carLocation/latestInfoFromCache`
- 参数：无。
- Tool 提示词：返回所有在园车辆的最新缓存位置，包括车牌、类型、摄像头编码和经纬高。只在用户明确询问“现在”“当前”“是否在园”“在哪里”时使用；不能因“最近”“历史”“所有信息”自动调用。查某车时只分析目标车辆，并明确这是缓存最新值，不保证无延迟实时定位。

#### 15. `closedoff_vehicle_stream`

- 请求：`GET /car/carLocation/vehicleStream`
- Tool 提示词：查询某车牌某时间段的轨迹视频或抓拍视频流。用户问“某车的轨迹视频/抓拍画面”时使用。未指定时间默认且最多查询最近 2 天。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `vehicleNo` | string | 是 | 车牌号 |
| `startTime` / `endTime` | string | 否 | 最大 2 天 |

### 停车区、停车组和车位

#### 16. `closedoff_parking_area_page`

- 请求：`POST /hazardous-park/tParkingArea/page`
- Tool 提示词：查询停车区及车位总数、已停数；适用于“园区有哪些停车区”“重载区情况”。`parkingAreaAttribute`：1重载区、2空载区、3普通车。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageIndex` / `pageSize` | integer | 是 | 分页 |
| `keyWords` | string | 否 | 关键字 |
| `parkingAreaAttribute` | string | 否 | `1`重载、`2`空载、`3`普通车 |

#### 17. `closedoff_parking_group_page`

- 请求：`POST /hazardous-park/tParkingGroup/page`
- Tool 提示词：查询停车组及车位总数、已停、待停、火灾危险性分类；适用于“某停车区有哪些停车组”“还有多少空位”。`fireRisk`：1液化烃、2非烃甲类、3乙类、4丙类、5丁类、6戊类。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageIndex` / `pageSize` | integer | 是 | 分页 |
| `keyWords` | string | 否 | 关键字 |
| `parkingAreaId` | string | 否 | 停车区 ID |
| `fireRisk` | string | 否 | `1`–`6`，含义见上 |

#### 18. `closedoff_parking_space_page`

- 请求：`POST /hazardous-park/tParkingSpace/page`
- Tool 提示词：查询停车位；适用于“某停车组有哪些车位”“违停车位有哪些”。`parkingStatus`：0待停、1已停、2空余、3违停；`isItToxic`：0否、1是。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageIndex` / `pageSize` | integer | 是 | 分页 |
| `keyWords` | string | 否 | 关键字 |
| `parkingAreaId` | string | 否 | 停车区 ID |
| `parkingGroupId` | string | 否 | 停车组 ID |
| `isItToxic` | string | 否 | `0`否、`1`是 |
| `parkingStatus` | string | 否 | `0`待停、`1`已停、`2`空余、`3`违停 |

#### 19. `closedoff_parking_lot_list`

- 请求：`GET /hazardous-park/parkingLot/list`
- 参数：无。
- Tool 提示词：查询园区停车场列表；用户问“园区有哪些停车场”时使用。

### 门禁、区域、设备和控制区

#### 20. `closedoff_gate_access_page`

- 请求：`POST /hazardous-park/gateAccessRecord/getPage`
- Tool 提示词：查询门禁或卡口的人车出入记录和出入园时间；适用于“某车什么时候进的园区”“近期的门禁记录”。未指定时间默认最近 30 天。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageIndex` / `pageSize` | integer | 是 | 分页 |
| `carNumb` | string | 否 | 车牌号；注意字段拼写是 `carNumb` |
| `inDateBegin` / `inDateEnd` | string | 否 | 入园时间范围 |
| `outDateBegin` / `outDateEnd` | string | 否 | 出园时间范围 |

#### 21. `closedoff_district_page`

- 请求：`POST /closed-off/district/page`
- Tool 提示词：查询设备区域、园区道路或区域；适用于“园区有哪些区域/道路”“某主干道信息”。
- 参数：`pageIndex:integer`、`pageSize:integer` 必填；`keyWords:string` 可选。

#### 22. `closedoff_checkpoint_devices`

- 请求：`POST /closed-off/device/getCheckPointDevice`
- Tool 提示词：按区域分组查询授权出入口的闸机或摄像头；适用于“入口有哪些车闸”“出口摄像头”。`inOrOut`：1出、2入；`deviceType`：1车闸、2人闸、3IP广播、4GDS、5报杆箱、6摄像头。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `inOrOut` | integer | 是 | `1`出、`2`入 |
| `deviceType` | integer | 是 | `1`–`6`，含义见上 |

#### 23. `closedoff_device_page`

- 请求：`POST /closed-off/device/page`
- Tool 提示词：查询设备分页列表，包括设备组 `groupId/groupName`、设备名称、编号和设备组标绘点位。只在用户直接查询设备时使用；车辆轨迹 Tool 会自行取得设备组，不应重复调用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageIndex` | integer | 是 | 轨迹内部固定传 `1` |
| `pageSize` | integer | 是 | 轨迹内部固定传 `500` |
| `groupId` | string | 否 | 设备组 ID；轨迹内部留空以查询全部 |
| `deviceName` / `deviceCode` | string | 否 | 设备名称 / 编号 |
| `deviceType` | integer | 否 | `1`车闸、`2`人闸、`3`IP广播、`4`GDS、`5`报杆箱、`6`摄像头、`7`预约屏 |

当前轨迹和摄像头投影确认读取的设备字段：

```json
{
  "id": "<设备ID>",
  "groupId": "<设备组ID>",
  "groupName": "<设备组名称>",
  "deviceName": "<设备名称>",
  "deviceCode": "<设备编号>",
  "deviceType": 6,
  "status": 1,
  "deviceIp": "<设备IP>",
  "videoAddress": "<优先播放地址>",
  "accessAddress": "<备用播放地址>",
  "cameraCode": "<摄像机编码>",
  "lastHeartbeatTime": "<最后心跳时间>",
  "plottingConfigData": {
    "plottingData": "<包含 PointLayer.points[].position 的 JSON 字符串>"
  }
}
```

设备组按 `groupId` 聚合；设备按 `id`，缺失时按 `deviceCode` 去重。组内多个设备继承同一个设备组点位是正常情况。

#### 24. `closedoff_control_area_stats`

- 请求：`GET /closed-off/controlArea/getControlAreaTypeStatistics`
- 参数：无。
- Tool 提示词：统计各类型控制区数量、异常巡检数和报警数；控制区类型为 1核心、2关键、3一般。

#### 25. `closedoff_control_area_page`

- 请求：`POST /closed-off/controlArea/page`
- Tool 提示词：分页查询电子围栏或控制区，包括名称、类型和标绘数据；适用于“园区有哪些控制区/电子围栏”“核心控制区有哪些”。`controlType`：1核心、2关键、3一般；`controlName` 支持模糊匹配。
- 参数：`pageSize:integer`、`pageIndex:integer` 必填；`controlName:string`、`controlType:string` 可选，`controlType` 只能是 `1`、`2`、`3`。

#### 26. `closedoff_plotting_config_one`

- 请求：`GET /system/plottingConfigData/one?bizDataId=<电子围栏ID>`
- 参数：`bizDataId:string`，必填。
- Tool 提示词：按电子围栏 ID 获取三维标绘 JSON；先从 `closedoff_control_area_page` 结果取得围栏 ID。

### 通行记录与车辆综合信息

#### 27. `closedoff_access_record_page`

- 请求：`POST /closed-off/accessRecord/page`
- Tool 提示词：分页查询车辆或人员的通行记录，包括入园、出园时间、设备和类型；适用于“某车什么时候进园的”“近期的通行记录”。`typeList`：1人、2普通车辆、3危化车、4危废车。`inDeviceCode` 在 Tool Schema 中必填，提示称未知时可传空字符串；实际组包限制见[当前已知参数不一致](#当前已知参数不一致)。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageSize` / `pageIndex` | integer | 是 | 分页 |
| `inDeviceCode` | string | 是 | 入口设备编码 |
| `outDeviceCode` | string | 否 | 出口设备编码 |
| `carNumb` | string | 否 | 车牌；注意字段拼写 |
| `inDateBegin` / `inDateEnd` | string | 否 | 入园时间范围，未给时间时默认这一组最近 30 天 |
| `outDateBegin` / `outDateEnd` | string | 否 | 出园时间范围 |
| `typeList` | integer[] | 否 | `1`人、`2`普通车、`3`危化车、`4`危废车 |

#### 28. `closedoff_gate_records_by_car`

- 请求：`GET /closed-off/accessRecord/getGateRecordsByCarNum?carNum=<车牌>`
- 参数：`carNum:string`，必填。
- Tool 提示词：按车牌查询该车的出入记录，包括闸机名称和时间；适用于“某车的进出记录”。
- 当前页面卡片能兼容 `data` 中的记录再次包含嵌套 `data` 数组，并把明细合并展示；方向 `type=1` 显示为出园，`type=2` 显示为入园。

#### 29. `closedoff_vehicle_comprehensive_page`

- 请求：`POST /closed-off/comprehensive/getVehicleComprehensivePage`
- Tool 提示词：按关键字分页查询车辆综合信息，包括黑白名单、预约和授权状态。`validityStatus`：`-1`否、`0`白名单、`1`预约、`2`黑名单。适用于“某车牌的信息”“有哪些危化车”。
- 参数：`pageIndex:integer`、`pageSize:integer` 必填；`keyword:string` 可选，可用于车牌或企业关键字。
- 当前页面重点展示车牌、车辆类型、车牌颜色、挂车牌号、授权状态、通行次数、入园次数、出园次数、违章次数和黑名单次数；实际字段仍以接口 `data` 为准。

#### 30. `closedoff_vehicle_count`

- 请求：`POST /closed-off/comprehensive/getVehicleCount`，body 为 `{}`。
- 参数：无。
- Tool 提示词：查询车辆总数、黑名单数、预约数等统计；适用于“园区共有多少车辆”。

### 白名单与黑名单

#### 31. `closedoff_white_page`

- 请求：`POST /closed-off/white/v2/page`
- Tool 提示词：分页查询人员或车辆白名单；适用于“某车牌是否在白名单”“白名单有哪些”。`type`：1人、2车；`sourceType`：1个人申请、2企业申请、3园区申请；`currentStatus`：0未生效、1生效中、2已过期；`companyCheckStatus` 固定传 1。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageSize` / `pageIndex` | integer | 是 | 分页 |
| `type` | integer | 是 | `1`人、`2`车 |
| `sourceType` | integer | 否 | `1`个人、`2`企业、`3`园区申请 |
| `currentStatus` | integer | 否 | `0`未生效、`1`生效中、`2`已过期 |
| `realName` | string | 否 | 姓名 |
| `carCategory` | string | 否 | `2`普通车、`3`危化车、`4`危废车、`5`普通货车 |
| `parkCheckStatus` | integer | 否 | `0`待审核、`1`通过、`2`拒绝 |
| `companyCheckStatus` | integer | 是 | 固定 `1` |
| `companyId` | string | 否 | 企业 ID |
| `keyWords` | string | 否 | 关键字 |
| `validityBeginTime` / `validityEndTime` | string | 否 | 有效期；这两个字段未声明为自动时间范围，不会自动补齐或截断 |
| `inDeviceCode` / `outDeviceCode` | string | 否 | 授权入口 / 出口设备编码 |

当前白名单卡片优先展示车牌、人员、性别、脱敏身份证、脱敏电话、企业、来源、当前状态、有效期、企业与园区审核、提交人、脱敏提交人电话和提交时间。未在当前 `WhiteVO` 中证明的用途备注不会显示。

#### 32. `closedoff_white_detail`

- 请求：`GET /closed-off/white/v2/one?id=<白名单记录ID>`
- 参数：`id:string`，必填。
- Tool 提示词：按 ID 查询单条白名单详情；先用 `closedoff_white_page` 取得 `id`。

#### 33. `closedoff_black_page`

- 请求：`POST /closed-off/black/v2/page`
- Tool 提示词：分页查询人员或车辆黑名单；适用于“某车是否被拉黑”“黑名单有哪些”。参数含义与白名单分页相同。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `pageSize` / `pageIndex` | integer | 是 | 分页 |
| `type` | integer | 是 | `1`人、`2`车 |
| `sourceType` | integer | 否 | `1`个人、`2`企业、`3`园区申请 |
| `currentStatus` | integer | 否 | `0`未生效、`1`生效中、`2`已过期 |
| `realName` | string | 否 | 姓名 |
| `carCategory` | string | 否 | 车辆类别 |
| `parkCheckStatus` | integer | 否 | `0`待审核、`1`通过、`2`拒绝 |
| `companyCheckStatus` | integer | 是 | 固定 `1` |
| `companyId` / `keyWords` | string | 否 | 企业 ID / 关键字 |
| `validityBeginTime` / `validityEndTime` | string | 否 | 有效期；不会自动补齐或截断 |
| `inDeviceCode` / `outDeviceCode` | string | 否 | 授权入口 / 出口设备编码 |

#### 34. `closedoff_black_detail`

- 请求：`GET /closed-off/black/v2/one?id=<黑名单记录ID>`
- 参数：`id:string`，必填。
- Tool 提示词：按 ID 查询单条黑名单详情及拉黑原因；先用 `closedoff_black_page` 取得 `id`。

### 园区总览、企业和运单

#### 35. `closedoff_park_status`

- 请求：`GET /closed-off/overviewV2/parkStatus`
- 参数：无。
- Tool 提示词：查询园区实时状态总览和在园车辆按类型统计；适用于“园区现在整体情况”“在园车辆”。

#### 36. `closedoff_company_base_info_page`

- 请求：`POST /system/companyBaseInfo/page`
- 参数：`pageIndex:integer`、`pageSize:integer`，均必填。
- Tool 提示词：分页查询园区企业基础信息，包括企业 ID 和名称；适用于“园区有哪些企业”“某企业的 ID/名称”。

#### 37. `closedoff_waybill_page`

- 请求：`POST /closed-off/reservationGoods/selDigitalWaybillPage`
- 参数：`pageIndex:integer`、`pageSize:integer` 必填；`keyWords:string` 可选。
- Tool 提示词：分页查询危化品电子运单，包括单号、起运地、车牌和企业；适用于“某车的电子运单”“某企业的运单”。

## 车辆轨迹的特殊执行逻辑

`closedoff_vehicle_track` 并不是只发一个 HTTP 请求。当前执行器会并行发出：

```text
GET  /car/carLocation/historyTrack
POST /closed-off/device/page  { "pageIndex": 1, "pageSize": 500 }
```

执行结果遵循以下规则：

1. 轨迹请求失败时，直接返回轨迹失败结果。
2. 轨迹请求成功时，把设备查询的归一化结果放入轨迹结果的 `devices` 字段。
3. 模型不会接收全部原始点位 JSON，而会收到中文摘要：车辆、轨迹点数、实际时间、高度范围、附近设备组、起终点附近组、最长驻留估算和排除的超长采样间隔。
4. 完整轨迹和设备数据保存在 Tool 结果元数据中，供页面生成轨迹图、三维地图、设备组和摄像头弹窗。
5. 设备组到轨迹线的距离不超过 `trackDeviceRadiusMeters` 才进入分析；默认 `100` 米。
6. 最长驻留只累计相邻轨迹点都靠近同一设备组，且时间间隔不超过 `trackDwellMaxGapSeconds` 的连续段；默认 `300` 秒。
7. 设备组靠近轨迹不表示摄像头实际识别到车辆，驻留是离散定位点估算，必须结合抓拍或业务记录核验。

轨迹 Tool 的专用模型摘要模板由 `src/tools.ts` 生成，核心提示为：

> 完整点位和设备组已交给轨迹地图展示。请基于这些事实补充园区管理分析；设备组名称表示轨迹线附近点位，不等于设备实际识别到车辆，驻留时长是离散定位点的保守估算，需结合摄像头抓拍核验。

因此另一个 AI 复现轨迹能力时，不应再次调用 `closedoff_device_page`，也不应自行把设备组邻近解释为车辆识别事实。

## 通过 DSH 专用页面调用 Agent

如果另一个客户端希望复用“自然语言 → Tool 选择 → 接口调用 → 中文分析”全链路，可以调用专用页面 API。下面以默认 `routePrefix=/closedoff-qa` 为例；修改前缀后应同步替换。

### 发起对话

```http
POST /closedoff-qa/chat
Content-Type: application/json
Accept: text/event-stream

{
  "message": "查询车牌<车牌号>最近两天的轨迹",
  "conversationId": "closedoff-web-<UUIDv4>"
}
```

- `message` 必须是非空字符串。
- `conversationId` 可省略或传空字符串以创建新会话。
- 复用会话时，只接受 `closedoff-web-<UUIDv4>` 格式，不能传普通 DSH session ID。
- 同一会话正在回答时再次提交，返回 HTTP `409`。
- 返回 `Content-Type: text/event-stream`，每条消息格式为 `data: <JSON>\n\n`。

SSE 事件：

| `type` | 主要字段 | 含义 |
| --- | --- | --- |
| `conversation` | `conversationId` | 新建或恢复后的会话 ID；客户端应保存 |
| `thinking_snapshot` | `text`, `done` | 经脱敏、稳定语句发布和限频后的可展示思考完整快照；不是原始推理增量 |
| `delta` | `text` | 回合完成并执行整段脱敏后的最终回答文本；当前一次发送完整正文 |
| `tool_start` | `callId`, `name`, `presentation` | Tool 开始及稳定业务分组 |
| `tool_end` | `callId`, `status` | Tool 结束，`status` 为 `done` 或 `error` |
| `track` | `callId`, `points` | 轨迹点投影 |
| `cameras` | `callId`, `cameras` | 轨迹附近设备组及其设备 |
| `cards` | `callId`, `payload` | 业务结果卡片投影 |
| `media` | `callId`, `items` | 车辆抓拍媒体投影；媒体地址仅交给播放器 |
| `usage` | `usage` | 模型用量对象 |
| `error` | `message` | Agent 回合错误 |
| `done` | `reason` | 回合结束 |

最小 JavaScript SSE 客户端示意：

```js
const response = await fetch('http://127.0.0.1:<port>/closedoff-qa/chat', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  },
  body: JSON.stringify({
    message: '查询车牌<车牌号>最近两天的轨迹',
    conversationId: savedConversationId,
  }),
})

if (!response.ok || !response.body) {
  throw new Error(`chat failed: ${response.status}`)
}

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const frames = buffer.split('\n\n')
  buffer = frames.pop() ?? ''
  for (const frame of frames) {
    const line = frame.split('\n').find(item => item.startsWith('data: '))
    if (!line) continue
    const event = JSON.parse(line.slice(6))
    if (event.type === 'conversation') savedConversationId = event.conversationId
    if (event.type === 'delta') process.stdout.write(event.text)
    if (event.type === 'done') console.log('\n回合结束:', event.reason)
  }
}
```

### 恢复历史

```http
GET /closedoff-qa/history?conversationId=closedoff-web-<UUIDv4>
```

没有 `conversationId`、会话不存在或持久化中没有记录时返回：

```json
{ "history": [] }
```

历史项目包括用户消息，或助手的 `thinking`、`thinkingDone`、`text`、Tool 状态、轨迹、媒体、卡片、时间和完成状态。历史来自 DSH session event 投影，不是单独的业务聊天表；`thinking` 与实时 `thinking_snapshot` 使用相同的稳定语句发布和脱敏投影，原始模型推理事件不由该 API 返回，旧助手正文中的手机号、身份证号和媒体地址会再次脱敏。

### 停止当前回答

```http
POST /closedoff-qa/stop
Content-Type: application/json

{
  "conversationId": "closedoff-web-<UUIDv4>"
}
```

成功返回：

```json
{ "ok": true }
```

## 给另一个 AI 的建议系统提示词

下面是从当前 `persona.txt` 和 Tool 执行规则整理出的可移植版本。它保留业务行为，不包含 DSH 专属实现细节：

```text
你是封闭化管理查询助手，只能使用 closedoff_* 只读查询工具获取园区业务数据。

语言和事实：
1. 最终回答使用中文；时间统一为 yyyy-MM-dd HH:mm:ss。
2. 不展示 epoch 毫秒、Unix 时间戳或经纬度弧度等内部原始细节。
3. 不虚构数据。无法由工具确认的信息明确写“无法确认”。
4. 结构化卡片展示可核对事实；最终正文只写结论、异常、风险和建议，不重复卡片明细表格。

选择工具：
1. 只调用与问题直接相关的 Tool。用户明确“只查某模块”时，不扩展查询范围。
2. 同一回答回合内，同一查询和同一 Tool 最多调用一次；只有执行失败时才可重试，最多 3 次，并说明失败原因。
3. 用户提出新问题时重新查询所需数据，不复用上一回合业务结果。
4. 空结果直接说明未查询到，不用近似参数反复搜索。
5. 用户要求全量信息时，每个相关模块最多查询一次。
6. 空结果只在影响结论时说明；不要逐项复述工具选择和调用过程。

时间范围：
1. 普通时间查询默认且最多最近 30 天；轨迹、历史定位、轨迹视频默认且最多最近 2 天。
2. 使用网关返回的实际时间范围或 note，说明默认或截断后的范围。

车辆规则：
1. 询问车辆轨迹必须调用 closedoff_vehicle_track；历史定位、当前坐标或车辆综合查询不能代替轨迹。
2. closedoff_vehicle_track 已自动查询设备组，不要再调用 closedoff_device_page。
3. 轨迹附近设备组只表示空间邻近，不表示设备识别到车辆；最长驻留是离散定位点估算，需要结合摄像头抓拍核验。
4. closedoff_vehicle_latest_positions 只用于明确询问“现在、当前、是否在园、在哪里”；它是缓存最新位置，不是无延迟实时定位。
5. 查询某一车辆的当前位置时，不在正文枚举无关车辆。

回答要求：
1. 调用成功后，优先回答影响业务判断的结论、异常、风险和建议。
2. 关键数字注明来自园区业务接口。
3. 回答简洁、专业；已有结构化卡片时不再生成业务明细表格。
```

如果目标 AI 支持为每个 Tool 单独设置 description，应使用本文各 Tool 的“Tool 提示词”，把统一回答规则只放在系统提示词中，避免每个 Tool 重复放大相同要求。

## 调用检查清单

### 直接调用业务 HTTP 接口

1. 从受控配置读取网关和六个认证字段，不把凭据写入提示词或日志。
2. 完成第一阶段认证并确认 `data` 是非空 accessToken。
3. 完成第二阶段认证并取得 `tokenValue`、`tokenTimeout`。
4. 按 Tool 目录选择固定方法和路径；不要允许模型提供完整 URL。
5. 根据 GET query、POST JSON 或路径参数规则组包。
6. 应用时间格式和最大时间范围；分页 Tool 提供 `pageIndex`、`pageSize`。
7. 携带 `Authorization: Bearer <tokenValue>`。
8. 校验 HTTP 状态、JSON 根对象和业务 `success`。
9. 对业务 `errCode=1001/1003` 重新认证并只重试一次。
10. 保留原始 `data`，把传输失败与业务失败区分记录。
11. 按 Tool 提示词分析结果，不把邻近、缓存或估算表述成已证实事实。

### 复用 DSH Agent

1. 启动安装了本插件的 DSH `web` profile。
2. 向 `${routePrefix}/chat` 发送自然语言和可选 `conversationId`。
3. 持续解析 SSE，并保存首个 `conversation` 事件中的 ID。
4. 将 `thinking_snapshot` 作为默认收起的可展示思考完整快照，将 `delta` 作为最终回答；Tool 状态独立展示，不因思考折叠而隐藏。不要读取或转发 DSH 原始推理增量。
5. 收到 `done` 后结束当前回合；连接异常时不要盲目重复提交可能仍在执行的同一问题。
6. 使用 `/history` 恢复会话，使用 `/stop` 取消活动回合。

## 维护说明

本文件是面向集成方的手工参考，权威源仍是 `src/specs.ts`、`src/gateway.ts`、`src/tools.ts`、`src/config.ts` 和 `persona.txt`。新增、删除或修改 Tool 时，必须同步更新本文并核对 Tool 名、HTTP 方法、路径、参数、提示词和特殊执行逻辑。

需要把 Tool 目录交给其他程序处理时，可以在插件包根目录用 Node.js 直接导出机器可读 JSON：

```powershell
node --experimental-strip-types --input-type=module -e "import { TOOL_SPECS } from './src/specs.ts'; console.log(JSON.stringify(TOOL_SPECS, null, 2))"
```

该输出包含精确的 `name`、`desc`、`method`、`path`、`maxDays`、`timeRanges`、`pathParamKey` 和 `params`。它不包含公共回答提示词和 persona 纪律，因此集成方仍需同时读取本文的提示词章节。
