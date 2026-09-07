# 私有部署验收

当前部署与更新入口见 [PRIVATE.md](../PRIVATE.md)，首次初始化流程见[一键部署](first-deployment.md)。验收以当前提交、实际镜像、发布清单和 HTTP 响应为准。

## 发布检查

- 本地完成选定插件的构建、类型检查、行为测试和归档消费检查；公共框架先推送 GitHub，再合入私有仓库并推送 Gitee。
- 服务器从 Gitee 快进更新，执行根 `bash build.sh`。`.local/source-release.json` 指向的记录应为 `ready`，记录中的 revision 应与服务器 `git rev-parse HEAD` 一致。
- `.local/artifacts/active-compose.json` 指向实际 Compose 配置。容器应为 healthy，镜像使用 `@dsh-plugin-manager/plugin-manager`，业务包保留 `dsh-auth`、`dsh-example`、`dsh-closedoff-assistant`。
- `/auth/health`、`/example/ready`、`/closedoff-qa/ready` 应返回 200；认证模式下，匿名访问业务历史接口应返回 401。
- 首次安装使用空数据目录；升级已有实例时，须停写备份并核对账号、授权、会话及插件配置。

## 功能检查

在隔离容器中消费实际发布归档，验证首次管理员登录与强制改密、授权、会话恢复、认证模式切换及缺失认证插件时的拒绝行为。示例问答另外验证流式输出、用户数据隔离、退出后中断和历史恢复。

使用本地模型替身的自动检查只证明应用集成行为。正式模型接入后，需要单独检查真实问答；浏览器交互验收也应单独记录。

构建日志、HTTP 结果、镜像与源码摘要以及备份路径存放于受限的 `.local/artifacts/` 或独立备份目录，不提交 Git。历史部署记录保留在 Git 历史和原始证据目录中，不作为当前版本状态。
