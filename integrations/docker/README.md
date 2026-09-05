# Docker 集成

镜像包含锁定官方 DSH 及独立打包的公共 manager，业务插件通过发布目录安装。需要 Linux Docker 引擎，Compose 使用 host 网络，DSH 默认监听宿主回环地址；外部入口由部署者配置代理。

```sh
git submodule update --init --recursive -- deepseek-harness
bash deploy/scripts/build-host-image.sh --help
```

Bash 实际构建入口为 `bash deploy/scripts/build-host-image.sh`，Node 入口为 `node deploy/scripts/host-image.mjs`。正式构建读取当前已提交的主仓输入和子模块 gitlink；`--working-tree` 用于本地开发验证，禁止发布。普通插件构建不需要这些步骤。

镜像名默认 `dsh-host`，标签由宿主版本、宿主提交与配方摘要构成。配置模板位于 `deploy/config/host-image.conf.example`；只有显式传入 `--config` 才读取配置。Harbor 缓存仅在明确不存在镜像时允许按配置回退上游，认证、TLS 或网络失败直接终止。`--publish` 独立控制推送，默认只构建。

操作记录默认保存在 `.local/artifacts/<操作 ID>/host-image.json`。`--resume <记录>` 仅用于恢复显式发布，并重新核验本机镜像 ID、标签、平台和目标仓库。

Compose 文件为 `integrations/docker/docker-compose.yml`，需要设置 `DSH_HOST_IMAGE` 为验证过的镜像引用、`DSH_PLUGIN_RELEASE_DIR` 为发布目录绝对路径。默认将宿主 `.local/data` 挂载为容器 `/data`。外部 home、配置文件、用户 patch 和离线来源可用管理器的 `render-compose` 生成覆盖文件，运行配置仅在运行时挂载。

以下 Bash 示例仅安装独立模式 example。镜像引用使用已完成操作记录中的 `image`（本机构建）或 `reference`（已发布摘要），模型凭据仍需在对应 home 配置。

```sh
pnpm package --plugins example --output .local/artifacts/example-release/plugins
mkdir -p .local/data
export DSH_HOST_IMAGE='<已验证的镜像引用>'
export DSH_PLUGIN_RELEASE_DIR="$(pwd)/.local/artifacts/example-release/plugins"
docker compose -f integrations/docker/docker-compose.yml up -d
```

包含 auth 的发布清单需要额外配置 `publicOrigin`，不能直接套用独立模式示例。使用官方 patch 为 auth 与业务插件配置固定 origin 和认证模式，并通过部署配置的 `patches` 加载；`render-compose --manifest <清单> --config <配置> --output .local/artifacts/compose` 生成覆盖文件后，将其以第二个 `-f` 传给 Compose。
