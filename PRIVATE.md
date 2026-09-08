# 私有插件仓库

本仓库的 `origin` 为 `git@gitee.com:dengpeilin/dsh-plugin-manager.git`。公共框架来自 `upstream`：`https://github.com/PelyDeng/dsh-plugin-manager.git`（已有 SSH 地址也可沿用）。两者通过 Git 合并更新；不要在 Gitee 使用覆盖式同步 GitHub，否则会替换包含私有插件的主分支历史。

公共框架改动在 `dsh-plugin-manager` 工作区完成、验证并推送 GitHub，再由本地私有集成库合并、检查并推送 Gitee。服务器只更新 Gitee 的集成版本。客户插件只在本仓库开发并推送 Gitee；`upstream` 的推送地址禁用。

## 源码一键更新

Windows 在仓库根的 PowerShell 执行 `.\build.ps1`，无需 Bash；macOS/Linux 执行 `./build.sh`，也兼容 `sh build.sh`。在 Windows 文件资源管理器打开仓库目录后，可在地址栏输入 `powershell`，再执行脚本。

请先安装 Node.js（含 npm）、Git、tar 和本机 Linux Docker Compose，脚本不会代为安装。支持哪些平台、如何配置、哪些环境已经验证，见[公共部署文档](doc/first-deployment.md)。

根 [build.sh](build.sh)、[build.ps1](build.ps1) 调用[私有更新入口](private-deploy/release.mjs)，使用公共 `sourceRelease` 的锁、启动前检查和构建进程。更新时必须位于 `main` 分支，只获取 `origin/main`，且仅在本地没有分叉时快进到新提交。其他分支或 detached HEAD（没有检出分支）会拒绝更新，脚本不会自动切换分支。

这个入口不访问 GitHub、不生成合并提交、不自动推送，也不更新宿主子模块。快进后，它启动新的 Node 构建进程，使用更新后的框架脚本、packageManager 和 pnpm 锁文件。公共 `deploy/*` 与 upstream 保持一致；直接执行 `deploy/build.ps1` 或 `bash deploy/build.sh` 只部署当前检出的源码，不更新 Git。

源码部署会重启服务。构建期间旧服务继续运行；包文件准备好、挂载检查通过后，脚本停止旧容器，确认容器归属和持久数据挂载，再重建容器并等待健康检查通过。

无法确认停服成功时，脚本尝试恢复旧服务。安装或启动失败时，原配置和产物会保留；保持配置不变，使用 `--resume` 继续同一次部署。它不会自动回滚业务数据。

源码部署不会自动备份运行数据，也不会删除已有数据、历史备份或操作记录。博客插件独立的网站备份功能仍可使用。

三平台使用同一 `.local/source-release.node.lock`，连续覆盖私有同步与公共构建；Linux shell 还在外层持有可用的旧 `.local/source-release.lock` flock，期间不再调用公共 shell 入口，避免重复加锁。未取得锁直接退出。正常同步失败或收到匹配完成 IPC 的普通构建失败释放 Node 锁；Git/构建子进程被信号中断或无法确认正常结束时保留。

中断后在仓库根执行 `sh build.sh doctor` 查看锁、进程与发布状态，再执行 `sh build.sh unlock-source`。Windows 使用 `.\build.ps1 doctor` 和 `.\build.ps1 unlock-source`。这些命令复用公共恢复实现，不获取 Gitee/GitHub、不做部署环境预检、不启动或停止服务；检查通过后将旧锁备份到 `.local/artifacts/source-lock-recovery/`，并明确提示普通构建或 `--resume`。

旧版锁缺少进程组和启动身份、进程仍活跃或核验失败时拒绝自动解锁。Linux 检查受管进程组；Windows 同一次启动中无法证明全部子进程退出时保留锁，核实系统重启后才能自动恢复。平台范围、control 元数据锁及异常处理见[源码锁恢复说明](deploy/README.md)。不要删除旧 flock 文件、profile 锁或恢复记录。

快进前保留 `backup/before-origin-*` 本地分支。`--resume`、`--help` 和管理子命令跳过源码更新；帮助及管理命令也不执行部署环境预检。非法参数在同步前拒绝。未完成部署不会重新安装工作区依赖，缺失时须先恢复原依赖。需要更换更新入口本身时，先确认旧入口及其子进程均已退出，在同一源码锁保护下快进到新版，再运行新版入口。

