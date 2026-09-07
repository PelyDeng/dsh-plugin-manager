# 插件运行配置规范

需要完整可复制配置时，使用 [demo 配置示例](../plugins/dsh-example/examples/README.md)，其中列出 example、auth、部署配置的全部适用字段、默认值和必填条件。

管理器 0.2.1 起，支持 `configuration` 声明的插件使用自己的 `plugin.json`。插件作者声明入口、认证角色和就绪地址；管理器负责配置读取、DSH patch、容器挂载、启停和健康检查。添加合规插件不需要修改管理器名单或分支。

## 插件声明

在 `package.json` 的 `deepseekPlugin` 中配置：

```json
{
  "schemaVersion": 3,
  "id": "example",
  "defaultEnabled": true,
  "entryPath": "/example",
  "healthPath": "/example/ready",
  "permissions": ["example:access"],
  "configuration": { "entryId": "example", "auth": "consumer" }
}
```

`entryId` 必须匹配插件 Bundle 中可配置的 Cordis entry ID，不一定等于插件 ID。`auth: consumer` 接入统一认证；认证提供者声明 `auth: provider`。不涉及认证的插件可以省略 `auth`，仍可使用统一配置。认证提供者只能有一个；消费者通过 kit 的身份和 HTTP 接口执行真实鉴权，元数据不会自动保护自行注册的路由。

`healthPath` 可省略；未声明时构建、打包及部署均可继续，管理器仍检查宿主和安装状态，将该插件就绪结果标记为 `not-provided`，不代表已验证业务就绪。声明后需要实现对应的 GET 就绪探针：当前可服务时返回 200，必需认证服务不可用时返回 503。探针无需登录，不返回账号、密钥或业务数据，不执行付费模型调用。地址必须是本站绝对路径，不能重定向到外部。管理器按实际已安装插件的声明检查，不维护额外地址名单。

## 必填与可选字段

构建与检查入口复用同一流水线，调用各插件声明的脚本，不增加业务插件名单或业务专属检查。管理器检查交付和启动必需的插件声明、源码和归档，不读取运行实例的 `plugin.json`、业务凭据或站点 origin。可选字段省略不会导致构建失败；已经填写但类型、路径或取值错误仍会报错。

| 字段 | 是否必填及省略行为 |
| --- | --- |
| `description` | 可选，可省略或填写空文本 |
| `displayName` | 可选，默认使用 npm 包名 |
| `defaultEnabled` | 可选，默认 true |
| `entryPath`、`healthPath` | 可选，不猜测页面或健康检查地址 |
| `permissions`、`verifyFiles` | 可选，默认没有额外声明；基本归档文件仍校验 |
| `configuration` | 可整体省略，使用插件自身的 Bundle 配置 |
| `configuration.entryId` | 声明 `configuration` 时必填，否则无法确定配置目标 |
| `configuration.auth` | 可选，不声明则不接入统一认证角色 |
| `runtimeConfig` | 可整体省略；声明时 `variable` 必填，`template` 可选，`required` 默认 true |
| `development` | 可整体省略；声明时开发 patch 和变量映射仍须有效 |
| 运行配置的 `enabled`、`accessMode`、`config` | 可省略，分别默认 true、消费者 authenticated、空对象；这些字段不参与构建 |

用于确定包身份、执行构建和加载 Bundle 的 `name`、`version`、`deepseekPlugin.schemaVersion`、`deepseekPlugin.id`、`main`、`dsh.bundle.patch`、`files`、README、`scripts.build` 和 `scripts.check` 是内部与独立包共用的必需输入。声明的文件必须真实存在；构建产物可由 build 生成。

要求认证的实例仍需在部署时提供合法站点 origin 和认证提供者；声明为必需的业务配置也在部署时检查。运行前置条件不会被可选构建字段豁免。

## 每个插件一份运行配置

