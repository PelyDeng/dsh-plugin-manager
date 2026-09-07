# 开发者助手配置参考

本目录展示 example、配套 auth 和站点部署的完整常用配置，适用于本文交付的 manager 0.3.0。在线 main 链接可能领先于安装版本，模板与本页随应用版本交付。JSON 不支持注释，因此模板只保存真实配置字段，逐项备注、是否必填和默认值在下表说明。模板可提交 Git；复制后的实例配置只保存在 `.local/`，不会随源码或归档自动生效。

源码一键部署直接运行 `bash deploy/build.sh`，站点和插件文件自动初始化，无需复制下方模板。站点选项修改 `.local/site.json`，插件参数按字段表修改各自 `plugin.json`；不要用 `deployment.json.example` 覆盖脚本生成的 `.local/deployment.json`。下方复制流程适用于自定义管理器集成，完整站点默认值及必填性见[一键部署](https://github.com/PelyDeng/dsh-plugin/blob/main/doc/first-deployment.md)。

## 文件与使用位置

| 模板 | 复制到交付根目录下 | 作用 |
| --- | --- | --- |
| [plugin.json.example](plugin.json.example) | `.local/data/dsh-home/plugins/example/plugin.json` | example 启停、认证及全部业务参数 |
| [auth.plugin.json.example](auth.plugin.json.example) | `.local/data/dsh-home/plugins/auth/plugin.json` | auth 启停及全部认证服务参数；此模板的 stateDir 适用于随附 Docker 布局 |
| [deployment.json.example](deployment.json.example) | `.local/deployment.json` | 站点、路径、容器和实例映射 |

在交付根目录操作：只为新实例复制模板，已有实例请对照字段修改，勿覆盖原配置。配置文件必须是 JSON；可选字段不使用时直接省略，不用 `null` 或无效空字符串代替。

1. 取得作者交付的 auth/example 完整发布目录；在安装 manager 的工具目录使用 `pnpm exec dsh-plugin compose-release --root <交付根> --output releases/site-v1 --manifest <auth清单> --manifest <example清单>` 组合。若已有包含两者的完整清单，只输入一次。输出目录必须为空或不存在。
2. 按上表创建目录并复制三份模板，将 manifest 改为实际组合清单。填写真实不可变 `containerImage`；示例中的占位符必须替换，镜像需包含匹配版本的 manager。
3. 本机演示可保留回环 origin；通过域名访问时同步填写 `publicOrigin`、`publicUrl`、`trustedHosts`，并配置站点反向代理。
4. 在同一个 DSH home 完成宿主默认模型与凭据配置；这些内容不属于插件模板，不能填写到 `plugin.json`。
5. Linux Docker 主机在工具目录执行 `pnpm exec dsh-plugin apply-compose --root <交付根> --config .local/deployment.json --plugins all`。无需框架源码或手改 Compose。

Docker 模板保持 `/data/dsh-home` 为容器 home，auth 的 `stateDir` 与之配套。本机直接运行官方宿主时，删除 auth 配置中的 `stateDir`，让其使用实际 `DSH_HOME/auth`；再从工具目录执行 `pnpm exec dsh-plugin start --root <交付根> --config .local/deployment.json --dsh-cli-js <官方CLI绝对路径> --plugins all`。不要把本机的绝对路径复制进容器配置。

## example 运行配置

“可选”表示省略后使用默认值；完整示例显式展示默认值，方便复制修改。`schemaVersion` 是存在的配置文件必须填写的字段。读取后的参数仍由插件 Schema 验证。

| 字段 | 是否必填 | 默认值 / 示例值 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | 必填 | `1` | 运行配置格式版本，不同于包声明中的版本 3 |
| `enabled` | 可选 | `true` | false 停用插件，保留持久数据 |
| `accessMode` | 可选，认证消费者适用 | `authenticated` | authenticated 要求登录与权限；standalone 使用共享本地身份 |
| `config` | 可选 | `{}` | 插件业务参数；省略整个对象也能使用默认值 |
| `config.routePrefix` | 可选 | `/example` | 非根绝对路由前缀；修改时同步插件声明的 entryPath、healthPath 和前端路由，重新构建验证 |
| `config.systemPrompt` | 可选 | `""` | 部署补充提示；内置开发者职责和随包知识独立注入，已有配置不自动覆盖 |
| `config.historyPath` | 可选 | `""` | 空字符串表示自动使用 `<DSH home>/plugins/example/history.sqlite`；自定义时建议绝对路径，不能指向其他插件数据库 |
| `config.authRecheckMs` | 可选 | `1000` 毫秒 | 活动请求复核认证的间隔，100–30000 |
| `config.turnTimeoutMs` | 可选 | `180000` 毫秒 | 单轮生成超时，1000–1800000 |
| `config.idleTimeoutMs` | 可选 | `1800000` 毫秒 | 空闲会话回收间隔，1000–86400000 |
| `config.maxConversations` | 可选 | `32` | 最大活动会话数，1–500 |
| `config.maxMessageChars` | 可选 | `8000` | 单条消息最大字符数，1–32000 |

`publicOrigin` 是站点共用参数，由管理器注入，不写入 `config`；`accessMode` 只放顶层。直接使用官方 Bundle 而不经过 manager 时，这两个字段才直接放入插件的 Cordis Config。

只免除 example 登录时，将该文件的 `accessMode` 改为 `standalone`，然后重复执行统一应用命令；无需停用 auth。停用插件使用 `enabled: false`，重新启用改回 true。认证、提示词和资源限额等运行参数通过受控重启生效，不需要重新打包；修改路由声明时按 routePrefix 的说明同步包内资源。已有账号历史与独立模式历史不合并。

## auth 配套配置

| 字段 | 是否必填 | 默认值 / 示例值 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | 必填 | `1` | 运行配置格式版本 |
| `enabled` | 可选 | `true` | 停用前必须没有消费者继续要求认证，否则管理器拒绝停止服务 |
| `config` | 可选 | `{}` | auth 服务参数 |
| `config.stateDir` | 可选 | 默认 `<DSH home>/auth`；模板 `/data/dsh-home/auth` | 存放 auth.sqlite；模板为 Docker 容器路径。本机运行应省略，已有实例不要随意改变以免切换到空账号库 |
| `config.sessionTtlSeconds` | 可选 | `86400` 秒 | 登录会话有效期，60–2592000 |
| `config.maxAttempts` | 可选 | `6` | 登录失败限制次数，1–100 |
| `config.lockSeconds` | 可选 | `30` 秒 | 达到失败限制后的锁定时长，1–3600 |
| `publicOrigin` | 使用认证时条件必填 | 来自站点配置 | 由管理器注入；不重复写入 auth 的 config |

auth 是认证提供者，没有 `accessMode` 配置。账号、密码和逐用户插件授权通过 auth 管理功能维护，不在模板中预置。详见 [auth 使用说明](https://github.com/PelyDeng/dsh-plugin/blob/main/plugins/dsh-auth/README.md)。

## 站点部署配置

以下路径相对于 `--root` 指定的仓库根目录，不相对于模板目录。已配置的 CLI 或环境变量可覆盖同名部署选项，应用示例前应核对当前 shell 的 `DSH_*`、`PLUGIN_MANIFEST_FILE` 和 `DEPLOYMENT_CONFIG`。

| 字段 | 是否必填 | 默认值 / 示例值 | 说明 |
| --- | --- | --- | --- |
| `profile` | 可选 | `web` | 官方 DSH profile；本 demo 使用 web |
| `plugins` | 可选 | 模板 `["auth", "example"]` | 显式候选插件集合；使用发布清单时省略表示使用完整清单；与 enabled 的实例启停不同 |
| `manifest` | apply-compose 时必填 | `.local/artifacts/release/plugins/manifest.json` | 已验证归档清单；不能指向不存在的文件 |
| `mode` | 可选 | `release` | release 使用归档；源码 development 模式用于开发流程，随附 Docker 模板使用 release |
| `dataRoot` | 可选 | `.local/data` | 持久数据根目录，容器挂载为 `/data` |
| `home` | 可选 | `<dataRoot>/dsh-home` | 保留同一 home 才能沿用账号、配置和历史 |
| `workspace` | 可选 | `<dataRoot>/workspace` | 宿主工作目录 |
| `authUrlFile` | 可选 | `<dataRoot>/dsh-web-auth-url.txt` | 官方 DSH 控制台认证地址文件，非业务插件账号配置 |
| `artifacts` | 可选 | `.local/artifacts` | 生成文件和操作记录，不得与持久数据重叠 |
| `publicOrigin` | 使用认证时条件必填 | `http://127.0.0.1:7902` | HTTP(S) origin，无路径和尾斜杠；省略时可由 publicUrl 提供 |
| `publicUrl` | 可选；作为 origin 来源时须合法 | `http://127.0.0.1:7902` | 对外控制台地址；省略时控制台地址按监听端口生成，但不会替代认证所需的显式 origin |
| `port` | 可选 | `7902` | 监听端口，需要与入口、代理和 origin 匹配 |
| `trustedHosts` | 可选 | `["127.0.0.1:7902"]` | 传给宿主的可信 Host 列表；远程入口填写真实主机名及必要端口 |
| `containerImage` | apply-compose 时必填 | 实际镜像名及 `@sha256:` 摘要 | 模板占位符不是可用镜像，不使用可变 latest 标签 |
| `composeProject` | 可选 | 默认 `dsh-plugins`；模板 `dsh-example-demo` | Compose 项目名，用于隔离演示实例；同一端口不能同时启动多个实例 |
| `containerUid` / `containerGid` | 可选 | 各 `1000` | 容器非 root 用户；已有数据和配置必须允许该用户访问 |
| `offline` | 可选 | `false` | 是否禁止安装时联网；设为 true 前先准备匹配版本的离线依赖 |
| `patches` | 可选 | `[]` | 其他宿主定制 patch；每个已填写文件须存在。插件认证和配置由管理器生成最后一层 patch |
| `instances` | 可选 | `{}` | 以插件 ID 为键的实例设置，不使用 npm 包名作为键 |
| `instances.<id>.settingsFile` | 可选 | `<home>/plugins/<id>/plugin.json` | 模板显式写出默认路径，方便定位 |
| `instances.<id>.configRevision` | 可选 | `0` | 非负整数；外部业务配置变更可递增修订号。普通 plugin.json 内容变化无需手动递增 |

下列扩展选项需要实际资源或特定启动方式，故不在可复制的 Docker 模板中填写虚假路径；使用时按表增补。

| 字段 | 是否必填 | 示例 / 默认 | 适用条件 |
| --- | --- | --- | --- |
| `storeDir` / `cacheDir` | 可选 | `.local/data/plugin-store` / `.local/data/plugin-cache` | 本机 pnpm 可写目录；Docker 配置由 renderCompose 固定映射到 `/data/plugin-store` 和 `/data/plugin-cache` |
| `offlineStore` / `offlineCache` | 可选 | `.local/artifacts/offline/store` / `.local/artifacts/offline/cache` | 已存在的离线来源；配置后会读取这些目录，不得指向虚构路径 |
| `instances.<id>.runtimeConfig` | 可选；插件声明 required 时需提供实际文件或使用默认位置 | `<home>/plugins/<id>/env.conf` | 仅对声明 runtimeConfig 的插件生效；demo 不读取业务 env 文件，无需填写 |
| `harnessRoot` | 可选，源码宿主适用 | 实际宿主源码目录 | development 模式未指定 CLI 时默认 `<root>/deepseek-harness`；Docker 镜像自带宿主，无需填写 |
| `dshCliJs` / `dshCli` | 可选；无可用宿主时须指定或先安装宿主 | 实际官方 CLI JS 路径 / 命令 | 对应 `--dsh-cli-js` / `--dsh-cli`；release 模式都省略时查找 PATH 中的 dsh |
| `host` | 可选 | `127.0.0.1` | 本机 start 监听地址；apply-compose 固定使用回环监听 |
| `hostMode` | 可选 | `external` | 外部管理者同步流程；start 和 container-start 自动使用 owned |
| `baseUrl` | 独立 verify 等操作需要探针时条件必填 | `http://127.0.0.1:7902` | 探针实际访问地址；start 与 health 可按端口生成，Docker health 使用容器本地端口 |
| `stoppedFile` / `startedFile` | external 同步/确认启动时条件必填 | 原管理者提供的证据文件 | 不是普通布尔开关，不自行伪造；正常 apply-compose 无需填写 |
| `authUrlDirectWrite` | 可选 | `false` | 外部认证地址文件 bind mount 需原位写入；Docker 渲染器按挂载位置自动设置 |

## 插件作者的声明

真实生效的声明位于 [package.json](../package.json)。example 已填写所有适用的描述、路由、权限、验证资源和统一配置字段；“可选”不妨碍 demo 显式展示。

| 字段 | 是否必填 | 本示例值 / 说明 |
| --- | --- | --- |
| `name` / `version` | 必填 | npm 包名 `dsh-example` / 包版本，与私有实例配置版本无关 |
| `description` | 可选 | 开发者接入答疑助手与可复制的鉴权对话示例 |
| `main` / `dsh.bundle.patch` | 必填 | `dist/index.mjs` / `./cordis.patch.yml`，必须与构建产物和 Bundle 一致 |
| `files`、README、`scripts.build`、`scripts.check` | 仓库必需 | 明确归档资源与构建检查流程；examples 作为公开模板一并打包 |
| `types` / `exports` | 按包接口需要 | 本示例声明类型及 ESM 入口，填写的路径必须存在 |
| `license` / `private` | 仓库必需许可；私有许可必须 private | 本示例 Apache-2.0，private true；公开源码不代表已发布到 npm |
| `engines` / `packageManager` | 本示例显式声明 | 支持的 Node 范围和 pnpm 版本，见 package.json |
| `dependencies` / `peerDependencies` / `devDependencies` | 按依赖需要 | 运行库、宿主接口、构建工具；不要把工作区 file/link 运行依赖带进归档 |
| `deepseekPlugin.schemaVersion` | 必填 | `3`，插件仓库声明格式 |
| `deepseekPlugin.id` | 必填 | `example`，全仓唯一身份 |
| `deepseekPlugin.defaultEnabled` | 可选 | `true`，源码默认候选集 |
| `deepseekPlugin.displayName` | 可选 | `开发者接入助手`，省略时使用包名 |
| `deepseekPlugin.entryPath` | 可选 | `/example`，无页面的插件可以省略 |
| `deepseekPlugin.healthPath` | 可选 | `/example/ready`，省略后不会阻断构建；探针状态为 not-provided |
| `deepseekPlugin.permissions` | 可选 | `["example:access"]`，省略为 []，权限标识限定在本插件命名空间 |
| `deepseekPlugin.verifyFiles` | 可选 | 完整静态资源列表见 package.json；基本入口、README 和 Bundle 无论是否列出都检查 |
| `deepseekPlugin.configuration` | 可整体省略 | `{ "entryId": "example", "auth": "consumer" }` |
| `configuration.entryId` | 声明 configuration 时必填 | 对应 Bundle 中实际 entry ID，不一定等于插件 ID |
| `configuration.auth` | 可选 | consumer 使用认证；provider 提供认证；省略表示无统一认证角色 |
| `deepseekPlugin.runtimeConfig` | 可整体省略 | demo 使用宿主模型，不读取独立 env 文件，故不启用。声明时 variable 必填、template 可选、required 默认 true |
| `deepseekPlugin.development` | 可整体省略 | demo 无专用开发 patch，故不启用。声明时 patch 和 rootVariable 必填，文件必须存在、变量不得占用保留名称 |

新增业务 env 或开发 patch 能力时，先实现对应读取或源码加载，再声明 runtimeConfig/development；元数据本身不会替插件实现功能。统一规则见[插件运行配置规范](https://github.com/PelyDeng/dsh-plugin/blob/main/doc/plugin-configuration.md)。
