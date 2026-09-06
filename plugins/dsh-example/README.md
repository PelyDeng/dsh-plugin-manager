# dsh-example

可复制的 AI 对话插件，页面为 `/example`，就绪探针为 `/example/ready`。支持多轮问答、SSE 流式输出、停止生成、新建对话、历史列表和恢复追问。

示例使用宿主选择的模型与 DSH Agent、会话日志，不保存模型密钥。工具白名单为空，即使宿主安装其他工具也不会自动使用。SQLite 仅保存身份、标题和时间等历史目录信息，消息正文由 DSH 持久化。

实时输出支持旧版日志 chunk 与 DSH 0.1.3 的瞬态流事件；中断后的历史从宿主持久化记录恢复。正在生成且尚未结算的文本仅通过当前 SSE 连接显示。

## 运行

先按根 README 构建并生成发布目录，准备兼容的官方宿主 CLI。在同一个 DSH home 配置默认模型与密钥，然后运行：

```sh
node deploy/scripts/deployment.mjs start --plugins auth,example --manifest .local/artifacts/release/plugins/manifest.json --dsh-cli-js /path/to/dsh/lib/bin.js
```

示例默认纳入源码选集，并默认使用 `authenticated` 模式。启动前设置 `DSH_PUBLIC_ORIGIN=http://127.0.0.1:7902`，同时安装 auth 后打开 `/auth`；管理员自动看到“AI 对话示例”，普通账号需要管理员授予 example 访问权限。示例入口为 `/example`，对话历史按账号隔离。缺少认证提供者时就绪探针返回 503，不会自动开放匿名访问。

需要无认证的独立演示时，显式设置 `DSH_ACCESS_MODE=standalone`，并仅选择 `example`。该模式使用安装级共享历史。反向代理或容器部署应通过用户 patch 为 example 和 auth 配置实际 `publicOrigin`，服务器实例明确设置 example 的 `accessMode: authenticated`；具体步骤见[部署说明](../../deploy/README.md)。

模式切换需要保持相同 home 并受控重启。独立历史与账号历史分别保留，不迁移、不合并；同一账号的不同登录共享个人历史。退出或撤权会取消该登录发起的活动回合。刷新或重启后可从历史继续追问。

宿主基线由根 gitlink 锁定。历史读取使用 `SessionHandle.open/read/close`，发布版类型与锁定源码存在差异，源码保留该接口的局部类型适配；不能仅凭 npm 版本字符串推断历史恢复兼容。

## 复制与扩展

复制本目录后修改 package.json 中的包名、插件 ID、入口、权限和探针；同步 Bundle、默认路由、会话 ID 前缀、提示词段名及测试。默认历史库按插件 ID 分开，不要复用原示例数据库。

仓库外开发时将 kit 的 `workspace:*` 开发依赖替换为可安装的 kit `.tgz`，保留 tsdown 内嵌配置。`clean` 是本仓库工具入口，独立项目应提供自己的清理命令。无需复制 kit 源码。

配置定义位于 `src/config.ts`，可通过官方 patch 覆盖。默认单轮超时 180 秒、空闲回收 30 分钟、最多 32 个活动会话、输入最多 8000 字符。添加工具时通过 kit 注册真实 ToolDefinition，并将对应工具名加入 Agent 白名单。

```sh
pnpm --filter dsh-example check
```

测试使用隔离 SQLite、HTTP 与可控 Agent，不消耗模型额度。真实宿主集成入口为 `tests/host-smoke.mjs`，需要已准备的锁定宿主与 auth/example 发布目录。
