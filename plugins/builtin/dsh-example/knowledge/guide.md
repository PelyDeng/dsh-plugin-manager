<!-- Generated from plugins/builtin/dsh-example/knowledge/guide.md.tmpl by scripts/version.mjs; edit the template. -->

# 开发者接入 FAQ

这是框架 0.19.2 随包指南。模型不可用时仍可在已授权应用中阅读；内容来自发布时固定的公共文档，不扫描部署者机器。在线 main 可能领先，知识不能证明生产状态。

## 这个框架是做什么的？

假设你想给团队做两个应用：知识库助手和销售报表助手。作者各自在自己的项目里写业务，打包后交给部署者统一运行。DSH 提供插件、Agent、模型和会话；manager 管理产物、配置、安装与启停；可选 auth/kit 提供账号和可信身份。业务权限仍由各应用检查，不因写了声明自动生效。

## 我已经有项目，怎么选入口？

新建 DSH 插件从 standalone-plugin 或 standalone-kit 起步。已有 Node 项目需满足 Cordis 插件入口与构建契约；其他语言服务继续独立运行，可由 DSH 插件调用接口。当前直接打包支持 pnpm 独立单包，不自动扫描外部 workspace，也不提供外部 development/link/HMR。普通 zip、前端 dist、Java jar 不能自动成为可加载插件。

## 工具从哪里来？

<!-- Excerpt from doc/plugin-development.md.tmpl#author-tools; edit its source. -->
需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 tar。从同一框架 Release 取得 `dsh-plugin-manager-starters-0.19.2.zip`、`plugin-manager-0.19.2.tgz`；起步包的鉴权目录已带同版 kit；仅单独复制仓库示例或升级 kit 时另取 `plugin-kit-0.19.2.tgz`。核对随发行提供的 SHA-256，不假设这些包已发布到 npm registry。

起步 zip 内有 standalone-plugin、standalone-kit；选一个目录复制为自己的作者项目，不复制 node_modules、dist 或 .local。在作者项目以外创建独立工具目录 dsh-tools，在该工具目录安装实际 manager 归档：

```sh
pnpm init
pnpm add --ignore-workspace /absolute/path/plugin-manager-0.19.2.tgz
pnpm exec dsh-plugin-manager --version
```

将占位路径替换为实际绝对路径，含空格时加引号。以后 pnpm exec dsh-plugin-manager 都在这个工具目录执行，--root 明确指向作者项目。manager 不加入业务运行依赖；工具目录和作者项目各自保存锁文件。

## 如何构建和交付？

<!-- Excerpt from doc/plugin-development.md.tmpl#author-pack; edit its source. -->
在工具目录执行，将作者项目换成实际绝对路径：

```sh
pnpm exec dsh-plugin-manager list --root /absolute/path/my-plugin --package .
pnpm exec dsh-plugin-manager pack --root /absolute/path/my-plugin --package . --output .local/artifacts/release/v1
pnpm exec dsh-plugin-manager verify-release --release .local/artifacts/release/v1
```

list 只读声明，不要求锁文件。pack 只做构建、打包与内容寻址（归档按实际字节摘要命名），不再顺带做检查或校验；输出必须是新目录或空目录，路径相对作者 root，再次发布用新目录 v2。自检是三条独立命令：`check`（先 build 再跑类型检查等，日常开发用它）、`verify-package --root <包根> --package . --archive <tgz>`（归档与本次构建源码字节一致）、`verify-release --release <发布目录>`（整个交付目录的清单、摘要、包结构与元数据合规，可进 CI）。pack 成功后 CLI 只说明生成了什么，不说"已验证"。

交付整个输出目录，其中有 manifest.json 和所有摘要命名 tgz。部署者把目录放到 incoming/my-plugin 后执行框架 build，不手写清单。不使用 prepare/prepack/postpack 重复构建。运行依赖不得指向作者机器或 workspace；pack 成功不是宿主、登录、模型或业务验收成功。交付时以整个目录为单位，不单独抽走 tgz。

作者最低声明：name/version/main/files、dsh.bundle.patch、deepseekPlugin.schemaVersion=3/id、scripts.build/check 和 README。entryId 必须对应实际 Cordis patch 条目。注册名、ID、路由及权限修改关系见起步包 README；完整规范查 doc/plugin-configuration.md。

## 部署者收到什么，如何启动？

