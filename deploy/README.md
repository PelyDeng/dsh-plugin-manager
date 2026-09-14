# 部署与管理

部署已经打好的插件，优先使用[产物一键部署](../doc/first-deployment.md)。本文维护源码构建、按需复用和站点恢复规则；只安装 manager 时的手工 CLI 操作保留在其随包 [DELIVERY](../packages/plugin-manager/DELIVERY.md)。

产物合规是**交付前**的事，不在部署时重复检查：作者打包后执行 `dsh-plugin-manager verify-release --release <发布目录>`（只读、可进 CI，退出码 0 表示合规）自检清单格式、产物摘要、包结构与元数据一致性，再把整个发布目录交给部署者。作者与部署者的分工和产物约定见[框架配置](../doc/framework-configuration.md)与[一键部署](../doc/first-deployment.md)。

## 服务器源码发版

Windows 使用根 `.\build.ps1`，macOS/Linux 使用 `bash build.sh`；`deploy/build.ps1` 与 `deploy/build.sh` 转发到同一入口。完整源码检出默认 source，使用已有官方宿主源码和锁定依赖，不自动克隆、拉取或切换宿主。需 Node.js `^22.19.0 || >=24`、npm、Git、tar、本机 Linux Docker 与 Compose；脚本只按需准备锁定 pnpm，不安装系统软件。

```sh
git clone --recurse-submodules https://github.com/PelyDeng/dsh-plugin-manager.git
cd dsh-plugin-manager
bash build.sh
```

后续自行确认更新源码，再运行同一 build。源码操作使用已提交输入；正常全量构建准备 manager、选中业务插件和宿主镜像，不要求宿主等于预设 gitlink，但记录实际提交。仅指定 publishImage 时推送镜像；默认使用本机不可变镜像 ID。宿主升级约束见[兼容说明](../doc/host-compatibility.md)。

