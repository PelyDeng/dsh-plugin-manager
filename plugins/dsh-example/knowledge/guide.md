<!-- Generated from plugins/dsh-example/knowledge/guide.md.tmpl by scripts/version.mjs; edit the template. -->

# 开发者接入 FAQ

适用：框架 0.13.1（manager、kit、auth、example 同一发布版本）；宿主以 gitlink 为准。本文是知识快照，不证明远程站点已升级。

## 如何按插件管理会话，删除前能先预览吗？

登录 `/auth` 的“会话管理”，按插件分类、标题或 ID、更新时间和状态筛选。只管理本人拥有且仍有插件权限的会话，管理员也不获得他人聊天。

点击标题或“预览”打开只读抽屉，最近 30 条消息可向前加载，思考和工具折叠；不启动模型、不恢复任务、不改更新时间。关闭保留筛选和勾选，“选中待删除”只勾选。

确认后批量移除当前插件所选 1–100 条，底层日志保留，无恢复入口；不释放磁盘或删除业务数据。运行中会话被阻止，失败可重试，“仅插件已移除”的旧记录可补齐官方归档。

开发使用 kit 的 `registerConversations`（protocol 1）提供 list、preview、remove，插件保留 owner 与生命周期，复用官方 `workspaceRegistry.archiveSession`。详情与源码入口见 `doc/conversation-management.md`；勿用 ID 前缀认领用户或让 auth 直读业务库。

## Auth 登录后，根路径为什么仍提示认证？

`dsh web authentication required; reopen the URL printed by dsh web.` 是官方控制台认证提示，不是模型密钥错误。插件 Auth 账号用于 `/auth` 及已授权应用；官方控制台根路径 `/` 使用自己的启动令牌和浏览器 Cookie；API 密钥用于调用模型。这三者独立，登录插件不会自动登录官方控制台。

普通用户从 `/auth` 进入应用。维护者在服务器私有终端读取 `.local/data/dsh-web-auth-url.txt`，在本人浏览器打开完整地址；校验后设置 Cookie 并跳转 `/`。自定义 dataRoot/authUrlFile 时按 `.local/deployment.json` 查路径。

重启会更新令牌，旧书签或 Cookie 失效后重新读文件。新地址仍失败时核对 publicUrl/publicOrigin 及代理的查询参数、Host、Cookie 转发。不要关闭认证、公开 token 或拿它替代应用授权。

## 控制台能打开，但模型和插件报 HTTP 403 怎么办？

如果通过官方认证地址进入后，页面显示“连接异常”，模型接口（如 `/api/llm/listProviders`）返回 403，先检查公网域名是否加入官方 DSH 的 `trustedHosts`。`publicUrl` 决定认证地址，`publicOrigin` 声明应用访问来源；仅设置它们不会自动允许该域名调用官方控制台 API。

在私有 `.local/env.conf` 填写以下字段，保留已有设置。域名仅为示例；旧站点先由部署入口导入配置，显式旧JSON仍使用publicUrl/publicOrigin/trustedHosts字段。

```ini
DSH_PUBLIC_URL=https://dsh.example.com
DSH_PUBLIC_ORIGIN=https://dsh.example.com
DSH_TRUSTED_HOSTS=["dsh.example.com"]
```

`trustedHosts` 填主机名，不带 `https://` 或路径；如需限定端口，填写与请求 Host 一致的 `主机名:端口`。保留已有信任项，不使用通配域名或关闭认证。通过仓库正常部署入口应用配置并受控重启；重启后读取当前认证地址，再检查模型、插件和工作区是否可用。真实域名属于站点配置，不写入公共模板。

403 也可能来自反向代理或 Origin 校验：如果仍失败，核对代理是否正确转发 Host、Cookie，以及请求 Origin 是否与访问地址一致。401 是认证未通过，与这里的 Host 信任检查不同；健康接口 200 不能证明控制台 API 正常。

## 运行内置应用应选择什么宿主？

完整源码部署使用仓库 gitlink 对应的 DeepSeek Harness，并在宿主目录按自己的 packageManager 和锁文件安装、构建。源码版本号不等于同名 npm 包已发布，不能把历史 SDK 依赖版本当作当前运行宿主。Node CLI 可通过部署配置的 harnessRoot 指向已准备的宿主源码目录；已安装的兼容宿主则使用 dshCliJs，二选一。默认密钥管理需要官方 credentials 服务和 credentials-local 存储；具体步骤见图文接入手册。

## 第一次如何配置或更换 API 密钥？

