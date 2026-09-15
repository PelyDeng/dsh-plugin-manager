# 框架统一配置

根目录 [env.conf](../env.conf) 是可提交的公开默认值模板，每项有中文注释；固定非秘密默认值已直接填入。运行时使用 Git 忽略的 `.local/env.conf`，通常只需核对访问地址、信任域名和所用模型密钥。真实域名、账号、密码和密钥只填私有文件，不能写入公共模板。

## 首次填写

新站点直接执行 Windows 的 `./build.ps1` 或 macOS/Linux 的 `./build.sh`，脚本自动创建私有配置；精简部署包默认 archives，框架源码检出默认 source，写入本次模式与平台的实际默认值。已有 `.local/env.conf` 不覆盖；旧站点先由部署入口导入旧 JSON，保留原路径和文件。

确需手工复制时，仅用于尚无配置与数据的新站点。公开模板的 UID/GID 为 1000、镜像架构为 `linux/amd64`，不会因为复制动作自动探测平台；macOS 用户及 ARM Docker 引擎应核对并修改这些值。显式填写的值会被保留。

```sh
# 仅用于尚无配置与数据的新站点
mkdir -p .local
cp -n env.conf .local/env.conf
chmod 600 .local/env.conf
```

公网部署按实际地址填写以下字段，保留已有信任项；此处域名仅为示例：

```ini
DSH_PUBLIC_URL=https://dsh.example.com
DSH_PUBLIC_ORIGIN=https://dsh.example.com
DSH_TRUSTED_HOSTS=["dsh.example.com"]
DEEPSEEK_API_KEY=
ZHIPU_API_KEY=
```

