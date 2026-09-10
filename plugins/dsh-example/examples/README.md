<!-- Generated from plugins/dsh-example/examples/README.md.tmpl by scripts/version.mjs; edit the template. -->

# 开发者助手配置参考

本目录维护 example 与配套 auth 的业务配置，适用于框架 0.16.0。下方 JSON 保留独立 CLI 集成的兼容模板，站点 build 不需要复制它。模板与本页随应用版本交付。JSON 不支持注释，因此模板只保存真实配置字段，逐项备注、是否必填和默认值在下表说明。模板可提交 Git；复制后的实例配置只保存在 `.local/`，不会随源码或归档自动生效。

站点 build 在 Windows PowerShell 执行根 `.\build.ps1`，macOS/Linux 执行根 `./build.sh`；站点和插件文件按实际模式初始化，无需复制下方模板。新 archives 站点可编辑文件在 .local/config/plugins/<id>，已有站点和显式路径不迁移。站点选项修改 `.local/env.conf`，根 `env.conf` 提供固定非秘密默认值，首次生成的私有文件写入实际平台默认值，已有配置不覆盖。

插件参数按字段表修改各自 `plugin.json`；不要用 `deployment.json.example` 覆盖脚本生成的 `.local/deployment.json`。下方复制流程适用于自定义管理器集成，完整站点默认值、各平台实际验证情况及恢复说明见[一键部署](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.0/doc/first-deployment.md)。

## 文件与使用位置

| 模板 | 独立 CLI 示例位置（build 使用实际输出路径） | 作用 |
| --- | --- | --- |
| [plugin.json.example](plugin.json.example) | `.local/data/dsh-home/plugins/example/plugin.json` | example 启停、认证及全部业务参数 |
| [auth.plugin.json.example](auth.plugin.json.example) | `.local/data/dsh-home/plugins/auth/plugin.json` | auth 启停及全部认证服务参数；此模板的 stateDir 适用于随附 Docker 布局 |
| [deployment.json.example](deployment.json.example) | `.local/deployment.json` | 站点、路径、容器和实例映射 |

在交付根目录操作：只为新实例复制模板，已有实例请对照字段修改，勿覆盖原配置。配置文件必须是 JSON；可选字段不使用时直接省略，不用 `null` 或无效空字符串代替。

1. 取得作者交付的 auth/example 完整发布目录；在安装 manager 的工具目录使用 `pnpm exec dsh-plugin-manager compose-release --root <交付根> --output releases/site-v1 --manifest <auth清单> --manifest <example清单>` 组合。若已有包含两者的完整清单，只输入一次。输出目录必须为空或不存在。
2. 按上表创建目录并复制三份模板，将 manifest 改为实际组合清单。填写真实不可变 `containerImage`；示例中的占位符必须替换，镜像需包含匹配版本的 manager。
3. 本机演示可保留回环 origin；通过域名访问时同步填写 `publicOrigin`、`publicUrl`、`trustedHosts`，并配置站点反向代理。
4. 在同一个 DSH home 完成宿主默认模型与凭据配置；这些内容不属于插件模板，不能填写到 `plugin.json`。
5. 使用本机 Linux Docker 引擎的部署者，在工具目录执行 `pnpm exec dsh-plugin-manager apply-compose --root <交付根> --config .local/deployment.json --plugins all`。当前 manager 会按执行平台处理网络和挂载；可先用 `check-compose` 检查候选配置及权限。无需框架源码或手改 Compose。

Docker 模板保持 `/data/dsh-home` 为容器 home，auth 的 `stateDir` 与之配套。本机直接运行官方宿主时，删除 auth 配置中的 `stateDir`，让其使用实际 `DSH_HOME/auth`；再从工具目录执行 `pnpm exec dsh-plugin-manager start --root <交付根> --config .local/deployment.json --dsh-cli-js <官方CLI绝对路径> --plugins all`。不要把本机的绝对路径复制进容器配置。

## example 运行配置

“可选”表示省略后使用默认值；完整示例显式展示默认值，方便复制修改。`schemaVersion` 是存在的配置文件必须填写的字段。读取后的参数仍由插件 Schema 验证。

| 字段 | 是否必填 | 默认值 / 示例值 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | 必填 | `1` | 运行配置格式版本，不同于包声明中的版本 3 |
| `enabled` | 可选 | `true` | false 停用插件，保留持久数据 |
| `accessMode` | 可选，需要认证的插件适用 | `authenticated` | authenticated 要求登录与权限；standalone 使用共享本地身份 |
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
| `enabled` | 可选 | `true` | 停用前必须没有其他插件继续要求认证，否则管理器拒绝停止服务 |
| `config` | 可选 | `{}` | auth 服务参数 |
| `config.stateDir` | 可选 | 默认 `<DSH home>/auth`；模板 `/data/dsh-home/auth` | 存放 auth.sqlite；模板为 Docker 容器路径。本机运行应省略，已有实例不要随意改变以免切换到空账号库 |
| `config.sessionTtlSeconds` | 可选 | `86400` 秒 | 登录会话有效期，60–2592000 |
| `config.maxAttempts` | 可选 | `6` | 登录失败限制次数，1–100 |
| `config.lockSeconds` | 可选 | `30` 秒 | 达到失败限制后的锁定时长，1–3600 |
| `publicOrigin` | 使用认证时条件必填 | 来自站点配置 | 由管理器注入；不重复写入 auth 的 config |

auth 是认证提供者，没有 `accessMode` 配置。账号、密码和逐用户插件授权通过 auth 管理功能维护，不在模板中预置。详见 [auth 使用说明](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.0/plugins/dsh-auth/README.md)。

## 通用配置与声明

上面的 JSON 是可离线复制的独立 CLI 示例，不是 build 的人工输入。必须把 manifest、镜像摘要和站点地址换成实际值；保留 home 和实例映射才能沿用原数据。显式部署 root 决定相对路径，不能相对模板文件计算。

框架字段、默认值和优先级统一在[配置参考](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.0/doc/framework-configuration.md#独立-cli-字段参考)维护；包声明与 enabled/accessMode/runtimeConfig 语义统一在[插件规范](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.0/doc/plugin-configuration.md)维护，不在本例重复整套通用字段表。

本应用实际声明见随包 [package.json](../package.json)：npm 包 dsh-example，插件 ID/entryId 为 example，页面 /example、探针 /example/ready，权限 example:access，认证角色 consumer。它使用官方模型凭据，没有业务 runtimeConfig 文件。新增业务配置或开发 patch 时先实现读取/加载能力，再填写声明；元数据不会代替实现。
