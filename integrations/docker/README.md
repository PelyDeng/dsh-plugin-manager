# Docker 集成

镜像包含仓库提供的官方 DSH 源码构建结果及独立打包的公共 manager，业务插件通过发布目录安装。需要本机 Linux Docker 引擎及 Compose，仅接受 unix/npipe endpoint。原生 Linux 使用 host 网络和回环监听；Windows/macOS 及 Linux Docker Desktop 使用 bridge 网络，DSH 仍监听 `127.0.0.1`。

管理器在容器唯一桥接 IPv4 地址的同端口进行 TCP 转发，宿主仅向 `127.0.0.1` 发布端口，连接随 DSH 生命周期清理。同一 Docker 网络中的其他容器仍属于受信任范围，不能据此认定服务已与公网隔离；外部入口由部署者配置代理。macOS 尚未完成真机验收。

管理器构建仅安装根工具链、kit 和 manager 的锁定依赖，使用隔离依赖布局；下游插件的私有 `file:` 构建资源不进入镜像上下文。

```sh
bash deploy/scripts/build-host-image.sh --help
```

Bash 实际构建入口为 `bash deploy/scripts/build-host-image.sh`，Node 入口为 `node deploy/scripts/host-image.mjs`。正式构建读取当前已提交的主仓输入和已有宿主源码提交，不检查其与主仓 gitlink 的版本一致性，也不下载源码；`--working-tree` 用于主仓本地开发验证，禁止发布。普通插件构建不需要这些步骤。

镜像名默认 `dsh-host`，标签由宿主版本、宿主提交与配方摘要构成。默认使用显式项目 root 下已有的 `.local/env.conf`，根 `env.conf` 提供固定且不含秘密的默认值；也可显式 `--config`。公开模板的镜像平台为 `linux/amd64`，源码新站点自动创建私有文件时按 Docker 引擎选择架构；手工复制或独立镜像构建需自行核对。`deploy/config/host-image.conf.example` 仅作为旧独立镜像配置兼容模板。Harbor 缓存仅在明确不存在镜像时允许按配置回退上游，认证、TLS 或网络失败直接终止。`--publish` 独立控制推送，默认只构建。

操作记录默认保存在 `.local/artifacts/<操作 ID>/host-image.json`。`--resume <记录>` 仅用于恢复显式发布，并重新核验本机镜像 ID、标签、平台和目标仓库。

## 配置和运行

使用发行部署包时按其随包 README 放入完整发布目录；管理器和固定宿主镜像信息已提供，不构建作者源码。取得完整源码后，Windows PowerShell 执行根 `.\build.ps1`，macOS/Linux 执行根 `./build.sh`，自动生成配置并构建、启动；`deploy/build.ps1` 与 `deploy/build.sh` 转发到同一入口。源码默认使用本机镜像，无需 Harbor。配置修改继续通过原站点 build 应用；原输入失败使用 resume，同包业务配置修正按[恢复说明](../../deploy/README.md#安装与恢复)操作。

下列基础命令供自行编排的独立 CLI 集成使用，不用于绕过站点 build 的记录。自定义集成需要自行提供清单及不可变 `containerImage`，支持本机 `sha256:<ID>` 或仓库 `repo@sha256:<摘要>`。插件启停和认证字段见[插件运行配置规范](../../doc/plugin-configuration.md)。

```sh
node deploy/scripts/deployment.mjs apply-compose --config .local/deployment.json
```

可先执行 `node deploy/scripts/deployment.mjs check-compose --config .local/deployment.json` 生成候选文件并预检，不停止服务或启动 DSH。`apply-compose` 会重复预检再受控重启；修改插件配置后重复执行同一命令，不需要另改 Compose、健康检查或认证 patch。

命令只支持串行执行。Windows/macOS 和 Docker Desktop 通过实际容器挂载探针检查权限；原生 Linux 保留目录和文件权限检查。容器 UID/GID 使用配置值，独立配置缺省为 1000，macOS 源码新站点按当前非 root 用户初始化。已有数据路径不会被递归改权。

站点操作固定 Docker 引擎；来源切换、prepared 后失败与恢复只在[运维说明](../../deploy/README.md#安装与恢复)维护。不能同时使用独立 Compose 和站点 build 接管同一实例。

需要自行编排时可用 `render-compose` 输出覆盖文件，配合 `docker-compose.yml` 和自己的进程管理流程。不得同时用两种流程管理同一实例。

## 源码发版使用的宿主层

根 build 脚本从现有源码构建缺失的宿主镜像；源码未变时使用 `manager-update.Dockerfile` 复用已有宿主层，安装当前源码打包的 manager。默认源码发版重新构建全部选定业务插件；显式 --rebuild-plugins 按运维规则仅重建选中项。archives 不执行插件构建。增量构建上下文仅包含该 Dockerfile 和 `plugin-manager.tgz`；基底使用不可变本机镜像 ID，`MANAGER_SHA256` 是归档摘要，`FRAMEWORK_REVISION` 是已提交仓库版本。源码新站点按 Docker 引擎初始化 `DSH_IMAGE_PLATFORM`，显式值和旧站点值保持；单独调用镜像构建入口的缺省值仍为 `linux/amd64`。
