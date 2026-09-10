<!-- Generated from packages/plugin-manager/README.md.tmpl by scripts/version.mjs; edit the template. -->

# @dsh-plugin-manager/plugin-manager

用于打包、安装和管理 DSH 应用的命令行工具（CLI）。独立包和内部 `plugins/*` 共用 build → check → pack，通过官方 DSH CLI 安装 Bundle、配置并受控启停。kit 和基础认证可选；管理声明不会自动保护业务路由。

## 安装与作者操作

<!-- Excerpt from doc/plugin-development.md.tmpl#author-tools; edit its source. -->
需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 tar。从同一框架 Release 取得 `dsh-plugin-manager-starters-0.16.1.zip`、`plugin-manager-0.16.1.tgz`；起步包的鉴权目录已带同版 kit；仅单独复制仓库示例或升级 kit 时另取 `plugin-kit-0.16.1.tgz`。核对随发行提供的 SHA-256，不假设这些包已发布到 npm registry。

起步 zip 内有 standalone-plugin、standalone-kit；选一个目录复制为自己的作者项目，不复制 node_modules、dist 或 .local。在作者项目以外创建独立工具目录 dsh-tools，在该工具目录安装实际 manager 归档：

```sh
pnpm init
pnpm add --ignore-workspace /absolute/path/plugin-manager-0.16.1.tgz
pnpm exec dsh-plugin-manager --version
```

将占位路径替换为实际绝对路径，含空格时加引号。以后 pnpm exec dsh-plugin-manager 都在这个工具目录执行，--root 明确指向作者项目。manager 不加入业务运行依赖；工具目录和作者项目各自保存锁文件。

<!-- Excerpt from doc/plugin-development.md.tmpl#author-pack; edit its source. -->
在工具目录执行，将作者项目换成实际绝对路径：

```sh
pnpm exec dsh-plugin-manager list --root /absolute/path/my-plugin --package .
pnpm exec dsh-plugin-manager pack --root /absolute/path/my-plugin --package . --output .local/artifacts/release/v1
```

list 只读声明，不要求锁文件；pack 要求作者根的 pnpm-lock.yaml，冻结安装后各执行一次 build/check，再校验并打包，无需事先重复 check。输出必须是新目录或空目录，路径相对作者 root；再次发布用新目录 v2。日常可独立运行 check，它会先 build，完整业务测试另行运行。

交付整个输出目录，其中有 manifest.json 和所有摘要命名 tgz。部署者把目录放到 incoming/my-plugin 后执行框架 build，不手写清单。不使用 prepare/prepack/postpack 重复构建。运行依赖不得指向作者机器或 workspace；pack 成功不是宿主、登录、模型或业务验收成功。

额外归档核对使用 `pnpm exec dsh-plugin-manager verify-package --root <作者根> --package . --archive <tgz>`，不重新构建。独立项目 --package 仅支持 .，与 --plugins 互斥。字段、源码/归档路径继续由既有公开校验负责。

## 部署现成归档

带 build 的部署包将完整发布目录放进 incoming 后运行根脚本，详情使用其随包 README。管理器 tgz 仍只提供 CLI；手工组合、启动、更新和配置见本包 [DELIVERY.md](DELIVERY.md)，不需要作者源码。

底层 start/apply-compose/compose-release 语义不变。清单 2 只支持 release，未声明 healthPath 显示 not-provided，不代表业务就绪；运行依赖可能需要网络。独立 CLI 必须指定 --root，不能从工具目录猜站点路径。

`release-site --root <站点> [--config <配置>] [--resume | --recover --data-compatible]` 是部署包 build 使用的统一编排入口；普通用户仍运行 build。recover 仅修正同包业务配置，不支持借此替换错误包。源码适配、锁和恢复说明见对应版本的[运维文档](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.16.1/deploy/README.md)。

## 内部批量开发与 API

省略 `--package` 时保留根锁文件及 `plugins/*` 扫描，支持 `--plugins "auth,example"`、默认选集、all/none。逗号分隔的 ID 列表加引号，避免 PowerShell 拆成数组。内部 kit 工作区准备和批量操作保持原行为。

包根导出部署函数，`/catalog` 导出 `readPlugin`、插件发现与选择，`/packaging` 导出打包函数。管理器只读取声明与归档，不导入业务源码。
## 发布物宿主验证

自 0.3.3 起支持可选验证记录及 `compose-release --verification-report <JSON>`。pack 只记录构建输入，测试运行器在最终 tgz 上验证后输出报告；安装提示不会仅因版本不同而阻止安装。完整流程、报告字段和记录能证明什么、不能证明什么见 [VERIFICATION.md](VERIFICATION.md)。

源码仓库提供根入口 `bash test-report.sh`，串联 auth/example 打包、真实宿主与本地模型替身测试、报告交付；需要已构建的官方 CLI，不执行站点部署。具体前置条件和输出目录见上述文档。

## 框架配置文件

独立 CLI 的字段与默认值见本包 [DELIVERY.md](DELIVERY.md#框架配置文件)。站点 build 自动生成 manifest/Compose，底层 CLI 要求显式输入，不能混用。模型密钥只注入官方 DSH，公开包不含真实配置或数据。
