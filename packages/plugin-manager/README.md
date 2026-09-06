# @dsh-plugin/plugin-manager

发现 schema 3 插件，执行 build → check → pack，校验发布清单与归档，并通过官方 DSH CLI 管理安装。管理器不启动另一套 Agent 引擎。

独立安装 `.tgz` 后使用 `dsh-plugin`。每个项目操作要求 `--root <项目根>`；相对配置、home 和产物路径均相对这个根解析。

标准插件的 `plugin.json` 由本包统一读取。Docker 实例使用 `dsh-plugin apply-compose --root <项目根> --config .local/deployment.json` 应用配置并等待就绪；`health` 根据已验证部署状态检查插件。声明、权限和迁移说明见[插件运行配置规范](../../doc/plugin-configuration.md)。

仓库源码部署使用 `bash deploy/build.sh` 自动初始化和更新，见[一键部署](../../doc/first-deployment.md)。`apply-compose` 接受不可变本机镜像 ID 或仓库摘要；本机镜像不触发拉取。生成的容器配置同步自定义端口供健康检查使用，`--resume` 转交容器内管理器恢复原安装操作。

```sh
dsh-plugin list --root /path/to/project
dsh-plugin pack --root /path/to/project --plugins example --output .local/artifacts/release/plugins
dsh-plugin paths --root /path/to/project
dsh-plugin start --root /path/to/project --manifest /path/to/release/manifest.json --plugins example --dsh-cli-js /path/to/dsh/lib/bin.js
```

源码任务需要 workspace 和锁文件。有清单的安装只读取发布清单、归档及显式运行配置，无需作者源码、Git 或 `plugins/`。归档中的身份、摘要、必需文件、Bundle、依赖和导出均在修改 profile 前验证。

归档名为 `<插件 ID>-<SHA-256>.tgz`，以清单中的 `archive` 字段为准。即使 npm 版本号相同，内容变化也会产生不同的安装路径，避免固定容器挂载路径下复用旧包。

部署、恢复和停服证据见[部署说明](../../deploy/README.md)。迁移使用 `migrate-data` 或 `migrate-artifacts`，默认只预览。模块 API 从包根导出部署函数，`/catalog` 导出发现与选集，`/packaging` 导出打包函数。
