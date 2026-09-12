<!-- Generated from deploy/DEPLOYMENT.md.tmpl by scripts/version.mjs; edit the template. -->

# DSH Plugin Manager 0.16.3 部署包

本目录是可独立使用的框架部署包，不需要作者源码或框架 Git 检出。先准备 Node，再按下列步骤部署标准插件产物。运行依赖和固定宿主镜像仍可能需要网络，离线阅读不等于离线安装。

## 放入产物并启动

<!-- Excerpt from doc/first-deployment.md.tmpl#deployment-start; edit its source. -->
从同一个框架 Release 取得 `dsh-plugin-manager-deployment-0.16.3.zip` 并解压。准备 Node.js `^22.19.0 || >=24`、系统 tar、本机 Linux Docker 引擎及 Compose；不自动安装系统软件。镜像架构必须有该版本实际提供的运行镜像，不使用未验证的默认摘要。

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

## 配置与平台

<!-- Excerpt from doc/framework-configuration.md#platform-defaults; edit its source. -->
Windows 使用 build.ps1，Linux/macOS 使用 build.sh。已有配置不覆盖；手工复制公共模板不探测平台。源码公共模板的 DSH_IMAGE_PLATFORM=linux/amd64，source 新站点根据 Docker 引擎初始化架构；Windows/Linux UID/GID 默认 1000，macOS 非 root 用户使用当前 UID/GID。archives 只选发行信息实际提供的镜像架构，未提供的架构拒绝，不回退构建源码。

source 默认 auth/example；archives 默认发现完整 incoming；独立 CLI 使用显式清单，三者不能混用默认选集。新 archives 可编辑插件配置位于 .local/config/plugins/<id>，通过已有 instances 引用；旧记录及显式 settingsFile/runtimeConfig 原样沿用，不自动迁移 home/plugins。

Docker 只接受本机 Linux 引擎 unix/npipe endpoint。Docker Desktop 使用桥接与 TCP 转发，原生 Linux 使用 host 网络；同 Docker 网络是信任边界，不能据此承诺公网隔离。macOS 尚未完成真实 Docker 部署验收，架构与平台以具体发行验收范围为准。恢复时核对同一引擎，不能切换 endpoint 后沿用原记录。

站点地址和选集编辑 `.local/env.conf`；全新 archives 插件参数编辑 `.local/config/plugins/<id>/plugin.json` 或所声明的运行文件，以错误提示的实际路径为准。域名部署同时填写 `DSH_PUBLIC_URL`、`DSH_PUBLIC_ORIGIN`、`DSH_TRUSTED_HOSTS`；不自动配置代理。生成的 deployment.json、清单和快照不手改。

## 登录与请求

<!-- Excerpt from doc/getting-started.md.tmpl#first-login; edit its source. -->
需要认证的应用先确认已选入并启用 auth，再访问实际站点的 /auth；无认证应用跳过登录。空数据库首次管理员为 admin，初始密码 123456；首次登录按页面强制改密，然后重新登录。此后创建普通账号，为它勾选目标插件授权，再用该普通账号登录。

鉴权起步插件的实际请求为 /independent-access-example/identity，成功返回含 owner 的 JSON；匿名或无该应用授权的账号不应取得身份结果。无 kit 的起步插件请求 /independent-example/ready，成功返回其 README 定义的就绪 JSON。测试身份端点不需要模型。

已部署 example 时，普通账号打开 /example；尚未配置模型可点击“阅读 FAQ（无需模型）”，指南仍需应用授权，但不创建 Agent 或调用模型。配置自己的模型后新建对话，确认真实流式回答及历史恢复。/auth 登录、官方根路径认证和模型 API 密钥分别管理，不能用填模型密钥修复根路径的认证提示。健康检查、登录和真实模型调用分别验证。

## 模型凭据

部署包运行不要求 pnpm，启用 auth 时可使用 /auth 的网页管理。下面的 pnpm 命令仅供已另外安装独立 CLI 工具的维护者使用。

<!-- Excerpt from doc/framework-configuration.md#model-credentials; edit its source. -->
私有 .local/env.conf 中的 DEEPSEEK_API_KEY / ZHIPU_API_KEY 非空时：文件为准，只注入官方DSH子进程，网页只读；改文件后受控部署。留空不添加覆盖、不删除官方凭据、不清除继承环境密钥。没有外部环境覆盖时，管理员可在 /auth 的“模型设置”管理 DeepSeek/智谱，写入官方存储时默认无需重启。

