# 开发者接入 FAQ

适用：plugin-manager 0.3.0、plugin-kit 0.1.0，示例宿主接口以仓库锁定源码为基线；宿主版本号相同也可能存在源码与发布类型差异。这是随 dsh-example 发布的知识快照，不是对远程仓库的实时查询。框架维护者在接口、命令或支持范围变化时更新本页及提示词，发布前复核代码与示例；页面摘要只标识知识内容，不证明所有代码自动同步。

## 这个仓库是什么？

基于 DSH 的应用接入与交付管理框架。开发者保留官方 Cordis 插件、Bundle 和 Agent 结构，按需接入统一身份、授权、配置与部署，将应用交给团队和客户使用。主要服务独立应用作者和部署维护者；使用者从登录后的应用入口使用业务能力。

官方 DSH 提供插件加载、服务依赖、Agent、模型、工具及会话运行。本框架补充应用声明、发布物检查与组合、实例配置、受控部署和可选账号/逐应用授权。不修改 DSH 源码才能接入，是这里“无侵入”的含义；作者仍需要编写接入声明和鉴权代码。

| 模块 | 复用什么 | 不替作者做什么 |
| --- | --- | --- |
| plugin-manager | 内外包发现、build/check/pack、清单组合、安装、配置与启停 | 不执行业务开发，不是插件市场或代码沙箱 |
| plugin-kit | 可信身份、受保护 HTTP、工具鉴权和应用登记 | 不自动保护绕过 kit 的路由，不判断部门数据范围 |
| dsh-auth | 登录、账号、会话、逐应用授权 | 不替代官方控制台认证，不提供完整企业 SSO |
| dsh-example | 开发者答疑、流式对话、个人历史和停止生成示例 | 不提供销售查询或知识库检索业务 |

只写自己的工具并在个人 DSH 使用，直接官方 Bundle 可能更简单。需要多应用共用账号、规范交付给他人时，本框架更有价值。代价是维护声明、显式接入 kit、验证宿主升级，以及学习发布与实例配置。没有证据证明本项目社区独有或兼容任意插件。

## 第二个应用到底少写什么？

假设知识库助手已交付，现在新增销售报表助手。

| 场景 | 作者仍写 | 持续复用 |
| --- | --- | --- |
| 知识库问答 | 文档导入、检索、引用、文档访问范围、工具和提示词 | auth 账号/登录、kit 身份、manager 配置与交付 |
| 销售报表 | 销售接口、指标计算、部门/客户权限、图表、工具和提示词 | 同一账号系统和部署命令，新增应用声明与必要接入代码 |

销售请求“上个月哪些产品销售下降”时，模型提出查询参数，应用从可信 actor 取得身份，服务端确定允许的数据范围后调用销售接口；不能接受模型给出的 userId 作为授权依据。应用访问许可与销售数据许可是两次不同检查。

无需为第二应用维护第二套密码和登录会话。kit 构建时内嵌，kit 升级仍需应用更新依赖、重打包；auth 共享服务的维护方式不同。复制 example 是初次开发便利，持续复用来自公共接口和服务，不是整份登录源码的复制。上述业务场景是设计例子；仓库的 independent-access-example 只返回当前身份，不证明真实销售查询或图表已实现，也没有测得节省工时。

## 选择哪种接入？

1. **普通官方 Bundle**：只需 DSH 的插件能力，用官方 package.json 的 dsh.bundle.patch 和 Cordis patch；无需 kit/manager。
2. **受管交付**：保留 Bundle，增加 deepseekPlugin schema 3 声明、build/check 脚本、README 和 files。管理器读取声明，无需维护中央插件名单。
3. **可选统一认证**：再声明 configuration.auth=consumer，接入 kit 的 createAccess/createPluginHttp 或工具鉴权，并在部署候选集合选入 auth。仅写声明不会获得保护。

内部开发扫描 `<框架根>/plugins/*`。外部支持独立 pnpm 单包：显式 `--root <作者包根> --package .`，只接受 `.`，不能同时传 --plugins；不会自动扫描外部 workspace。外部清单 2 只支持 release，内部清单 1 继续支持 release 和 development/link。页面、Agent、Tool、探针、kit 都不是受管包的必选功能。

## 工具从哪里来？