根 env.conf 已填写固定非秘密默认值，真实配置只填 Git 忽略的 .local/env.conf；密钥、仓库账号密码和生成项继续留空。常用地址、信任域名、DeepSeek/智谱密钥排在前面；插件业务配置各自维护。

文件 DEEPSEEK_API_KEY/ZHIPU_API_KEY 非空时，以文件为准，只注入官方DSH子进程，网页只读；修改后正常部署并受控重启。留空不添加覆盖、不删除官方凭据、不清除继承环境密钥。官方来源顺序为进程环境、.credentials.yaml、工作目录.env、home.env；已有环境覆盖时仍只读，没有覆盖时继续网页管理。

管理员完成初始改密后，在 /auth “模型设置”的 DeepSeek 或智谱 GLM 卡片管理对应密钥，桌面每行最多两张、手机单列。页面仅返回状态及 SHA-256 指纹，不返回密钥。脚本仅支持 DeepSeek：在源码仓库执行 `bash deploy/scripts/set-api-key.sh --config .local/deployment.json`，隐藏输入，不将密钥放入参数。独立工具使用 `dsh-plugin-manager set-api-key --root <交付根> --config <部署文件>`，需已安装兼容官方 CLI 及正确数据所有者。文件管理的 DeepSeek 会拒绝脚本写入。

网页与脚本复用官方凭据服务及文件锁，保留其他凭据、账号和历史。写入官方存储时默认无需重启，宿主监听加载；自定义存储或关闭监听时使用网页。Compose脚本确认活动容器/home后以容器用户执行，Linux凭据文件0600。文件覆盖不会导入.credentials.yaml，原值仍需保存在私有文件供宿主调用，不能仅保存指纹。

API Key不创建模型路由、不选择默认模型，也不验证额度；智谱需要在同一宿主的官方设置或patch配置路由和ZHIPU_API_KEY引用。已有site.json/deployment.json自动导入时保留原文件与路径；生成deployment/Compose不手改，恢复保留原env及凭据投影，不能用新密钥恢复旧操作。

## 密钥已填、探针 200，为什么仍不能回答？

在“模型设置”刷新状态和指纹，核对当前实例的 home、`.local/deployment.json` 及是否有遗留 `DSH_HOME`/`DSH_DATA_DIR` 路径覆盖；检查是否显示外部环境只读。然后核对默认模型是否使用已配置且可用的提供方，以及是否仍使用默认 `DEEPSEEK_API_KEY` 引用。写入官方存储默认无需重启，修改框架env需受控重启；改变默认模型后新建对话，旧会话保留创建时的模型选择。根据具体错误检查密钥有效性、余额/配额、限流和服务器网络。健康探针不调用模型，不能证明真实问答成功。

密钥是站点维护者配置的宿主凭据，不是每个 Auth 用户单独提供。更换密钥不清空账号或历史；文件模式重启前应等待正在进行的回答结束。保留 `.local/data`、`.local/artifacts` 和备份，不用删除 `.local` 或空数据初始化排错。模型尚未可用时，首页“阅读 FAQ（无需模型）”仍可直接阅读本页；快捷提问生成回答需要模型。

## 这个仓库是什么？

基于 DeepSeek Harness 的 AI 应用开发与部署框架。作者沿用官方 Cordis、Bundle 和 Agent，在自己的仓库开发插件；框架提供统一打包、安装、配置、启停及可选认证。

官方 DSH 负责插件、Agent、模型、工具及会话；框架补充声明、交付、配置、部署和可选账号授权。无需修改宿主源码，但作者仍编写接入声明和鉴权代码。

| 模块 | 复用什么 | 不替作者做什么 |
| --- | --- | --- |
| plugin-manager | 内外包发现、build/check/pack、清单组合、安装、配置与启停 | 不执行业务开发，不是插件市场或代码沙箱 |
| plugin-kit | 可信身份、受保护 HTTP、工具鉴权和应用登记 | 不自动保护绕过 kit 的路由，不判断部门数据范围 |
| dsh-auth | 登录、账号、会话、逐应用授权 | 不替代官方控制台认证，不提供完整企业 SSO |
| dsh-example | 开发者答疑、流式对话、个人历史和停止生成示例 | 不提供销售查询或知识库检索业务 |

个人工具可直接使用官方 Bundle；多插件交付可用管理器。安装更新走 CLI，auth 不提供插件市场或在线升级。作者维护声明与兼容性，按需接入 kit；任意社区插件不保证直接兼容。

