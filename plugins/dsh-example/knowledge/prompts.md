# 可复制的开发提示词

替换尖括号占位符，先读目标版本 AGENTS、文档和源码；不默认推送或上线，不读取凭据，保留其他改动和原数据，未验证的项目明确说明。

## 源码行为查证

```text
解释 <问题>，框架版本 <版本>。核对前提，检索实现、调用方和测试，引用完整路径与行号，区分事实、推断和未知。
模型查 packages/plugin-kit/src/models.ts、plugins/dsh-auth/src/models.ts；版本查 scripts/version.mjs；CI查 .github/workflows；公共部署查 deploy/。不把快照当生产状态，不据公共代码推断私有入口，不用历史发布说明代替当前实现，不修改代码。
```

## 会话管理接入

```text
按 doc/conversation-management.md 和 example，为 <插件ID> 接入本人查询、只读预览和逐项官方归档。复用 owner 索引及移除生命周期，验证撤权、旧数据、并发、部分失败重试与独立归档消费，不操作生产数据。
```

## 最小工具插件

```text
在 <作者包根> 开发 <包名>/<插件ID>，功能为 <输入、输出、错误行为>。参考官方 ToolDefinition 和 examples/standalone-plugin，保留 Cordis、dsh.bundle.patch、官方 dsh profile；补 schema 3、README、files、build/check、工具 disposer、权限及 Agent 白名单。
生成作者 pnpm 锁文件，宿主外置；在工具目录执行 pnpm exec dsh-plugin-manager pack --root <作者包根> --package . --output .local/release-v1，验证后交付完整目录与宿主要求。受限数据必须鉴权，未知 API 先查证。
```

## 带登录和历史的问答应用

```text
用公开 example 开发 <业务>，包名 <包名>、ID <插件ID>、路由 /<路由>。复用 Agent、流式输出、停止、历史和 kit 鉴权，owner 来自可信 actor；替换知识、工具、提示词及身份命名。
用 kit/models 的 conversationModel 读取默认或恢复历史，读取前后鉴权，分支传继承事件数。独立包将 kit workspace:* 改为版本化 tgz 并内嵌，替换框架专用脚本与测试。验证匿名拒绝、账号隔离、授权、停止和恢复；standalone 不承诺个人隔离，未测真实模型须说明。
```

## 现有项目接入

```text
评估 <作者包根> 的 <项目> 接入框架 <版本>、宿主 <版本>。比较外部服务加适配插件与现有 Node 入口，选择最小方案。采用 --root <作者包根> --package . 的 pnpm 单包流程；不承诺多包自动发现或外部 development/link。补声明、锁文件、配置校验和 README，验证脱离作者目录的归档消费。
```

## 内部插件交付

```text
框架根执行 pnpm package --plugins <完整候选ID列表> --output <新目录>，包含所需唯一启用 auth provider。提供 manager tgz/摘要、完整目录、公开模板和宿主要求，不打包账号数据。
组合用 compose-release；--previous 不继承候选，列出全部保留应用，start/apply-compose 显式 --plugins all。说明更新、恢复及数据兼容性，分别报告构建、宿主、授权和真实业务验证。
```

## 安装成功但无法访问

```text
诊断 <插件ID> 的 <页面/API/模型> 失败。环境 <OS、Node/pnpm、框架/宿主版本、运行/认证模式>，脱敏错误 <命令、目录角色、候选ID、HTTP状态>。
只读区分安装、监听、探针、授权和模型调用；核对 manifest/--plugins/enabled、入口、publicOrigin、同 DSH_HOME 的模型与凭据。已装 auth 不等于候选启用 auth。
给出预期、失败含义和最小修复，不关鉴权、清数据或删除 pending 试探。Windows 用 build.ps1，macOS/Linux 用 build.sh；沿用配置，需要重启时说明影响。
```
