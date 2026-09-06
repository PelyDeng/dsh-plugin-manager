# 插件配置规范验收

2026-09-06，公共框架 `c97f8d1` 合并至私有集成 `7a2b1ec`，封闭化插件按统一规范声明配置入口。公共改动保存在 GitHub，定制插件保存在 Gitee，宿主 gitlink 保持 `d347e703908d0406b7a7ef80e3a0e594d86b2215`。

## 最新部署：服务器源码发版

2026-09-06，服务器在私有集成提交 `e0bfca90a30ea991807cfccd52094d0128e107b8` 上执行 `git pull --ff-only` 和 `bash deploy/build.sh`，完整完成源码依赖安装、管理器与三个插件的构建检查、打包、镜像推送、停服备份、Compose 部署及健康等待。公共框架对应 `bd8d7ad`；管理器为 `0.2.2`，example 为 `0.2.1`。各组件版本来自源码，运维不需要分别指定版本或上传本机归档。

- 生产容器 healthy，重启次数 0，无未完成安装记录；三项健康接口返回 200，两个业务历史接口匿名访问返回 401。
- 三个插件共 31 个受检文件与服务器生成的归档逐字节一致；安装引用使用清单中的摘要文件名。
- 插件配置及业务 `env.conf` 摘要未变；数据库完整性检查通过，账号、授权、登录会话及业务会话计数与更新前一致。
- 生产部署前，使用停服备份的隔离副本，在独立端口验证了相同的安装文件和认证行为。未执行浏览器或真实模型问答回归。

迁移验证中发现固定归档名复用旧包，以及 pnpm 替换依赖时仍需读取旧归档的问题。两次失败均恢复了停服备份中的 profile 和原 Compose，业务数据库没有回退。修复采用内容摘要归档名，并在新发布目录保留上一份清单引用的已校验归档；隔离验证通过后，生产按完整源码入口重新部署成功。

完整构建日志和最终验证位于 `.local/artifacts/source-build-e0bfca9/`，隔离验证位于 `.local/artifacts/source-migration-smoke/result.json`。成功操作记录及备份位于 `.local/artifacts/source-release-e0bfca90a30e-df75a2b3-4d84-440c-8380-3174b5e0e55c/`。失败现场和旧版本备份保留，不提交 Git。

## 历次部署：0.2.1

2026-09-06，服务器部署公共框架 `7fc04ef`、私有集成 `7beb8fd`。plugin-manager 与 example 均更新为 `0.2.1`：管理器支持省略非必填发布元数据，example 归档包含完整配置模板及必填、默认值说明。DSH、auth 和 closedoff 版本保持不变。

- 容器内与服务器独立运维目录 `.local/tooling` 的 manager 均为 `0.2.1`；容器 healthy，重启次数 0。
- 容器内实际 health CLI 检查 auth、example、closedoff 均 ready；独立夹具验证未声明 `healthPath` 时返回 `ready: not-provided`，不阻断检查。
- 公网三项健康接口均返回 200；example 与 closedoff 历史接口匿名访问均返回 401。两个业务插件继续要求认证。
- 三份插件配置与业务 `env.conf` 摘要未变，数据库完整性检查通过。更新前后均为 3 个账号、4 条授权、3 个登录会话、6 条封闭化会话、0 条 example 会话。
- 已安装 example 归档包含说明文档及三份 JSON 配置模板；模板没有覆盖生产配置。

本次检查覆盖镜像、归档、容器健康、HTTP 接口及数据保留，没有执行浏览器交互或真实模型问答回归。证据位于 `.local/artifacts/runtime-0.2.1-7beb8fd/result.json`，镜像构建记录位于同目录 `image/record.json`。同目录 `backup/` 保留停写后的完整 DSH home、原站点配置及 Compose 配置；旧镜像和发布目录保留。

## 首次规范验收

- 公共仓库 `pnpm check`、`pnpm build`、`node scripts/check-artifacts.mjs` 和源码文档检查通过；manager 74 项通过，3 项 Windows 平台不适用的检查跳过。
- 私人仓库 `pnpm check` 通过，包含封闭化插件 105 项行为测试；三个插件的发布归档已生成并验证。
- Linux 独立依赖环境的配置、权限、真实 health CLI 专项测试 12 项通过，无跳过。
- 隔离容器中，example 与封闭化插件分别只修改自己的 `plugin.json`，均完成 authenticated → standalone → authenticated。其他插件的配置与鉴权不受影响。
- example 通过 `enabled` 完成停用和重新启用，停用时路由移除、数据文件保留；仍有消费者要求认证时停用 auth，在停止容器前被拒绝。
- 生产服务已重启，容器 healthy、重启次数 0；公网 `/auth/health`、`/example/ready`、`/closedoff-qa/ready` 均返回 200，两项业务历史接口匿名访问返回 401。
- 生产重启前后均为 3 个账号、4 条授权、3 个登录会话、6 条封闭化会话、0 条 example 会话；数据库完整性检查通过，业务 `env.conf` 摘要一致。备份包含原站点配置、Compose 配置、用户 patch 和完整 DSH home。

验收覆盖配置应用、HTTP 接口、安装状态和数据保留；本次没有执行浏览器交互或真实模型问答回归。

## 当前运行版本

| 组件 | 版本 |
| --- | --- |
| DSH | 0.1.3-alpha.1 |
| plugin-manager | 0.2.2 |
| auth | 0.8.0 |
| example | 0.2.1 |
| closedoff | 0.3.0 |

当前源码发版镜像为 `harbor.pelycloud.com/pelycloud/dsh-host@sha256:023707a3a8ab7acceb20b5a80815c5b2ceeb4c9bc46ba6c4882380854b936ca5`，复用已验证的 DSH 宿主层；同次发版的三个插件均从服务器源码重新构建。升级前镜像为 `harbor.pelycloud.com/pelycloud/dsh-host@sha256:f447357b0d2203072fb1eb76ebfb02ca6fd607b0a7655b725fd0385abc341f42`。

## 日常配置

每个插件使用 `<DSH home>/plugins/<id>/plugin.json`。生产实例的 auth、example、closedoff 均已初始化配置，两个业务插件都保持 `accessMode: authenticated`。`enabled` 控制插件启停；`accessMode: standalone` 仅关闭对应业务插件认证。修改后需要受控重启，见[插件配置规范](plugin-configuration.md)。

服务器版本更新在仓库根目录执行：

```sh
git pull --ff-only
bash deploy/build.sh
```

只调整插件配置而不更新代码时，使用 `bash deploy/build.sh apply-compose --config .local/deployment.json`。站点 origin 和 Compose 项目名在站点配置中维护；源码发版自动更新镜像和发布清单，日常认证切换不修改这些字段。不要使用原手工 Compose 覆盖文件重启同一实例。当前成功生成的 Compose 路径记录在 `.local/artifacts/active-compose.json`。

首次规范验收证据位于 `.local/artifacts/plugin-settings-release/`：`production-result.json` 记录备份位置、版本、数据库计数和生产检查，`smoke-result.json` 与 `private-smoke-result.json` 记录隔离验收，`linux-final-tests.log` 记录 Linux 专项检查。运行证据和备份不提交 Git。
