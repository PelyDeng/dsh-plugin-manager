# 官方宿主版本与升级

当前框架使用 DeepSeek Harness `0.1.7-alpha.2`，子模块锁定提交 `00102833dfaee1da9f48a3a8eae9d34005a75218`，对应官方标签 `dsh-v0.1.7-alpha.2`。这是官方预发布版本。kit、auth、example 的宿主依赖与开发类型使用同一版本；宿主服务继续由官方运行环境提供，不打入业务插件。

## 更新源码和镜像

先更新框架，再显式更新子模块：

```sh
git pull --ff-only
git submodule update --init deepseek-harness
```

普通构建不会下载或切换宿主。宿主使用自己的 `pnpm@11.7.0` 和锁文件，框架使用根 `package.json` 指定的 pnpm。源码构建步骤见[源码部署](../deploy/README.md#服务器源码发版)。Docker 构建使用已有的干净宿主检出，并记录提交和镜像身份。

若站点配置了 `DSH_HOST_IMAGE`，更新 gitlink 不会更换这个固定镜像。应先构建新宿主镜像，验证其 `org.opencontainers.image.revision` 和版本标签，再更新站点镜像引用。内置插件固定全量构建，不复用旧宿主基线中的归档。具体操作见[部署说明](../deploy/README.md)。

## 插件接口

- 官方从 `0.1.6-alpha.1` 起只在**全局必需条目**（`agent-loop`、`webserver`、`modules`、`connection`、`headless-runner`、`acp`、`sdk-jsonrpc-server`）失败时中止启动并非零退出；其余条目导入失败、配置校验失败或一直等待依赖，只打印一条 `warning: N entries did not activate` 并继续服务（该警告在 `0.1.6-alpha.2` 保持逐条明细格式）。`0.1.6-alpha.2` 把必需失败的诊断重写为分组格式：`startup failed: N required plugins did not activate` 抬头，其下 `Failed plugins`（含每个插件的 `Package:` 与原因）与 `Plugins waiting for services` 两组，可选条目也并入同一份诊断；完整诊断同时写入 `$DSH_HOME/logs/startup-<时间戳>-<id>.log`。`0.1.7` 未再改动这份诊断的格式，管理器的两代解析锚点原样有效。旧版对任何未激活条目都直接退出，因此「端口能访问」不再等于站点可用。管理器读这两种世代的诊断：受管插件未激活就按启动失败处理并终止本次构建，必需条目失败则把官方诊断一并报出。判定只覆盖启动期：启动之后再出现的诊断（例如 profile patch 热重载失败经宿主日志打印）不在范围内。
- 官方 `0.1.7` 起 bundle 层失败不再中止启动：某个 profile bundle 解析、manifest 或 patch 加载失败时，宿主向 stderr 写一行 `dsh: skipping profile bundle "<包名>": <错误>` 后跳过该层继续启动（profile manifest 本身和用户 patch 的错误仍属致命）。这是健康判定语义的变化——「宿主启动成功」不再等于「站点插件全部就位」。管理器解析该行并把命中托管名单的被跳过 bundle 按启动失败处理，错误证据与未激活条目、官方必需失败块合并报出。
- 官方 `0.1.6-alpha.1` 引入一次性的包解析代（link、dual、runtime 三种模式），`0.1.6-alpha.2` 起默认解析代改为 runtime，`0.1.7` 把解析代**彻底移除**：`resolutionMode` 配置与 CLI 选项删除，只剩运行时解析器；每次加载 profile 时自动清理 link 时代遗留的 `.dsh-module-fallback` 投影符号链接（pnpm 安装的包与其他链接不受影响）。app-boot 的相关导出同步更名（`createProfileResolutionGeneration` → `createRuntimeResolution`，heal/unlink fallback 系列 API 删除，`PluginPackages` 选项 `generation/behavior` 合并为 `resolution`）——框架与业务插件零引用，无需改码。插件就位判定以 profile manifest（`dsh.profile.bundles`）为准，这一点自 `0.1.6-alpha.2` 起不变。
- 官方 `0.1.6-alpha.2` 重写了 `dsh plugin` 子命令（转发官方插件管理器）：安装/卸载的参数面保持，但统一了 profile 写锁、pnpm 输出截断与失败诊断（`dsh: pnpm failed; diagnostics: <日志路径>`），git 托管插件的构建脚本（prepare 等）需要在 profile 的 `pnpm-workspace.yaml` `allowBuilds` 显式放行。管理器经该子命令转发 pnpm，安装失败时按官方诊断排查。同版本删除了 `dsh.profile.patchReload` 配置键：profile manifest 含该键会被忽略，热重载由最终 YAML 组合是否加载 `dsh-hmr` 决定；自定义 profile 模板应移除该键。
- 宿主 `0.1.6-alpha.1` 起把缓存放在 `$DSH_HOME/cache/`（附件与请求图片缓存）。缓存可以丢弃，备份与迁移只需要会话、存储、profile 和私有配置。
- 官方 `0.1.6-alpha.1` 已删除 `@deepseek-ai/dsh-code-runtime`（能力族改为 `dsh-ptc-runtime`），`workflow-worker-thread` 更名为 `workflow-ptc`。框架的依赖声明已同步；业务插件若直接依赖旧包名，需在自身升级时改为新包名。
- 官方 `0.1.7` 起 `deepseek-official` 为 **Messages-only**：Chat Completions 实现与协议选择器整体删除，配置只暴露一个 endpoint、无协议选择键；Anthropic 风格 Messages 协议（含专属 HTTP header 与附加 JSON 字段的 wire 扩展）是唯一通路。站点配置无需协议键；接入该服务商的自建模型替身应只实现 `/messages`。
- 官方 `0.1.7` 把 `@deepseek-ai/dsh-agent-presets` 拆为 `dsh-agent-preset`（单个 preset 定义）与 `dsh-agent-preset-registry`（注册表），内置 preset 改为随 bundle 分发的独立 `presets/<id>.patch.yml`，并可在 profile YAML 直接声明。框架与站点配置零引用旧包名；自定义 patch 若复制过旧版内置 preset 段，升级时需按新结构整理。
- 官方 `0.1.7` 把 `dsh-agent-default-model` 的 `provider`/`model` 与 `dsh-agent-loop` 的 `maxParallelToolCalls` 配置字段 Volatile 化（YAML 书写格式不变，支持只改这些字段的热更新而不重载插件）。`AgentDefaultModelConfig` 服务的 `currentSelection()` 签名不变，kit 经服务对象消费不受影响；同版本删除了 `AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE`/`SCHEMA` 与 `AgentDefaultModelSettings` 旧导出，业务插件不要引用。
- 实时输出订阅官方 `agent/assistant-stream`，按 Agent 实例隔离。持久日志使用 `assistant/message` 与 `assistant/attempt` 的 `stream`，通过 `expandAssistantStream()` 展开；不再订阅或自行写入 `assistant/chunk`。example 的中断历史和首 token 时间均来自官方持久流。
- `SessionHandle.read()` 返回 `{ events, eventState }`，不再直接返回事件数组。kit 在一个入口解包并校验结果，example 复用此入口；业务插件应使用官方类型，避免通过旧的类型断言隐藏接口变化。
- 模型目录、会话模型选择和历史投影继续使用官方 `sessionController`、`agentDefaultModel` 和 `sessionProjections`。kit 在模型切换前、异步校验后的提交边界和返回后复核权限；提交边界使用 Cordis 的同步 `internal/dispatch`，普通 `session/event` 观察者在事件提交后运行，不能用于阻止写入。
- 官方 base 已挂载 `session-title` 与 `session-title-first-prompt-llm`，对全新非分支会话的第一条提问发起一次辅助提炼，输入上限 4096 字节、输出上限 64 tokens、超时 60 秒；失败保留回退标题。kit 通过全生命周期 `session/event` 监听结果，不重复调用模型；业务索引与手动改名保护见[自动标题](conversation-management.md#自动标题)。
- 官方 Web 插件面板使用 `sidebar.panellist` 和 `main`；原 `conversation` Slot 对应 `main` 的 `conversation` key。auth 和 example 使用独立 HTTP 页面，不注册这些 Slot。自定义 Web 面板插件需自行适配。
- 官方极简 profile 的默认工具有变化，自定义插件应明确注册所需工具，不能依赖旧版默认工具集合。实验性的 Agent Teams 不由框架默认启用。

## 旧会话与回退

Session 当前格式为 V4（官方 `0.1.7` 起，`0.1.6` 写 V3）。读取旧格式时，官方持久化层先完成迁移和验证，返回当前逻辑事件；只读打开不发布新文件。首次写入旧会话时，官方在原目录发布新的 V4 generation，原始文件保持不变。V3→V4 迁移把工具结果提升为一等 tool-role 消息，并要求显式的子会话证据（无子声明空数组），因此事件序号可能变化。框架通过官方持久化接口读取，不自行转换日志或覆盖旧文件。

**回滚不兼容**：V3 读取器拒绝 V4 generation——升级后产生的会话数据不能被 `0.1.6` 宿主读取。升级前结束活动会话；升级后刷新页面，重新获取历史和分支位置。需要批量把既有会话发布为 V4 时，官方提供一次性命令（在宿主仓库内运行，不用模型/API key）：`pnpm run migrate:sessions-to-v4`。

生产切换前停止写入，备份整个持久数据目录及私有配置，并核对备份可读。旧镜像和发布清单应保留。V4 已产生新数据后，回退镜像不能代替数据恢复；需要停服并从升级前备份恢复到单独目录，核验后再切换，保留原目录。

## 旧反馈迁移

新版 `messageFeedback` 只读取会话日志中的反馈事件，不自动读取或迁移旧 `storages/message_feedback.json`。保留旧文件不足以让评分和备注继续可见。停写并备份后，可在新宿主运行环境中生成隔离迁移结果：

```sh
node scripts/stage-legacy-feedback.mjs --runtime /opt/dsh-runtime --sessions /input/sessions --legacy /input/storages/message_feedback.json --output /work/feedback-migration
```

输入应只读挂载，输出须为不存在的独立目录。脚本用官方格式接口验证日志，核对会话创建身份和反馈对应消息，保留版本与时间戳；已有日志反馈和删除记录优先，避免重放旧评分。生成的 `report.json` 与 `sessions/` 仅用于核验，不会发布到原目录。确认原服务停写、输出完整且旧目录已备份后，按同一数据属主将报告涉及的会话目录切换到迁移结果；不要混入运行中的数据。缺失会话、损坏数据或版本不符会中止，原文件保持不变。

独立备份工具可从管理器 `@dsh-plugin-manager/plugin-manager/session-snapshot` 导入 `restoreSessionSnapshot` 和 `mergeLegacyFeedback`，显式传入官方 catalog 与 V2/V3/V4 codec；离线快照没有子会话 artifact，catalog 用 `createSessionFormatCatalogWithChildren([])` 组装（空数组声明无子）。管理器不会自行寻找项目根或加载业务数据。

## 验证范围

插件通过 `ctx.<服务名>` 直接访问宿主服务时，须在导出的 `inject` 中声明；可选服务通过 `ctx.get()` 检查是否可用。测试服务应由独立的 Cordis 插件提供，再用被测插件的实际 `inject` 加载消费方；普通对象替身或根上下文提供服务会漏掉注入作用域错误。新建对话、读取旧历史和业务工具调用应分别验收，ready 成功不能替代这些检查。

升级应分别记录类型与行为测试、独立归档安装、真实宿主加模型替身、容器与生产验收。替身问答不代表真实模型可用，健康检查也不代表浏览器操作完成。框架的 `test-report.sh` 提供 auth/example 的真实宿主及归档验证；私有插件由集成仓库单独检查。

依据：[官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.2)、[V2 到 V3 迁移规范](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/session/session-format-v2-to-v3/README.zh.md)、[官方 JSONL 持久化语义](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/session/session-persistence-jsonl/README.zh.md)。诊断文案与坏 bundle 跳过的行为锚点：宿主 `packages/boot/app-boot/src/index.ts`（`activationDiagnostic`、`startupDiagnostic`、`requiredStartupEntryIds`）与 `packages/boot/app-boot/src/profile.ts`（skipping profile bundle 与运行时解析）。