## 第二个应用到底少写什么？

已有知识库助手再加销售助手，复用 auth 登录、kit 身份和 manager 交付；作者仍写检索/销售接口、指标、图表、工具、提示词及业务数据权限。

模型仅提出查询参数；服务端从可信 actor 取得身份、限定数据范围，不能将模型给出的 userId 当授权依据。应用许可与业务数据许可分别检查。

第二应用复用同一认证，kit 升级仍需重打包。销售场景只是设计例子；independent-access-example 只返回身份，不证明销售查询、图表或节省工时。

## 选择哪种接入？

1. **普通官方 Bundle**：只需 DSH 的插件能力，用官方 package.json 的 dsh.bundle.patch 和 Cordis patch；无需 kit/manager。
2. **受管交付**：保留 Bundle，增加 deepseekPlugin schema 3 声明、build/check 脚本、README 和 files。管理器读取声明，无需维护中央插件名单。
3. **可选统一认证**：再声明 configuration.auth=consumer，接入 kit 的 createAccess/createPluginHttp 或工具鉴权，并在部署候选集合选入 auth。仅写声明不会获得保护。

内部开发扫描 `<框架根>/plugins/*`。外部支持独立 pnpm 单包：显式 `--root <作者包根> --package .`，只接受 `.`，不能同时传 --plugins；不会自动扫描外部 workspace。外部清单 2 只支持 release，内部清单 1 继续支持 release 和 development/link。页面、Agent、Tool、探针、kit 都不是受管包的必选功能。

## 工具从哪里来？

本助手可检索随包 manager、kit、auth、example、部署与集成源码，引用路径和行号。构建快照不含私有业务或真实配置，也不证明生产执行成功。

pack 只记录构建输入；最终 tgz 经测试后，用 `compose-release --verification-report <JSON>` 附加报告。安装时展示宿主、平台和组合的已测、未知或差异，不因版本不同禁止安装，也不把模型替身当真实模型。格式见 manager 的 VERIFICATION.md。

需要 Node.js `^22.19.0 || >=24`、pnpm 11.19.0、tar。包名不代表公共 npm 已发布；从可信维护者取得 manager/kit tgz并核对摘要，或按作者指南构建明确提交。只有 tgz 不等于完整离线依赖。

在独立工具目录安装：`pnpm add --ignore-workspace <manager-tgz绝对路径>`，以后在该目录执行 `pnpm exec dsh-plugin-manager ...`。不要在任意目录假设全局命令可用。作者包根的 package.json、pnpm-lock.yaml 与工具目录分开。

## 内部与外部如何构建交付？

内部：在框架根先 `pnpm install --frozen-lockfile`，执行 `pnpm list:plugins`。交付 auth 和 example：

```sh
pnpm package --plugins "auth,example" --output .local/artifacts/release-v1
```

输出目录必须为空或不存在。日常 `pnpm check --plugins example` 做构建、类型和语法检查；业务回归另行执行 test。省略 --package 保留内部扫描、默认选集和 all/none/指定 ID；根 build/check 的默认范围是 all，源码 package 默认按 defaultEnabled 选取，安装现成清单默认选清单全部。

外部：复制最小 examples/standalone-plugin 或完整 plugins/dsh-example 到作者自己的包根。完整 example 需替换 kit 的 workspace:* 为版本化 tgz 开发依赖，保留 tsdown 内嵌 kit，替换引用原仓库的 clean 脚本；test 中框架专用集成测试应留框架，独立项目保留自身行为测试。在作者根运行 `pnpm install --ignore-workspace`，提交作者锁文件。在工具目录运行：

```sh
pnpm exec dsh-plugin-manager list --root <作者包根> --package .
pnpm exec dsh-plugin-manager pack --root <作者包根> --package . --output .local/release-v1
```

list 只读声明，不要求锁文件；check 会先 build；pack 冻结安装作者根锁文件，然后各执行一次 build/check 再打包，无需先重复 check。外部任务忽略父 workspace。不要声明 prepare/prepack/postpack 重复构建。发布目录包含 manifest.json 和摘要命名 tgz，一起交付，不能仅移动清单。运行依赖不能带 workspace:/file:/link: 或本机绝对路径；本地 kit 是构建依赖并内嵌。作者源码可以不在部署机器上。

## 最小声明是什么？

package.json 至少有 name/version、main、files、scripts.build/check、dsh.bundle.patch、deepseekPlugin.schemaVersion=3 和 id；包内有 README、Bundle 以及构建后的入口。下面仅为接入字段片段，不是完整 package.json：

