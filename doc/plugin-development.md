<!-- Generated from doc/plugin-development.md.tmpl by scripts/version.mjs; edit the template. -->

# 插件作者接入

本框架支持独立 pnpm 单包与内部 `plugins/*` 批量开发。选择一种开发方式即可，无需先运行内置问答应用，也无需修改 DSH 本体。

[项目首页](../README.md) · [文档导航](README.md) · [CLI 参数](../packages/plugin-manager/README.md) · [部署者指南](../packages/plugin-manager/DELIVERY.md)

## 本页导航

- [独立仓库开发](#独立仓库开发)
- [内部工作区开发](#内部工作区开发)
- [复制完整问答应用到独立仓库](#复制完整问答应用到独立仓库)
- [交付内容](#交付内容)

## 独立仓库开发

### 1. 取得并安装工具

需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 `tar`。准备一个作者仓库之外的工具目录，例如 `dsh-tools`。取得维护者交付的 manager 0.13.2 tgz；需要统一身份时再取得 kit 0.13.2 tgz，按交付 SHA-256 核对文件。已公开归档见 [GitHub Releases](https://github.com/PelyDeng/dsh-plugin-manager/releases)，目标版本没有附件时按下方源码步骤构建，不假定 npm 已发布。以下命令安装本地归档。

在工具目录执行，把占位路径替换成实际文件的绝对路径：

```sh
pnpm add --ignore-workspace "/absolute/path/plugin-manager-0.13.2.tgz"
pnpm exec dsh-plugin-manager --version
```

**预期**：输出 manager 0.13.2。保存工具目录的锁文件；后续 `pnpm exec dsh-plugin-manager` 均在这个目录运行，通过 `--root` 指明作者仓库。尚无工具包时，可按[从源码准备工具](getting-started.md#1-准备工具和目录)中的工具 build/pack 步骤取得 tgz；仅打包插件不需要安装官方 CLI 或启动示例。

### 2. 选择示例，建立自己的仓库

将选定目录的内容复制到新的作者包根，放在框架 workspace 之外。不要复制 node_modules、dist 或 .local。

| 示例 | 验证能力 |
| --- | --- |
| [standalone-plugin](../examples/standalone-plugin/README.md) | 不依赖 kit，官方 Bundle 与受管 release 均可加载 |
| [standalone-kit](../examples/standalone-kit/README.md) | 独立消费 kit tgz，复用登录及应用授权，返回当前账号身份 |

无 kit 的示例，在作者根执行：

```sh
pnpm install --ignore-workspace
```

统一身份示例，在作者根执行以下命令安装实际 kit 归档，同时生成锁文件：

```sh
pnpm add --ignore-workspace --save-dev "/absolute/path/plugin-kit-0.13.2.tgz"
```

**预期**：作者根生成自己的 pnpm-lock.yaml，应随源码保存。kit 是构建依赖并内嵌到应用；作者构建需能取得该 tgz，release 运行端不需要它的原始路径。希望从完整聊天应用开始时，见[完整问答应用复制步骤](#复制完整问答应用到独立仓库)。

### 3. 填写声明，实现业务

修改包名、插件 ID、Bundle 与路由，保持相互一致；声明和配置字段见[配置规范](plugin-configuration.md)。在工具目录验证能发现自己的单包：

```sh
pnpm exec dsh-plugin-manager list --root "/absolute/path/my-plugin" --package .
```

**预期**：只列出指定包的插件声明，不依赖框架内部名单。`--package .` 相对于 `--root`；list 不要求锁文件，后续 pack 要求作者根存在锁文件并冻结安装。

build/check 由作者声明，完成产物构建和不可缺少的启动检查；完整业务测试保留独立 test。需要统一身份时显式接入 kit 的受保护接口，业务数据范围由应用检查。业务配置错误应标明应用 ID 与字段名，不能输出凭据。不要复制框架登录、密码或部署实现。

### 4. 构建、检查并交付

在工具目录执行，将作者根替换成实际绝对路径：

```sh
pnpm exec dsh-plugin-manager pack --root "/absolute/path/my-plugin" --package . --output .local/artifacts/release/v1
```

**预期**：在作者根的 `.local/artifacts/release/v1` 生成 manifest.json 和摘要命名 tgz。pack 已依次执行安装、build、check 和打包，无需先重复 build/check。输出目录必须使用新目录或空目录；失败时按对应任务错误修复，若已留下产物则换一个新输出目录重试。

日常开发可单独执行 `pnpm exec dsh-plugin-manager check --root "/absolute/path/my-plugin" --package .`；完整业务测试在作者根按自己的 test 脚本运行，不塞进每次打包的启动检查。

将整个发布目录交给部署者，不能只交 manifest.json。部署者按[交付指南](../packages/plugin-manager/DELIVERY.md)组合与启动；统一身份示例需要把认证 provider 一起选入候选清单，并配置 publicOrigin。两应用的完整演练见[进阶手册](getting-started.md#进阶加入第二个应用)。

当前外部入口仅支持 pnpm 单包及 release；不支持外部 workspace 自动发现或 development/link/HMR。

## 内部工作区开发

### 1. 安装依赖并扫描插件

在本仓库根执行，内部流程不传 `--package`：

```sh
pnpm install --frozen-lockfile
pnpm list:plugins
```

**预期**：继续扫描 `plugins/*`。新增插件放在该目录并按[配置规范](plugin-configuration.md)声明；使用 `--plugins` 选择需要处理的插件。源码默认选集包含 auth 和 example。

### 2. 选择日常检查或直接打包

| 目的 | 在本仓库根执行 |
| --- | --- |
| 日常构建 | `pnpm build` |
| 必要检查 | `pnpm check`，单插件可用 `pnpm check --plugins example` |
| 完整开发回归 | `pnpm test`，先构建再运行测试；CI 单独执行测试步骤 |
| 构建并交付 | `pnpm package --plugins "auth,example" --output .local/artifacts/release/plugins` |

只交付时直接 package，不需要先重复 build/check。普通构建和测试不要求宿主子模块、模型密钥或 Docker；内部清单 1 保留 development/link，外部单包与组合清单 2 只支持 release。

### 3. 运行并验证

首次运行按[配置并启动](getting-started.md#3-配置并启动)操作；开发模式及管理参数见[部署命令](../deploy/README.md)。示例默认要求登录，候选选入 auth、example 并配置公开 origin。安装现成清单默认选择其中全部插件，也可通过 `--plugins` 限定。

## 复制完整问答应用到独立仓库

复制 `plugins/dsh-example` 中的源码、scripts、web、knowledge、examples、skills、Bundle、README/LICENSE、package.json、tsconfig 与 tsdown 配置；不复制 node_modules、dist、数据库和 .local。选择一个未加入原框架 workspace 的新包根。问答视觉与交互遵循随包 [聊天风格 skill](../plugins/dsh-example/skills/dsh-chat-style/SKILL.md)，包括折叠思考预览、流式更新和回答工具栏。

1. 在作者 package.json 删除 `@dsh-plugin-manager/plugin-kit` 的 `workspace:*` 开发依赖，再在作者根执行 `pnpm add --ignore-workspace --save-dev <kit-tgz绝对路径>`。保留 tsdown 内嵌 kit，宿主依赖保持 peer。
2. 删除 scripts.clean 的原仓库相对入口，或换成只清理本包构建目录的实现。不要把数据目录加入清理命令。
3. `tests/config-examples.test.mjs` 含框架管理器集成检查，`tests/host-smoke.mjs` 使用框架相对宿主和归档路径；这两份留在框架，不复制到独立应用测试。其余 chat/history/knowledge 测试和 fixture 可作为应用自己的回归基础。
4. 修改包名、ID、Bundle、页面/探针、权限、配置 entryId、会话前缀/正则、提示词段名、知识、页面文案和测试；仅验证原 example 独立构建时可先保留名称，但不能与原包在同一候选中重复安装。
5. FAQ 读取包内 knowledge；源码问答索引在构建时生成。保留框架答疑用途时，把 build 中 `scripts/build-reference.mjs --root ../..` 的 root 改为明确的公共框架源码根路径；只在作者构建机需要该源码。部署时索引随 tgz 携带，不依赖作者目录。改成其他业务应替换 src/knowledge.ts 中职责、两份知识及源码检索能力，不能只改 config.systemPrompt；它仅为补充。
6. 在作者根执行 `pnpm build`、`pnpm check` 和 `pnpm test`，保存 pnpm-lock.yaml。在工具目录执行 `pnpm exec dsh-plugin-manager pack --root <作者包根> --package . --output <新发布目录>`。只交付无需事先重复 build/check。

部署者只取得整个发布目录及说明。确认 tgz 包含知识、页面、配置模板和入口；作者源码目录不参与 release。kit 更新需每个消费应用更新内嵌版本后重新交付，不能只升级管理器。

## 交付内容

作者随归档提供公开配置模板、包内 README、已验证宿主版本、就绪地址和一次业务验证方法。manager 0.3.3 可通过 `compose-release --verification-report` 将最终归档的测试记录附入新发布清单，详细字段与命令见[发布物验证记录](../packages/plugin-manager/VERIFICATION.md)。pack 的构建检查不等于宿主或模型测试。不要在归档中加入真实凭据或客户数据。

使用说明应提供就绪地址、普通账号操作步骤和所需授权。销售接口、数据范围、Agent 工具和图表属于应用代码，kit 的可信身份不能替代业务数据授权。

交付后的组合、配置、启动和更新统一参考[部署者指南](../packages/plugin-manager/DELIVERY.md)。
