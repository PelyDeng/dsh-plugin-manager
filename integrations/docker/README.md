# Docker 集成

镜像包含锁定官方 DSH 及独立打包的公共 manager，业务插件通过发布目录安装。需要 Linux Docker 引擎，Compose 使用 host 网络，DSH 默认监听宿主回环地址；外部入口由部署者配置代理。

管理器构建仅安装根工具链、kit 和 manager 的锁定依赖，使用隔离依赖布局；下游插件的私有 `file:` 构建资源不进入镜像上下文。

```sh
git submodule update --init --recursive -- deepseek-harness
bash deploy/scripts/build-host-image.sh --help
```

Bash 实际构建入口为 `bash deploy/scripts/build-host-image.sh`，Node 入口为 `node deploy/scripts/host-image.mjs`。正式构建读取当前已提交的主仓输入和子模块 gitlink；`--working-tree` 用于本地开发验证，禁止发布。普通插件构建不需要这些步骤。

镜像名默认 `dsh-host`，标签由宿主版本、宿主提交与配方摘要构成。配置模板位于 `deploy/config/host-image.conf.example`；只有显式传入 `--config` 才读取配置。Harbor 缓存仅在明确不存在镜像时允许按配置回退上游，认证、TLS 或网络失败直接终止。`--publish` 独立控制推送，默认只构建。

操作记录默认保存在 `.local/artifacts/<操作 ID>/host-image.json`。`--resume <记录>` 仅用于恢复显式发布，并重新核验本机镜像 ID、标签、平台和目标仓库。

## 配置和运行

首次部署执行 `bash deploy/build.sh`，自动生成配置并从锁定源码构建、启动。以后 `git pull --ff-only` 后执行同一命令。默认使用本机镜像，无需 Harbor；配置和恢复见[一键部署](../../doc/first-deployment.md)。下方为配置变更及自定义集成使用的基础命令。

一键部署生成 `.local/deployment.json` 后，可通过基础命令单独应用插件 `plugin.json` 的启停和认证设置，见[插件运行配置规范](../../doc/plugin-configuration.md)。自定义集成需要自行提供清单及不可变 `containerImage`，支持本机 `sha256:<ID>` 或仓库 `repo@sha256:<摘要>`。

```sh
node deploy/scripts/deployment.mjs apply-compose --config .local/deployment.json
```

`apply-compose` 生成完整 Compose 文档并受控重启；修改插件配置后重复执行同一命令，不需要另改 Compose、健康检查或认证 patch。命令只支持串行执行。Linux 目录和配置权限按 `containerUid`/`containerGid` 检查，默认均为 1000；新建受管目录由 root 执行时赋予该用户，已有路径不会自动改权。

需要自行编排时可用 `render-compose` 输出覆盖文件，配合 `docker-compose.yml` 和自己的进程管理流程。不得同时用两种流程管理同一实例。

## 源码发版使用的宿主层

`deploy/build.sh` 自动构建缺失或版本不匹配的宿主；匹配时使用 `manager-update.Dockerfile` 复用宿主层，安装当前源码打包的 manager。同次发版重新构建全部选定业务插件。增量构建上下文仅包含该 Dockerfile 和 `plugin-manager.tgz`；基底先固定到已核验的本机镜像 ID，构建后再次核对，`MANAGER_SHA256` 是归档摘要，`FRAMEWORK_REVISION` 是已提交仓库版本。
