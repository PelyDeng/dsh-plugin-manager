# 文档导航

[项目首页](../README.md) · [English](../README.en.md)

## 第一次使用

1. [插件产物一键部署](first-deployment.md)：下载部署包，放完整插件目录，运行 build。
2. [独立作者接入](plugin-development.md)：取得起步包与工具，开发和打包自己的插件。
3. [登录、授权与问答体验](getting-started.md)：使用 auth/example 验证实际功能。
4. [图文导览](quick-tour.md)：查看页面与操作效果。

## 开发插件

- [插件声明与实例配置](plugin-configuration.md)
- [kit 接口](../packages/plugin-kit/README.md)
- [内部工作区开发](plugin-development.md#内部工作区开发)
- [复制完整问答应用](plugin-development.md#复制完整问答应用到独立仓库)
- [会话管理](conversation-management.md)
- [聊天风格](../plugins/dsh-example/skills/dsh-chat-style/SKILL.md)

## 部署与维护

- [框架配置与默认值](framework-configuration.md)：站点参数、来源模式和凭据规则。
- [源码部署与恢复](../deploy/README.md)：按需构建、锁、resume 和同包配置 recover。
- [独立 CLI 交付](../packages/plugin-manager/DELIVERY.md)：手工清单组合、Node/Compose 操作；随工具包可离线阅读。
- [Docker 镜像与网络](../integrations/docker/README.md)
- [数据与产物迁移](migration.md)
- [宿主兼容](host-compatibility.md)
- [发布物验证记录](../packages/plugin-manager/VERIFICATION.md)

## 查询与维护规则

[FAQ](FAQ.md)负责故障判别，[架构](architecture.md)说明职责，[版本管理](versioning.md)说明模板与发行同步，[AGENTS.md](../AGENTS.md)规定开发约束。历史版本内容见各 Release，不用旧版本说明代替当前操作文档。