工作区改动、未完成 Git 操作、本机未共享到 Gitee 的提交或分支分叉都会阻止更新。将这些修改带回私有集成库，保留并合并、检查后推送 Gitee，再重试。不要在服务器执行强制覆盖、丢弃本地提交，或在 Gitee 网页覆盖同步 GitHub。网络错误显示 Git 原始诊断，源码更新失败时不启动构建或停止服务。

## 本地集成公共更新

在私有仓库的 `main` 分支上操作；先确认工作区干净。已经在服务器产生的提交应先取回并保留，不能直接覆盖。

```sh
git fetch origin
git merge --ff-only origin/main
git fetch upstream
git merge --no-edit upstream/main
```

合并冲突在本地处理并提交。`pnpm-lock.yaml` 同时记录公共和私有插件依赖，不能整份选 GitHub 或 Gitee 一方。先检查各包声明，保留双方需要的依赖，再用仓库锁定的 pnpm 校验或整理锁文件，并核对版本变化。虽然两个仓库使用各自的根入口，共享锁文件和公共接口的变化仍需检查。

```sh
pnpm install --frozen-lockfile
pnpm build --plugins "auth,closedoff,example"
pnpm check --plugins "auth,closedoff,example"
pnpm --filter dsh-example test
pnpm --filter dsh-closedoff-assistant test
node --test private-deploy/tests/sync-origin.test.mjs
pnpm package --plugins "auth,closedoff,example" --output .local/artifacts/release/plugins
```

