# 部署与管理

## 服务器源码发版

Linux Docker 站点首次部署和后续更新使用同一入口。首次克隆仓库后执行：

```sh
bash deploy/build.sh
```

默认只显示正在执行的步骤、完成或失败结果，以及最终访问地址和发布记录。每项步骤右侧都有独立的进度条和百分比，从 0% 开始，成功后显示 100%。插件按各自的构建、检查、打包三步依次显示，每一步独立计数。底层工具没有统一的工作量计数，执行中的百分比是等待进度提示，按等待时间逐渐增长并放缓，最高为 95%，不代表真实工作量或剩余时间；只有该步骤成功后才填满。交互终端持续刷新，快速步骤也有短暂的填充动画，动画不阻塞后台构建。重定向输出或 CI 环境只记录开始和结果，不播放动画。pnpm、打包器和 Docker 的详细输出保存在 `.local/artifacts/build-logs/build-*.log`，每次运行打印其路径。失败步骤保留当时的百分比，并显示最后 12 行诊断信息；`pnpm pack` 失败时会将捕获到的标准输出和错误输出写入同一日志，成功时保持安静；完整日志仍保留，Linux 日志文件仅当前用户可读写。构建与校验照常执行。

后续更新：

```sh
git pull --ff-only
bash deploy/build.sh
```

首次自动从 Git 中的 `deploy/config/site.defaults.json` 生成 `.local/site.json`。已有站点会先导入 `.local/deployment.json` 的设置及实际数据路径。以后读取 `.local/site.json`；`.local/deployment.json`、发布清单、Compose 和操作记录均由脚本生成，不需要人工准备，也不提交 Git。完整配置、前置环境和恢复说明见[一键部署设计与使用](../doc/first-deployment.md)。

脚本自动准备锁定的 pnpm，安装依赖，构建和检查管理器及 `plugins` 列出的全部插件，并打包发布清单。需要宿主镜像时直接使用仓库已提供的官方源码构建；源码不完整时提示缺失，不自动拉取，也不要求与预设锁定版本一致。宿主源码未变时复用已有宿主层，安装本次构建的 manager。默认使用本机不可变镜像 ID，仅设置 `publishImage` 时推送镜像仓库。构建记录使用已提交源码，无需分别选择组件版本。

站点插件启停、认证配置及持久数据继续沿用；修改数据路径或 profile 需要显式迁移。

新归档使用内容摘要命名。发布目录同时保留上一份清单引用的已校验归档，供 pnpm 在替换旧依赖引用时解析；部署目标仍只来自新清单，不重新启用已停用的插件。

构建期间旧服务继续运行。每次记录和备份位于 `.local/artifacts/source-release-<提交>-<操作 ID>/`；备份包含原运行配置、Compose 和停止服务后的持久挂载数据。构建失败不停止服务，备份失败恢复旧服务；安装开始后失败则保留现场与备份，保持站点配置不变并执行 `bash deploy/build.sh --resume`。恢复使用同一次已验证的镜像和归档。源码发版使用 flock 排他执行，期间不要并行运行其他管理命令。

标准插件的日常认证及启停只修改自身 `plugin.json`，然后执行 `apply-compose`；首次站点配置和旧 patch 迁移见[插件运行配置规范](../doc/plugin-configuration.md)。下方 `render-compose` 等基础操作用于自定义集成，不要求日常手工维护多份配置。

插件先构建成独立发布目录，再通过官方 DSH CLI 安装。普通插件交付无需 Docker。基础管理操作使用 `deploy/build.sh <命令>` 或 `deploy/scripts/deployment.mjs <命令>`；不带参数的 `deploy/build.sh` 执行上述完整源码发版。

```sh
pnpm package --plugins auth,example --output .local/artifacts/release/plugins
node deploy/scripts/deployment.mjs paths
node deploy/scripts/deployment.mjs start --plugins auth,example --manifest .local/artifacts/release/plugins/manifest.json --dsh-cli-js /path/to/dsh/lib/bin.js
```