网页只返回状态与 SHA-256 指纹，不返回原密钥。指纹不能还原密钥；“已配置”不代表余额、网络或调用通过。命令行 set-api-key 只支持 DeepSeek，密钥使用隐藏输入，不放在 argv。在安装 manager 的工具目录使用 `pnpm exec dsh-plugin-manager set-api-key --root <站点根> --config .local/deployment.json`。

已有源码仓库可使用 `bash deploy/scripts/set-api-key.sh --config .local/deployment.json`；Windows 使用 `node deploy/scripts/set-api-key.mjs --config .local/deployment.json`。这些源码包装器不属于独立起步项目。Compose 核验当前容器与 home 后以实际用户写入；独立 CLI 指向已安装的兼容宿主。默认凭据服务/监听关闭或自定义时，通过当前服务的网页入口管理。

模型默认值由同一宿主的官方 agentDefaultModel 提供；管理员选择新会话默认模型无需重启。已有会话及分支按官方记录恢复，模型选择为 pending ?? lastUsed，读取或投影失败拒绝恢复，不用新默认覆盖旧记录。凭据不会创建提供方路由，健康探针不调用模型；实际问答另验收。

## 更新插件或框架

<!-- Excerpt from doc/first-deployment.md.tmpl#deployment-update; edit its source. -->
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

## 失败后的操作

<!-- Excerpt from deploy/README.md#site-recovery; edit its source. -->
归档、公共配置结构或认证提供者缺失在停服前报告。插件业务 Schema 可能在加载时才检查；健康通过仍需实际业务请求。保留 .local/data、.local/artifacts、incoming 和用户备份，不通过删除状态重新初始化。

| 情况 | 在站点根执行 |
| --- | --- |
| 尚未 prepared 的准备失败 | 修复错误后 `bash build.sh` |
| prepared 后临时网络、权限或挂载失败 | 原输入不变，`bash build.sh --resume` |
| 同一插件包的业务配置错误 | 编辑指出的原文件，`bash build.sh --recover --data-compatible` |
| 遗留站点发布锁 | `bash build.sh doctor` 查看归属，确认进程退出后 `bash build.sh unlock-source` |

Windows 用 `.\build.ps1` 替代 bash build.sh。--resume、--recover、--rebuild-plugins 互斥；--data-compatible 只能随 recover。doctor 只读诊断锁和记录，不要求 Docker/kit，也不是完整的安装环境扫描。

resume 使用保存的工具、镜像、归档和配置副本；原受管配置被修改时拒绝。prepared 前不为新站点创建 data/home，之后即使挂载预检尚未停服就失败，也通过 resume 沿用已记录归属。

recover 只修正新 schema 3 失败操作的 plugin.json.config 或 runtimeConfig，保留包摘要、选集、认证控制字段、镜像、工具和站点路径。--data-compatible 是部署者确认当前包可继续读取现有数据，不是自动备份或兼容证明。新候选保留前序失败快照；再次临时失败用 resume，继续改业务配置则再显式 recover。

恢复会核对安装状态和 pending 是否确属前序站点候选；仅包名和摘要相同不足以接管另一操作。尚未写出 pending 时也须与保存的前序状态证据一致，不能手工替换状态或把其他站点的记录移入当前目录。

需要换修复包、宿主或工具不属于这一高层快捷恢复；保留现场并由维护者核查底层高级修复与数据兼容流程，不自行删锁、改记录或删数据。旧 schema 2 使用其原环境与兼容恢复证据，不能伪造新快照。恢复只继续部署，不回滚业务数据；发布归档和配置副本不能代替独立数据备份。

## 进阶资料

本 README 的操作正文来自框架固定公开维护源，由同一文档同步生成。进一步查阅该版本的[配置规范](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.3/doc/framework-configuration.md)、[运维说明](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.3/deploy/README.md)及[独立 CLI 指南](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.3/packages/plugin-manager/DELIVERY.md)。这些链接不保证比已安装版本更新；本目录 `framework-runtime.json` 记录实际配套运行镜像身份。