涉及博客插件时，将 `blog` 加入构建、检查和打包的插件选集，并执行其 [README](plugins/dsh-blog-assistant/README.md#开发检查) 列出的相关测试。DSH 源码部署不会自动更新博客站点里的 Typecho 桥接扩展；浏览次数不再导致版本冲突需要同时部署当前博客插件及 DshBlogBridge 0.3.2。按插件说明单独备份并更新桥接文件，旧确认卡片必要时重新预览，实际文章内容变化仍会被拒绝。

检查、归档及与改动相关的业务验收完成后，提交集成修改并执行 `git push origin main`。部署者随后运行对应平台的根 build 脚本获取这一版本。Gitee 分支本身不自动证明所有测试通过；发布维护者负责检查，不能把冲突转移回服务器。框架构建、配置和恢复能力见[部署说明](deploy/README.md)。

`plugins/dsh-closedoff-assistant` 是私有定制插件，其 `vendor/` 包含构建播放器所需的版本化归档。该目录不受根 Apache-2.0 许可授权，适用插件 [LICENSE](plugins/dsh-closedoff-assistant/LICENSE)。第三方资源保持各自许可。不得将该目录或包含它的提交推送公共仓库。

`plugins/dsh-blog-assistant` 是个人博客私有插件，适用其 [LICENSE](plugins/dsh-blog-assistant/LICENSE)，只在 Gitee 集成。它通过 auth 使用博客工作台，通过 Typecho 桥接编辑文章，并使用独立 systemd 执行器备份网站。运行凭据源为插件自己的 `config/config.json`；文件不提交、不进入镜像和归档，生产以 `instances.blog.runtimeConfig` 显式引用。安装与使用见[插件说明](plugins/dsh-blog-assistant/README.md)。

公共 example 的问答知识与源码索引只承载公共框架能力，不加入本文件、`private-deploy/`、定制插件源码、内部接口或运行凭据。私有模型路由和业务接入说明保留在本仓库及各私有插件文档中，不能为补齐公共问答而复制到 GitHub。

首次部署时，从插件模板创建 `.local/secrets/closedoff.env.conf`，在私有 `.local/env.conf` 的 `DSH_INSTANCES` 对象中设置 `closedoff.runtimeConfig` 为该文件路径，保留其他插件引用。业务配置仍由各插件维护。根 `env.conf` 已填写受控的非秘密默认值；首次自动创建私有文件会写入实际平台默认值，已有配置不覆盖，手工复制须核对 UID/GID 和镜像架构。

公共默认选集为 auth/example，私有业务插件按需加入 `DSH_PLUGINS`。模型密钥写入私有 `.local/env.conf` 或 auth 管理页对应的官方凭据存储；文件项非空时文件优先且网页只读，留空沿用官方来源而不删除旧值。文件凭据更改通过部署后重启生效，不能在 `--resume` 中替换旧操作的凭据。配置文件应仅允许服务运行用户读取。

不要提前向数据目录写入文件；首次构建由管理器初始化数据目录。真实凭据及运行数据不进入 Git。发布包放在 `.local/artifacts/`。

宿主子模块锁定 DSH `0.1.3-alpha.1`，以 Git gitlink 为准。升级公共框架时单独审查宿主版本变化；最终构建、插件归档和部署验收均以本仓库提交为依据。

## 默认模型与私有插件

管理员在 auth“模型设置”中从官方宿主模型目录单选默认模型；设置保存到同一 DSH home 的官方设置，无需重启，对随后创建的普通会话生效。模型目录、默认选择和服务商凭据由官方 DSH 提供，框架负责管理员入口及 kit 接入；业务插件负责自己的工具、权限与专用模型用途。保存默认模型不等于已经通过真实模型请求验证。

example、封闭化以及博客的普通文字新会话都使用这个默认模型。继续旧对话或创建分支时，使用对应历史位置记录的模型；重启或修改默认值不会改写旧记录。尚无模型记录时，才使用官方默认值。

如果宿主无法从会话日志中还原模型选择（缺少模型投影能力），或读取记录失败，就拒绝恢复，不会悄悄换模型。封闭化的新会话只在所选模型支持时使用插件配置的推理等级，旧会话保留记录中的设置。

博客文章编辑器的专用写作仍使用 `models.text`，首次发送图片可切换至 `models.vision`；已有图片历史的续聊和分支沿用记录中的识图模型。服务商密钥与这些 provider/model 引用分开管理。若把博客 Bundle 注册的模型路由选为框架默认，使用它的站点必须保留该 Bundle；未安装私有插件的公共框架不会因此自动获得私有路由。细节见[博客宿主能力](plugins/dsh-blog-assistant/README.md#宿主能力)和[封闭化对话模型](plugins/dsh-closedoff-assistant/README.md#对话模型)。

## 已部署实例的运维

实例插件选集以私有 `.local/env.conf` 的 `DSH_PLUGINS` 及生成的发布清单为准；各插件认证模式按自己的 `plugin.json` 维护。管理员管理普通账号的应用授权。默认更新入口会一次导入旧 site.json/deployment.json，保留已解析路径与原文件；已有未完成操作继续使用原输入恢复。当前镜像与发布清单由 `.local/deployment.json` 记录。

Compose 项目名为 `dsh-plugin-manager`，实际配置路径由 `.local/artifacts/active-compose.json` 指向，不使用固定的历史产物目录。启用 example 时健康检查包含 `/example/ready`。在仓库根操作：

```sh
compose_file=$(node -p "JSON.parse(require('node:fs').readFileSync('.local/artifacts/active-compose.json', 'utf8')).path")
docker compose -p dsh-plugin-manager -f "$compose_file" ps
bash build.sh
```

调整发布清单或配置后，通过管理器重新生成 Compose 配置并核对挂载；如果还有未完成的部署，不能只替换 tgz 就继续恢复。迁移前须确认所有写入进程已停止，保存确认记录、完整数据备份和校验记录。部署和 clean 不会自动删除旧目录或独立备份。历史产物中的绝对路径用于核对原操作，不能批量替换成新路径。


## 查看运行状态

`.local/source-release.json` 记录最近一次源码部署状态，成功状态为 `ready`；其 `operation` 指向操作目录，目录内 `result.json` 的 `revision` 对应服务器构建的源码提交。实际容器由 `.local/artifacts/active-compose.json` 指向的 Compose 配置管理。

启用 auth、example、closedoff 时，就绪地址分别是 `/auth/health`、`/example/ready`、`/closedoff-qa/ready`。认证模式的业务历史接口要求登录；健康探针不执行模型问答。账号、授权和历史保存在现有数据目录，服务更新继续沿用该目录。
