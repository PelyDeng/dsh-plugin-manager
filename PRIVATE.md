# 私有插件仓库

本仓库的 `origin` 为 `git@gitee.com:dengpeilin/dsh-plugin-manager.git`。公共框架来自 `upstream`：`https://github.com/PelyDeng/dsh-plugin-manager.git`（已有 SSH 地址也可沿用）。两者通过 Git 合并更新；不要在 Gitee 使用覆盖式同步 GitHub，否则会替换包含私有插件的主分支历史。

公共框架改动在 `dsh-plugin-manager` 工作区完成、验证并推送 GitHub，再由本地私有集成库合并、检查并推送 Gitee。服务器只更新 Gitee 的集成版本。客户插件只在本仓库开发并推送 Gitee；`upstream` 的推送地址禁用。

## 源码一键更新

Windows 在仓库根的 PowerShell 执行 `.\build.ps1`，无需 Bash；macOS/Linux 执行 `./build.sh`，也兼容 `sh build.sh`。在 Windows 文件资源管理器打开仓库目录后，可在地址栏输入 `powershell`，再执行脚本。Node.js（含 npm）、Git、tar 和本机 Linux Docker Compose 须提前可用，脚本不安装系统软件。macOS 尚未完成真机验收，平台范围与配置说明见[公共部署文档](doc/first-deployment.md)。

根 [build.sh](build.sh)、[build.ps1](build.ps1) 调用 [私有协调入口](private-deploy/release.mjs)，复用公共 `sourceRelease` 的锁、预检和构建进程。同步回调仅获取 `origin/main` 并允许快进，不访问 GitHub、不生成合并提交、不自动推送、不更新宿主子模块。快进后启动新的 Node 构建进程，读取更新后的框架脚本、packageManager 和 pnpm 锁文件。公共 `deploy/*` 与 upstream 保持一致；直接执行 `deploy/build.ps1` 或 `bash deploy/build.sh` 只构建当前检出代码，不更新 Git。

三平台使用同一 `.local/source-release.node.lock`，连续覆盖私有同步与公共构建；Linux shell 还在外层持有可用的旧 `.local/source-release.lock` flock，期间不再调用公共 shell 入口，避免重复加锁。未取得锁直接退出。正常同步失败或收到匹配完成 IPC 的普通构建失败释放 Node 锁；Git/构建子进程被信号中断或无法确认正常结束时保留。先核实锁中主机、PID、workerPid 及其子进程均已退出，再清理 Node 锁；不要删除旧 flock 文件、profile 锁或恢复记录。

快进前保留 `codex/before-origin-*` 本地分支。`--resume`、`--help` 和管理子命令跳过源码更新；帮助及管理命令也不执行部署环境预检。非法参数在同步前拒绝。未完成部署使用对应平台的根脚本加 `--resume`，保留原输入及归档；不会重新安装工作区依赖，缺失时须先恢复原依赖。更新入口自身时，先结束旧入口进程，再从已检出的新版脚本开始一次部署。

工作区改动、未完成 Git 操作、本机未共享到 Gitee 的提交或分支分叉都会阻止更新。将这些修改带回私有集成库，保留并合并、检查后推送 Gitee，再重试。不要在服务器执行强制覆盖、丢弃本地提交，或在 Gitee 网页覆盖同步 GitHub。网络错误显示 Git 原始诊断，源码更新失败时不启动构建或停止服务。

## 本地集成公共更新

在私有仓库的 `main` 分支上操作；先确认工作区干净。已经在服务器产生的提交应先取回并保留，不能直接覆盖。

```sh
git fetch origin
git merge --ff-only origin/main
git fetch upstream
git merge --no-edit upstream/main
```

冲突在这里处理一次并提交。`pnpm-lock.yaml` 同时记录公共和私有插件依赖，不能整份选 GitHub 或 Gitee 一方；先检查各包声明，保留双方需要的依赖，再用仓库锁定的 pnpm 校验或整理锁文件，并审查版本变化。独立的根入口减少脚本和文档冲突，但不消除共享锁文件或公共接口的集成成本。

```sh
pnpm install --frozen-lockfile
pnpm build --plugins "auth,closedoff,example"
pnpm check --plugins "auth,closedoff,example"
pnpm --filter dsh-example test
pnpm --filter dsh-closedoff-assistant test
node --test private-deploy/tests/sync-origin.test.mjs
pnpm package --plugins "auth,closedoff,example" --output .local/artifacts/release/plugins
```