```json
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "deepseekPlugin": {
    "schemaVersion": 3, "id": "sales",
    "entryPath": "/sales", "healthPath": "/sales/ready",
    "permissions": ["sales:access"],
    "configuration": { "entryId": "sales", "auth": "consumer" }
  }
}
```

entryId 对应实际 Cordis patch 条目，不必与插件 ID 相同。healthPath 可省略；提供时实现公开 GET 就绪探针，返回 200 或依赖不可用时 503，不返回秘密、不调用付费模型。无探针的 not-provided 不代表业务就绪。

## 如何增加页面、Tool 或 Agent？

页面注册到官方 WebServer；需要身份的路由通过 kit，而非普通公开注册。接入核心示意（假设 ctx/config 已由官方插件 apply 提供）：

```ts
const access = createAccess(ctx, { pluginId: 'sales', mode: config.accessMode, publicOrigin: config.publicOrigin })
const http = createPluginHttp(ctx, { access, routePrefix: '/sales' })
ctx.effect(() => http.register({ kind: 'exact', path: '/sales/identity', handler(_req, res, actor) {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ userId: actor.userId }))
} }))
```

import 来自 `@dsh-plugin-manager/plugin-kit`，完整可运行实例见 examples/standalone-kit。Tool 使用官方 ToolDefinition；需要认证时参照 kit/tools 的 createPluginTools/guardTool，声明权限并将工具名加入 Agent 白名单。不要猜测未提供的工具签名，应查当前安装版本导出与示例。Agent 使用官方 ctx.agents 与默认模型选择，systemPrompt.section 注入提示，tools.restrict 限制能力。example 的白名单仅含随包公共源码检索和阅读工具，不能执行命令、读取服务器文件或访问销售系统。

## 复制 example 需要改哪些名字？

同步修改 npm 包名、deepseekPlugin.id、displayName、entryPath/healthPath、permissions、configuration.entryId、Bundle 的 name/id、默认 routePrefix、会话 ID 前缀及校验正则、systemPrompt section 名、页面建议问题与知识文件、测试。不要复用 example 的历史库。kit 不复制源码，继续通过包名导入并内嵌。

如果改成销售助手，替换两份知识和固定开发者职责提示；config.systemPrompt 只是部署补充，不能单靠它把内置开发者知识变成其他业务。复制时保持官方启动方式，不另写应用服务器 bin。

## 部署者收到什么，如何启动？

收到各应用完整发布目录、manager 工具及摘要、经应用验证的官方宿主版本/获取方式、公开配置模板和交付说明。使用者无需作者 Git 仓库。把分项归档放在 `<交付根>/incoming/`，在工具目录组合真实示例：

```sh
pnpm exec dsh-plugin-manager compose-release --root <交付根> --output releases/site-v1 --manifest incoming/base/manifest.json --manifest incoming/second/manifest.json
```

base 是内部 auth+example 的清单，second 是 independent-access-example 的清单。组合只读取校验并复制归档，不执行作者代码。重复 ID/包名要选择一个版本，不能直接叠加旧整站包和同 ID 新包。

在交付根创建 .local/deployment.json，示意如下；dshCliJs 必须替换成已安装官方 CLI 绝对路径：

```json
{
  "manifest": "releases/site-v1/manifest.json", "plugins": "all", "mode": "release",
  "home": ".local/data/dsh-home", "dshCliJs": "<官方CLI绝对路径>",
  "port": 7902, "publicOrigin": "http://127.0.0.1:7902"
}
```

在工具目录执行：

```sh
pnpm exec dsh-plugin-manager start --root <交付根> --config .local/deployment.json --plugins all
```

start 前台运行，保留终端；另开工具目录终端执行 health（同 root/config）。打开 origin/auth，首次 admin 使用初始密码 123456，强制改密后重新登录；创建普通账号并授予 example/第二应用权限，再访问 /example 或第二应用入口。官方控制台有另一套认证地址；不要把它的 token 发到公开提问中。

安装成功、宿主监听、应用探针 200、真实问答完成是四个不同结果。example 问答还需在同一 DSH_HOME 配置官方默认模型与密钥；插件不保存模型密钥，模型失败先查宿主设置。

