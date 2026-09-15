# 部署与管理

部署已经打好的插件，优先使用[产物一键部署](../doc/first-deployment.md)。本文维护源码构建、按需复用和站点恢复规则；只安装 manager 时的手工 CLI 操作保留在其随包 [DELIVERY](../packages/plugin-manager/DELIVERY.md)。

产物合规是**交付前**的事，不在部署时重复检查：作者打包后执行 `dsh-plugin-manager verify-release --release <发布目录>`（只读、可进 CI，退出码 0 表示合规）自检清单格式、产物摘要、包结构与元数据一致性，再把整个发布目录交给部署者。类型检查用 `check`，归档与源码一致用 `verify-package`；pack 只构建、打包并做内容寻址，不附赠任何检查。作者与部署者的分工和产物约定见[框架配置](../doc/framework-configuration.md)与[一键部署](../doc/first-deployment.md)。

## 服务器源码发版

Windows 使用根 `.\build.ps1`，macOS/Linux 使用 `bash build.sh`；`deploy/build.ps1` 与 `deploy/build.sh` 转发到同一入口。完整源码检出默认 source，使用已有官方宿主源码和锁定依赖，不自动克隆、拉取或切换宿主。需 Node.js `^22.19.0 || >=24`、npm、Git、tar、本机 Linux Docker 与 Compose；脚本只按需准备锁定 pnpm，不安装系统软件。

```sh
git clone --recurse-submodules https://github.com/PelyDeng/dsh-plugin-manager.git
cd dsh-plugin-manager
bash build.sh
```

后续自行确认更新源码，再运行同一 build。源码操作使用已提交输入；正常全量构建准备 manager、选中业务插件和宿主镜像，不要求宿主等于预设 gitlink，但记录实际提交。仅指定 publishImage 时推送镜像；默认使用本机不可变镜像 ID。宿主升级约束见[兼容说明](../doc/host-compatibility.md)。

