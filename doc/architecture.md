# 架构

`@dsh-plugin/plugin-kit` 提供可选的身份、HTTP、工具和运行目录协议。业务插件依赖官方宿主及所需 kit 接口；kit 不依赖业务插件或管理器。各插件内嵌 kit，以 Cordis 事件协议互通，宿主单例保持外部依赖。

`@dsh-plugin/plugin-manager` 只读取 schema 3 声明、归档和发布清单，通过官方 CLI 安装 Bundle。内部按配置、目录、打包、安装事务、进程监督和迁移分工；状态文件名与版本在目录调整后保持一致。未声明本管理器元数据的标准 Bundle 仍可直接通过官方机制使用。

根 workspace 包含 `packages/*` 与 `plugins/*`，发现器只扫描后者。官方 `deepseek-harness/` 是独立的可选 gitlink，使用自己的 workspace 和锁文件。Docker 集成消费同一构建流程产生的 manager tgz，宿主镜像不内置业务插件。

源码、发布归档和运行数据分别管理。`.local` 不进入 Git、插件归档或源码镜像上下文。部署可显式挂载其中的发布目录；这不改变其作为运行输入的性质。