示例默认启用登录鉴权，启动前设置 `DSH_PUBLIC_ORIGIN` 为实际访问 origin。Windows 可使用 `deploy/scripts/start.ps1 -Mode release -Plugins auth,example -Manifest .local/artifacts/release/plugins/manifest.json -DshCliJs C:/path/to/bin.js`。源码开发使用 `-Mode development -HarnessRoot deepseek-harness`，直接使用仓库已有宿主源码；运行前需要准备其依赖和构建结果。

## 运行配置

以下为基础管理命令的运行配置；源码发版的用户配置见[站点配置](../doc/first-deployment.md#配置归属)。基础命令的 `--config` 指向运行 JSON。相对路径以显式项目根解析；仓库入口默认传入仓库根，独立 `dsh-plugin` 必须传 `--root`。基础命令的路径优先级为 CLI → 环境变量 → 配置文件 → 默认值。源码发版仅采用站点文件中的部署选项，不采用这些环境覆盖项。

| CLI | 环境变量 | JSON 字段 | 新环境默认值 |
| --- | --- | --- | --- |
| `--data-root` | `DSH_DATA_DIR` | `dataRoot` | `.local/data` |
| `--home` | `DSH_HOME` | `home` | dataRoot 下的 `dsh-home` |
| `--workspace` | `DSH_WORKSPACE` | `workspace` | dataRoot 下的 `workspace` |
| `--auth-url-file` | `DSH_AUTH_URL_FILE` | `authUrlFile` | dataRoot 下的 `dsh-web-auth-url.txt` |
| `--artifacts` | `DSH_DEPLOY_ARTIFACTS` | `artifacts` | `.local/artifacts` |

存在旧 `data/` 或 `deploy-artifacts/` 而未明确选择时，管理器拒绝自动切换。外部绝对路径可继续使用。迁移见[目录迁移](../doc/migration.md)。

配置示例：

```json
{
  "profile": "web",
  "plugins": ["auth", "example"],
  "home": ".local/data/dsh-home",
  "manifest": ".local/artifacts/release/plugins/manifest.json",
  "dshCliJs": "/path/to/dsh/lib/bin.js",
  "patches": [".local/example.patch.yml"]
}
```

插件如声明 `runtimeConfig`，其配置默认从 `home/plugins/<id>/env.conf` 读取，可由 `instances.<id>.runtimeConfig` 覆盖。配置内容不进入发布包；`configRevision` 由维护者递增以声明需要重新应用的配置。

模型密钥通过 `deploy/scripts/set-api-key.mjs` 的隐藏终端输入或 stdin 写入选定 home，不放在 argv。官方认证地址写入私有 `authUrlFile`，不输出令牌。

## 安装与恢复

`start` 安装并监督 DSH 子进程；`stop` 请求原监督进程停止。`sync` 只同步，外部服务需要 `--host-mode external --stopped-file <json>`，并由原管理器重新启动。`verify --started-file <json>` 在检查安装与探针后完成状态提交。

停服证据字段为 `schemaVersion: 1`、目标 `home`、`profile`、`manager`、`instanceId`、`stopped: true`、`stoppedAt`；`manager` 支持 `process`、`compose` 或 `systemd`，进程证据还需 `pid`。工具核验实际管理状态，不以锁代替停服。启动证据对应使用 `started: true` 和 `startedAt`。

安装先在隔离 profile 预检，保护非受管依赖和用户 Bundle。未完成操作保留 pending：原清单和配置使用 `--resume`；变更修复目标需要 `--recover --data-compatible`，明确确认所选包能读取现有数据。运行环境变化需要 `--rebuild`。`unlock` 仅在本机锁拥有者已退出时移除遗留锁。

离线安装需要准备目标平台的包内容 store 和 registry 元数据 cache，分别用 `--offline-store`、`--offline-cache` 及独立可写 `--store-dir`、`--cache-dir` 指定，并启用 `--offline`。仅复制 tgz 不保证传递依赖可离线解析；管理器在修改目标 profile 前进行隔离安装预检。