首次创建 .local/env.conf，已有文件不覆盖；旧 JSON 导入保留解析后的数据路径。源码默认启用 auth/example，精简部署包默认 archives 并发现 incoming 全集。显式改为 archives 后，不构建 plugins/*；源码树中缺少工具时只准备 manager 工具依赖。两种模式不混合输入，字段规则见[框架配置](../doc/framework-configuration.md)。

### 内置构建与外部产物

<!-- excerpt:source-rebuild -->
内置插件（`plugins/builtin/`）由根 build 在只含公开输入的构建视图里**固定全量**构建，不再按旧成功记录逐插件复用；外部/私有插件由作者自行打包成完整发布目录放入 incoming，缺外部归档时在停旧前报错，绝不回退构建作者源码。部署选集仍由 `DSH_PLUGINS`/站点配置控制，构建某个插件不表示启用它。

内置构建只使用框架发行方的完整公开构建输入（`packages`、`plugins/builtin`、`scripts`、`deploy`、`integrations`、`examples`、`doc`、`.github` 与公开根文件），不在私有全 workspace 安装、不触发 external 脚本；两类产物合并为一份安装计划，共用安装启动健康流程。

普通 build 每次从当前现场重新收敛，没有 resume/recover/--rebuild-plugins：准备失败不触旧服务；停旧失败不改安装层；包增删或安装验证失败保留授权与安装层；启动或探针失败停止本次候选。修正输入后直接重新运行 build。旧站点升级先执行 `dsh-plugin-manager migrate-site --root <站点根> --config <配置>` 预览，确认后加 `--apply --stopped-file <停写证据>`（物理搬迁用 `--rebind`）完成一次性迁移。

迁移在站点锁与 profile 锁下执行，并只补写能证明属于同一次未完成转换的现场。取锁、退役残留锁与显式解锁共用同一把 control 锁（`<profileRoot>/.deepseek-plugin-lock.control`）：残留锁只有在能证明持有者已退出时才退役——本机记录要求 PID 已退出，容器来源要求停写证据声明 compose 且本机引擎上没有任何运行中容器在写同一批持久目录；来源不明时保留记录并提示人工移出 profile 目录。声明的管理者是 compose 时，停写证据本身也会核对本机引擎上的重叠写入者，不接受「只停了声明的那一个容器」。

旧 profile 里指向旧归档挂载的 `file:` 引用会在写任何新元数据之前保全；旧活动记录不可读或缺少时，用 `--archive-root <旧归档主机目录>` 明确原位置。迁移步骤与回退见随包维护的迁移文档。
<!-- /excerpt:source-rebuild -->

### 日志与锁

终端显示阶段、实际耗时和日志路径；运行中的百分比仅为等待提示。重定向输出只记录开始及结果，详细日志在 `.local/artifacts/build-logs/`。同目录的 `timings.json` 是终端那张表的机器可读版本（逐步耗时、墙钟与逐项相加、退出状态、本次框架版本、输入形态、构建平台与目标架构、包管理器）：`wallMs` 与终端「墙钟」同一口径（首个阶段开始到末个阶段结束），`sumMs` 对应「相加（逐项）」，`processMs` 另外给出首个阶段到构建进程退出的全程，用来发现末个阶段之后的收尾耗时。失败也会写，排查「哪一步慢」先看它的 `stages`（未结束的阶段标成 `unfinished`），或直接运行 `check-records` 读取末次构建最慢的几个阶段。这份记录由发布记录里的 `timings` 指针引用，指针只是尽力而为：构建日志目录被清理后读不到，诊断会照常返回、不报错。失败后保留实际错误，不用进度百分比推断已完成的数据比例。

一次发布里同一份发布清单会被加载多遍（上一次发布的清单、复用判定、合并后的清单）。部署读路径只做操作边界检查：清单可解析、身份唯一、路径与归档成员不越界、实际包名与版本来自归档本身；完整合规校验（清单与包内元数据一致、verifyFiles 完备性、exports 等）由作者侧 verify-release 承担，不在这里重复。作者摘要写错不阻断安装，内部寻址与记录用归档实际字节摘要；损坏或被换掉的包在按字节读取时直接失败，不会被旧的「摘要比对」掩盖。

站点发布锁保护来源准备与部署；profile 安装锁保护安装事务，职责不同。保留 source-release.node.lock/control.lock 与 Linux flock 兼容路径。worker 报告完成且正常退出才释放外层锁，强制终止时保留证据。源码 beforeBuild hook 仅在正常 source 构建触发，archives/resume/recover 均不更新源码。入口先校验模式、静态字段及未完成操作，再允许 hook 准备源码；非法配置或尚需恢复的操作不会触发私有源码同步。帮助和 doctor 使用轻量入口，不先安装框架依赖或启动 Docker。

## 运行配置

日常只编辑 .local/env.conf 和实际插件配置，deployment.json、清单、Compose、patch 由编排生成。root 从脚本位置明确传入；独立 CLI 必须指定 --root，不从工具安装目录猜项目根。完整字段、入口默认和凭据优先级只在[框架配置](../doc/framework-configuration.md)维护。

source/archives 切换须无未完成操作，核验原 home/profile/引擎/归属及旧归档。已有实例 settingsFile/runtimeConfig 原样沿用，不自动迁移。数据路径调整按[迁移流程](../doc/migration.md)处理。

插件配置、环境变量和 patch 都在容器启动时读取，改完需要一次受控重启才会生效。改哪一层、几层之间谁覆盖谁、环境变量按什么顺序取值，只在[框架配置](../doc/framework-configuration.md#插件配置与环境变量的生效路径)维护；插件字段本身见[插件运行配置](../doc/plugin-configuration.md)。此处只保留操作口径：日常改 `.local/env.conf`、`instances.<id>.settingsFile` 与插件的 `runtimeConfig` 文件，改完按下面的正常流程重新发布。

插件归档按内容哈希命名，profile 以 `file:` 引用它们，由部署流程一起改写。不要单独替换归档目录或手工改 profile；中断后的恢复按下一节的入口处理。

## 安装与重试

<!-- excerpt:site-recovery -->
归档、公共配置结构或认证提供者缺失在停服前报告。插件业务 Schema 可能在加载时才检查；健康通过仍需实际业务请求。保留 .local/data、.local/artifacts、incoming 和用户备份，不通过删除状态重新初始化。

| 情况 | 操作 |
| --- | --- |
| 准备阶段失败（旧服务未动） | 修正输入后 `bash build.sh` |
| 停旧失败 | 由原管理者处理仍活跃的服务，再 `bash build.sh` |
| 包增删或安装验证失败 | 修正包/权限/网络后 `bash build.sh`，从当前现场重新求差 |
| 启动或就绪探针失败 | 停止本次候选并确认退出，修正后 `bash build.sh` |
| 遗留站点发布锁 | `bash build.sh doctor` 查看归属，确认进程退出后 `bash build.sh unlock-source` |

Windows 用 `.\build.ps1` 替代 bash build.sh。doctor 只读诊断锁和记录，不要求 Docker/kit，也不是完整的安装环境扫描。`dsh-plugin-manager check-records --root <站点根> --config <env.conf|deployment.json>` 只读对比上一次发布记录、活动 Compose、镜像、容器与 profile 证据，报告现场差异与需要人工核实的项；它不写状态、不动容器，旧记录只作诊断、不阻断普通 build，收敛仍须显式执行。

受管授权集合（profile 状态 schema 3）承接部分失败：add 写一半失败后授权已持久保留，普通 build 重新求差并修复，不要求 pending 或同一包版本；remove 完成后才移除授权，遗留的精确受管 Bundle 会被清理，模板与非受管内容不变。换修复包、宿主或工具直接准备新的完整输入再 build；不自行删锁、改记录或删数据。恢复只收敛部署，不回滚业务数据；发布归档和配置副本不能代替独立数据备份。
<!-- /excerpt:site-recovery -->

站点 build 由 manager 的 release-site 编排，仓库 source 准备仅作为输入适配；底层 start/apply-compose/compose-release 保持独立语义。独立 CLI 的 pending 修复仍由唯一安装器执行，不拿 profile unlock 处理外层站点锁。

挂载、引擎身份、旧归档 previous 路径及非受管依赖/用户 patch 保护均保留。更新镜像或工具时保留未完成操作的执行树；不能用当前工具替代原工具继续安装。镜像和平台差异见 [Docker 集成](../integrations/docker/README.md)。