<!-- Excerpt from doc/first-deployment.md.tmpl#deployment-start; edit its source. -->
从同一个框架 Release 取得 `dsh-plugin-manager-deployment-0.19.2.zip` 并解压。准备 Node.js `^22.19.0 || >=24`、系统 tar、本机 Linux Docker 引擎及 Compose；不自动安装系统软件。首次 build 会在随包公开构建视图（`source/` 与 `tools/builtin-build/`）里安装框架工作区依赖，并按站点根清单准备固定版本的 pnpm；这一步需要网络或完整缓存，站点自身目录不会安装依赖。镜像架构必须有该版本实际提供的运行镜像，不使用未验证的默认摘要。

每个作者交付的是一个完整目录，包含 manifest.json 和它引用的全部 tgz。将它放在部署根的 incoming 直接子目录中：

```text
dsh-deployment/
├─ build.ps1 / build.sh
├─ tools/                       随包管理器与公开构建输入，不手改
├─ source/                      公开源码材料，内置插件构建输入，不手改
├─ framework-runtime.json       固定运行镜像信息，不手改
├─ incoming/
│  └─ my-plugin/
│     ├─ manifest.json
│     └─ my-plugin-<摘要>.tgz
└─ .local/                      运行后创建，保留配置和数据
```

在部署根执行 `bash build.sh`；Windows PowerShell 执行 `.\build.ps1`。普通 zip/tgz 单文件不能代替完整发布目录。内置 auth、example 由本次构建产出（archives 用随包公开构建视图），已经在候选里；`incoming/` 只放外部作者的完整发布目录。把随包的 `public-apps`（同一批插件）再放进去会在准备输入阶段被拒绝，并指明与哪个内置插件重复。不要删除组合清单中某个归档来挑选插件。

产物合规由**作者在交付前**自检，部署侧不重复检查：作者打包后执行 `dsh-plugin-manager verify-release --release <发布目录>`，它只读目录，退出码 0 表示清单格式、产物摘要、包结构与包内元数据一致。部署者收到目录后想再确认一次，可在**停服前**对 incoming 下的目录跑同一条命令；它不接触部署状态，也不改动任何文件。

首次自动创建 .local/env.conf。新 archives 站点的可编辑业务配置在 .local/config/plugins/<id>/，错误提示会给出实际文件、插件 ID、已知缺项和下一条命令。填写真实必需参数后再执行同一个 build；已有配置不覆盖。无必需业务配置的最小插件应一次执行完成。业务 Schema 错误可能在加载阶段才发现，不能把模板存在当作配置正确。

成功输出访问地址、选中插件、声明探针结果及发布记录。未声明探针的 not-provided 表示未提供业务就绪检查。默认本机地址为 http://127.0.0.1:7902；实际请求和响应还需按插件 README 验证。

## 如何首次登录并验证实际功能？

<!-- Excerpt from doc/getting-started.md.tmpl#first-login; edit its source. -->
需要认证的应用先确认已选入并启用 auth，再访问实际站点的 /auth；无认证应用跳过登录。空数据库首次管理员为 admin，初始密码 123456；首次登录按页面强制改密，然后重新登录。此后创建普通账号，为它勾选目标插件授权，再用该普通账号登录。

鉴权起步插件的实际请求为 /independent-access-example/identity，成功返回含 owner 的 JSON；匿名或无该应用授权的账号不应取得身份结果。无 kit 的起步插件请求 /independent-example/ready，成功返回其 README 定义的就绪 JSON。测试身份端点不需要模型。

已部署 example 时，普通账号打开 /example；尚未配置模型可点击“阅读 FAQ（无需模型）”，指南仍需应用授权，但不创建 Agent 或调用模型。配置自己的模型后新建对话，确认真实流式回答及历史恢复。/auth 登录、官方根路径认证和模型 API 密钥分别管理，不能用填模型密钥修复根路径的认证提示。健康检查、登录和真实模型调用分别验证。

## Auth 登录后，根路径为什么仍提示认证？

<!-- Excerpt from doc/FAQ.md#root-auth; edit its source. -->
根路径出现 `dsh web authentication required`，表示官方控制台需要其自己的启动认证地址。/auth 的插件账号、官方控制台令牌和模型 API 密钥是三种不同凭据。仅使用业务应用时从 /auth 进入已授权应用即可。

需要官方控制台时，在私有本机文件中读取本次启动生成的认证 URL（默认 .local/data/dsh-web-auth-url.txt；自定义路径看实际输出），仅在自己的浏览器访问。不分享其中 token；填模型 API 密钥不会修复控制台登录，重启后应使用本次的新地址。

