# 可复制的开发提示词

先替换尖括号占位符。让执行者先读取目标版本公开资料和项目 AGENTS；不要让 AI 猜不存在的命令。以下是任务模板，不代表对应业务已经实现。manager 0.3.3 的独立包只支持 pnpm 单包 release。

## 1. 最小工具插件

```text
请在 <作者包根> 开发 DSH 工具插件 <包名>/<插件ID>，功能为 <具体输入、输出、错误行为>。
先读取本项目 AGENTS、所用 DSH 版本的 ToolDefinition 示例、框架作者指南及 examples/standalone-plugin。
保留官方 Cordis 插件与 dsh.bundle.patch，通过官方 dsh profile 启动，不新增独立服务启动器。
这是无私密数据的个人工具，无需 kit/auth；如果需求实际上访问受限数据，先指出并补充鉴权方案。
按 manager 0.3.3 添加 schema 3 声明、README、files、build/check。工具注册有 disposer，工具权限与 Agent 白名单显式配置。
在作者根生成 pnpm 锁文件；在 <工具目录> 用 pnpm exec dsh-plugin-manager pack --root <作者包根> --package . --output .local/release-v1。
保持宿主为外部依赖，运行依赖不得引用作者路径。执行构建和针对工具的测试，交付整个发布目录、输入输出例子、所验证宿主版本及使用说明。
不修改框架或 DSH 源码；不发布、不推送、不读取真实凭据。未知接口先查证，不用伪 API。
```

## 2. 带登录和个人历史的问答应用

```text
请用公开 dsh-example 开发 <应用名称>，包名 <包名>、ID <插件ID>、路由 /<路由>，业务是 <问答内容>。
保留官方 Agent、模型选择、会话日志、流式输出、停止和个人历史；不要自建密码/登录系统。
接入 kit createAccess/createPluginHttp，声明 configuration.auth=consumer。数据所有者来自可信 actor，不能信任请求体或模型给出的 userId。
替换原开发者知识与职责、建议问题，以及包名/ID/Bundle/路由/权限/会话前缀/提示词段名/测试。独立仓库把 kit workspace:* 改为版本化 tgz 并保持构建内嵌，移除仅适用于框架的脚本依赖。
列出业务仍需实现的数据访问规则。standalone 仅共享体验，不承诺个人隔离。
执行独立 check/pack、匿名拒绝、普通账号授权、不同账号历史、停止生成和恢复追问验证。
给部署者 auth 与应用的完整候选组合命令、配置模板和真实问答验证步骤。未配置测试模型时明确尚未验证真实回答。
```

## 3. 现有独立项目接入

```text
请评估 <作者包根> 的 <现有项目> 如何接入 DSH Plugin Manager，manager 版本 <版本>，宿主版本 <版本>。
先读代码，不假设任意 HTTP/Python 服务可以直接变成 Cordis 插件。说明保留为外部服务并写 DSH 适配插件、或重用现有 Node 插件入口的成本。
按普通 Bundle/受管交付/可选身份三层选择最小改动；统一认证 <需要或不需要>。
使用 --root <作者包根> --package . 的 pnpm 单包流程，不让父 workspace 或原框架路径影响构建。
若是多包 workspace，明确当前不支持自动发现，选择一个可独立交付的适配包；不要承诺外部 development/link。
补齐声明、构建、check、README、锁文件及实际业务配置校验。若需 kit，内嵌版本化开发依赖，宿主仍外置。
交付改动清单、准确命令、可迁移 tgz/manifest，以及作者源码不在部署机时的验证结果；不迁移或删除原业务数据。
```

## 4. 内部插件交给另一位部署者

```text
请将 <框架根> 中插件 <插件ID列表> 交付给未参与开发的部署者。
先检查工作区并保留其他改动，继续使用 plugins/* 扫描，确认需要认证的应用在候选中具有启用 provider。
在框架根使用 pnpm package --plugins <插件ID列表> --output <新的发布目录>，不要手写 manifest 或修改中央名单。
提供管理器 tgz/摘要、应用完整发布目录、配置模板、已验证官方宿主版本和获取步骤；不打包真实 env、账号或客户数据。
部署者若合并其他应用，用 compose-release 输入完整候选集合；更新加 --previous <现用清单> 仅携带旧归档，仍列出全部保留应用，start/apply-compose 显式 --plugins all。
手册说明 cwd、home、profile、origin、首次改密、普通账号授权、health 与真实业务验证、stop/更新/恢复；无需作者源码或手改 Compose。
核对更新保留原账号/授权/配置，业务数据格式升级需另行说明。只报告实际执行的检查，不默认推送或上线。
```

## 5. 安装成功但无法访问

```text
请诊断 DSH 应用 <插件ID> 安装成功但 <页面/API/模型问答> 失败。
环境：<OS、Node/pnpm、manager、插件、官方CLI版本>；模式 <release/development>；认证 <authenticated/standalone>。
我提供的脱敏信息：<命令与执行目录角色、候选ID、HTTP状态、错误文本>。
先只读区分安装、宿主监听、应用探针、登录授权、真实业务调用。核对 manifest/--plugins/实例enabled、entryPath/routePrefix、publicOrigin、同DSH_HOME的模型选择。
已装auth不等于本次候选选中auth；需要检查唯一启用provider。不要关鉴权、清空数据、删除pending或打印密钥作为试探。
每一步给预期、失败含义和最小修复；需要重启时说明影响。无法核实时明确未知，不声称已经查看我的机器。最终列根因证据、修复和实际验证结果。
```
