# Linux Docker 一键部署

一个完整的仓库检出目录管理一个 Linux Docker 站点。首次初始化与更新统一使用 `bash deploy/build.sh`，脚本根据保存的部署记录选择流程。依赖和镜像从服务器构建，不需要先提供旧镜像、发布清单或 Compose。部署直接使用仓库现有的官方宿主源码，不下载、更新、切换它，也不要求它与预设锁定版本一致。

## 首次部署

服务器需要 Git、Node.js `^22.19 || >=24`、npm、可用的 Linux Docker 引擎及 Compose 插件、tar 和 flock。Docker 需要支持多阶段构建与命名构建上下文。脚本自动在需要时安装仓库锁定的 pnpm；不会自动安装系统软件、修改防火墙或创建反向代理。执行用户必须有 Docker 权限，并能创建默认 UID/GID 1000 可访问的运行目录；以 root 执行时脚本只给新建目录设置所有者。

```sh
git clone --recurse-submodules https://github.com/PelyDeng/dsh-plugin-manager.git
cd dsh-plugin-manager
bash deploy/build.sh
```

源码检出阶段使用递归克隆带齐仓库提供的子模块；已有完整源码无需重复克隆。普通 Git 克隆只取得子模块版本引用，实际源码缺失时，部署脚本提示检出不完整，不自行补拉。镜像记录实际使用的源码提交，便于定位构建来源，不拿它与预设版本作准入比较。

默认选中 auth、example，使用本机镜像，监听 `http://127.0.0.1:7902`。构建依赖 npm、基础镜像和 Debian 软件源；本机依赖缓存和 Docker 缓存可以复用。首次完整构建比后续更新耗时更长。受限网络可通过 `hostImageConfig` 配置镜像源；预构建宿主是可选加速，不是初始化前置条件。