控制台 API 返回 403 时检查 trustedHosts，而不是只改 publicUrl/publicOrigin。域名、端口和信任项应使用同一实际站点；不关闭鉴权或 CSRF 来掩盖问题。

## 第一次如何配置或更换 API 密钥？

<!-- Excerpt from doc/framework-configuration.md#model-credentials; edit its source. -->
私有 .local/env.conf 中的 DEEPSEEK_API_KEY / ZHIPU_API_KEY 非空时：文件为准，只注入官方DSH子进程，网页只读；改文件后受控部署。留空不添加覆盖、不删除官方凭据、不清除继承环境密钥。没有外部环境覆盖时，管理员可在 /auth 的“模型设置”管理 DeepSeek/智谱，写入官方存储时默认无需重启。

网页只返回状态与 SHA-256 指纹，不返回原密钥。指纹不能还原密钥；“已配置”不代表余额、网络或调用通过。命令行 set-api-key 只支持 DeepSeek，密钥使用隐藏输入，不放在 argv。在安装 manager 的工具目录使用 `pnpm exec dsh-plugin-manager set-api-key --root <站点根> --config .local/deployment.json`。

已有源码仓库可使用 `bash deploy/scripts/set-api-key.sh --config .local/deployment.json`；Windows 使用 `node deploy/scripts/set-api-key.mjs --config .local/deployment.json`。这些源码包装器不属于独立起步项目。Compose 核验当前容器与 home 后以实际用户写入；独立 CLI 指向已安装的兼容宿主。默认凭据服务/监听关闭或自定义时，通过当前服务的网页入口管理。

模型默认值由同一宿主的官方 agentDefaultModel 提供；管理员选择新会话默认模型无需重启。已有会话及分支按官方记录恢复，模型选择为 pending ?? lastUsed，读取或投影失败拒绝恢复，不用新默认覆盖旧记录。凭据不会创建提供方路由，健康探针不调用模型；实际问答另验收。

## 只改 C，能只构建 C 或任意多个插件吗？

<!-- Excerpt from deploy/README.md#source-rebuild; edit its source. -->
内置插件（`plugins/builtin/`）由根 build 在只含公开输入的构建视图里**固定全量**构建，不再按旧成功记录逐插件复用；外部/私有插件由作者自行打包成完整发布目录放入 incoming，缺外部归档时在停旧前报错，绝不回退构建作者源码。部署选集仍由 `DSH_PLUGINS`/站点配置控制，构建某个插件不表示启用它。

内置构建只使用框架发行方的完整公开构建输入（`packages`、`plugins/builtin`、`scripts`、`deploy`、`integrations`、`examples`、`doc`、`.github` 与公开根文件），不在私有全 workspace 安装、不触发 external 脚本；两类产物合并为一份安装计划，共用安装启动健康流程。

普通 build 每次从当前现场重新收敛，没有 resume/recover/--rebuild-plugins：准备失败不触旧服务；停旧失败不改安装层；包增删或安装验证失败保留授权与安装层；启动或探针失败停止本次候选。修正输入后直接重新运行 build。旧站点升级先执行 `dsh-plugin-manager migrate-site --root <站点根> --config <配置>` 预览，确认后加 `--apply --stopped-file <停写证据>`（物理搬迁用 `--rebind`）完成一次性迁移。

迁移在站点锁与 profile 锁下执行，并只补写能证明属于同一次未完成转换的现场。取锁、退役残留锁与显式解锁共用同一把 control 锁（`<profileRoot>/.deepseek-plugin-lock.control`）：残留锁只有在能证明持有者已退出时才退役——本机记录要求 PID 已退出，容器来源要求停写证据声明 compose 且本机引擎上没有任何运行中容器在写同一批持久目录；来源不明时保留记录并提示人工移出 profile 目录。声明的管理者是 compose 时，停写证据本身也会核对本机引擎上的重叠写入者，不接受「只停了声明的那一个容器」。

旧 profile 里指向旧归档挂载的 `file:` 引用会在写任何新元数据之前保全；旧活动记录不可读或缺少时，用 `--archive-root <旧归档主机目录>` 明确原位置。迁移步骤与回退见随包维护的迁移文档。

## 第二个应用加入、升级与停用？

