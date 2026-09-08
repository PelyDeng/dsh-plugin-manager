# Docker 一键部署

一个完整的框架仓库检出目录管理一个 Linux 容器站点。Windows 使用根 `build.ps1`，macOS/Linux 使用根 `build.sh`，首次初始化与更新共用同一流程；旧 `bash deploy/build.sh` 继续支持。依赖和镜像在执行脚本的机器构建。默认使用已有官方宿主源码，不下载、更新、切换它，也不要求它与预设锁定版本一致；也可显式提供不可变 `DSH_HOST_IMAGE` / `hostImage`，无需检出未使用的宿主源码。不需要人工准备发布清单或 Compose。

## 首次部署

需要 Git、Node.js `^22.19 || >=24`（含 npm）、可用的本机 Linux Docker 引擎及 Compose 插件和系统 tar。Windows 不依赖 Bash 或 flock；macOS/Linux 使用系统 Bash。Docker 需要支持多阶段构建与命名构建上下文。脚本自动在需要时安装仓库锁定的 pnpm；不会自动安装系统软件、修改防火墙或创建反向代理。执行用户必须有 Docker 权限。原生 Linux 默认使用容器 UID/GID 1000；macOS 新站点按当前非 root 用户初始化 UID/GID。实际挂载读写在停服前检查，已有目录不自动迁移或放宽权限。

```sh
git clone --recurse-submodules https://github.com/PelyDeng/dsh-plugin-manager.git
cd dsh-plugin-manager
./build.sh
```

Windows 将最后一行换成 `.\build.ps1`。在文件资源管理器打开仓库目录，选择“在终端中打开”并使用 PowerShell，即可执行该命令并保留完整输出；也可通过 `build.ps1` 的“使用 PowerShell 运行”菜单启动。需要传参数或查看失败原因时使用终端。在执行策略阻止运行时，可以仅为这一次调用执行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build.ps1`，不修改全局执行策略。

Docker 必须运行 Linux 容器，只接受本机 unix/npipe endpoint；远端 context、SSH/TCP endpoint 不属于本入口的部署范围。一次发布固定 Docker endpoint，并记录引擎身份和架构；切换引擎后不能直接继续原 `--resume`。Windows/macOS 以及 Linux 上的 Docker Desktop 使用 bridge：官方 DSH 仍监听 `127.0.0.1`，容器桥接 IPv4 地址的同端口通过 TCP 转发至它，宿主只向 `127.0.0.1` 发布端口。

同一 Docker 网络中的其他容器仍属于受信任范围，不能据此认定服务已与公网隔离；原生 Linux 引擎保留 host 网络。macOS 的实际 Docker 站点部署尚未完成真机验收；CI 测试不等同于部署验收。

使用宿主源码时，检出阶段用递归克隆带齐子模块；已有完整源码无需重复克隆。普通 Git 克隆只取得子模块版本引用，需要构建宿主而实际源码缺失时，脚本提示检出不完整，不自行补拉。镜像记录实际宿主提交，便于定位构建来源，不会因为它与预设版本不同而拒绝全量构建。

默认选中 auth、example，使用本机镜像，监听 `http://127.0.0.1:7902`。构建依赖 npm、基础镜像和 Debian 软件源；本机依赖缓存和 Docker 缓存可以复用。首次完整构建比后续更新耗时更长。受限网络可通过 `.local/env.conf` 的镜像字段配置镜像源；预构建宿主是可选加速，不是初始化前置条件。

