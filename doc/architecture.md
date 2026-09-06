# 架构

`@dsh-plugin/plugin-kit` 提供可选的身份、HTTP、工具和运行目录协议。业务插件依赖官方宿主及所需 kit 接口；kit 不依赖业务插件或管理器。各插件内嵌 kit，以 Cordis 事件协议互通，宿主单例保持外部依赖。

`@dsh-plugin/plugin-manager` 只读取 schema 3 声明、归档和发布清单，通过官方 CLI 安装 Bundle。内部按配置、目录、打包、安装事务、进程监督和迁移分工；状态文件名与版本在目录调整后保持一致。未声明本管理器元数据的标准 Bundle 仍可直接通过官方机制使用。

根 workspace 包含 `packages/*` 与 `plugins/*`，内部发现器只扫描后者；显式 `--root <作者包根> --package .` 读取独立单包，复用相同任务和归档校验。内部发布清单 1 保留源码目录与 development/link；独立发布清单 2 不携带源码目录，只支持 release。官方 `deepseek-harness/` 是独立的可选 gitlink，使用自己的 workspace 和锁文件。Docker 集成消费同一构建流程产生的 manager tgz，宿主镜像不内置业务插件。

源码、发布归档和运行数据分别管理。`.local` 不进入 Git、插件归档或源码镜像上下文。部署可显式挂载其中的发布目录；这不改变其作为运行输入的性质。

标准插件通过 `configuration` 声明 Cordis 配置入口和认证角色，每个实例的 `plugin.json` 控制启用及认证模式。管理器据此生成不可变 patch，通过官方 CLI 同步 Bundle；健康检查读取成功部署状态中的探针声明。站点参数与业务凭据分别保存，不在插件切换时重复修改。完整规则见[插件运行配置规范](plugin-configuration.md)。