地址不带路径或末尾斜杠，信任项不带协议或路径。自定义端口时同时核对 URL 与反向代理。设置访问地址不会自动添加信任域名；控制台接口 403 的排查见 [FAQ](FAQ.md#控制台能打开但模型和插件报-http-403-怎么办)。

文件按字面量 `KEY=VALUE` 解析，不执行 shell，不展开变量；数组和对象使用单行 JSON，含引号的字符串可用 JSON 字符串表示。重复字段、未知字段或非法类型会拒绝。相对路径从明确指定的项目根目录（root）计算。Linux/macOS 私有输入必须是普通文件且权限为 `0600` 或更严格；Windows 通过 ACL 保护新建的框架私有配置、供进程读取的凭据文件、日志和操作目录。已有用户文件及数据目录不会被递归改权，手工提供的私有输入仍需部署者限制其 ACL。

## 密钥由谁管理

<!-- excerpt:model-credentials -->
私有 .local/env.conf 中的 DEEPSEEK_API_KEY / ZHIPU_API_KEY 非空时：文件为准，只注入官方DSH子进程，网页只读；改文件后受控部署。留空不添加覆盖、不删除官方凭据、不清除继承环境密钥。没有外部环境覆盖时，管理员可在 /auth 的“模型设置”管理 DeepSeek/智谱，写入官方存储时默认无需重启。

网页只返回状态与 SHA-256 指纹，不返回原密钥。指纹不能还原密钥；“已配置”不代表余额、网络或调用通过。命令行 set-api-key 只支持 DeepSeek，密钥使用隐藏输入，不放在 argv。在安装 manager 的工具目录使用 `pnpm exec dsh-plugin-manager set-api-key --root <站点根> --config .local/deployment.json`。

已有源码仓库可使用 `bash deploy/scripts/set-api-key.sh --config .local/deployment.json`；Windows 使用 `node deploy/scripts/set-api-key.mjs --config .local/deployment.json`。这些源码包装器不属于独立起步项目。Compose 核验当前容器与 home 后以实际用户写入；独立 CLI 指向已安装的兼容宿主。默认凭据服务/监听关闭或自定义时，通过当前服务的网页入口管理。

模型默认值由同一宿主的官方 agentDefaultModel 提供；管理员选择新会话默认模型无需重启。已有会话及分支按官方记录恢复，模型选择为 pending ?? lastUsed，读取或投影失败拒绝恢复，不用新默认覆盖旧记录。凭据不会创建提供方路由，健康探针不调用模型；实际问答另验收。
<!-- /excerpt:model-credentials -->

## 配置范围与默认值

完整字段以根模板与当前模式为准。固定默认值直接填写，派生值、可选输入、秘密和生成项按注释留空；空值不等于没有默认行为。

| 项目 | 公开模板中的值或规则 |
| --- | --- |
| 访问与监听 | `DSH_PUBLIC_URL=http://127.0.0.1:7902`、`DSH_BIND_HOST=127.0.0.1`、`DSH_PORT=7902`；origin 留空时从 URL 派生，信任域名按实际访问填写 |
| 启动与存储 | profile `web`、选集留空（采用全部候选）、mode `release`、数据根 `.local/data`、产物根 `.local/artifacts` |
| 工具与容器 | CLI `dsh`、patches `[]`、offline `false`、Compose 项目 `dsh-plugins`、UID/GID `1000` |
| 镜像 | 平台 `linux/amd64`、基础镜像 `docker.io/library/node:24-bookworm-slim`；Harbor 关闭，上游回退开启 |
| 保持留空 | 模型密钥、仓库账号密码、生成的镜像/manifest、可选宿主来源；home/workspace/authUrlFile 等从入口与数据根派生 |

选集留空表示采用清单里的全部候选（builtin 加全部 incoming），显式 `[]` 表示空集合；两种来源行为一致，不因 source 或 archives 改变，构建某个插件也不表示启用它。独立 CLI 留空沿用显式发布清单。手工更改端口不会同步改写已填的 URL，需同时核对。

| 类别 | 字段 |
| --- | --- |
| 常用访问与模型 | `DSH_PUBLIC_URL`、`DSH_PUBLIC_ORIGIN`、`DSH_TRUSTED_HOSTS`、`DEEPSEEK_API_KEY`、`ZHIPU_API_KEY` |
| 启动与选集 | `DSH_BIND_HOST`、`DSH_PORT`、`DSH_PROFILE`、`DSH_PLUGINS`、`DSH_MODE`、`DSH_HOST_MODE` |
| 数据与路径 | `DSH_DATA_DIR`、`DSH_HOME`、`DSH_WORKSPACE`、`DSH_AUTH_URL_FILE`、`DSH_DEPLOY_ARTIFACTS` |
| 宿主与插件文件引用 | `DSH_HARNESS_ROOT`、`DSH_CLI_JS`、`DSH_CLI`、`DSH_PATCHES`、`DSH_INSTANCES` |
| 离线与缓存 | `DSH_OFFLINE`、`DSH_STORE_DIR`、`DSH_CACHE_DIR`、`DSH_OFFLINE_STORE_DIR`、`DSH_OFFLINE_CACHE_DIR` |
| 容器与独立交付 | `DSH_COMPOSE_PROJECT`、`DSH_CONTAINER_UID`、`DSH_CONTAINER_GID`、`DSH_HOST_IMAGE`、`DSH_PUBLISH_IMAGE`、`DSH_CONTAINER_IMAGE`、`DSH_MANIFEST`、`DSH_BASE_URL` |
| 可选镜像构建 | `HARBOR_ENABLED`、`ALLOW_UPSTREAM`、`REGISTRY_HOST`、`BASE_PROJECT`、`APP_PROJECT`、`IMAGE_NAME`、`REGISTRY_USERNAME`、`REGISTRY_PASSWORD`、`DSH_SOURCE_BASE_IMAGE`、`DSH_DEBIAN_MIRROR`、`DSH_IMAGE_PLATFORM` |

`DSH_INSTANCES` 仅支持按插件 ID 引用 `settingsFile`、`runtimeConfig` 和 `configRevision`。注册插件的业务参数继续由插件自己的 `plugin.json`、运行配置及 Schema 管理；框架不接管其密钥和业务规则。账号、会话、历史及官方动态模型设置也不迁入此文件。

镜像仓库账号和密码仅用于临时 Docker 登录，不传入 DSH。推送部署镜像时，凭据目标必须与 `DSH_PUBLISH_IMAGE` 的仓库主机一致；未填写凭据时沿用 Docker 已有登录。部署 JSON、Compose 和普通操作记录仅保存供容器读取的模型凭据文件路径与摘要，原值保存在 `.local/secrets/framework-credentials/` 的私有文件中，并以只读挂载提供给容器。备份恢复时须保留这些被引用的原文件，不要手改或清理它们。

<!-- excerpt:platform-defaults -->
Windows 使用 build.ps1，Linux/macOS 使用 build.sh。已有配置不覆盖；手工复制公共模板不探测平台。源码公共模板的 DSH_IMAGE_PLATFORM=linux/amd64，source 新站点根据 Docker 引擎初始化架构；Windows/Linux UID/GID 默认 1000，macOS 非 root 用户使用当前 UID/GID。archives 只选发行信息实际提供的镜像架构，未提供的架构拒绝，不回退构建源码。

两个入口都构建全部内置插件（source 用检出、archives 用随包公开构建视图），留空 DSH_PLUGINS 表示候选全集＝全部内置加全部 incoming；独立 CLI 使用显式清单；三者不能混用默认选集。incoming 只放外部作者的完整发布目录，与内置同 id 的目录会被组合清单拒绝。新 archives 可编辑插件配置位于 .local/config/plugins/<id>，通过已有 instances 引用；旧记录及显式 settingsFile/runtimeConfig 原样沿用，不自动迁移 home/plugins。

Docker 只接受本机 Linux 引擎 unix/npipe endpoint。Docker Desktop 使用桥接与 TCP 转发，原生 Linux 使用 host 网络；同 Docker 网络是信任边界，不能据此承诺公网隔离。macOS 尚未完成真实 Docker 部署验收，架构与平台以具体发行验收范围为准。本次所有命令固定到同一 endpoint，不要求历史引擎 ID 与本次一致。
<!-- /excerpt:platform-defaults -->

## 三种入口

| 入口 | 输入与默认行为 |
| --- | --- |
| 精简部署包 build | archives，从 incoming 直接子目录发现完整清单；不构建作者源码；镜像来自发行信息或显式完整不可变 containerImage |
| 框架源码 build | source，内置插件固定全量构建并合并 incoming 外部归档；不构建作者源码 |
| 独立 manager CLI | 显式 --root 与 --config/DEPLOYMENT_CONFIG；手填 manifest/运行镜像，不自动发现；保留 Node 和 Compose 操作 |

build 只允许 release。source 禁止手填 manifest/containerImage；archives 禁止手填 manifest，允许完整 containerImage，但不接受 hostImage/publishImage 或主动源码构建参数。插件来源不再是站点配置字段（旧 `DSH_PLUGIN_SOURCE` 已移除，旧站点先跑 migrate-site），由入口固定为「builtin 自动构建加 incoming 外部归档」。

站点 build 以文件为输入，不套用底层 CLI 的环境覆盖。基础 CLI 保持“参数→原对应环境变量→文件→默认值”；仓库 start.ps1 的显式 Mode 优先，无配置的旧 development 默认继续兼容。重试与失败语义见 deploy/README.md。

## 旧站点导入与恢复

默认入口首次发现没有 `.local/env.conf` 时，优先导入 `.local/site.json`，其次导入 `.local/deployment.json`，保留已解析的数据路径、profile 和原文件。旧 `hostImageConfig` 的镜像字段一并导入，之后以统一文件为准。无法表示的旧字段拒绝自动导入，可以继续显式传原 JSON，不能静默丢弃。

`.local/deployment.json`、清单、Compose 和官方 patch 是生成输入，不替代人工入口。站点目标与数据位置由 `.local/site-binding.json` 稳定绑定，每个持久目录根带 `.dsh-site-id` 标记；绑定或标记损坏必须通过 `dsh-plugin-manager migrate-site` 显式修复，普通 build 只读核对。旧 schema 2 受管状态经同一工具一次性迁移为 schema 3 managed 授权集合。配置格式导入不搬迁数据，更换数据路径仍须遵守[正式迁移流程](migration.md)。

## 插件配置与环境变量的生效路径

插件行为有三类输入，落点不同、优先级不同。改错落点最常见的现象是"配置写了却不生效"，或在下次发布后失效。

### 1. 插件配置：patch 与 settings 层

管理器把插件配置渲染成一串官方 patch，按顺序追加到已有 patch 之后，由 supervisor 逐个传给宿主 CLI 的 `--patch`。

| 落点 | 内容 | 覆盖语义 |
| --- | --- | --- |
| 站点配置 `patches` 列出的文件 | 使用者自己写的宿主 patch | 按声明顺序前置 |
| `instances.<id>.settingsFile`（默认 `<home>/plugins/<id>/plugin.json`）的 `config` | 该插件业务配置，管理器生成为**最后一层** patch | 同一 entry 的 `config` **整块替换**，不做深合并 |

两点必须记清：

- **整块替换**是同一 entry 内 `config` 的行为，不是"所有 patch 都无效"。不同 entry、同一 entry 的其它键仍按各自语义生效；只写 `config` 的一部分会丢掉同 entry 中未写的字段。
- patch 的 `id` 是**配置树中的 `entry.id`**，由插件 manifest 的 `configuration.entryId` 声明。它既不是 npm 包名，也不总等于插件注册名（`entry.id` 可以与注册 `name` 不同）。宿主报错只会提到 entry id，因此接入新插件时先确认它的 `entryId`。

### 2. 环境变量：继承环境优先于文件

宿主进程的变量按下列顺序取值，**只为尚未定义的变量赋值**，因此越靠前优先级越高：

1. 继承的进程环境（容器里即 Docker/Compose 传给容器的环境变量）；
2. 工作目录的项目 `.env`；
3. DSH home 下的 `.env`。

由此可以判断常见误解：

- **Docker 环境变量是生效的**，只要它真的进到了容器进程；"框架默认渲染的 Compose 是否提供某个变量"是另一个问题，与优先级无关。
- 反过来，写在工作区 `.env` 的变量在容器内也生效，因为容器的工作目录就是该工作区。
- 变量已在继承环境中定义时，写在 `.env` 里的同值不会覆盖它。

### 3. `runtimeConfig` 是文件，不是环境变量

`instances.<id>.runtimeConfig`（默认 `<home>/plugins/<id>/env.conf`）是给**插件自己读**的配置文件；它的路径通过声明的环境变量传给插件，不会自动变成任意 `process.env` 字段。要让某个值出现在 `process.env`，按第 2 条选择落点。

### 4. 何时需要重启

插件配置、环境变量与 patch 内容都在**容器启动时**读取。改完这些输入后需要一次受控重启（按部署流程停旧服务、重新应用并启动），运行中的容器不会自动拾取新值；只改业务数据文件、不动上述输入时无需重启。

### 5. 归档引用：部署后不要单独更新插件目录

发布把插件归档以**内容哈希**命名，追加复制到 `.local/artifacts/plugin-packages/` 缓存并按实际字节寻址，profile 的 `package.json` 以 `file:` 绝对路径钉住这些归档。归档集合与 profile 引用由部署流程一起改写。只替换归档目录而不重新部署，会让 profile 指向不存在的归档，容器安装阶段直接失败。失败后直接重新运行普通 build，不要手工改 profile。

## 独立 CLI 字段参考

以下路径相对于 `--root` 指定的仓库根目录，不相对于模板目录。已配置的 CLI 或环境变量可覆盖同名部署选项，应用示例前应核对当前 shell 的 `DSH_*`、`PLUGIN_MANIFEST_FILE` 和 `DEPLOYMENT_CONFIG`。

| 字段 | 是否必填 | 默认值 / 示例值 | 说明 |
| --- | --- | --- | --- |
| `profile` | 可选 | `web` | 官方 DSH profile；示例应用使用 web |
| `plugins` | 可选 | 模板 `["auth", "example"]` | 显式候选插件集合；使用发布清单时省略表示使用完整清单；与 enabled 的实例启停不同 |
| `manifest` | apply-compose 时必填 | `.local/artifacts/release/plugins/manifest.json` | 已验证归档清单；不能指向不存在的文件 |
| `mode` | 可选 | `release` | release 使用归档；源码 development 模式用于开发流程，独立 Docker 集成使用 release |
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

下列扩展选项需要实际资源或特定启动方式；使用时提供可核验的资源，不填写虚假路径。

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