远程浏览器通过 SSH 端口转发访问，或配置反向代理后填写 `DSH_PUBLIC_ORIGIN`、`DSH_PUBLIC_URL`，并在 `DSH_TRUSTED_HOSTS` 加入实际主机名。设置自定义端口时同时调整这两个 URL。首次管理员及密码修改流程见 [auth 说明](../plugins/dsh-auth/README.md)。站点启动和登录不要求模型密钥；实际 AI 对话需按[部署说明](../deploy/README.md#运行配置)配置模型密钥。

本机访问 `http://127.0.0.1:7902/auth` 登录插件账号，`http://127.0.0.1:7902/example` 打开示例；根路径属于官方控制台，使用独立的官方认证地址。

## 首次登录与模型密钥

插件 /auth 登录、官方控制台根路径认证和模型 API 密钥分别管理。根路径提示 `dsh web authentication required; reopen the URL printed by dsh web.` 时，在服务器私有终端读取本次启动生成的 `.local/data/dsh-web-auth-url.txt`，仅在自己的浏览器打开完整地址。自定义路径按生成的 deployment.json 的 authUrlFile 核对；不要分享其中的令牌，详情见 [FAQ](FAQ.md)。

框架模型密钥有两种管理方式：在私有 `.local/env.conf` 填写 `DEEPSEEK_API_KEY` / `ZHIPU_API_KEY` 时，以文件为准，对应密钥在网页只读，修改后受控重启；字段留空时沿用官方凭据，不删除已有值，也不清除继承环境覆盖。

没有环境覆盖时，管理员完成初始改密后可在 /auth 的“模型设置”管理 DeepSeek 或智谱。页面只返回状态与不可逆指纹，不返回密钥。命令行只支持 DeepSeek，在仓库根执行后隐藏输入：

```sh
bash deploy/scripts/set-api-key.sh --config .local/deployment.json
```

Windows 使用 `node deploy/scripts/set-api-key.mjs --config .local/deployment.json`，无需 Bash。

密钥不放进命令参数。网页和脚本复用官方凭据服务，保留其他凭据、账号和历史；默认官方文件监听使存储更新无需重启。文件或其他启动环境覆盖时拒绝写入。Compose 脚本核验活动容器与 home，以容器用户执行；独立 CLI 要以数据所有者运行，并指向已安装的兼容官方 CLI。自定义存储或关闭监听时使用当前运行服务的网页入口。

密钥保存不验证模型可用性、不创建路由、不选择默认模型。在同页上方的模型卡片选择新会话默认模型后会自动保存，无需重启；已有对话和分支保留官方记录中的模型选择。智谱等提供方需要在同一 DSH 的官方设置或 patch 中配置相应路由和凭据引用。随后在 /example 新建对话验收；详见[统一配置](framework-configuration.md)与[模型准备](../packages/plugin-manager/DELIVERY.md#问答应用的模型准备)。

## 配置归属

| 文件 | 用途 | 提交 Git |
| --- | --- | --- |
| 根 `env.conf` | 带中文注释和固定非秘密默认值的公开模板，真实站点值不得填入 | 是，受控默认值及必要空值 |
| `.local/env.conf` | 部署者维护的框架运行输入，常用配置排在前面 | 否 |
| `deploy/config/site.defaults.json` | 源码一键入口的通用默认值 | 是 |
| `.local/deployment.json`、清单及 Compose | 脚本生成的本次部署输入 | 否 |
| 各插件 `plugin.json` / runtimeConfig | 插件自己的启停、认证及业务配置 | 否，运行实例私有 |
| `.local/secrets/`、`.local/artifacts/` | 供进程读取的私有凭据文件、产物和部署记录 | 否 |

首次运行自动创建私有配置并填写实际默认值；已有文件不覆盖，旧 JSON 导入保留原文件和解析路径。通常只需核对公网 URL、trustedHosts 与所用模型凭据。端口为 7902、profile 为 web、插件为 auth/example；Windows/Linux 的容器 UID/GID 为 1000，macOS 非 root 用户采用当前 UID/GID；镜像架构按 Docker 引擎选择 amd64/arm64。

公开模板填写通用的 UID/GID 1000 和 linux/amd64；手工复制模板不会执行平台探测，须自行核对这些值。密钥、自动生成项及部分按其他配置计算的字段继续留空。完整键名与默认规则见[框架统一配置](framework-configuration.md)。

已有站点没有 env 文件时，优先导入旧 site.json，其次导入 deployment.json，保留原文件和已解析的数据路径。旧 hostImageConfig 的镜像配置一并导入，未知字段拒绝静默丢弃。显式 `--config <旧站点.json>` 仍兼容；生成的 deployment.json 不作为人工站点输入。未完成部署沿用原操作文件，恢复期间不迁移。

相对路径从检出目录解析，一个检出目录只管理一个站点。源码入口以文件为准，不套用基础管理器的环境变量覆盖。`DSH_MANIFEST`、`DSH_CONTAINER_IMAGE` 仅供独立归档部署，源码构建自动生成，必须留空。`DSH_PUBLISH_IMAGE` 可选；填写仓库账号时使用临时 Docker 登录且验证目标主机，留空凭据时沿用 Docker 已有登录。业务配置不集中到框架文件，见[插件配置规范](plugin-configuration.md)。

## 更新与恢复

默认更新重建全部部署插件。只需重建 c 时，可使用 `./build.sh --rebuild-plugins c`，Windows 使用 `.\build.ps1 --rebuild-plugins c`；多个 ID 用逗号分隔。保留站点完整插件选集，其余自动复用当前成功部署的归档。首次部署或来源不完整时先全量构建；共享源码、依赖或文档变化也可能要求全量，具体条件见[按需重建说明](../deploy/README.md#服务器源码发版)。公共组件、镜像和服务重启仍按现有流程执行。

按需复用支持两种宿主来源：未配置 `hostImage` 时要求与基线一致的干净宿主源码；显式不可变 `hostImage` 时以同一镜像摘要和成功记录中的宿主提交核验，不要求宿主源码目录存在。切换宿主来源或缺少可核实身份时先全量构建，不能靠补写发布记录绕过检查。

```sh
git pull --ff-only --recurse-submodules
./build.sh
```

Windows 将最后一行换成 `.\build.ps1`。更新代码时按需同步子模块；版本选择由源码维护者决定。部署从干净的已提交源码重新构建管理器及选中插件。宿主源码未变化时复用已有宿主层；本地宿主源码更新后构建新的镜像，不因此拒绝部署。镜像与归档准备完成后，先通过 `check-compose` 核验最终挂载和容器用户权限，再停止旧服务、核验原容器及其持久挂载，随后安装并等待健康检查。重复运行沿用已有插件设置和数据，不执行重置。源码更新不自动创建全量运行数据备份；发布记录、原归档及配置副本不能替代数据备份。需要数据恢复能力时，应在更新前独立备份并验证恢复，保留已有备份。

| 情况 | 行为与处理 |
| --- | --- |
| 第一次运行，没有部署记录和数据 | 生成站点文件、构建、初始化、启动 |
| 存在成功部署记录 | 检查项目与镜像一致性，构建后停服、核验并更新 |
| 有旧数据但缺少活动部署记录 | 拒绝当作新站点；恢复记录或按迁移流程处理 |
| 产物准备完成前构建失败 | 旧服务继续运行；正常报错退出后修正错误并重复普通命令 |
| 产物已标记 prepared，挂载或权限预检失败 | 尚未停止旧服务；修正挂载访问条件、保持原配置与产物不变，然后执行 `--resume` |
| 停服核验失败 | 不应用新版本，尝试启动原服务；保留发布记录 |
| 构建完成后断电、安装或启动失败 | 保留同次镜像、归档和配置；配置不变时执行下方恢复命令 |

```sh
./build.sh --resume
# 使用过显式站点文件时，恢复仍传入同一个文件：
./build.sh --config .local/env.conf --resume
```

Windows 使用 `.\build.ps1 --resume` 或 `.\build.ps1 --config .local/env.conf --resume`。恢复不带 `--rebuild-plugins`，使用该次保存的完整清单和镜像。原先显式使用旧 JSON 时，恢复仍传原 JSON。私有操作目录中的 `framework-input.conf` 备存本次 env 原始字节；输入误改时先恢复原文件再 resume，不自动切换来源。

恢复不重建镜像和插件归档，重新核验保存的输入，并交给原管理器恢复安装。源码入口允许管理器在检测到宿主或 Node 等运行环境变化时预检并重装依赖；环境未变化时不会因该许可单独重装。若断电留下进程记录，必须先由 Docker 确认对应容器已停止且其 hostname、profile、home 挂载匹配，才能备存并解除残留记录，pending 保持原样。旧版无 hostname 的运行记录不支持自动解除，需由维护者核实原容器归属后处理。

不要删除 `.local`、pending 或数据目录来绕过失败；镜像、归档、站点文件已变化时保留现场处理。对新目标包进行数据兼容恢复属于基础管理器的显式运维流程，不由初始化自动推断。

三个平台共用检出目录级 `.local/source-release.node.lock`；Linux shell 同时保留可用的旧 `flock` 互斥。构建子进程通过 IPC 报告完成、退出码一致且没有中断时，才自动释放源码锁，普通构建报错也可正常重试。

强制终止、断电或完成证明缺失时会保留锁。先在仓库根执行 `bash build.sh doctor` 查看状态，再用 `bash build.sh unlock-source` 核验相关进程已经退出，并备份后解除源码锁。Windows 对应命令为 `.\build.ps1 doctor` 和 `.\build.ps1 unlock-source`。旧锁缺少身份信息或无法确认进程已退出时，命令会拒绝解锁，按[源码锁恢复说明](../deploy/README.md)处理。

不要直接删除 Node 锁、旧 `.local/source-release.lock`、profile 锁或 pending；管理器的 `unlock` 只处理 profile 锁。部署期间仍不要并行操作同一站点的基础管理命令。

`--resume` 继续同一次部署，不自动回滚业务数据。恢复时须保留同一 Docker 引擎、原始输入与不可变镜像。
