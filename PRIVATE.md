# 私有插件仓库

本仓库的 `origin` 为 `git@gitee.com:dengpeilin/dsh-plugin-manager.git`。公共框架来自 `upstream`：`https://github.com/PelyDeng/dsh-plugin-manager.git`（已有 SSH 地址也可沿用）。两者通过 Git 合并更新；不要在 Gitee 使用覆盖式同步 GitHub，否则会替换包含私有插件的主分支历史。

公共框架改动在 `dsh-plugin-manager` 工作区完成、验证并推送 GitHub，再由本地私有集成库合并、检查并推送 Gitee。服务器只更新 Gitee 的集成版本。客户插件只在本仓库开发并推送 Gitee；`upstream` 的推送地址禁用。

## 选择部署入口

交付给独立站点时，优先使用[插件产物一键部署](doc/first-deployment.md)：将本仓库打包所得的完整发布目录放入部署包的 `incoming`，填写插件业务配置后执行部署包的 build。站点不需要私有源码；私有归档及其业务资源仍须遵守对应插件许可，不能上传公共 Release。作者规范见[插件开发](doc/plugin-development.md)。

现有 Gitee 源码服务器继续使用下面的源码更新入口。两种方式共用管理器，但已有数据和配置路径不迁移；不要把新部署包的默认配置覆盖到现有服务器。

## 源码一键更新

Windows 在仓库根的 PowerShell 执行 `.\build.ps1`，macOS/Linux 执行 `bash build.sh`。在 Windows 文件资源管理器打开仓库目录后，可在地址栏输入 `powershell`，再执行脚本。

