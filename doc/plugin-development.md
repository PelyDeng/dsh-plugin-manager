<!-- Generated from doc/plugin-development.md.tmpl by scripts/version.mjs; edit the template. -->

# 插件作者接入

作者在自己的仓库开发和打包，部署者只取得标准发布目录。先选适合自己的入口：

| 项目情况 | 做法 |
| --- | --- |
| 新建 DSH 插件 | 从本页起步包开始，先用原名跑通，再改业务 |
| 已有 Node 项目 | 调整为官方 Cordis 插件入口，提供 Bundle 和构建产物；不是只添加几个字段就能运行 |
| 非 Node 服务 | 服务继续独立部署，由一个 DSH 插件调用接口；框架不接管 Java/其他进程 |

直接打包支持独立 pnpm 单包。npm/yarn/monorepo 不承诺同样的一步流程；部署端只认合规发布物，不扫描作者源码。[部署者指南](first-deployment.md)与[配置规范](plugin-configuration.md)分别说明运行和声明。

## 独立仓库开发

### 1. 取得并安装工具

<!-- excerpt:author-tools -->
需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 tar。从同一框架 Release 取得 `dsh-plugin-manager-starters-0.16.0.zip`、`plugin-manager-0.16.0.tgz`；起步包的鉴权目录已带同版 kit；仅单独复制仓库示例或升级 kit 时另取 `plugin-kit-0.16.0.tgz`。核对随发行提供的 SHA-256，不假设这些包已发布到 npm registry。

起步 zip 内有 standalone-plugin、standalone-kit；选一个目录复制为自己的作者项目，不复制 node_modules、dist 或 .local。在作者项目以外创建独立工具目录 dsh-tools，在该工具目录安装实际 manager 归档：

```sh
pnpm init
pnpm add --ignore-workspace /absolute/path/plugin-manager-0.16.0.tgz
pnpm exec dsh-plugin-manager --version
```

将占位路径替换为实际绝对路径，含空格时加引号。以后 pnpm exec dsh-plugin-manager 都在这个工具目录执行，--root 明确指向作者项目。manager 不加入业务运行依赖；工具目录和作者项目各自保存锁文件。
<!-- /excerpt:author-tools -->