<!-- Excerpt from doc/first-deployment.md.tmpl#deployment-update; edit its source. -->
incoming 是期望保留的完整集合，不是一次性投递队列。新增插件放一个新的完整目录；更新则整体替换对应目录，保留其他应用。一个清单含多个插件时整体更换，不覆盖合并新旧文件。重复 ID/包名会报错，不自动挑“最新版本”。

先在 incoming 外解压并核对新发布目录；停止编辑和并行 build。下面假设 my-plugin 是原目录，incoming 外的 next/my-plugin 是准备好的完整新目录，backups/my-plugin-v1 尚不存在。

Windows PowerShell，在部署根执行：

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
Move-Item -LiteralPath incoming/my-plugin -Destination backups/my-plugin-v1
Move-Item -LiteralPath next/my-plugin -Destination incoming/my-plugin
.\build.ps1
```

Linux，在部署根执行：

```sh
mkdir -p backups
test ! -e backups/my-plugin-v1 && mv incoming/my-plugin backups/my-plugin-v1
test ! -e incoming/my-plugin && mv next/my-plugin incoming/my-plugin
bash build.sh
```

每个命令失败后先修复，不继续执行后续步骤；不要删除原目录或数据来重试。build 在停服前显示新增、更新、保留和停用。移走仍启用的插件产物会拒绝，不等于卸载。停用配置型插件先设 enabled=false 并成功部署，再移走其产物；其他插件用 DSH_PLUGINS 显式列出保留集合。留空选集为全部发现项，[] 才是明确空集合。

框架升级在同一站点 root 替换公开脚本、tools、source、framework-runtime.json 和公开模板；incoming/.local 原样保留。内置插件固定全量构建，外部产物来自 incoming；普通 build 每次从当前现场重新收敛。

## 构建或部署失败如何处理？

<!-- Excerpt from deploy/README.md#install-retry; edit its source. -->
归档、公共配置结构或认证提供者缺失在停服前报告。插件业务 Schema 可能在加载时才检查；健康通过仍需实际业务请求。保留 .local/data、.local/artifacts、incoming 和用户备份，不通过删除状态重新初始化。

| 情况 | 操作 |
| --- | --- |
| 准备阶段失败（旧服务未动） | 修正输入后 `bash build.sh` |
| 停旧失败 | 由原管理者处理仍活跃的服务，再 `bash build.sh` |
| 包增删或安装验证失败 | 修正包/权限/网络后 `bash build.sh`，从当前现场重新求差 |
| 启动或就绪探针失败 | 停止本次候选并确认退出，修正后 `bash build.sh` |
| 遗留站点发布锁 | `bash build.sh doctor` 查看归属，确认进程退出后 `bash build.sh unlock-source` |

Windows 用 `.\build.ps1` 替代 bash build.sh。doctor 只读诊断锁和记录，不要求 Docker/kit，也不是完整的安装环境扫描。`dsh-plugin-manager check-records --root <站点根> --config <env.conf|deployment.json>` 只读对比上一次发布记录、活动 Compose、镜像、容器与 profile 证据，报告现场差异与需要人工核实的项；它不写状态、不动容器，旧记录只作诊断、不阻断普通 build，收敛仍须显式执行。

受管授权集合（profile 状态 schema 3）承接部分失败：add 写一半失败后授权已持久保留，普通 build 重新求差并修复，不要求 pending 或同一包版本；remove 完成后才移除授权，遗留的精确受管 Bundle 会被清理，模板与非受管内容不变。换修复包、宿主或工具直接准备新的完整输入再 build；不自行删锁、改记录或删数据。恢复只收敛部署，不回滚业务数据；发布归档和配置副本不能代替独立数据备份。

输入不合法时依错误修复；暂时网络和权限问题不等于包缺陷。业务加载失败也不一定是模型密钥错误，分别查服务 inject 声明、插件参数、授权和提供方错误。提问附版本、操作系统、Node/pnpm、目录角色、脱敏命令与错误、预期/实际结果，不发送完整 env、Cookie、token 或数据库。

## 配置在哪里？为什么装了 auth 还提示缺 provider？

<!-- Excerpt from doc/framework-configuration.md#platform-defaults; edit its source. -->
Windows 使用 build.ps1，Linux/macOS 使用 build.sh。已有配置不覆盖；手工复制公共模板不探测平台。源码公共模板的 DSH_IMAGE_PLATFORM=linux/amd64，source 新站点根据 Docker 引擎初始化架构；Windows/Linux UID/GID 默认 1000，macOS 非 root 用户使用当前 UID/GID。archives 只选发行信息实际提供的镜像架构，未提供的架构拒绝，不回退构建源码。

两个入口都构建全部内置插件（source 用检出、archives 用随包公开构建视图），留空 DSH_PLUGINS 表示候选全集＝全部内置加全部 incoming；独立 CLI 使用显式清单；三者不能混用默认选集。incoming 只放外部作者的完整发布目录，与内置同 id 的目录会被组合清单拒绝。新 archives 可编辑插件配置位于 .local/config/plugins/<id>，通过已有 instances 引用；旧记录及显式 settingsFile/runtimeConfig 原样沿用，不自动迁移 home/plugins。

Docker 只接受本机 Linux 引擎 unix/npipe endpoint。Docker Desktop 使用桥接与 TCP 转发，原生 Linux 使用 host 网络；同 Docker 网络是信任边界，不能据此承诺公网隔离。macOS 尚未完成真实 Docker 部署验收，架构与平台以具体发行验收范围为准。本次所有命令固定到同一 endpoint，不要求历史引擎 ID 与本次一致。

每个实例保留 plugin.json 的 enabled/accessMode/config；业务凭据使用已声明 runtimeConfig，不加入公开归档。认证消费者默认 authenticated，本次候选必须有唯一启用 provider；过去装过 auth 不代表这次已选中。元数据不会保护作者自行注册的路由。停用保留数据，重新启用仍需存在于候选中。

## 如何增加页面、Tool 或 Agent？

页面使用官方 WebServer；受保护接口从 kit 的 createAccess/createPluginHttp 获得可信 actor。工具按 kit 的 createPluginTools/guardTool 接入，并加入 Agent 白名单。`createPluginTools().register(定义, 显示名, 分类)` 的第三个参数是**工具分类标签**，由注册方自己填写：它既用于认证页面按标签分组展示，也是宿主按标签限制可见范围的依据 —— `toolsForCategory(条目, 本分类)` 返回「本分类 + 通用工具」，调用方在 Agent 的 setup 里用 `tools.restrict({ allow })` 应用它，该 Agent 就只能调用自己标签下的工具。约定好的公共集用固定标签 `通用工具`（kit 导出的 `UNIVERSAL_TOOL_CATEGORY`），每个 Agent 都能调。不传分类的工具不参与这套限制，既有插件不受影响。完整签名先查 packages/plugin-kit/README.md 与实际导出，不猜接口。业务账号由可信请求上下文取得，不接受模型生成的 userId。

## 插件的页面怎么改、怎么测？

<!-- Excerpt from doc/plugin-development.md.tmpl#author-page-test; edit its source. -->
插件的页面代码是浏览器原生模块，没有 jsdom 能覆盖的执行环境，所以布局改动最容易只能靠人眼。仓库提供的做法是**真的把页面跑起来量一遍**：`scripts/web-page-probe.mjs` 起静态服务、按桩文件顶掉接口、用无头 Chromium 在多个视口宽度下执行你写的探针表达式，再把结果打回来。

```bash
node scripts/web-page-probe.mjs --root plugins/builtin/dsh-auth --prefix /auth \
  --stub plugins/builtin/dsh-auth/tests/page-stub.json --probe plugins/builtin/dsh-auth/tests/page-probe.js \
  --widths 1150,860,640