默认位置为 `<DSH home>/plugins/<插件 ID>/plugin.json`，可用部署配置 `instances.<id>.settingsFile` 指定外部路径。文件不进入 Git、插件包或镜像。首次 `apply-compose` 为缺少配置文件的标准插件创建默认配置，已有文件保持原内容。

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "accessMode": "authenticated",
  "config": {}
}
```

- `enabled` 默认 true，控制该实例是否运行插件；false 会从受管 profile 移除该插件，保留数据。插件仍须存在于部署候选清单，才能通过此开关重新启用。
- `accessMode` 仅适用于认证消费者，默认 `authenticated`。`standalone` 关闭该插件认证，其他插件不变；共享历史与个人历史仍分别保留，不迁移或合并。
- `config` 是插件自己的 Cordis Config 参数，由插件 Schema 校验。`accessMode` 放在顶层；`publicOrigin` 由站点部署配置统一提供，禁止在 `config` 中重复定义。
- 存在的文件必须声明 `schemaVersion: 1`，未知顶层字段、非法类型及非法模式在部署前报错。缺失文件使用安全默认值。

业务凭据继续使用插件声明的 `runtimeConfig` 文件（如 `env.conf`），不会因为认证开关被合并、打印或重新写入。修改认证只编辑 `plugin.json` 的 `accessMode`。

## 一次配置站点，之后统一应用

源码一键部署自动创建 `.local/site.json` 并生成 `.local/deployment.json`，后者保存候选清单和公共参数，不需要手工填写。首次部署及站点字段见[一键部署](first-deployment.md)。以下运行配置仅供自定义管理器集成参考：

```json
{
  "profile": "web",
  "plugins": ["auth", "example"],
  "manifest": ".local/artifacts/release/plugins/manifest.json",
  "publicOrigin": "https://plugins.example.com",
  "publicUrl": "https://plugins.example.com",
  "containerImage": "registry.example.com/dsh-host@sha256:<已验证的64位摘要>",
  "composeProject": "dsh-plugins"
}
```

`auth` 和 `example` 默认纳入源码选集。站点 origin 只配置一次；标准插件的认证和配置由管理器自动生成 patch。`patches` 仅保留其他宿主定制，不再手工为这些标准入口重复配置认证。迁移旧实例时应移除对应旧 patch 条目。

修改某个 `plugin.json` 后，在安装了新版管理器的宿主机执行：

```sh
dsh-plugin-manager apply-compose --root /path/to/project --config .local/deployment.json
```

此命令校验配置与归档，生成独立 Compose 文档，停止指定项目的 dsh 服务，重新创建并等待健康检查通过。使用已有发布包，不重新构建插件；镜像必须包含同版本管理器。生成文件位于 `.local/artifacts/`，当前成功部署记录为 `.local/artifacts/active-compose.json`。不要手改生成文件，也不要混用旧 Compose 覆盖文件启动同一项目。Docker 和 Compose 需在执行命令的宿主机可用，命令仅支持串行执行。容器使用 `containerUid`/`containerGid`（默认均为 1000）；root 首次执行时只为新创建目录和设置文件赋权，已有目录或文件权限不符会在停服前报错，需要部署者调整。

配置变更通过受控重启生效，不承诺热切换。运行中修改配置文件不会改变当前已验证的健康检查对象；新配置应用后，检查实际启用的插件。周期探针检查宿主 HTTP、安装包版本、入口、Bundle 和插件就绪地址；完整归档内容验证在部署和启动验收阶段执行。停用 auth 而仍有消费者要求认证时，在停服前拒绝操作。

非 Docker 启动同样通过 `start --config ...` 读取每个插件的配置。生成的 patch 使用内容摘要命名，保持旧运行实例所读文件不变；发布目录、历史和配置均不由停用操作删除。

## 接入要求

认证消费者通过 kit 校验登录和应用授权，提供者不可用时拒绝访问；standalone 使用共享身份。统一配置支持停用和重新启用，健康探针按本页定义返回服务状态。新增插件只需声明配置与入口，业务独有字段放在插件 `config` 中。