附件见 [GitHub Releases](https://github.com/PelyDeng/dsh-plugin-manager/releases)。已有框架源码的维护者可按[准备工具](getting-started.md#1-准备工具和目录)构建工具；普通作者不用克隆框架。

### 2. 先按原名跑通

Release 起步包的两个示例都在作者根执行 `pnpm install --ignore-workspace`。仅从仓库单独复制 standalone-kit 时，先把对应 kit tgz 保存为自己项目的 vendor/plugin-kit.tgz，再在作者根执行：

```sh
pnpm add --ignore-workspace --save-dev ./vendor/plugin-kit.tgz
```

vendor 是作者选择保存的公开构建输入，不能放真实配置；保留该归档和作者 pnpm-lock.yaml 以便再次构建。kit 内嵌到产物，运行包不能留下作者本地 file/link/workspace 路径。官方宿主实现仍由运行环境提供。

### 3. 构建、检查并交付

<!-- excerpt:author-pack -->
在工具目录执行，将作者项目换成实际绝对路径：

```sh
pnpm exec dsh-plugin-manager list --root /absolute/path/my-plugin --package .
pnpm exec dsh-plugin-manager pack --root /absolute/path/my-plugin --package . --output .local/artifacts/release/v1
```

list 只读声明，不要求锁文件；pack 要求作者根的 pnpm-lock.yaml，冻结安装后各执行一次 build/check，再校验并打包，无需事先重复 check。输出必须是新目录或空目录，路径相对作者 root；再次发布用新目录 v2。日常可独立运行 check，它会先 build，完整业务测试另行运行。

交付整个输出目录，其中有 manifest.json 和所有摘要命名 tgz。部署者把目录放到 incoming/my-plugin 后执行框架 build，不手写清单。不使用 prepare/prepack/postpack 重复构建。运行依赖不得指向作者机器或 workspace；pack 成功不是宿主、登录、模型或业务验收成功。
<!-- /excerpt:author-pack -->

按[首次部署](first-deployment.md)用真实请求跑通。无 kit 示例请求 `/independent-example/ready`；鉴权示例需 optional/auth、登录与授权后请求 `/independent-access-example/identity`。有了第一次成功后再改名称和业务。

### 4. 改名与实现业务

| 修改项 | 位置 | 需要一致的关系 |
| --- | --- | --- |
| npm 包名与作者版本 | package.json | 归档身份；独立于框架版本 |
| 插件 ID | deepseekPlugin.id、src 导出的 name/注册 ID | 用于部署选集和配置目录，不能与已有插件重复 |
| Bundle 插件名和 entry ID | cordis.patch.yml | 导入实际 npm 包；configuration.entryId 指向可配置条目 |
| 页面与探针路由 | src、entryPath/healthPath | 声明对应真实地址，不要求它们都与包名相同 |
| 权限 | permissions、注册信息、访问检查 | 使用同一应用权限；声明本身不保护路由 |

最低声明为 package.json 的 name/version/main/files、dsh.bundle.patch、deepseekPlugin schemaVersion=3/id、scripts.build/check 和包内 README。完整字段只在[配置规范](plugin-configuration.md)维护。需要业务参数时用 config 或声明 runtimeConfig；缺项错误包含插件 ID 与字段名，不输出凭据。不要复制框架登录、密码或部署实现。

后续开发循环：改代码并运行业务测试 → pack 到新的发布目录 → 整体替换 incoming 对应目录 → build → 再请求验证。多个应用保留完整选集，更新与配置错误恢复见部署指南。当前不提供外部 development/link/HMR。

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

按当前改动选择上表中的命令，不必每次全部执行。只交付时直接 package，不需要先重复 build/check。普通构建和测试不要求宿主子模块、模型密钥或 Docker；内部清单 1 保留 development/link，外部单包与组合清单 2 只支持 release。

源码部署可用 `./build.sh --rebuild-plugins c` 或 `.\build.ps1 --rebuild-plugins c` 只重建指定插件，并复用其余已启用插件的旧归档；部署选集、复用条件及恢复方式见[部署说明](../deploy/README.md#服务器源码发版)。日常 `pnpm package --plugins c` 只生成 c 的交付清单，不会自动补入其他插件。

可复用插件的构建输入须来自自身目录、受管共享源码，以及 `dependencies`、`devDependencies`、`optionalDependencies` 声明的本地依赖。读取其他插件源码也属于构建依赖，应通过本地包名和标准 `workspace:` 声明；间接依赖变化同样影响复用，匹配本地包名的 peer 依赖也会检查。example 读取 auth 源码生成索引，因此把 auth 声明为开发依赖。

本地构建归档可声明为 `file:vendor/library-0.1.0.tgz`，但必须位于声明它的插件自身目录内，是已纳入 Git 的常规 `.tgz` / `.tar.gz` 文件。复用时核对旧、新提交中的 Git blob 一致，且磁盘字节与 Git 对象相符；归档及父目录不能是符号链接。跨目录、目录形式、未跟踪或仅在忽略目录中的归档，以及 `link:` 依赖仍不支持复用，须全量构建。这不改变最终发布包不能携带 `file:` 运行依赖的约束：本地归档用于构建，所需代码应内嵌到插件产物。

任意脚本读取未声明目录、外部文件或环境产生的输入无法由 Git 差异证明；存在这种输入变化时应全量构建。

插件构建由显式 build/check/pack 流程执行，不得用依赖安装钩子触发插件构建或修改产物。选择重建前会核验相关安装钩子；不能以“插件没有被选中”为由允许其安装钩子间接重建。

### 3. 运行并验证

首次运行按[配置并启动](getting-started.md#3-配置并启动)操作；开发模式及管理参数见[部署命令](../deploy/README.md)。示例默认要求登录，候选选入 auth、example 并配置公开 origin。安装现成清单默认选择其中全部插件，也可通过 `--plugins` 限定。

## 复制完整问答应用到独立仓库

复制 `plugins/dsh-example` 中的源码、scripts、web、knowledge、examples、skills、Bundle、README/LICENSE、package.json、tsconfig 与 tsdown 配置；不复制 node_modules、dist、数据库和 .local。选择一个未加入原框架 workspace 的新包根。问答视觉与交互遵循随包 [聊天风格 skill](../plugins/dsh-example/skills/dsh-chat-style/SKILL.md)，包括折叠思考预览、流式更新和回答工具栏。

1. 在作者 package.json 删除 `@dsh-plugin-manager/plugin-kit` 的 `workspace:*` 开发依赖，再在作者根执行 `pnpm add --ignore-workspace --save-dev <kit-tgz绝对路径>`。同时删除只用于声明框架源码索引输入的 `dsh-auth` 开发依赖；索引读取第 5 步显式提供的框架源码。保留 tsdown 内嵌 kit，宿主依赖保持 peer。
2. 删除 scripts.clean 的原仓库相对入口，或换成只清理本包构建目录的实现。不要把数据目录加入清理命令。
3. `tests/config-examples.test.mjs` 含框架管理器集成检查，`tests/host-smoke.mjs` 使用框架相对宿主和归档路径；这两份留在框架，不复制到独立应用测试。其余 chat/history/knowledge 测试和 fixture 可作为应用自己的回归基础。
4. 修改包名、ID、Bundle、页面/探针、权限、配置 entryId、会话前缀/正则、提示词段名、知识、页面文案和测试；仅验证原 example 独立构建时可先保留名称，但不能与原包在同一候选中重复安装。
5. FAQ 读取包内 knowledge；源码问答索引在构建时生成。保留框架答疑用途时，把 build 中 `scripts/build-reference.mjs --root ../..` 的 root 改为明确的公共框架源码根路径；只在作者构建机需要该源码。部署时索引随 tgz 携带，不依赖作者目录。改成其他业务应替换 src/knowledge.ts 中职责、两份知识及源码检索能力，不能只改 config.systemPrompt；它仅为补充。
6. 在作者根执行 `pnpm build`、`pnpm check` 和 `pnpm test`，保存 pnpm-lock.yaml。在工具目录执行 `pnpm exec dsh-plugin-manager pack --root <作者包根> --package . --output <新发布目录>`。只交付无需事先重复 build/check。

部署者只取得整个发布目录及说明。确认 tgz 包含知识、页面、配置模板和入口；作者源码目录不参与 release。kit 更新需每个使用它的应用更新内嵌版本后重新交付，不能只升级管理器。

## 交付内容

作者随归档提供公开配置模板、包内 README、已验证宿主版本、就绪地址和一次业务验证方法。manager 可通过 `compose-release --verification-report` 将最终归档的测试记录附入新发布清单，详细字段与命令见[发布物验证记录](../packages/plugin-manager/VERIFICATION.md)。pack 的构建检查不等于宿主或模型测试。不要在归档中加入真实凭据或客户数据。

使用说明应提供就绪地址、普通账号操作步骤和所需授权。销售接口、数据范围、Agent 工具和图表属于应用代码，kit 的可信身份不能替代业务数据授权。

交付后的配置、启动和更新参考[产物部署指南](first-deployment.md)；需要自行组合清单或直接管理宿主时使用[手工 CLI 指南](../packages/plugin-manager/DELIVERY.md)。
