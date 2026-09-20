---
description: "面向封闭化园区业务的仓库外 DeepSeek Harness 只读问答插件包。"
kind: "package-bundle"
---

# DSH 封闭化管理智能助手

新站点优先使用[产物一键部署](../../../../../doc/first-deployment.md)，已有 Gitee 源码服务器使用[私有更新入口](../../../../../PRIVATE.md#源码一键更新)。插件的 `plugin.json` 管理启停和认证，业务 `env.conf` 独立保存；填写位置以 build 输出或已有实例引用为准，规则见[插件运行配置](../../../../../doc/plugin-configuration.md)。默认要求登录。

## 摘要

封闭化助手是「智能体群组」（`dsh-agents-group`）的一个子包，不是独立插件。它把封闭化园区接口封装成 37 个只读 Tool，为每个浏览器会话创建独立的 DSH Agent，并在群组前缀下的 `/agents/closedoff` 提供面向业务人员的问答页面、可展示思考、工具执行状态、数据卡片与车辆轨迹地图。群组负责装载、各 Agent 的页面前缀与授权标识，以及探针；本子包只负责自己的业务实现。

本包不修改 DSH 源码。DSH 负责模型、Agent Loop、Tool 调度、会话日志和 Web Server；本包负责业务知识、接口映射、私有业务配置、安全限制以及专用页面。

支持明确选择的独立运行和统一认证模式。启用认证后，页面通过 `/auth` 登录，全部业务 API 和工具要求 `closedoff:access`，历史对话按账号隔离；不安装 auth 时可使用独立模式。身份、存储及旧数据规则见 [认证与个人历史](doc/architecture.md#认证与个人历史)。

会话机制（Agent 生命周期、工具限制、事件投影、协作入口）由智能体群组的运行时 `packages/runtime` 代管，本包只提供一份 `src/definition.ts` 声明与业务实现。实时输出走官方 `agent/assistant-stream`，历史走 Session V3 的 message/attempt 记录展开，保留思考预览、工具提示、失败或取消的部分输出和首 token 时间；瞬时帧不写入持久日志。开发依赖与运行宿主均固定为 `0.1.6-alpha.2`，升级和回退约束见[宿主兼容说明](../../../../../doc/host-compatibility.md)。

## 对话模型

新会话使用 auth“模型设置”管理的框架默认模型，已有会话及分支恢复官方记录中的模型；服务重启不改变该规则。默认切换无需重启，模型目录、凭据与设置均由官方 DSH 提供。恢复依赖宿主的 `modelSelection` 投影，缺失或读取失败时明确报错。

输入框可选择官方目录中的模型，下一条消息发送时生效，回答期间不能切换。选择复用官方 `sessionController.selectModel()`，也会尝试更新宿主默认值，其他已有会话不随之改变。目录不可用或切换失败时保留用户输入并显示原因。

## 会话管理

桌面左侧常驻历史栏，与博客助手使用同一套历史组件；可收起、搜索标题、按最近活动时间分组、置顶、重命名、导出 Markdown 及多选删除。手机通过顶部“历史对话”打开抽屉。点击历史恢复问答，回答期间须先停止才能切换或新建。

第一条消息发出后先显示首句占位，再同步官方宿主生成的简短标题，不额外调用模型。标题可能晚于回答到达，侧栏在短时间内自动刷新；生成失败时保留首句。用户手动改名后，迟到的自动结果不会覆盖；随后在官方宿主再次手动更名仍会同步。旧历史不自动重命名。

删除复用既有会话归档流程，不删除园区业务数据或官方日志；导出仅包含问答正文。退出、账号切换或权限失效会清空侧栏及打开的导出窗口。

启用牛马聊天群（`dsh-butler-console`）后，可从统一入口委派封闭化查询。协作复用本插件的业务 Agent、只读工具、会话归属和登录身份；只向群聊返回脱敏正文、可展示思考快照及原生会话链接，不传递原始推理、工具参数或原始工具数据。群聊是可选插件，未安装时不影响原有问答入口。

回答正文按到达顺序上报增量，不等整轮结束；增量走与最终正文同一套脱敏，只发布不会再被后续增量改写的部分，因此页面上的字不会先出现再被改写。思考走业务页面同一套投影：脱敏、只含到句末为止的稳定语句、隐藏工具结果里的内部标识，并且只覆盖实时看到的那份，不引入落定 message 里的推理记录，废弃尝试的推理一并丢弃。原始推理增量、工具参数和原始工具结果都不上报。

会话打开并核验归属后，会先提供原会话入口，便于在查询中或停止后回看；该链接不代表查询已完成。

`/agents/closedoff?conversationId=closedoff-web-<UUIDv4>` 可打开指定会话（**页面前缀由群组推导**：群里是 `/agents/<id>`；只有独立运行本包时才是它自己的默认前缀 `/closedoff-qa`）。页面先验证身份，历史接口再校验会话主人；链接本身不授予访问权限。自定义 `routePrefix` 时使用对应入口路径。切换、新建或删除当前会话会同步地址中的 `conversationId`；刷新后恢复当前会话，或保持新会话入口。

closedoff 在 authenticated 模式接入 auth 的[会话管理](../../../../../doc/conversation-management.md)。本人对话按插件分类、筛选和分页；只读预览使用已有的脱敏消息转换逻辑，不恢复 Agent 或查询园区接口。批量移除使用官方归档，底层日志和独立分支保留。

运行、恢复与分支创建中的记录不可移除；失败项禁止继续发送，允许刷新重试。重启后 pending 转为可重试的 failed；旧数据不认领给新账号，standalone 历史不进入个人管理列表。索引 schema 4 保存标题来源并保留旧标题、归属、置顶与删除状态；从 schema 2/3 自动迁移，回退旧插件前须恢复兼容的数据备份，不能只替换代码。

## 目录

- [功能范围](#功能范围)
- [架构关系](#架构关系)
- [本地构建](#本地构建)
- [安装到 DSH](#安装到-dsh)
- [配置业务参数](#配置业务参数)
- [启动与访问](#启动与访问)
- [开发模式与正式模式](#开发模式与正式模式)
- [开发与升级](#开发与升级)
- [使用限制](#使用限制)

## 功能范围

- 预约审批、预警报警、车辆综合信息、出入记录、实时位置、历史轨迹、电子运单、黑白名单、停车区与设备等 37 个查询 Tool。
- 两阶段业务认证、token 内存缓存、鉴权失效后单次重试；修改私有配置后通过插件重载生效。
- `pageSize`、时间范围、请求体、响应体、接口超时、Agent 回合时长和并发会话限制。
- 时间字段按 Tool 声明的起止对处理，保留用户时分秒；长轨迹在保留首尾点的前提下最多向页面提供 800 个点。
- 每段车辆轨迹及其全屏视图在顶部突出显示结果中的车牌号，保留起止时间；实时结果与历史恢复使用同一车牌字段，缺失时显示“车牌未知”。
- 车辆轨迹 Tool 同时查询设备列表，按轨迹先后返回附近设备组、起终点附近设备组和最长驻留估算；完整点位与设备响应通过展示元数据交给页面，模型只接收已格式化的分析摘要。
- 电子围栏列表和单个围栏标绘 Tool 自动展示三维场景截图，可全屏交互并保存当前视角；实时结果与历史恢复共用轨迹的地形、3D Tiles、串行截图队列与资源释放。支持保存的围栏墙和多边形边界，保留完整坐标与围栏高度；无效或不支持的标绘明确提示，不补画边界。
- 同一回答的结构化结果按车辆概览、授权与名单、通行、轨迹、预约与运单、风险等业务主题聚合；卡片展示事实，最终正文只补充结论、异常、风险和建议。
- 专用 Agent 要求页面可展示的查询规划、工具选择、异常判断和结果分析使用中文。专用页面将经服务端脱敏、按完整语句发布并限频的可展示思考放在默认收起的独立行中；下方 Tool 状态常显且不受思考折叠影响。页面不发送不稳定的生成尾部或原始模型推理；存在结构化结果时还会移除最终正文中的重复 Markdown 表格。
- 完整回答底部提供与 DSH 对话页一致的复制、赞/踩、从该回合创建新对话、用量详情、耗时详情和完成时间。赞/踩写入 DSH 消息反馈 sidecar；创建分支复用截止该回合的持久事件，不修改原会话。
- 若查询结果已经返回但结论汇总被用户停止或连接中断，页面会保留结果并明确提示该轮已中断；历史恢复时沿用同一提示，不把空正文误显示成一次完整分析。
- 37 个 Tool 共用可校验的成功/业务失败/传输失败结果 envelope，并按当前代码证据声明 `data` 基数和主要业务字段；模型只会收到已声明且允许展示的字段（fail-closed），手机号、身份证号和媒体地址在进入模型或普通卡片前脱敏。
- “在园车辆最新位置”只用于明确的当前状态问题；该接口返回缓存最新值，不表述为无延迟实时坐标。
- 浏览器会话使用 `closedoff-web-<UUID>` 命名空间，服务端同时检查持久化的会话归属，不能读取其他用户或其他 DSH 会话。
- 达到进程内会话上限时只回收最久未使用的空闲 handle，不删除持久会话，也不打断正在回答的会话。
- 对话正文通过 DSH session persistence 保存；历史索引（归属、标题、置顶与移除围栏）落在 PostgreSQL 的 `dsh_conversations`，本地只留围栏镜像与待补写队列。服务重启或更换浏览器后登录相同账号可恢复个人历史。
- 存储未配置或连不上时本 Agent **未就绪**（`/agents/closedoff/ready` 返回 503 并说明配置方法），页面与探针照常在线；不存在其他存储后端，不会回退 SQLite。
- 页面资源均由本包本地提供，不依赖 CDN。
- 视频播放器默认开启 AI 识别框，并提供开启／关闭按钮；画框依赖视频流携带的 SEI 识别数据，开关只控制前端识别框显示，不启停后台算法。

## 架构关系

```mermaid
flowchart LR
  U[业务用户浏览器] -->|HTTP + SSE| W[本包 Web 路由]
  W --> M[群组运行时<br/>会话生命周期 + 存储端口]
  M --> A[DSH Agent + Agent Loop]
  A --> T[本包 37 个只读 Tool]
  T --> G[ClosedoffGateway]
  G -->|HTTPS| B[封闭化业务网关]
  A --> S[DSH Session Persistence]
  M --> D[(PostgreSQL<br/>dsh_conversations)]
  G --> C[插件私有 env.conf]
  W --> P[纯展示投影<br/>卡片/轨迹/历史]
  S --> P
```

详细职责和数据流见 [doc/architecture.md](doc/architecture.md)。

全部 37 个查询 Tool、业务接口、参数、响应、认证、配置和提示词见 [doc/tool-api-reference.md](doc/tool-api-reference.md)。

## 本地构建

要求 Node.js `^22.19.0` 或 `>=24.0.0`，并使用仓库锁定的 pnpm 11.19.0。

```powershell
Set-Location '<dsh-plugin-manager-gitee 仓库目录>'
pnpm install --frozen-lockfile
pnpm check --external --plugins agents-group
```

本包是群组 `dsh-agents-group` 的子包，**没有独立的构建入口**：构建与检查都通过群组完成。根 `check --external --plugins agents-group` 会先构建群组（含本子包），再执行类型、前端语法和行为检查；只构建时使用 `pnpm build --external --plugins agents-group`。子包单独的 `pnpm typecheck` 与 `pnpm test` 仍可在本目录执行，用于快速定位本包的问题。构建生成群组的 `dist/`，并把页面源码、固定为 `1.142.0` 的公共 CesiumJS、设备组标记图片、DSH 图标和 `@hy-media/video-player@0.0.37` 运行资源复制到本子包的 `web/assets/`。`index.html` 保留页面骨架，`app.js` 管理主交互，`trajectory.js` 管理地图、截图和摄像头播放器。轨迹地图和视频播放器均不使用公网 CDN。

`@hy-media/video-player@0.0.37` 的版本化 npm 包快照保存在本插件的 `vendor/`，本包通过相对 `file:` 开发依赖安装，不再访问原私有 npm 源。CesiumJS 和其余公开依赖仍从公共 npm 源安装。正式插件 `.tgz` 携带复制到 `web/assets/` 的播放器运行资源，不依赖仓库外目录。

## 安装到 DSH

以下用于手工维护 DSH profile；build 站点的安装由管理器自动完成。已安装 `dsh` 命令时，在已构建的本包目录执行：

```powershell
dsh plugin --profile web add .
```

从 `deepseek-harness` 源码运行时执行：

```powershell
$pluginRoot = (Get-Location).Path
Set-Location '<deepseek-harness 仓库目录>'
pnpm dsh plugin --profile web add "file:$pluginRoot"
```

上面的命令从已完成构建的插件包根执行，`$pluginRoot` 使用本机实际路径。直接使用官方 Bundle 时，配置路径和认证模式由自己的 patch 或环境设置；使用管理器时按后文统一启动，不混用两套安装流程。

该命令把本包作为 profile 依赖安装，并自动把 `cordis.patch.yml` 加入 `web` profile 的 bundle 层。无需改动 `deepseek-harness/packages/` 或官方 profile 模板。

## 配置业务参数

业务配置保存网关地址和两阶段认证参数。**本项目及其全部子 Agent 的配置统一在 [项目根 env.conf](../../env.conf)**，closedoff 的字段是其中的「封闭化 closedoff」段；子 Agent 不另建 env.conf。全新产物站点按 build 提示填写自动生成的 runtimeConfig 文件；站点部署时实际值维护在站点 `env.conf` 的 `DSH_PLUGIN_CONFIG.agents-group.closedoff`，构建时派生成运行配置文件。已有实例沿用当前配置路径，不覆盖配置文件。

Node 开发或独立运行时，可在仓库根新建 `.local/closedoff.deployment.json`，再通过下文的 `-Config` 指定；这份文件与 Docker 自动生成的部署配置分开：

```json
{
  "publicOrigin": "http://127.0.0.1:7903",
  "port": 7903,
  "dataRoot": ".local/data/closedoff-dev",
  "home": ".local/data/closedoff-dev/dsh-home",
  "artifacts": ".local/closedoff-dev/artifacts",
  "instances": {
    "closedoff": { "runtimeConfig": ".local/secrets/closedoff.env.conf" }
  }
}
```

该示例使用独立端口、数据与产物目录，workspace 和官方认证地址文件也由独立 dataRoot 派生。端口占用时同时调整 port 和 publicOrigin；现有实例应选择其原配置，不用它替换生产配置。

`env.conf` 包含 `CLOSEDOFF_BASE_URL`、阶段一 `clientId/clientSecret`，以及阶段二 `appCode/clientId/clientSecret/username`。插件每次激活时读取并校验该文件；缺失文件、空字段、非 HTTPS 网关地址都会使插件明确启动失败。

字段模板见[项目根 env.conf](../../env.conf) 的 closedoff 段；真实文件由用户维护，不进入 Git、tgz 或镜像。部署配置可以覆盖文件位置，启动时通过 `CLOSEDOFF_ENV_CONF` 传入路径。

## 启动与访问

专用业务 Agent 默认使用 `low` 推理等级，避免查询型任务继承 DSH 全局的高推理等级而产生冗长思考和额外等待；部署环境可用 `CLOSEDOFF_REASONING_EFFORT` 在 `off`、`low`、`high`、`max` 中调整。轨迹地图默认读取插件配置中的地形与 3D Tiles 地址。部署环境可分别通过 `CLOSEDOFF_TERRAIN_URL` 和 `CLOSEDOFF_TILESET_URL` 覆盖这两个地址，并通过 `CLOSEDOFF_TILESET_HEIGHT` 设置模型沿椭球法向的高度偏移（米）；默认值为 `60`。

`CLOSEDOFF_TRACK_DEVICE_RADIUS_METERS` 设置设备组到轨迹线的最大距离，默认 `100` 米；`CLOSEDOFF_TRACK_DWELL_MAX_GAP_SECONDS` 设置驻留估算允许累计的最大相邻采样间隔，默认 `300` 秒，超过该值的间隔按定位中断排除。正文三维视图和三维弹窗都根据轨迹、起终点和筛选后的设备组自动计算完整取景范围。

浏览器必须能直接访问目标服务，目标服务也必须允许跨域读取。更换数据集或定位采样策略时必须重新标定高度、设备组距离和驻留间隔，不能照搬当前默认值。

服务器部署执行所选部署方式的 build 脚本。本地 Node 开发使用下一节的统一启动脚本，它从运行配置解析业务文件路径。

直接运行已经安装的 profile 时，设置的只是配置文件路径，正式值仍从文件读取：

```powershell
$env:CLOSEDOFF_ENV_CONF = (Resolve-Path '<用户配置目录>\env.conf').Path
dsh --profile web
```

浏览器打开 DSH 输出的 Web 地址，再追加**群组给的入口** `/agents/closedoff`（独立运行本包时才是 `/closedoff-qa`）。例如 DSH 显示 `http://127.0.0.1:<port>/` 时，群里访问 `http://127.0.0.1:<port>/agents/closedoff`，独立运行时访问 `http://127.0.0.1:<port>/closedoff-qa`。

## 开发模式与正式模式

以下为本地 Node 宿主的 development/release 模式，不是服务器 source/archives 来源选项。切换前先停止该开发实例的 DSH 服务，然后在仓库根目录执行：

```powershell
# 开发模式：link 安装并加载 HMR patch
.\deploy\scripts\start.ps1 -Plugins auth,closedoff -Config .local/closedoff.deployment.json -Mode development

# 正式模式：tgz 发布快照安装，不加载开发 patch
.\deploy\scripts\start.ps1 -Plugins auth,closedoff -Config .local/closedoff.deployment.json -Mode release -HarnessRoot deepseek-harness
```

开发模式默认查找插件主仓内部的 `deepseek-harness` 官方子模块；发布模式也可显式选择该源码宿主，否则使用已安装的 dsh。目录布局不同时传入仓库位置：

```powershell
.\deploy\scripts\start.ps1 -Plugins auth,closedoff -Config .local/closedoff.deployment.json -Mode development -HarnessRoot '<deepseek-harness 仓库目录>'
```

开发模式会以 `link:` 方式接入 DSH，并通过 [dev/dev-hmr.patch.yml](dev/dev-hmr.patch.yml) 启用 Cordis 模块 HMR。再打开另一个终端，在插件包根目录启动持续构建：

```powershell
pnpm dev
```

此后修改 `src/` 下的 TypeScript 文件会重建 `dist/index.mjs`；修改 `web/index.html`、`web/app.css`、`web/trajectory.js` 或 `web/app.js` 会同步第一方页面资源并刷新服务端持有的插件。Cordis 只卸载并重新加载本插件，不重启 DSH 进程。页面文件不是浏览器 HMR 模块，因此修改页面后仍需手动刷新浏览器，但不需要重启服务。

HMR 会释放旧插件注册的路由、Agent 和正在响应的 SSE 流，开发时应在智能体空闲时保存代码。修改 `package.json`、依赖、Bundle 列表或安装版本仍需重启；profile 与 home 的 `cordis.patch.yml` 配置继续由 DSH 自身热加载。

正式模式会先生成 `.tgz` 发布快照，将其保存到主仓的 `.local/artifacts/<操作ID>/plugins/`，再从该快照安装本包，不加载开发 HMR patch，也不指向开发工作区。开发模式和正式模式共用 profile、模型设置与用户维护的运行配置；切换只改变依赖来源及启动 patch，不修改 DSH 主仓源码。跨模式切换需要一次服务重启，此后开发模式内的普通源码与页面改动不再需要重启。

## 开发与升级

构建和检查使用[本地构建](#本地构建)的命令。开发 link 安装在重新构建后生效；手工快照安装须更新包并重启。**发布走群组，不单独发布本子包**：在仓库根执行 `pnpm package --external --plugins agents-group`，认证站点还需交付 auth，完整选集和部署步骤见[私有集成说明](../../../../../PRIVATE.md#本地集成公共更新)。

仅在发版时按版本规则更新本插件 `package.json`，提交源文件、文档与必要锁文件；真实 `env.conf` 留在用户配置目录，不提交 `dist/`、`web/assets/` 等生成物。播放器升级时更新本插件 `vendor/` 快照和对应 `file:` 依赖，确认没有有效引用后再移除旧快照。

DSH 上游升级时，先在单独测试 profile 中安装本包并运行 `--dump-default-config` 或启动冒烟；只有 DSH 插件 API、session event、bundle patch 或 Web Server API 改变时才需要调整本包。正常业务 Tool 增减只修改本包。

`tests/agent.test.ts` 使用真实 Cordis 作用域验证新建对话的服务注入；`llm` 必须包含在插件导出的 `inject` 中。浏览器历史栏可运行 `node tests/history-browser.mjs`，需要当前环境已安装 Playwright 及浏览器；可通过 `DSH_TEST_PLAYWRIGHT` 指定其模块入口、`DSH_TEST_BROWSER=msedge` 使用已安装的 Edge、`DSH_TEST_OUTPUT` 指定截图目录。该检查使用真实页面和 HTTP 替身，不访问模型或园区服务，正式验收仍需发送真实问题并检查工具结果。

业务前后端升级后还应重新核对 `src/specs.ts` 的 `result`：先确认接口的 `data` 是列表、对象、内嵌分页对象还是未定结构，再核对模型分析所需字段。对象允许服务端增加字段，已知字段也不要求每条记录都存在；没有源码或脱敏响应证据的接口保持 `unknown`，不能按接口名猜测并收紧。

预警模块字典 `closedoff_warning_module_list` 返回字符串字段 `id`（字典记录标识）、`name`（模块名称）和 `code`（模块编码）；模型保留这三个字段，普通卡片只展示名称与编码。该查询无分页参数，返回条数表示本次接口提供的模块条数，不代表报警数量；不能把 `code` 直接当作其他查询的 `subModuleType` 参数。

设备、地图或播放器需要但不应提示给模型的字段登记在 `result.runtimeFields`。常用业务 Tool 继续使用 `src/presentation.ts` 的显式展示定义；没有显式定义的 Tool 只从自身 `result.fields` 按声明顺序生成通用卡片，并采用该 Tool Schema 的字段说明作为标签。opaque ID、媒体、标绘配置、轨迹点和嵌套原始数据不会自动进入卡片；接口确有数据但没有安全可展示字段时，页面明确提示该状态，不生成空白“记录”卡片。

文档和命令示例不得写入开发者电脑的盘符或用户目录；使用仓库相对路径、当前目录命令或 `<插件包目录>` 一类明确占位符。

## 使用限制

- 当前 37 个接口全部是查询接口；本包没有审批、放行、删除或其他写操作。
- `baseUrl` 必须是 HTTPS。服务端只访问 Tool catalog 内声明的固定路径，不接受模型或浏览器传入任意 URL。
- Agent 的自然语言答案可能产生解释错误；关键审批、报警处置和车辆管控决定必须回到业务系统核验。
- 查询详情所需的 opaque ID 可以保留给模型完成后续只读调用，但不会进入普通卡片；未知响应字段、完整手机号、身份证号和媒体地址不会进入模型可见结果。
- 轨迹页面展示接口返回的轨迹点，并按设备列表中的 `groupId` 聚合已标绘设备组；没有有效标绘点或到任一轨迹线段的最短距离超过配置阈值的设备组不会显示。轨迹连线只连接离散历史点，不代表业务系统提供了连续定位。
- 轨迹 Tool 内部只查询一次设备列表，并把附近设备组按其最接近的轨迹线段排序。最长驻留位置只累计首尾点都落在同一设备组配置半径内、且相邻采样间隔没有超过配置上限的连续时段；这是离散定位点估算，不是停车事实，需用摄像头抓拍或业务记录核验。
- 问答正文自动显示 Cesium 三维场景截图；多条轨迹按队列逐张生成，任一时刻最多创建一个临时 Viewer，截图完成后立即销毁以释放 WebGL 资源。正文截图与大屏弹窗使用同一套地形、3D Tiles、轨迹、设备组、完整取景和模型精度。用户点击“全屏查看”后可交互操作独立 Viewer；弹窗当前视角的三维瓦片完成可见渲染后，可点击“截图并保存”把 PNG 保存到本机，保存操作不会销毁或改变弹窗 Viewer。
- 点击三维地图中的设备组标记或右侧设备组名称，会打开该组的摄像头详情。详情只包含 `deviceType = 6` 的摄像头，不展示 IP 广播或电源保障终端；设备接口返回 `videoAddress` 或 `accessAddress` 时使用园区定制播放器播放，两个字段都缺失时明确展示无可用视频地址。页面在收到含有效流地址的设备组后利用浏览器空闲时间预热本地播放器运行资源，视频流仍只在用户打开摄像头详情时连接。
- 轨迹地图直接使用公共 CesiumJS `1.142.0` 加载地形和 3D Tiles，并使用其本地 `NaturalEarthII` 默认底图，不依赖 `@prism-next/core`。默认底图不是园区卫星影像；模型周边出现绿色区域不等于 tileset 未加载，当前提供的地形和 3D Tiles 地址之外还缺少业务系统使用的卫星影像图层。要复现业务系统中的连续地表画面，必须另行取得并配置该影像服务。
- 地形与 3D Tiles 由外部数据服务提供。页面在 tileset 加载后先应用可配置高度偏移，再飞到模型，并保持地形深度检测开启。`layer.json` 可访问不代表地形可用；排障时还应抽查其声明的 `.terrain` 瓦片。CesiumJS 不能修复数据服务的 404、跨域、证书错误或缺失的数据内容。
- 开发依赖固定在 DSH `0.1.6-alpha.2`，兼容范围以 package.json 为准。DSH 仍处于 alpha 阶段，升级前必须执行本包检查和隔离 profile 冒烟。