管理器启动打印认证地址文件位置，默认 `<交付根>/.local/data/dsh-web-auth-url.txt`；仅在本机编辑器读取并访问其中官方控制台地址，不公开 token。“设置”→“模型”管理提供方凭据；默认模型由官方会话输入框的模型选择器保存（先选择工作区），或停服后在同 home/settings.yaml 合并 agent-default-model 分节的 provider/model。两者必须是实际已注册提供方 ID 及其支持的模型 ID，保留其他设置。未由文件或其他环境覆盖的官方 DeepSeek，在工具目录运行 `pnpm exec dsh-plugin-manager set-api-key --root <交付根> --config .local/deployment.json` 隐藏输入密钥，写入该 home/.credentials.yaml，默认宿主热加载，无需重启；也可由管理员在 /auth 的模型设置中更换。新建对话核实。该命令不切换模型；其他提供方按宿主模型设置配置。

## 配置在哪里？为什么装了 auth 还提示缺 provider？

源码目录存代码；release 目录存 tgz/清单；DSH_HOME 存 profile、插件实例配置和数据；profile 是官方应用组合。明确 root 决定管理器相对路径，不能把它当 DSH_HOME。工具目录安装 manager，和上述目录均可不同。

标准实例设置在 `<home>/plugins/<id>/plugin.json`：`{"schemaVersion":1,"enabled":true,"accessMode":"authenticated","config":{}}`。accessMode 只用于 consumer，auth provider 不填写它。publicOrigin 在站点配置统一设置；业务参数放 config 并由应用 Schema 校验，业务凭据按作者 runtimeConfig 声明放独立 env.conf，不能把密钥塞入公开模板。管理器拒绝缺少必需配置文件；只有应用知道销售接口字段，所以字段缺失可能在插件加载时才报告。

认证要求本次候选集有唯一且启用的 provider。已安装 auth 不等于本次选中 auth；组合必须带它，start 显式 --plugins all，实例 enabled=false 仍生效。缺 provider 会在安装前拒绝；运行时缺认证不会降级为匿名。默认消费者 authenticated；standalone 需要显式修改实例配置并受控重启。

## 历史、授权和停用会怎样？

authenticated 模式按可信账号拥有历史；同账号不同登录共享个人历史。SQLite 只保存历史目录，消息正文由 DSH 会话日志持久化。standalone 是安装级共享历史，不能用于承诺每人私有。切换模式保留两套命名空间，不迁移、不合并；沿用同 home 才能继续原数据。退出/撤权取消该登录发起的活动回合，停止按钮断开 SSE 并取消模型工作。

停用在 plugin.json 设 enabled=false，使用原配置受控应用；数据不删除。非 Docker 的 start 运行时先 stop，修改配置后重新 start；Docker 用 apply-compose 受控重建。重新启用仍需清单包含该应用。停用 auth 而其他 consumer 仍要求认证会被拒绝。

## 第二个应用加入、升级与回退？

在工具目录组合新目录，输入所有要保留的应用：

```sh
pnpm exec dsh-plugin-manager compose-release --root <交付根> --output releases/site-v2 --previous releases/site-v1/manifest.json --manifest incoming/base/manifest.json --manifest incoming/second/manifest.json
```

--previous 只携带旧归档供旧 file: 依赖解析，不继承旧候选。未出现在新候选的受管应用会撤选，数据保留。改部署配置 manifest 指向 v2，沿用 home/plugin.json，stop 后 start --plugins all。确认原应用、新应用、普通账号、授权、配置都可用。保留旧发布目录和一致备份；业务数据库跨版本是否可回退由作者说明，不能直接删 pending 或清数据重试。

## 常见失败先看什么？

| 现象 | 核实与处理 |
| --- | --- |
| 找不到 dsh-plugin-manager | 到安装 manager 的工具目录用 pnpm exec；先 --version/--help |
| 根目录/锁文件错误 | 外部 root 必须是作者单包根，先在该根 install --ignore-workspace 并保存锁文件 |
| 发布输出非空 | 用新版本目录；保留现用目录和恢复归档 |
| 包含 workspace:/file:/link: 运行依赖 | 宿主做 peer，kit 做内嵌开发依赖，重新 pack |
| 外部 development 不支持 | 用 release；需要 link/HMR 时用原内部开发路径 |
| 应用入口匿名 303/401 | 登录 /auth；不是“安装失败” |
| 根路径提示 dsh web authentication required | 官方控制台认证，读取当前私有认证地址；与 API 密钥分开处理 |
| 登录后 403 | 管理员检查应用授权，重新登录；核对 origin/CSRF，不关闭防护 |
| 探针 503 | 查缺 provider、插件启动错误和必需服务；不把匿名开放当修复 |
| 探针成功但模型失败 | 同 home/default model/凭据与模型网络；探针不验证付费调用 |
| 页面 404 | 核对 entryPath、routePrefix、Bundle 是否加载和实例 enabled |
| 新应用未出现 | 完整候选清单、--plugins all、实例 enabled、运行模式与实际版本 |
| 重启后历史变空 | 核对 home、账号、accessMode；不要先删除数据库 |
| Windows、macOS 与 Linux 差异 | 见下节三平台入口与默认值；路径加引号，PowerShell 用 $env:NAME，Bash 用 export NAME |
| 宿主升级不兼容 | 查应用交付版本和真实启动/历史验证，保留旧环境；不要只凭 npm 版本判断 |

