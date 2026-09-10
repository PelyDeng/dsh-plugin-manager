<!-- Generated from doc/first-deployment.md.tmpl by scripts/version.mjs; edit the template. -->

# 插件产物一键部署

把作者交付的标准发布目录放进框架部署包，执行 build 即可部署。部署机器不需要作者源码、kit 或插件构建工具链。本文适用于框架 **0.16.0**；框架源码用户见[源码部署](../deploy/README.md#服务器源码发版)，只安装 manager 的用户见[手工 CLI 交付](../packages/plugin-manager/DELIVERY.md)。

## 首次部署

<!-- excerpt:deployment-start -->
从同一个框架 Release 取得 `dsh-plugin-manager-deployment-0.16.0.zip` 并解压。准备 Node.js `^22.19.0 || >=24`、系统 tar、本机 Linux Docker 引擎及 Compose；不自动安装系统软件。镜像架构必须有该版本实际提供的运行镜像，不使用未验证的默认摘要。

每个作者交付的是一个完整目录，包含 manifest.json 和它引用的全部 tgz。将它放在部署根的 incoming 直接子目录中：

```text
dsh-deployment/
├─ build.ps1 / build.sh
├─ tools/                       随包管理器，不手改
├─ framework-runtime.json       固定运行镜像信息，不手改
├─ optional/auth/               按需使用的认证发布目录
├─ incoming/
│  └─ my-plugin/
│     ├─ manifest.json
│     └─ my-plugin-<摘要>.tgz
└─ .local/                      运行后创建，保留配置和数据
```

在部署根执行 `bash build.sh`；Windows PowerShell 执行 `.\build.ps1`。普通 zip/tgz 单文件不能代替完整发布目录。需要认证时，将 optional/auth 整个目录复制到 incoming/auth，保留自己的应用。不要删除组合清单中某个归档来挑选插件。

首次自动创建 .local/env.conf。新 archives 站点的可编辑业务配置在 .local/config/plugins/<id>/，错误提示会给出实际文件、插件 ID、已知缺项和下一条命令。填写真实必需参数后再执行同一个 build；已有配置不覆盖。无必需业务配置的最小插件应一次执行完成。业务 Schema 错误可能在加载阶段才发现，不能把模板存在当作配置正确。

成功输出访问地址、选中插件、声明探针结果及发布记录。未声明探针的 not-provided 表示未提供业务就绪检查。默认本机地址为 http://127.0.0.1:7902；实际请求和响应还需按插件 README 验证。
<!-- /excerpt:deployment-start -->

发行附件见 [GitHub Releases](https://github.com/PelyDeng/dsh-plugin-manager/releases)。部署包自带可执行 manager，依赖安装仍可能需要网络或完整缓存。镜像含官方 DSH 和匹配 manager；它不包含业务数据，也不保证任意社区插件兼容。

仅支持本机 unix/npipe Docker endpoint 的 Linux 容器。原生 Linux 使用 host 网络；Docker Desktop 使用 bridge，容器地址的同端口通过 TCP 转发至 DSH 的回环监听，宿主仅向回环发布。macOS 真机或 ARM 镜像未验证时，以该 Release 的明确范围为准；不把 CI 等同于现场部署。

## 首次登录与模型密钥

无 kit 的起步插件：请求 `/independent-example/ready` 并核对其 README 中的 JSON。带认证的起步插件：先复制 optional/auth，再访问 `/auth` 完成初始管理员改密、重新登录、普通账号授权，最后请求 `/independent-access-example/identity`。详细操作见[首次登录与请求](getting-started.md#4-登录并体验问答)。

`/auth` 的账号、官方控制台根路径认证、模型 API 密钥各有用途。需要 AI 问答时再配置模型，见[模型与凭据规则](framework-configuration.md#密钥由谁管理)；仅登录或 identity 请求不需要模型。密钥不放进插件 config 或命令参数。

## 配置归属

| 位置 | 操作方式 |
| --- | --- |
| .local/env.conf | 站点地址、选集等人工输入；真实值不入 Git |
| .local/config/plugins/<id>/ | 全新 archives 站点的 plugin.json/runtimeConfig，按提示编辑 |
| 旧站点或显式 instances 路径 | 沿用原位置，不因换入口自动迁移 |
| .local/deployment.json、artifacts 内清单/Compose/快照 | 自动生成，不手改 |
| .local/data | 账号、会话、业务数据，沿用与独立备份 |
| incoming | 完整候选发布目录，框架不自动清空 |

公网访问应配置代理或 SSH 转发，并核对 `.local/env.conf` 的 public URL、origin、trusted hosts；自定义端口时同步核对 URL。字段及 source/archives/CLI 默认值差异只在[框架配置](framework-configuration.md)维护。新部署包默认 archives，全新源码检出默认 source，不能把源码模板的 auth/example 默认选集复制到新产物站点。

## 更新与恢复

<!-- excerpt:deployment-update -->
incoming 是期望保留的完整集合，不是一次性投递队列。新增插件放一个新的完整目录；更新则整体替换对应目录，保留其他应用。一个清单含多个插件时整体更换，不覆盖合并新旧文件。重复 ID/包名会报错，不自动挑“最新版本”。

先在 incoming 外解压并核对新发布目录；停止编辑和并行 build。下面假设 my-plugin 是原目录，incoming 外的 next/my-plugin 是准备好的完整新目录，backups/my-plugin-v1 尚不存在。

Windows PowerShell，在部署根执行：

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
Move-Item -LiteralPath incoming/my-plugin -Destination backups/my-plugin-v1
Move-Item -LiteralPath next/my-plugin -Destination incoming/my-plugin
.\build.ps1
```

Linux，在部署根执行：

```sh
mkdir -p backups
test ! -e backups/my-plugin-v1 && mv incoming/my-plugin backups/my-plugin-v1
test ! -e incoming/my-plugin && mv next/my-plugin incoming/my-plugin
bash build.sh
```

每个命令失败后先修复，不继续执行后续步骤；不要删除原目录或数据来重试。build 在停服前显示新增、更新、保留和停用。移走仍启用的插件产物会拒绝，不等于卸载。停用配置型插件先设 enabled=false 并成功部署，再移走其产物；其他插件用 DSH_PLUGINS 显式列出保留集合。留空选集为全部发现项，[] 才是明确空集合。

框架升级在同一站点 root 替换公开脚本、tools、framework-runtime.json、optional 资源和公开模板；incoming/.local 原样保留。optional/auth 更新不会自动替换 incoming 中正在部署的 auth。未完成操作沿用保存的原工具、镜像和输入，先按恢复流程处理。
<!-- /excerpt:deployment-update -->

| 情况 | 下一步 |
| --- | --- |
| 归档/静态配置检查失败，尚未 prepared | 按错误修复后普通 build |
| prepared 后临时网络、权限或挂载错误 | 保持原受管配置，`bash build.sh --resume` |
| 需修改同一个插件包的业务配置 | 修改错误提示指出的原文件，`bash build.sh --recover --data-compatible` |
| 需要替换错误插件包 | 不属于本次高层快捷恢复；保留现场，查运维指南 |
| 遗留锁 | 先运行 build doctor，按归属证据解锁；不删状态 |

Windows 将上述 `bash build.sh` 换为 `.\build.ps1`。`--data-compatible` 是部署者明确确认同包可使用现有数据，不是框架证明兼容或自动备份。完整恢复、旧记录与按需重建规则见[部署与管理](../deploy/README.md)。
