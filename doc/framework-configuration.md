# 框架统一配置

根目录 [env.conf](../env.conf) 是可提交的公开默认值模板，每项有中文注释；固定非秘密默认值已直接填入。运行时使用 Git 忽略的 `.local/env.conf`，通常只需核对访问地址、信任域名和所用模型密钥。真实域名、账号、密码和密钥只填私有文件，不能写入公共模板。

## 首次填写

源码新站点直接执行 Windows 的 `./build.ps1` 或 macOS/Linux 的 `./build.sh`，脚本自动创建私有配置，写入本次平台的实际默认值。已有 `.local/env.conf` 不覆盖；旧站点先由部署入口导入旧 JSON，保留原路径和文件。

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

文件按字面量 `KEY=VALUE` 解析，不执行 shell，不展开变量；数组和对象使用单行 JSON，含引号的字符串可用 JSON 字符串表示。重复字段、未知字段或非法类型会拒绝。相对路径从显式项目 root 解析。Linux/macOS 私有输入必须是普通文件且权限为 `0600` 或更严格；Windows 通过 ACL 保护新建的框架私有配置、凭据投影、日志和备份。已有用户文件及数据目录不会被递归改权，手工提供的私有输入仍需部署者限制其 ACL。

## 密钥由谁管理

| 文件字段 | 实际行为 |
| --- | --- |
| 非空 | 文件值只注入官方 DSH 子进程；覆盖其继承的同名密钥，网页与 DeepSeek 写入脚本只读。修改后按正常部署流程受控重启。 |
| 留空 | 不注入、不删除官方凭据，也不清除启动环境的同名值。沿用官方凭据来源；没有环境覆盖时可继续网页管理。 |

`/auth` 的模型设置支持 DeepSeek 和智谱，`set-api-key` 命令只管理 DeepSeek。网页和脚本写入官方存储时，默认宿主通过自身凭据服务/文件监听生效，无需重启；自定义存储或关闭监听时使用当前运行服务的网页入口。文件模式不会把密钥导入 `.credentials.yaml`。由非空改为空并重启后，会重新使用官方已有来源，不表示删除旧密钥；若启动环境仍注入同名值，网页仍只读。

密钥不会创建模型路由、选择默认模型或验证额度。特别是智谱，需要在同一 DSH 实例的官方设置或 patch 中配置模型与凭据引用。真实问答须单独验收。

## 配置范围与默认值

完整字段以根模板为准。固定默认值直接填写，派生值、可选输入、秘密和生成项按注释留空；空值不等于没有默认行为。

| 项目 | 公开模板中的值或规则 |
| --- | --- |
| 访问与监听 | `DSH_PUBLIC_URL=http://127.0.0.1:7902`、`DSH_BIND_HOST=127.0.0.1`、`DSH_PORT=7902`；origin 留空时从 URL 派生，信任域名按实际访问填写 |
| 启动与存储 | profile `web`、插件 `["auth","example"]`、mode `release`、数据根 `.local/data`、产物根 `.local/artifacts` |
| 工具与容器 | CLI `dsh`、patches `[]`、offline `false`、Compose 项目 `dsh-plugins`、UID/GID `1000` |
| 镜像 | 平台 `linux/amd64`、基础镜像 `docker.io/library/node:24-bookworm-slim`；Harbor 关闭，上游回退开启 |
| 保持留空 | 模型密钥、仓库账号密码、生成的镜像/manifest、可选宿主来源；home/workspace/authUrlFile 等从入口与数据根派生 |

模板中的 auth/example 选集用于源码示例站点。独立归档消费按自己的清单调整；留空选集沿用发布清单。手工更改端口不会同步改写已填的 URL，需同时核对。

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

镜像仓库账号和密码仅用于临时 Docker 登录，不传入 DSH。推送部署镜像时，凭据目标必须与 `DSH_PUBLISH_IMAGE` 的仓库主机一致；未填写凭据时沿用 Docker 已有登录。部署 JSON、Compose 和普通操作记录仅保存模型凭据投影的文件路径与摘要，原值保存在 `.local/secrets/framework-credentials/` 的私有文件中，并以只读挂载提供给容器。备份恢复时须保留这些被引用的原文件，不要手改或清理它们。

源码入口自动创建新站点配置时，`DSH_IMAGE_PLATFORM` 按本机 Docker 引擎选择 `linux/amd64` 或 `linux/arm64`，并写入私有文件；Windows/Linux 的容器 UID/GID 为 1000，macOS 非 root 用户采用当前 UID/GID。公共模板和独立镜像入口的通用平台值仍为 `linux/amd64`。已有文件、显式值及旧站点导入值保持，不重新套用新默认值，也不会迁移或递归改权旧数据。Docker endpoint 与引擎身份记录在生成的发布记录中，不能切换引擎后继续原恢复操作。

## 三种入口

| 入口 | 选取规则 |
| --- | --- |
| 源码根 `build.sh` / `build.ps1` | 默认读取或初始化 `.local/env.conf`；默认 release、auth/example、本机镜像。兼容 deploy 目录入口和显式旧站点 JSON。源码构建自动生成 manifest/containerImage，对应 env 字段必须留空。 |
| 仓库 Windows `deploy/scripts/start.ps1` | 未显式指定配置且没有 `DEPLOYMENT_CONFIG` 时使用已有 `.local/env.conf`。有配置时遵从配置 mode，缺省 release；无配置保留 development 默认值。显式 `-Mode` 优先。 |
| 独立 manager CLI | 显式 `--root`，通过 `--config` 或 `DEPLOYMENT_CONFIG` 选择 env/JSON；不自动扫描作者仓库。默认 release，插件选集留空沿用发布清单；独立 Compose 必须提供不可变镜像。 |

基础 manager 的参数优先级保持“显式 CLI 参数 → 原有对应环境变量 → 文件 → 默认值”；源码一键入口按站点文件生成部署输入，不套用这一环境覆盖。API 密钥使用上文专门规则。

## 旧站点导入与恢复

默认入口首次发现没有 `.local/env.conf` 时，优先导入 `.local/site.json`，其次导入 `.local/deployment.json`，保留已解析的数据路径、profile 和原文件。旧 `hostImageConfig` 的镜像字段一并导入，之后以统一文件为准。无法表示的旧字段拒绝自动导入，可以继续显式传原 JSON，不能静默丢弃。

`.local/deployment.json`、清单、Compose 和官方 patch 是生成输入，不替代人工入口。已有未完成部署继续使用原操作记录中的文件，不在恢复期间迁移格式。`--resume` 要求原输入和凭据投影未变化；源码操作目录的 `framework-input.conf` 保存本次 env 原始字节；原文件丢失时从此私有备份恢复到原路径，不用新密钥重建旧操作。配置格式导入不搬迁数据，更换数据路径仍须遵守[正式迁移流程](migration.md)。
