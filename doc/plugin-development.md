# 插件作者接入

从 [dsh-example](../plugins/dsh-example/README.md) 开始。标准 DSH 插件以 `package.json` 的 `dsh.bundle.patch` 声明 Bundle，并提供真实入口、类型和资源。接入本管理器时增加 `deepseekPlugin.schemaVersion: 3`、唯一 `id`、可选 `defaultEnabled`、`entryPath`、`healthPath`、`permissions` 与 `verifyFiles`。

插件放在 `plugins/*`，需要 `description`、`files`、README、`build` 和 `check`。构建由管理器按 build → check → pack 执行，不能用 prepare/prepack/postpack 重复构建。`files` 仅包含公开产物，用户配置使用公开模板及 `runtimeConfig` 声明。发现时允许尚未生成的入口，打包时必须提供全部声明文件。

kit 是可选的。源码按需导入 `@dsh-plugin/plugin-kit/access`、`/http` 或 `/tools`。注册资源依附 Cordis 生命周期；工具执行前后复核服务端绑定的身份，不从模型参数接收身份。

`standalone` 使用共享本地身份；`authenticated` 要求固定 `publicOrigin` 和唯一可用的认证提供者。HTTP 注册必须位于声明的路由前缀内，公开健康探针使用 `registerPublic`。运行目录来自实际注册，不以磁盘发现冒充已加载状态。

工作区以 kit 的 `workspace:*` 开发依赖配合 tsdown `deps.alwaysBundle` 内嵌实现；宿主包声明为 peer，开发时另装对应类型。仓库外开发安装 kit tgz，编译后检查 JS、声明文件和资源均不引用作者源码目录。kit 及宿主升级需要复查实际消费者，不通过包名相同推断兼容。