检查、归档及与改动相关的业务验收完成后，提交集成修改并执行 `git push origin main`。部署者随后运行对应平台的根 build 脚本获取这一版本。Gitee 分支本身不自动证明所有测试通过；发布维护者负责检查，不能把冲突转移回服务器。框架构建、配置和恢复能力见[部署说明](deploy/README.md)。

`plugins/dsh-closedoff-assistant` 是私有定制插件，其 `vendor/` 包含构建播放器所需的版本化归档。该目录不受根 Apache-2.0 许可授权，适用插件 [LICENSE](plugins/dsh-closedoff-assistant/LICENSE)。第三方资源保持各自许可。不得将该目录或包含它的提交推送公共仓库。

`plugins/dsh-blog-assistant` 是个人博客私有插件，适用其 [LICENSE](plugins/dsh-blog-assistant/LICENSE)，只在 Gitee 集成。它通过 auth 使用博客工作台，通过 Typecho 桥接编辑文章，并使用独立 systemd 执行器备份网站。运行凭据源为插件自己的 `config/config.json`；文件不提交、不进入镜像和归档，生产以 `instances.blog.runtimeConfig` 显式引用。安装与使用见[插件说明](plugins/dsh-blog-assistant/README.md)。

首次部署时，从插件模板创建 `.local/secrets/closedoff.env.conf`，在私有 `.local/env.conf` 的 `DSH_INSTANCES` 对象中设置 `closedoff.runtimeConfig` 为该文件路径，保留其他插件引用。业务配置仍由各插件维护。根 `env.conf` 已填写受控的非秘密默认值；首次自动创建私有文件会写入实际平台默认值，已有配置不覆盖，手工复制须核对 UID/GID 和镜像架构。公共默认选集为 auth/example，私有业务插件按需加入 `DSH_PLUGINS`。真实模型密钥仅填写私有副本，非空时文件优先且网页只读，留空沿用官方来源而不删除旧值。配置文件应仅允许服务运行用户读取。不要提前向数据目录写入文件；首次构建由管理器初始化数据目录。真实凭据及运行数据不进入 Git。发布包放在 `.local/artifacts/`。

宿主子模块锁定 DSH `0.1.3-alpha.1`，以 Git gitlink 为准。升级公共框架时单独审查宿主版本变化；最终构建、插件归档和部署验收均以本仓库提交为依据。

## 已部署实例的运维

实例插件选集以私有 `.local/env.conf` 的 `DSH_PLUGINS` 及生成的发布清单为准；各插件认证模式按自己的 `plugin.json` 维护。管理员管理普通账号的应用授权。默认更新入口会一次导入旧 site.json/deployment.json，保留已解析路径与原文件；已有未完成操作继续使用原输入恢复。当前镜像与发布清单由 `.local/deployment.json` 记录。Compose 项目名为 `dsh-plugin-manager`，实际配置路径由 `.local/artifacts/active-compose.json` 指向，不使用固定的历史产物目录。启用 example 时健康检查包含 `/example/ready`。在仓库根操作：

```sh
compose_file=$(node -p "JSON.parse(require('node:fs').readFileSync('.local/artifacts/active-compose.json', 'utf8')).path")
docker compose -p dsh-plugin-manager -f "$compose_file" ps
bash build.sh
```

调整发布清单或配置后，通过管理器重新生成 Compose 配置并核对挂载；不能只替换 tgz 而忽略恢复状态。迁移须保留停写证据、完整数据备份和校验记录。旧目录及独立备份不由部署或 clean 自动删除；历史产物中的绝对路径保持原样，不能批量替换成新路径。


## 查看运行状态

`.local/source-release.json` 记录最近一次源码部署状态，成功状态为 `ready`；其 `operation` 指向操作目录，目录内 `result.json` 的 `revision` 对应服务器构建的源码提交。实际容器由 `.local/artifacts/active-compose.json` 指向的 Compose 配置管理。

启用 auth、example、closedoff 时，就绪地址分别是 `/auth/health`、`/example/ready`、`/closedoff-qa/ready`。认证模式的业务历史接口要求登录；健康探针不执行模型问答。账号、授权和历史保存在现有数据目录，服务更新继续沿用该目录。