```

探针就是一段返回可序列化值的表达式，能直接读 DOM（样例量的是每行卡片数、同一行卡片头部与页脚的位置差、是否横向溢出、说明渲染了几行）。`plugins/builtin/dsh-auth/tests/page-layout.test.mjs` 把这些量变成断言，`pnpm test` 里就会跑：宽视口必须出现三张一行、窄视口回落单列、任何宽度都不许出现错位或横向溢出。

页面 HTML 与构建产物不在同一目录时：用 `--dir <目录>` 换掉页面目录（默认 `<root>/web`），用 `--mount <路径=目录>` 把产物目录挂到宿主约定的资源前缀下；HTML 里有待宿主替换的占位配置时，用 `--replace <词=文件>` 在返回前换成该文件内容。探针与桩文件放在插件的 `tests/` 下随源码维护，不需要额外依赖。加 `--json` 只输出结果，便于脚本消费。

**断言要守住两条底线**：产物缺失属于构建问题，应当直接失败并给出该跑的命令；只有机器上确实没有可用 Chromium 时才允许跳过（`CHROME_PATH`／`--browser` 指定，`--require-browser` 把跳过变成失败），而且跳过在测试里必须记成真正的 SKIP，不能算通过。

私有页面若依赖宿主注入的配置或构建产物，就按上面两种做法（`--replace`／`--mount`）把夹具补齐再改；跳过必须是真正的 SKIP，产物缺失要当构建问题直接失败。

## 如何复制完整 example？

改包名、插件 ID、Bundle、权限、配置 entryId、页面路由、会话前缀/正则、提示词段名、知识和测试。独立包将 kit 改成版本化相对构建输入并内嵌，替换框架专用构建脚本和测试。config.systemPrompt 只是补充，不能只改它就把内置开发者知识变成其他业务；详见 doc/plugin-development.md。

## 历史、授权与模型恢复会怎样？

authenticated 历史按可信账号隔离；standalone 使用安装级共享身份，不能承诺个人私有。切换模式保留两个命名空间，不自动合并或迁移。撤权/退出取消该登录的活动回答。模型读取前仍需核对 owner，分支只读取分支点之前的官方事件。

本人会话管理允许查找、预览与逐项归档，不直接删宿主日志；正文缺失或投影失败须明确报告。具体语义查 doc/conversation-management.md、kit/conversations 与公共应用实现。

新对话标题复用官方宿主的首句提炼，插件不重复发标题请求；宿主辅助请求仍有模型用量。标题可能晚于回答结束：当前新会话先刷新历史，仍为 automatic 时每 2 秒刷新，最多 65 秒；取得生成标题、手动改名、切换或新建会话后停止。后来提问不会反复改名。

通过 kit 的 registerConversationTitles(ctx, accept) 在插件生命周期接收 (id,title,manual,complete)，只更新已有 owner、已就绪、未删除且未在移除中的记录。example 的 schema 4 titleSource 保存 automatic/generated/manual；旧历史和分支按 manual 保护，自动结果不能覆盖手动标题，但可信宿主 user 再次改名可以生效。旧版 example 会拒绝 schema 4，回退不能只换旧包或手改数据库版本；先停写备份，按一致备份恢复。接入、迁移和事件过滤查 doc/conversation-management.md。

## 版本、CI 与源码查证

根 package.json 是公共框架唯一版本源，manager/kit/auth/example 同步，独立插件与官方宿主单独版本化。scripts/version.mjs 的 sync/check 同时负责固定公开片段和版本文档；不要手改生成 guide.md。Windows/macOS/Linux × Node 22/24 共六组检查，Release 另有 runtime、build/publish；数量以该提交实际工作流为准，不代表现场部署通过。

Release 的 runtime 构建并发布固定宿主/manager 镜像，检查匿名拉取；build 复用同一 manager，输出 manager/kit tgz、public-apps/deployment/starters ZIP 五个产物及 SHA256SUMS.txt。普通 main 推送不发布 Release，也不部署服务器；细节查 .github/RELEASING.md 和实际工作流。

源码证据先用 example_search_framework 搜完整路径，再用 example_read_framework 分页阅读实现和调用方，引用路径与行号。快照包含当前公共源码、文档和已登记模板，不收私有配置、业务数据、根私有 build 入口、宿主源码和 doc/releases/ 历史说明。构建时版本/来源校验失败不能截断索引。

模型查 packages/plugin-kit/src/models.ts；源码部署查 deploy/，公共 CLI 查 packages/plugin-manager；版本和 CI 查 scripts/version.mjs 与 .github/workflows。宿主升级查 doc/host-compatibility.md，Session V3 与旧反馈迁移查对应迁移模块。快照中没有的环境和接口明确说未知，不声称已检查用户文件。

## 更多离线与验证资料

当前包的源码检索与 FAQ 页面用途不同，FAQ 不需要先调用模型。只有两个公共源码阅读工具，没有任意命令、服务器文件读取或私有业务查询能力。

根 test-report.sh 验证最终 auth/example 归档、真实宿主及本地模型替身；不代表真实提供方或生产业务已通过。完整记录见 packages/plugin-manager/VERIFICATION.md。其他插件独立测试，重打包不能沿用旧包验证结果。

- [固定版本作者指南](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.19.2/doc/plugin-development.md)
- [固定版本部署指南](https://github.com/PelyDeng/dsh-plugin-manager/blob/v0.19.2/doc/first-deployment.md)
- [可复制开发提示词](prompts.md)
