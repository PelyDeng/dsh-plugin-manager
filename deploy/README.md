# 部署与管理

## 服务器源码发版

已有 Docker 站点统一从服务器的插件仓库构建并部署：

```sh
git pull --ff-only
bash deploy/build.sh
```

默认读取 `.local/deployment.json`，其他站点可用 `bash deploy/build.sh --config <站点配置>`。首次需要安装仓库 `packageManager` 锁定的 pnpm、Node.js、Docker Compose、tar 和 flock，并登录站点镜像仓库。该入口要求已有成功的 `active-compose.json`，首次部署按下文及 Docker 集成文档初始化。

脚本检查源码已提交且工作区干净，安装锁定依赖，构建和检查管理器及站点 `plugins` 列出的全部插件，生成新的归档与发布清单。随后基于站点不可变镜像构建当前管理器镜像并推送，自动更新站点的镜像摘要和发布清单，停服备份后调用 `apply-compose` 等待健康检查。各组件版本来自源码，无需分别选择或升级，也不依赖本机上传的包或临时部署脚本。

DSH 宿主必须与仓库 gitlink 一致，可以复用已构建的宿主层；宿主版本变更时先用仓库 `deploy/scripts/build-host-image.sh` 构建相应基底。构建不会拉取宿主的浮动版本。站点配置中的其他字段、插件认证配置及持久数据保持原值。

新归档使用内容摘要命名。发布目录同时保留上一份清单引用的已校验归档，供 pnpm 在替换旧依赖引用时解析；部署目标仍只来自新清单，不重新启用已停用的插件。

构建期间旧服务继续运行。每次记录和备份位于 `.local/artifacts/source-release-<提交>-<操作 ID>/`；备份包含原站点配置、Compose 和停止服务后的持久挂载数据。构建失败不停止服务，备份失败恢复旧服务；安装开始后失败则保留现场与备份，避免将已经迁移的数据自动交给旧版本。源码发版使用 flock 排他执行，期间不要并行运行其他管理命令。

标准插件的日常认证及启停只修改自身 `plugin.json`，然后执行 `apply-compose`；首次站点配置和旧 patch 迁移见[插件运行配置规范](../doc/plugin-configuration.md)。下方 `render-compose` 等基础操作用于自定义集成，不要求日常手工维护多份配置。

插件先构建成独立发布目录，再通过官方 DSH CLI 安装。普通插件交付无需 Docker。基础管理操作使用 `deploy/build.sh <命令>` 或 `deploy/scripts/deployment.mjs <命令>`；不带参数的 `deploy/build.sh` 执行上述完整源码发版。

```sh
pnpm package --plugins auth,example --output .local/artifacts/release/plugins
node deploy/scripts/deployment.mjs paths
node deploy/scripts/deployment.mjs start --plugins auth,example --manifest .local/artifacts/release/plugins/manifest.json --dsh-cli-js /path/to/dsh/lib/bin.js
```

示例默认启用登录鉴权，启动前设置 `DSH_PUBLIC_ORIGIN` 为实际访问 origin。Windows 可使用 `deploy/scripts/start.ps1 -Mode release -Plugins auth,example -Manifest .local/artifacts/release/plugins/manifest.json -DshCliJs C:/path/to/bin.js`。源码开发使用 `-Mode development -HarnessRoot deepseek-harness`；需要先显式初始化并构建锁定的官方子模块。

## 运行配置

`--config` 指向 JSON 配置。相对路径以显式项目根解析；仓库入口默认传入仓库根，独立 `dsh-plugin` 必须传 `--root`。路径优先级为 CLI → 环境变量 → 配置文件 → 默认值。

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
