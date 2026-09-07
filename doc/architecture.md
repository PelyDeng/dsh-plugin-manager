# 架构

`@dsh-plugin-manager/plugin-kit` 提供可选的身份、HTTP、工具和运行目录协议。业务插件依赖官方宿主及所需 kit 接口；kit 不依赖业务插件或管理器。各插件内嵌 kit，以 Cordis 事件协议互通，宿主单例保持外部依赖。

`@dsh-plugin-manager/plugin-manager` 只读取 schema 3 声明、归档和发布清单，通过官方 CLI 安装 Bundle。内部按配置、目录、打包、安装事务、进程监督和迁移分工；状态文件名与版本在目录调整后保持一致。未声明本管理器元数据的标准 Bundle 仍可直接通过官方机制使用。

根 workspace 包含 `packages/*` 与 `plugins/*`，内部发现器只扫描后者；显式 `--root <作者包根> --package .` 读取独立单包，复用相同任务和归档校验。内部发布清单 1 保留源码目录与 development/link；独立发布清单 2 不携带源码目录，只支持 release。官方 `deepseek-harness/` 是独立的可选 gitlink，使用自己的 workspace 和锁文件。Docker 集成消费同一构建流程产生的 manager tgz，宿主镜像不内置业务插件。

源码、发布归档和运行数据分别管理。`.local` 不进入 Git、插件归档或源码镜像上下文。部署可显式挂载其中的发布目录；这不改变其作为运行输入的性质。

发布清单可选的 verification 在管理器发布物层记录构建输入与归档测试，绑定最终 tgz 摘要并保留被测插件组合。统一模块负责校验、合并、选集和安装提示，不进入事务 desiredHash 或改变 kit/插件声明。证据与部署环境指纹分别处理，身份不足时明确未知。协议与交付流程见[发布物验证记录](../packages/plugin-manager/VERIFICATION.md)。

example 的代码问答通过 kit 工具授权包装官方工具，只检索构建时生成的公共框架快照；索引随插件归档交付，不在运行时扫描框架或私有插件源码。FAQ、源码参考与业务运行数据分开，回答引用快照路径及行号。

标准插件通过 `configuration` 声明 Cordis 配置入口和认证角色，每个实例的 `plugin.json` 控制启用及认证模式。管理器据此生成不可变 patch，通过官方 CLI 同步 Bundle；健康检查读取成功部署状态中的探针声明。站点参数与业务凭据分别保存，不在插件切换时重复修改。完整规则见[插件运行配置规范](plugin-configuration.md)。