需要 Node.js `^22.19.0 || >=24`、pnpm 11.19.0、系统 tar。包名不表示已发布到公共 npm。取得可信维护者的版本化 manager tgz（用 kit 才需 kit tgz），核对提供方摘要；没有现成包时，按仓库作者指南从明确源码提交构建。依赖安装可能需要网络，只有 tgz 不等于完整离线闭包。

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

import 来自 `@dsh-plugin-manager/plugin-kit`，完整可运行实例见 examples/standalone-kit。Tool 使用官方 ToolDefinition；需要认证时参照 kit/tools 的 createPluginTools/guardTool，声明权限并将工具名加入 Agent 白名单。不要猜测未提供的工具签名，应查当前安装版本导出与示例。Agent 使用官方 ctx.agents 与默认模型选择，systemPrompt.section 注入提示，tools.restrict 限制能力。example 当前白名单为空，无法代你执行命令、读磁盘或访问销售系统。

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

管理器启动打印认证地址文件位置，默认 `<交付根>/.local/data/dsh-web-auth-url.txt`；仅在本机编辑器读取并访问其中官方控制台地址，不公开 token。“设置”→“模型”管理提供方凭据；默认模型由官方会话输入框的模型选择器保存（先选择工作区），或停服后在同 home/settings.yaml 合并 agent-default-model 分节的 provider/model。两者必须是实际已注册提供方 ID 及其支持的模型 ID，保留其他设置。使用官方 DeepSeek 时，在工具目录运行 `pnpm exec dsh-plugin-manager set-api-key --root <交付根> --config .local/deployment.json` 隐藏输入密钥，保存到该 home/.env 后 stop/start，新建对话核实。该命令不切换模型；其他提供方按宿主模型设置配置。

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
| 匿名 303/401 | 登录 /auth；不是“安装失败” |
| 登录后 403 | 管理员检查应用授权，重新登录；核对 origin/CSRF，不关闭防护 |
| 探针 503 | 查缺 provider、插件启动错误和必需服务；不把匿名开放当修复 |
| 探针成功但模型失败 | 同 home/default model/凭据与模型网络；探针不验证付费调用 |
| 页面 404 | 核对 entryPath、routePrefix、Bundle 是否加载和实例 enabled |
| 新应用未出现 | 完整候选清单、--plugins all、实例 enabled、运行模式与实际版本 |
| 重启后历史变空 | 核对 home、账号、accessMode；不要先删除数据库 |
| Windows 与 Linux 差异 | pnpm/node 命令一致；路径加引号。PowerShell 用 $env:NAME，Bash 用 export NAME；build.sh 源码部署仅 Linux Docker |
| 宿主升级不兼容 | 查应用交付版本和真实启动/历史验证，保留旧环境；不要只凭 npm 版本判断 |

提问时提供：manager/插件/官方 CLI 版本，操作系统与 Node/pnpm，已脱敏命令、执行目录角色、候选 ID、release/development、错误文本、期望与实际结果。不要提供完整 env.conf、Cookie、token、数据库或客户数据。助手没有读取你机器状态，不能声称检查过你的文件。

## 能回答哪些问题？哪些不能保证？

可以解释此知识中的流程，按目标生成最短步骤、接入清单和可复制提示词。先明确作者/部署者、内部/外部、是否认证及版本；缺少信息时给适用条件，不猜造命令。没有知识依据的 API、最新社区功能、私有插件业务、未来路线、任意版本兼容性应明确不知道并指向当前版本文档/源码核实。不要承诺自动沙箱、多租户物理隔离、全语言应用直接运行、任意外部服务零改动接入或 marketplace 自动分发。

## 来源与进一步阅读

本 FAQ 由框架维护者维护，职责与示例应与下列公开资料及代码核对；在线 main 文档可能领先于安装版本，交付时以随包 README 和知识摘要为准。

- [产品与导航](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/README.md)
- [图文接入手册](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/doc/getting-started.md)
- [作者指南](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/doc/plugin-development.md)
- [实例配置规范](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/doc/plugin-configuration.md)
- [发布物交付](https://github.com/PelyDeng/dsh-plugin-manager/blob/main/packages/plugin-manager/DELIVERY.md)
- [kit 接口](https://github.com/PelyDeng/dsh-plugin-manager/tree/main/packages/plugin-kit/src)
- [示例实现](https://github.com/PelyDeng/dsh-plugin-manager/tree/main/plugins/dsh-example/src)
- [可复制 AI 提示词](prompts.md)