远程浏览器通过 SSH 端口转发访问，或配置反向代理后将 `publicOrigin`、`publicUrl` 改为实际访问 origin。设置自定义端口时同时调整这两个 URL。首次管理员及密码修改流程见 [auth 说明](../plugins/dsh-auth/README.md)。站点启动和登录不要求模型密钥；实际 AI 对话需按[部署说明](../deploy/README.md#运行配置)配置模型密钥。

本机访问 `http://127.0.0.1:7902/auth` 登录插件账号，`http://127.0.0.1:7902/example` 打开示例；根路径属于官方控制台，使用独立的官方认证地址。

## 首次登录与模型密钥

插件 `/auth` 登录、官方控制台 `/` 认证和模型 API 密钥分别管理。根路径提示 `dsh web authentication required; reopen the URL printed by dsh web.` 表示官方控制台尚未认证；录入 API 密钥不能消除此提示。

管理员在服务器的私有终端读取本次启动保存的认证地址，默认文件为 `.local/data/dsh-web-auth-url.txt`，再在自己的浏览器打开完整地址。自定义路径以 `.local/deployment.json` 的 `authUrlFile` 或实际 `dataRoot` 为准。该地址含控制台访问令牌，不要分享或截图；普通用户使用应用入口。具体步骤与地址失效处理见 [FAQ](FAQ.md#auth-登录后为什么根路径仍提示认证)。

使用官方 DeepSeek 提供方时，在服务器仓库根执行已有脚本，然后在提示后手动输入 API 密钥，按 Enter 保存：

```sh
bash deploy/scripts/set-api-key.sh --config .local/deployment.json
```

输入不回显，可用 Ctrl+C 取消。脚本只替换选定 DSH home 下 `.env` 中的 `DEEPSEEK_API_KEY`，保留其他设置；Linux 文件权限为 `0600`，首次创建沿用 home 的属主，已有文件保留属主。不要将密钥写在命令参数中。只有格式检查通过不代表密钥有效或模型可用。

脚本不选择模型、不调用模型，也不自动重启。管理员确认当前没有需要保留的进行中问答后，使用活动 Compose 配置重启服务，让宿主重新加载密钥：

```sh
compose_file=$(node -p "JSON.parse(require('node:fs').readFileSync('.local/artifacts/active-compose.json', 'utf8')).path")
compose_project=$(node -p "JSON.parse(require('node:fs').readFileSync('.local/deployment.json', 'utf8')).composeProject")
docker compose -p "$compose_project" -f "$compose_file" restart dsh
docker compose -p "$compose_project" -f "$compose_file" ps
```

等待容器 healthy，再进入官方控制台确认提供方与默认模型，在 `/example` 新建对话验证回答。其他提供方、环境变量覆盖和旧会话的注意事项见 [FAQ](FAQ.md#密钥已保存为什么问答仍然失败)；独立 CLI 部署按[模型准备](../packages/plugin-manager/DELIVERY.md#问答应用的模型准备)由原管理器 stop/start，不套用 Docker 命令。

## 配置归属

| 文件 | 谁维护 | 是否提交 Git |
| --- | --- | --- |
| `deploy/config/site.defaults.json` | 仓库维护者，通用默认值 | 是 |
| `.local/site.json` | 首次自动生成；部署者按需调整站点设置 | 否 |
| `.local/deployment.json` | 脚本生成，含本次镜像和发布清单 | 否 |
| `.local/data/dsh-home/plugins/<id>/plugin.json` | 首次生成；各插件的启停及认证设置 | 否 |
| `.local/artifacts/`、`.local/source-release.json` | 构建记录、备份、Compose 及恢复指针 | 否 |

无需手工创建 `.local/site.json`。已有 `.local/deployment.json` 时，脚本在首次生成站点文件时导入其设置，保留已解析的数据路径、profile、origin 和镜像发布仓库。已有站点文件以后不会被默认模板覆盖。`--config <文件>` 可显式选择另一个已有站点文件；文件不存在时报错，避免拼写错误部署出新站点。同一检出目录的状态仍只服务一个站点，多站点应使用独立检出目录和端口。

所有站点字段均可省略并采用默认值；提供的值必须合法。可选字段缺省不会阻止构建，非法端口、缺失的显式文件、错误插件依赖等配置错误会明确拒绝。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `profile` | `web` | 官方 DSH profile；已有站点切换需迁移 |
| `plugins` | `["auth", "example"]` | 构建的插件 ID 选集；`[]` 表示无业务插件 |
| `port` | `7902` | 回环监听端口，1–65535 |
| `publicOrigin`、`publicUrl` | `http://127.0.0.1:7902` | 实际访问 origin，无路径或尾部斜杠 |
| `composeProject` | `dsh-plugins` | 独占的 Compose 项目名 |
| `dataRoot` | `.local/data` | 持久数据根目录 |
| `home` | `.local/data/dsh-home` | DSH profile、插件配置及业务数据 |
| `workspace` | `.local/data/workspace` | 工作目录；上述路径独立配置，已有站点需显式迁移 |
| `artifacts` | `.local/artifacts` | 管理器生成 Compose 等产物；源码构建记录固定保存在检出目录 `.local/artifacts` |
| `containerUid`、`containerGid` | `1000` | 非 root 容器身份；已有目录不会自动改权 |
| `patches` | `[]` | 额外官方 profile patch；标准认证无需自行写 patch |
| `publishImage` | `null` | 可选 `registry/project/image`；设置后推送，执行前需 `docker login` |
| `hostImage` | `null` | 可选 `registry/image@sha256:…`；显式选用预构建宿主，无预设版本匹配要求 |
| `hostImageConfig` | `null` | 可选宿主构建 `.conf` 路径；格式见 `deploy/config/host-image.conf.example`，Linux 权限须为 0600 |

相对路径均从检出目录解析。`instances`、`authUrlFile`、离线源等高级选项沿用[管理器运行配置](../deploy/README.md#运行配置)。源码入口从站点文件读取部署选项，不使用基础管理命令的环境变量覆盖。模型密钥及插件密钥按各自文档保存在本机文件，不进入站点默认模板。

## 更新与恢复

```sh
git pull --ff-only --recurse-submodules
bash deploy/build.sh
```

更新代码时按需同步子模块；版本选择由源码维护者决定。部署从干净的已提交源码重新构建管理器及选中插件。宿主源码未变化时复用已有宿主层；本地宿主源码更新后构建新的镜像，不因此拒绝部署。构建和归档校验通过后，停止旧服务、备份原配置及持久挂载，再安装并等待健康检查。重复运行沿用已有插件设置和数据，不执行重置。

| 情况 | 行为与处理 |
| --- | --- |
| 第一次运行，没有部署记录和数据 | 生成站点文件、构建、初始化、启动 |
| 存在成功部署记录 | 检查项目与镜像一致性，构建后停服备份并更新 |
| 有旧数据但缺少活动部署记录 | 拒绝当作新站点；恢复记录或按迁移流程处理 |
| 构建失败 | 旧服务继续运行；修正错误后重复普通命令 |
| 备份命令失败 | 不应用新版本，尝试启动原服务；保留备份现场 |
| 构建完成后断电、安装或启动失败 | 保留同次镜像、归档、配置、备份；配置不变时执行下方恢复命令 |

```sh
bash deploy/build.sh --resume
# 使用过显式站点文件时，恢复仍传入同一个文件：
bash deploy/build.sh --config .local/my-site.json --resume
```

恢复不重建镜像和插件归档，重新核验保存的输入，并交给原管理器恢复安装。源码入口允许管理器在检测到宿主或 Node 等运行环境变化时预检并重装依赖；环境未变化时不会因该许可单独重装。若断电留下进程记录，必须先由 Docker 确认对应容器已停止且其 hostname、profile、home 挂载匹配，才能备存并解除残留记录，pending 保持原样。旧版无 hostname 的运行记录不支持自动解除，需由维护者核实原容器归属后处理。

不要删除 `.local`、pending 或数据目录来绕过失败；镜像、归档、站点文件已变化时保留现场处理。对新目标包进行数据兼容恢复属于基础管理器的显式运维流程，不由初始化自动推断。

脚本使用检出目录级 flock，部署期间不要并行操作同一站点的基础管理命令。备份保留在每次操作目录，脚本不自动清理；维护者需规划磁盘空间和备份保留周期。
