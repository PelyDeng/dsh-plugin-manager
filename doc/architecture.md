# 架构

## 各部分负责什么

`@dsh-plugin-manager/plugin-kit` 提供可选的身份、HTTP、工具和运行目录接口。业务插件依赖官方宿主，按需使用 kit；kit 不依赖业务插件或管理器。kit 打包在各插件内部，插件之间通过 Cordis 事件通信。需要共享同一实例的宿主服务由官方运行环境提供，不打入插件包。

`@dsh-plugin-manager/plugin-manager` 只读取 schema 3 声明、归档和发布清单，通过官方 CLI 安装 Bundle。内部按配置、目录、打包、安装事务、进程监督和迁移分工；状态文件名与版本在目录调整后保持一致。未声明本管理器元数据的标准 Bundle 仍可直接通过官方机制使用。

## 源码、安装包和数据放在哪里

根 workspace 的源码插件发现只扫描 `plugins/*`；产物 build 只扫描站点 incoming 直接子目录的完整发布清单，两者由明确的 source/archives 模式选择。开发者在独立仓库开发单个包时，用 `--root <作者包根> --package .` 指定它的位置，仍使用相同的任务和归档校验。

内部发布清单（格式 1）保留源码目录，支持 development/link；独立发布清单（格式 2）不携带源码目录，只支持 release。官方 `deepseek-harness/` 以可选 Git 子模块（gitlink）记录，使用自己的 workspace 和锁文件。Docker 使用同一构建流程产生的 manager tgz，宿主镜像不内置业务插件。

当前宿主版本、实时流接口和 Session V3 迁移约束见[官方宿主版本与升级](host-compatibility.md)。框架和业务插件只通过官方接口读取迁移后的会话，不直接改写宿主日志。

源码、发布归档和运行数据分别管理。`.local` 不提交 Git，不打入插件归档，也不传给源码镜像构建。部署时可以显式挂载其中的发布目录，供运行时读取。

## 构建、部署与恢复

Windows 根 `build.ps1` 与 macOS/Linux 根 `build.sh` 只转发到同一站点编排。source 准备源码构建产物，archives 冻结外部完整发布目录；两者交给同一 composer、安装器与状态/恢复实现。manager 不导入业务源码，也不反向依赖仓库 deploy/integrations 路径。源码发布锁防止一次更新与部署被其他任务同时修改；profile 锁仍由安装事务管理。两者使用相同的原子文件锁机制，锁文件路径不同。

构建子进程（worker）通过进程间通信（IPC）报告完成并正常退出后，才释放源码锁；异常终止时保留锁和操作记录。各平台在本机 Linux Docker 上的网络、挂载和私有文件权限差异，由部署辅助程序（helper）处理，不改变 kit 接口、业务插件或官方 profile 协议。

resume 使用原执行树、镜像、归档与私有配置副本；同包业务配置 recover 形成保留原快照的后续候选。两种操作不迁移目录，也不自动回滚业务数据。源码更新仍会检查服务是否停止、容器是否属于当前部署、挂载是否正确，但不会自动备份全部运行数据。数据备份与恢复由运维单独安排。

发布清单可选的 verification 记录构建输入、归档测试、最终 tgz 的摘要，以及测试过的插件组合。管理器用同一模块处理记录校验、合并、插件选择和安装提示；这些记录不参与事务 desiredHash 的计算，也不改变 kit 或插件声明。测试记录与部署环境标识分开核对；信息不足、无法确认对应关系时，结果标为未知。协议与交付流程见[发布物验证记录](../packages/plugin-manager/VERIFICATION.md)。

## 会话模型与 example 问答

业务插件可在输入框选择对话模型。kit 与 Auth 共用官方模型目录和默认值，切换委托 `sessionController.selectModel()`。插件先验证会话归属、打开自己的 Agent，并在切换与发送期间保持会话忙碌检查。官方接口记录当前会话选择，同时尝试保存宿主默认值；普通插件用户的选择也会影响后续新会话。kit 不保存第二份配置，管理器不参与运行时模型选择。

新会话模型由官方 `agentDefaultModel` 提供，Auth 为管理员提供查看官方模型目录和保存默认选择的入口。调用 kit 的 `conversationModel()` 前，业务插件须先检查会话是否属于当前用户（owner）。该接口通过官方会话投影，也就是从日志整理出的会话状态，恢复已有对话或分支点使用的模型。读取或投影能力缺失时拒绝继续，不用新的默认模型覆盖旧记录。example 使用此接口，默认值不写进框架 env 或业务历史文件。

自动标题由官方首句标题服务生成，kit 的 `registerConversationTitles()` 在插件生命周期内转交可信事件。业务插件只更新自己已存在的 owner 索引，保留手动、分支及旧历史标题；example 持久化标题来源，并通过当前回答通知和有界历史刷新呈现晚到结果，不建立第二个标题模型服务。完整语义见[会话管理](conversation-management.md#自动标题)。

example 的代码问答通过 kit 工具授权包装官方工具，只检索构建时生成的公共框架快照；索引随插件归档交付，不在运行时扫描框架或私有插件源码。FAQ、源码参考与业务运行数据分开，回答引用快照路径及行号。部署检索包含稳定的公共 `deploy/build.sh`、`deploy/build.ps1` 及 worker；私有集成可以替换仓库根 build 入口，因此快照不收录根 `build.sh`、`build.ps1`，也不收录 `doc/releases/` 的历史说明。

## 配置由谁维护

标准插件通过 `configuration` 声明 Cordis 配置入口和认证角色，每个实例的 `plugin.json` 控制是否启用及认证模式。管理器据此生成不可变 patch，通过官方 CLI 同步 Bundle；健康检查读取成功部署记录中的探针声明。框架配置与插件业务配置分别维护，切换插件时不需要重复修改两份配置。完整规则见[插件运行配置规范](plugin-configuration.md)。

需要手动填写的框架配置集中在私有 `.local/env.conf`。根目录的公开模板只填写固定且不含秘密的默认值；密钥、自动生成项及部分按其他配置推算的值留空。首次创建私有文件时，按实际平台填写默认值，已有配置不覆盖。

管理器据此生成部署文件、Compose 和官方 patch。插件自己的 Schema、plugin.json 及 runtimeConfig 仍独立维护；账号与会话继续使用原存储。详见[配置范围](framework-configuration.md)。

公开正文按主题维护；scripts/version.mjs 的同一 sync/check 按固定来源组合版本文档与 FAQ，example build 消费输出而不另写 guide.md。离线指南与可搜索源码快照分别保留，详见[版本与文档同步](versioning.md)。