提问时提供：manager/插件/官方 CLI 版本，操作系统与 Node/pnpm，已脱敏命令、执行目录角色、候选 ID、release/development、错误文本、期望与实际结果。不要提供完整 env.conf、Cookie、token、数据库或客户数据。助手没有读取你机器状态，不能声称检查过你的文件。

## Windows、macOS、Linux 怎样构建？默认值从哪里来？

Windows PowerShell 用根 `.\build.ps1`，无需 Bash；macOS/Linux 用根 `./build.sh`。共用 Node 流程，需提前准备 Node.js（含 npm）、Git、tar、本机 Linux Docker Compose；首次安装框架锁定依赖，不安装系统软件、不更新宿主子模块。`--help` 无需工作区依赖，`--resume` 沿用原归档与输入，不重装框架源码工作区依赖；缺失时须恢复原工作区，容器部署依赖仍按环境变化恢复。普通构建失败可重试；强杀遗留源码锁须确认主机、PID及子进程退出后处理。

公开默认值：URL `http://127.0.0.1:7902`、端口 7902、profile web、插件 auth/example、mode release、数据 `.local/data`、产物 `.local/artifacts`、容器 UID/GID 1000、`DSH_IMAGE_PLATFORM=linux/amd64`。origin/home/workspace 等可派生；密钥和生成的镜像/manifest 留空。独立 manager 显式选择 env/JSON，选集留空沿用清单。

首次自动生成私有 `.local/env.conf` 写入实际默认值：镜像架构按 Docker 引擎选 amd64/arm64，macOS 非 root 用户采用当前 UID/GID，Windows/Linux 为 1000。已有配置不覆盖，旧 JSON 导入保留原路径；手工复制公共模板不探测平台，须自行核对 UID/GID、架构和已填 URL。

只支持本机 unix/npipe Docker endpoint 和 Linux 容器。Windows/macOS及 Linux Desktop 用桥接；DSH 保持 `127.0.0.1`，容器桥接地址通过 TCP 转发至它，宿主只向 `127.0.0.1` 发布端口。同 Docker 网络是信任边界，不宣称公网隔离。原生 Linux 用 host 网络。macOS 尚未真机验收；健康、知识检索或模型替身通过不等于真实模型问答通过。具体值和实现可检索 `env.conf`、`deploy/scripts/site.mjs`、`packages/plugin-manager/src/apply-compose.mjs`。

## 能回答哪些问题？哪些不能保证？

可解释随包流程、给出步骤和接入提示词。先区分作者/部署者、内部/外部、认证与版本；未知 API、私有业务及兼容性需核实，不猜命令，不承诺自动沙箱、物理隔离或任意外部服务零改动接入。

## 来源与进一步阅读

根 `bash test-report.sh --cli <已构建官方CLI>` 验证 auth/example 归档、真实宿主和本地模型替身，不读取站点配置或部署。交付 `.local/artifacts/test-report-*/delivery/`；重打包不继承报告，其他插件另测。详见 `packages/plugin-manager/VERIFICATION.md`。

在线 main 可能领先，交付以随包 README 和知识摘要为准。

- [产品与导航](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/README.md)
- [使用与运维 FAQ](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/doc/FAQ.md)
- [图文接入手册](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/doc/getting-started.md)
- [作者指南](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/doc/plugin-development.md)
- [实例配置规范](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/doc/plugin-configuration.md)
- [发布物交付](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/packages/plugin-manager/DELIVERY.md)
- [kit 接口](https://github.com/PelyDeng/dsh-plugin-manager/tree/main/packages/plugin-kit/src)
- [示例实现](https://github.com/PelyDeng/dsh-plugin-manager/tree/main/plugins/dsh-example/src)
- [可复制 AI 提示词](prompts.md)
