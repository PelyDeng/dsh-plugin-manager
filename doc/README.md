# 文档导航

[返回项目首页](../README.md)

按你要完成的事情选择入口。首次体验、独立开发和交付部署可以分别开始，无需先读完全部文档。

## 第一次使用

1. [图文体验：启动第一个应用](getting-started.md)——准备工具、打包、启动、登录与问答。
2. [Linux Docker 一键部署](first-deployment.md)——在服务器运行完整源码站点的另一条路径。
3. [进阶：加入第二个应用](getting-started.md#进阶加入第二个应用)——组合不同作者的交付物，保留原应用与账号。

## 开发插件

1. [独立仓库开发](plugin-development.md#独立仓库开发)——取得工具、复制示例、填写声明、构建与交付。
2. [内部工作区开发](plugin-development.md#内部工作区开发)——保留 `plugins/*` 扫描、批量任务及 development/link。
3. [复制完整问答应用](plugin-development.md#复制完整问答应用到独立仓库)——将流式对话、历史与知识示例迁入自己的仓库。
4. [插件配置规范](plugin-configuration.md)——声明、实例参数和运行配置。
5. [kit 接口](../packages/plugin-kit/README.md)——接入身份、权限、HTTP 与工具登记。

## 部署与维护

1. [独立发布物交付](../packages/plugin-manager/DELIVERY.md)——只取得包与清单即可部署，包含组合、配置、启动、验证和更新。
2. [部署与管理命令](../deploy/README.md)——仓库入口、运行配置、构建日志与恢复。
3. [数据和产物迁移](migration.md)——已有数据目录与发布物的迁移。
4. [Docker 集成](../integrations/docker/README.md)——宿主镜像与 Compose 使用。

## 查接口与解决问题

| 需要查什么 | 文档 |
| --- | --- |
| 常用命令与启动排错 | [体验手册速查](getting-started.md#命令速查与求助) |
| CLI 完整参数与行为 | [管理器参考](../packages/plugin-manager/README.md) |
| 框架和官方 DSH 的职责 | [架构与包职责](architecture.md) |
| 开发、授权及第二应用问题 | [开发者 FAQ](../plugins/dsh-example/knowledge/guide.md) |
| 让 AI 协助开发 | [五种可复制开发提示词](../plugins/dsh-example/knowledge/prompts.md) |