首次创建 .local/env.conf，已有文件不覆盖；旧 JSON 导入保留解析后的数据路径。源码默认启用 auth/example，精简部署包默认 archives 并发现 incoming 全集。显式改为 archives 后，不构建 plugins/*；源码树中缺少工具时只准备 manager 工具依赖。两种模式不混合输入，字段规则见[框架配置](../doc/framework-configuration.md)。

### 按需重建

<!-- excerpt:source-rebuild -->
日常 `pnpm build --plugins c` 只构建 c，`pnpm package --plugins "c,d" --output <新目录>` 只交付 c、d。源码部署使用 `./build.sh --rebuild-plugins c`；Windows 使用 `.\build.ps1 --rebuild-plugins c`，多个 ID 使用 `.\build.ps1 --rebuild-plugins "c,d"`，Bash 同样可加引号。所有逗号分隔选集都加引号，避免 PowerShell 将其拆成数组。保留站点 a,b,c,d 完整选集，只有指定插件重建，其余复用可核实旧归档，新清单仍完整。省略参数全量构建；不接受空项、重复、all/none 或选集外 ID。**不想点名就用 `--rebuild-plugins auto`**：重建集由判定自己算，判不出来时退回整套重建而不是让发布失败；点名选集时判定拒绝会一次给出补全后的完整命令（`--rebuild-plugins "a,b,c"`），不用失败一次补一个。

复用需与活动站点对应的 ready 基线、构建环境、宿主来源与旧归档均可核验。判定按「改动落在哪些插件的构建输入里」：插件目录、它声明的 `workspace:` 依赖（含间接依赖）、仓库级共享输入（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、`.gitattributes`），以及清单 `deepseekPlugin.buildInputs` 列出的路径；落在这些之外的变化不再阻塞复用。没声明 `buildInputs` 的插件读取范围未知，仍要求改动全部落在本次重建的插件目录内。本地依赖按传递关系校验，不得靠安装钩子重建。点名选集时不会自动扩大选集或静默全量；`auto` 是显式要求扩容的形态，它按同一套判定迭代出重建集，判定拿不到可靠基线（没有活动部署、宿主或记录对不上、声明无法核验）时整套重建并在日志里说明原因。没有基线时先正常全量构建；archives 成功记录不充当 source 基线，切回 source 首次必须全量。

管理器工具归档也按输入复用：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`packages/plugin-kit`、`packages/plugin-manager` 的已跟踪内容没变、且**活动部署**记录里的归档摘要仍与磁盘一致时，直接复用那份归档再安装一次（省掉 18.6 秒的 pnpm 重建）；任何一条核验不过就照常重新构建，并在日志里写明原因（例如「管理器构建输入已变化」）。基线取活动部署而不是最近一次操作记录，因为后者可能正是失败的那次。

源码模式要求与基线一致的干净检出；镜像模式核验同一摘要和旧成功记录的宿主提交，不要求宿主源码存在，最终镜像标签仍须一致。插件自身目录内已纳入 Git 的常规 .tgz/.tar.gz 可作 file: 构建输入，旧新 blob 与磁盘字节须一致；符号链接、目录、越界、未跟踪归档及 `link:` 仍拒绝复用。

manager/kit、镜像准备、停服安装和健康检查仍执行，不是热更新。prepared 后失败只用 `--resume` 重试原输入，不带重建参数；需要改同包业务配置时使用单独的 recover 流程。archives 不接受 --rebuild-plugins。
<!-- /excerpt:source-rebuild -->

### 日志与锁

终端显示阶段、实际耗时和日志路径；运行中的百分比仅为等待提示。重定向输出只记录开始及结果，详细日志在 `.local/artifacts/build-logs/`。失败后保留实际错误，不用进度百分比推断已完成的数据比例。

一次发布里同一份发布清单会被加载多遍（上一次发布的清单、复用判定、合并后的清单），每次都要核对摘要并解包核验；归档是内容寻址的，**同一份归档在一次发布里只解包核验一次**，其余按内容摘要复用结论并在日志里记一行「清单核验：解包核验 N 次，按内容摘要复用 M 次」。失败仍然失败：摘要不符在查表之前就报错，损坏或被换掉的包不会被复用结论掩盖。

站点发布锁保护来源准备与部署；profile 安装锁保护安装事务，职责不同。保留 source-release.node.lock/control.lock 与 Linux flock 兼容路径。worker 报告完成且正常退出才释放外层锁，强制终止时保留证据。源码 beforeBuild hook 仅在正常 source 构建触发，archives/resume/recover 均不更新源码。入口先校验模式、静态字段及未完成操作，再允许 hook 准备源码；非法配置或尚需恢复的操作不会触发私有源码同步。帮助和 doctor 使用轻量入口，不先安装框架依赖或启动 Docker。

## 运行配置

日常只编辑 .local/env.conf 和实际插件配置，deployment.json、清单、Compose、patch 由编排生成。root 从脚本位置明确传入；独立 CLI 必须指定 --root，不从工具安装目录猜项目根。完整字段、入口默认和凭据优先级只在[框架配置](../doc/framework-configuration.md)维护。

source/archives 切换须无未完成操作，核验原 home/profile/引擎/归属及旧归档。已有实例 settingsFile/runtimeConfig 原样沿用，不自动迁移。数据路径调整按[迁移流程](../doc/migration.md)处理。

插件配置、环境变量和 patch 都在容器启动时读取，改完需要一次受控重启才会生效。改哪一层、几层之间谁覆盖谁、环境变量按什么顺序取值，只在[框架配置](../doc/framework-configuration.md#插件配置与环境变量的生效路径)维护；插件字段本身见[插件运行配置](../doc/plugin-configuration.md)。此处只保留操作口径：日常改 `.local/env.conf`、`instances.<id>.settingsFile` 与插件的 `runtimeConfig` 文件，改完按下面的正常流程重新发布。

插件归档按内容哈希命名，profile 以 `file:` 引用它们，由部署流程一起改写。不要单独替换归档目录或手工改 profile；中断后的恢复按下一节的入口处理。

## 安装与恢复

<!-- excerpt:site-recovery -->
归档、公共配置结构或认证提供者缺失在停服前报告。插件业务 Schema 可能在加载时才检查；健康通过仍需实际业务请求。保留 .local/data、.local/artifacts、incoming 和用户备份，不通过删除状态重新初始化。

| 情况 | 在站点根执行 |
| --- | --- |
| 尚未 prepared 的准备失败 | 修复错误后 `bash build.sh` |
| prepared 后临时网络、权限或挂载失败 | 原输入不变，`bash build.sh --resume` |
| 同一插件包的业务配置错误 | 编辑指出的原文件，`bash build.sh --recover --data-compatible` |
| 遗留站点发布锁 | `bash build.sh doctor` 查看归属，确认进程退出后 `bash build.sh unlock-source` |

Windows 用 `.\build.ps1` 替代 bash build.sh。--resume、--recover、--rebuild-plugins 互斥；--data-compatible 只能随 recover。doctor 只读诊断锁和记录，不要求 Docker/kit，也不是完整的安装环境扫描。`dsh-plugin-manager check-records --root <站点根> --config <env.conf|deployment.json>` 只读核对发布记录、活动 Compose、镜像与容器，判定漂移类别并给出对账计划；它不写状态、不动容器，收敛仍须显式执行。

resume 使用保存的工具、镜像、归档和配置副本；原受管配置被修改时拒绝。prepared 前不为新站点创建 data/home，之后即使挂载预检尚未停服就失败，也通过 resume 沿用已记录归属。

recover 只修正新 schema 3 失败操作的 plugin.json.config 或 runtimeConfig，保留包摘要、选集、认证控制字段、镜像、工具和站点路径。--data-compatible 是部署者确认当前包可继续读取现有数据，不是自动备份或兼容证明。新候选保留前序失败快照；再次临时失败用 resume，继续改业务配置则再显式 recover。

恢复会核对安装状态和 pending 是否确属前序站点候选；仅包名和摘要相同不足以接管另一操作。尚未写出 pending 时也须与保存的前序状态证据一致，不能手工替换状态或把其他站点的记录移入当前目录。

需要换修复包、宿主或工具不属于这一高层快捷恢复；保留现场并由维护者核查底层高级修复与数据兼容流程，不自行删锁、改记录或删数据。旧 schema 2 使用其原环境与兼容恢复证据，不能伪造新快照。恢复只继续部署，不回滚业务数据；发布归档和配置副本不能代替独立数据备份。
<!-- /excerpt:site-recovery -->

站点 build 由 manager 的 release-site 编排，仓库 source 准备仅作为输入适配；底层 start/apply-compose/compose-release 保持独立语义。独立 CLI 的 pending 修复仍由唯一安装器执行，不拿 profile unlock 处理外层站点锁。

挂载、引擎身份、旧归档 previous 路径及非受管依赖/用户 patch 保护均保留。更新镜像或工具时保留未完成操作的执行树；不能用当前工具替代原工具继续安装。镜像和平台差异见 [Docker 集成](../integrations/docker/README.md)。