系统依赖、源码准备及平台范围见[源码部署](deploy/README.md#服务器源码发版)。

根 [build.sh](build.sh)、[build.ps1](build.ps1) 调用[私有更新入口](private-deploy/release.mjs)，使用公共 `sourceRelease` 的锁、启动前检查和构建进程。普通 `source` 发布必须位于 `main`，只获取 `origin/main`，且仅在本地没有分叉时快进。`archives`、`--resume`、`--recover --data-compatible`、帮助及管理命令均不获取源码；非法配置或未完成操作上的普通构建先于同步被拒绝。脚本不会自动切换分支。

这个入口不访问 GitHub、不生成合并提交、不自动推送，也不更新宿主子模块。快进后，它启动新的 Node 构建进程，使用更新后的框架脚本、packageManager 和 pnpm 锁文件。公共 `deploy/*` 与 upstream 保持一致；直接执行 `deploy/build.ps1` 或 `bash deploy/build.sh` 只部署当前检出的源码，不更新 Git。

私有同步与构建连续持有公共 `.local/source-release.node.lock`。Linux 根脚本还持有旧 `.local/source-release.lock` flock，再直接启动 Node 入口，不重复进入公共 shell。快进前保存 `backup/before-origin-*` 本地分支。更换更新入口本身前，须核实旧入口及子进程退出，并在同一源码锁保护下快进到新版。

构建、停服与备份边界、`--resume`、同包配置 `--recover --data-compatible` 及 doctor/unlock-source 的用法统一见[部署与恢复](deploy/README.md)。私有入口不扩展这些规则，不通过删锁、改记录或替换失败操作的归档绕过恢复检查。

工作区改动、未完成 Git 操作、本机未共享到 Gitee 的提交或分支分叉都会阻止更新。将这些修改带回私有集成库，保留并合并、检查后推送 Gitee，再重试。不要在服务器执行强制覆盖、丢弃本地提交，或在 Gitee 网页覆盖同步 GitHub。网络错误显示 Git 原始诊断，源码更新失败时不启动构建或停止服务。

## 本地集成公共更新

在干净的私有集成工作区操作。主工作区有其他任务改动时，使用基于 `origin/main` 的独立 worktree，保留主工作区不动。已经在服务器产生的提交应先取回并保留，不能直接覆盖。

```sh
git fetch --no-recurse-submodules origin
git merge --ff-only origin/main
git fetch --no-recurse-submodules upstream
git merge --no-commit --no-ff upstream/main
```

合并冲突在本地处理并提交。`pnpm-lock.yaml` 同时记录公共和私有插件依赖，不能整份选 GitHub 或 Gitee 一方。先检查各包声明，保留双方需要的依赖，再用仓库锁定的 pnpm 校验或整理锁文件，并核对版本变化。虽然两个仓库使用各自的根入口，共享锁文件和公共接口的变化仍需检查。

```sh
pnpm install --frozen-lockfile
node scripts/version.mjs check
node scripts/check-repository.mjs
pnpm check --plugins "auth,closedoff,example,blog"
pnpm --filter dsh-auth test
pnpm --filter dsh-example test
pnpm --filter dsh-blog-assistant test
node --test private-deploy/tests/sync-origin.test.mjs
pnpm package --plugins "auth,closedoff,example,blog"
```

上述选集覆盖现有四个应用，打包后核对输出路径及完整 manifest。省略 `--output` 会创建独立产物目录，不覆盖旧包；按需指定时必须使用不存在或空目录。`check` 已包含构建，closedoff 的 `check` 还包含其行为测试，不重复执行。博客桥接相关修改另按其 [README](plugins/dsh-agents-group/agents/blog/README.md#开发检查) 验证；框架部署不自动替换 Typecho 桥接文件。

检查、归档及相关业务验收完成后，只暂存任务文件，运行 `git diff --cached --check` 并提交集成修改。推送前刷新 origin，核实当前提交包含最新 origin/main，再执行 `git push origin HEAD:main` 并核对远端 SHA；不使用强制推送。部署者随后运行根 build 获取这个集成版本，不能把合并冲突转移到服务器。

封闭化智能体已并入[智能体群组](plugins/dsh-agents-group/README.md)，源码在 `plugins/dsh-agents-group/agents/closedoff/`，其 `vendor/` 包含构建播放器所需的版本化归档。该目录不受根 Apache-2.0 许可授权，适用群组的 [LICENSE](plugins/dsh-agents-group/LICENSE)。第三方资源保持各自许可。不得将该目录或包含它的提交推送公共仓库。

博客智能体已并入[智能体群组](plugins/dsh-agents-group/README.md)，源码在 `plugins/dsh-agents-group/agents/blog/`，适用群组的 [LICENSE](plugins/dsh-agents-group/LICENSE)，只在 Gitee 集成。它通过 auth 使用博客工作台，通过 Typecho 桥接编辑文章，并使用独立 systemd 执行器备份网站。运行凭据源为插件自己的 `config/config.json`；文件不提交、不进入镜像和归档，生产以 `instances.blog.runtimeConfig` 显式引用。安装与使用见[插件说明](plugins/dsh-agents-group/agents/blog/README.md)。

公共 example 的问答知识与源码索引只承载公共框架能力，不加入本文件、`private-deploy/`、定制插件源码、内部接口或运行凭据。私有模型路由和业务接入说明保留在本仓库及各私有插件文档中，不能为补齐公共问答而复制到 GitHub。

首次配置分别按[封闭化业务参数](plugins/dsh-agents-group/agents/closedoff/README.md#配置业务参数)和[博客配置](plugins/dsh-agents-group/agents/blog/README.md#配置)填写。现有实例沿用原 `runtimeConfig` 引用。站点来源、选集、模型凭据优先级及入口默认值统一见[框架配置](doc/framework-configuration.md)。

宿主子模块锁定 DSH `0.1.5-alpha.2`，以 Git gitlink 为准。升级公共框架时单独审查宿主版本变化；最终构建、插件归档和部署验收均以本仓库提交为依据。

私有根更新入口不更新宿主子模块，也不替换 `DSH_HOST_IMAGE`。宿主升级时显式运行 `git submodule update --init deepseek-harness`，或准备与 gitlink 对应的干净检出并构建新镜像，再更新私有镜像引用。Session V3 的迁移、刷新历史与数据回退约束见[宿主兼容说明](doc/host-compatibility.md)。仅发布现有业务应用时保留 `auth,example,blog,closedoff` 选集，不加入尚未交付的插件。

## 默认模型与私有插件

三个应用的普通新会话使用框架默认模型，旧会话和分支沿用官方模型记录；各自输入框的选择器可以显式切换。模型选择、首句自动标题及手动命名行为分别见[博客对话](plugins/dsh-agents-group/agents/blog/README.md#对话与历史)和[封闭化对话](plugins/dsh-agents-group/agents/closedoff/README.md#对话模型)。

博客文章编辑器的专用写作仍使用 `models.text` / `models.vision`。普通对话由用户选择模型，图片提交要求所选模型支持图片；已有会话和分支沿用记录中的模型。服务商密钥与这些 provider/model 引用分开管理。若把博客 Bundle 注册的模型路由选为框架默认，使用它的站点必须保留该 Bundle；未安装私有插件的公共框架不会因此自动获得私有路由。细节见[博客宿主能力](plugins/dsh-agents-group/agents/blog/README.md#宿主能力)和[封闭化对话模型](plugins/dsh-agents-group/agents/closedoff/README.md#对话模型)。

DeepSeek V4.1 Flash 临时模型使用公共框架提供的[模型声明](deploy/models/deepseek-v4.1-flash.json)，配置与到期处理见[公共 FAQ](doc/FAQ.md#如何添加-deepseek-v41-flash-临时模型)。

## 已部署实例的运维

实例插件选集以私有 `.local/env.conf` 的 `DSH_PLUGINS` 及生成的发布清单为准；各插件认证模式按自己的 `plugin.json` 维护。管理员管理普通账号的应用授权。默认更新入口会一次导入旧 site.json/deployment.json，保留已解析路径与原文件；已有未完成操作继续使用原输入恢复。当前镜像与发布清单由 `.local/deployment.json` 记录。

Compose 项目名为 `dsh-plugin-manager`，实际配置路径由 `.local/artifacts/active-compose.json` 指向，不使用固定的历史产物目录。启用 example 时健康检查包含 `/example/ready`。在仓库根操作：

```sh
compose_file=$(node -p "JSON.parse(require('node:fs').readFileSync('.local/artifacts/active-compose.json', 'utf8')).path")
docker compose -p dsh-plugin-manager -f "$compose_file" ps
bash build.sh
```

发布前按[数据迁移与备份规则](doc/migration.md)保存停写和备份证据。私有业务备份还须包含实际 `runtimeConfig`：博客配置可能在 `.local` 目录之外；只备份 `.local/data` 不完整。博客自身的网站备份范围见[备份与恢复](plugins/dsh-agents-group/agents/blog/README.md#定时备份与恢复)。

`.local/source-release.json` 记录最近一次源码部署状态，成功状态为 `ready`；其 `operation` 指向操作目录，目录内 `result.json` 的 `revision` 对应服务器构建的源码提交。实际容器由 `.local/artifacts/active-compose.json` 指向的 Compose 配置管理。

启用 auth、example、closedoff 时，就绪地址分别是 `/auth/health`、`/example/ready`、`/closedoff-qa/ready`。认证模式的业务历史接口要求登录；健康探针不执行模型问答。账号、授权和历史保存在现有数据目录，服务更新继续沿用该目录。
