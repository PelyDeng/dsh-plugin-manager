# 插件配置规范验收

2026-09-06，公共框架 `c97f8d1` 合并至私有集成 `7a2b1ec`，封闭化插件按统一规范声明配置入口。公共改动保存在 GitHub，定制插件保存在 Gitee，宿主 gitlink 保持 `d347e703908d0406b7a7ef80e3a0e594d86b2215`。

## 已验证

- 公共仓库 `pnpm check`、`pnpm build`、`node scripts/check-artifacts.mjs` 和源码文档检查通过；manager 74 项通过，3 项 Windows 平台不适用的检查跳过。
- 私人仓库 `pnpm check` 通过，包含封闭化插件 105 项行为测试；三个插件的发布归档已生成并验证。
- Linux 独立依赖环境的配置、权限、真实 health CLI 专项测试 12 项通过，无跳过。
- 隔离容器中，example 与封闭化插件分别只修改自己的 `plugin.json`，均完成 authenticated → standalone → authenticated。其他插件的配置与鉴权不受影响。
- example 通过 `enabled` 完成停用和重新启用，停用时路由移除、数据文件保留；仍有消费者要求认证时停用 auth，在停止容器前被拒绝。
- 生产服务已重启，容器 healthy、重启次数 0；公网 `/auth/health`、`/example/ready`、`/closedoff-qa/ready` 均返回 200，两项业务历史接口匿名访问返回 401。
- 生产重启前后均为 3 个账号、4 条授权、3 个登录会话、6 条封闭化会话、0 条 example 会话；数据库完整性检查通过，业务 `env.conf` 摘要一致。备份包含原站点配置、Compose 配置、用户 patch 和完整 DSH home。

验收覆盖配置应用、HTTP 接口、安装状态和数据保留；本次没有执行浏览器交互或真实模型问答回归。

## 运行版本

| 组件 | 版本 |
| --- | --- |
| DSH | 0.1.3-alpha.1 |
| plugin-manager | 0.2.0 |
| auth | 0.8.0 |
| example | 0.2.0 |
| closedoff | 0.3.0 |

镜像以原运行镜像为基础，仅替换 manager，引用为 `harbor.pelycloud.com/pelycloud/dsh-host@sha256:9dff95f5e3eac32e331ed6a4fac9e74c192473daa2f85f189d1bcf37536b5f0f`。

## 日常配置

每个插件使用 `<DSH home>/plugins/<id>/plugin.json`。生产实例的 auth、example、closedoff 均已初始化配置，两个业务插件都保持 `accessMode: authenticated`。`enabled` 控制插件启停；`accessMode: standalone` 仅关闭对应业务插件认证。修改后需要受控重启，见[插件配置规范](plugin-configuration.md)。

服务器在仓库根目录使用已安装的独立 manager：

```sh
node .local/tooling/node_modules/@dsh-plugin/plugin-manager/dist/cli.mjs apply-compose --root . --config .local/deployment.json
```

站点 origin、镜像、发布清单和 Compose 项目名只需在站点配置中维护；日常认证切换不修改这些字段。不要使用原手工 Compose 覆盖文件重启同一实例。当前成功生成的 Compose 路径记录在 `.local/artifacts/active-compose.json`。

本次证据位于 `.local/artifacts/plugin-settings-release/`：`production-result.json` 记录备份位置、版本、数据库计数和生产检查，`smoke-result.json` 与 `private-smoke-result.json` 记录隔离验收，`linux-final-tests.log` 记录 Linux 专项检查。运行证据和备份不提交 Git。
