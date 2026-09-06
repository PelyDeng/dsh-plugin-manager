# dsh-example

通过管理器部署时，编辑 `<DSH home>/plugins/example/plugin.json` 的 `accessMode` 即可单独切换本插件认证，默认 `authenticated`；`enabled` 控制插件是否运行。修改后统一应用部署，无需重打包或修改生产 patch、Compose、健康检查名单。

[完整配置示例](examples/README.md)提供可复制的 example、auth、部署 JSON 模板，并逐项说明是否必填、默认值、单位、范围和使用条件；模板随插件归档发布。统一规则见[配置规范](../../doc/plugin-configuration.md)。

可复制的 AI 对话插件，页面为 `/example`，就绪探针为 `/example/ready`。支持多轮问答、SSE 流式输出、停止生成、新建对话、历史列表和恢复追问。

示例使用宿主选择的模型与 DSH Agent、会话日志，不保存模型密钥。工具白名单为空，即使宿主安装其他工具也不会自动使用。SQLite 仅保存身份、标题和时间等历史目录信息，消息正文由 DSH 持久化。

实时输出支持旧版日志 chunk 与 DSH 0.1.3 的瞬态流事件；中断后的历史从宿主持久化记录恢复。正在生成且尚未结算的文本仅通过当前 SSE 连接显示。

## 运行

Linux Docker 首次体验运行 `bash deploy/build.sh`，自动生成站点和插件默认配置，见[一键部署](../../doc/first-deployment.md)。全部配置字段及可选性见[完整配置示例](examples/README.md)。AI 对话需在同一个 DSH home 配置默认模型与密钥。使用已构建的官方宿主 CLI 直接启动时，按完整示例准备运行配置及发布目录，省略 auth 模板的 Docker 专用 stateDir，再运行：

```sh
node deploy/scripts/deployment.mjs start --config .local/deployment.json --dsh-cli-js /path/to/dsh/lib/bin.js
```

示例默认纳入源码选集，并默认使用 `authenticated` 模式。站点 origin 在部署配置中统一填写，同时安装 auth 后打开 `/auth`；管理员自动看到“AI 对话示例”，普通账号需要管理员授予 example 访问权限。示例入口为 `/example`，对话历史按账号隔离。管理器在部署前拒绝缺少认证提供者的组合；运行中认证服务不可用时就绪探针返回 503，不会自动开放匿名访问。

需要无认证的独立演示时，将 example 的 `plugin.json` 中 `accessMode` 改为 `standalone`，然后重新应用部署。该模式使用安装级共享历史。完全绕过管理器、直接使用官方 Bundle 时，才由 `DSH_ACCESS_MODE` 和 `DSH_PUBLIC_ORIGIN` 或官方 patch 提供对应配置；它们不能替代管理器的实例配置。

模式切换需要保持相同 home 并受控重启。独立历史与账号历史分别保留，不迁移、不合并；同一账号的不同登录共享个人历史。退出或撤权会取消该登录发起的活动回合。刷新或重启后可从历史继续追问。

宿主基线由根 gitlink 锁定。历史读取使用 `SessionHandle.open/read/close`，发布版类型与锁定源码存在差异，源码保留该接口的局部类型适配；不能仅凭 npm 版本字符串推断历史恢复兼容。

## 复制与扩展

复制本目录后修改 package.json 中的包名、插件 ID、入口、权限和探针；同步 Bundle、默认路由、会话 ID 前缀、提示词段名及测试。默认历史库按插件 ID 分开，不要复用原示例数据库。

仓库外开发时将 kit 的 `workspace:*` 开发依赖替换为可安装的 kit `.tgz`，保留 tsdown 内嵌配置。`clean` 是本仓库工具入口，独立项目应提供自己的清理命令。无需复制 kit 源码。

配置定义位于 `src/config.ts`，管理器部署时写入实例配置的 `config`。全部字段和约束见[完整配置示例](examples/README.md)。添加工具时通过 kit 注册真实 ToolDefinition，并将对应工具名加入 Agent 白名单。

```sh
pnpm --filter dsh-example check
```

测试使用隔离 SQLite、HTTP 与可控 Agent，不消耗模型额度。真实宿主集成入口为 `tests/host-smoke.mjs`，需要已准备的锁定宿主与 auth/example 发布目录。
