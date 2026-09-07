# 部署与管理

## 服务器源码发版

Linux Docker 站点首次部署和后续更新使用同一入口。首次克隆仓库后执行：

```sh
bash deploy/build.sh
```

终端显示各步骤的进度和结果；执行中的百分比是等待提示，只有成功后才显示 100%，不表示剩余时间。重定向输出时只记录开始和结果。

详细输出写入 `.local/artifacts/build-logs/build-*.log`，终端会显示日志路径。失败时显示最后 12 行诊断信息，完整日志保留在文件中。

后续更新：

```sh
git pull --ff-only --recurse-submodules
bash deploy/build.sh
```

首次自动创建 `.local/env.conf`，采用源码入口默认值；已有站点优先导入旧 site.json，其次导入 deployment.json，保留原文件和解析路径。根 `env.conf` 只提交空模板，真实值只填私有副本，详见[统一配置](../doc/framework-configuration.md)。以后读取私有 env；`.local/deployment.json`、发布清单、Compose 和操作记录均由脚本生成，不需要人工准备，也不提交 Git。完整配置、前置环境和恢复说明见[Linux Docker 一键部署](../doc/first-deployment.md)。

脚本自动准备锁定的 pnpm，安装依赖，构建和检查管理器及 `plugins` 列出的全部插件，并打包发布清单。需要宿主镜像时直接使用仓库已提供的官方源码构建；源码不完整时提示缺失，不自动拉取，也不要求与预设锁定版本一致。宿主源码未变时复用已有宿主层，安装本次构建的 manager。默认使用本机不可变镜像 ID，仅设置 `publishImage` 时推送镜像仓库。构建记录使用已提交源码，无需分别选择组件版本。

站点插件启停、认证配置及持久数据继续沿用；修改数据路径或 profile 需要显式迁移。

新归档使用内容摘要命名。发布目录同时保留上一份清单引用的已校验归档，供 pnpm 在替换旧依赖引用时解析；部署目标仍只来自新清单，不重新启用已停用的插件。

构建期间旧服务继续运行。每次记录和备份位于 `.local/artifacts/source-release-<提交>-<操作 ID>/`；备份包含原运行配置、Compose 和停止服务后的持久挂载数据。构建失败不停止服务，备份失败恢复旧服务；安装开始后失败则保留现场与备份，保持站点配置不变并执行 `bash deploy/build.sh --resume`。恢复使用同一次已验证的镜像和归档。源码发版使用 flock 排他执行，期间不要并行运行其他管理命令。

标准插件的日常认证及启停只修改自身 `plugin.json`，然后执行 `apply-compose`；首次站点配置和旧 patch 迁移见[插件运行配置规范](../doc/plugin-configuration.md)。下方 `render-compose` 等基础操作用于自定义集成，不要求日常手工维护多份配置。

插件先构建成独立发布目录，再通过官方 DSH CLI 安装。普通插件交付无需 Docker。基础管理操作使用 `deploy/build.sh <命令>` 或 `deploy/scripts/deployment.mjs <命令>`；不带参数的 `deploy/build.sh` 执行上述完整源码发版。

```sh
pnpm package --plugins "auth,example" --output .local/artifacts/release/plugins
node deploy/scripts/deployment.mjs paths
node deploy/scripts/deployment.mjs start --plugins "auth,example" --manifest .local/artifacts/release/plugins/manifest.json --dsh-cli-js /path/to/dsh/lib/bin.js
```

示例默认启用登录鉴权，启动前设置 `DSH_PUBLIC_ORIGIN` 为实际访问 origin。Windows 可使用 `deploy/scripts/start.ps1 -Mode release -Plugins auth,example -Manifest .local/artifacts/release/plugins/manifest.json -DshCliJs C:/path/to/bin.js`。源码开发使用 `-Mode development -HarnessRoot deepseek-harness`，直接使用仓库已有宿主源码；运行前需要准备其依赖和构建结果。

## 运行配置

以下为基础管理命令的运行配置；源码发版的用户配置见[站点配置](../doc/first-deployment.md#配置归属)。基础命令的 `--config` 支持私有 env 或运行 JSON。相对路径以显式项目根解析；仓库入口默认传入仓库根，独立 `dsh-plugin-manager` 必须传 `--root`。基础命令的路径优先级为 CLI → 环境变量 → 配置文件 → 默认值。源码宿主可用 `harnessRoot` 指向已安装依赖并构建的源码根；已安装宿主用 `dshCliJs` 指向 CLI 文件，二选一。源码发版仅采用站点文件中的部署选项，不采用这些环境覆盖项。

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
  "publicOrigin": "http://127.0.0.1:7902"
}
```

插件如声明 `runtimeConfig`，其配置默认从 `home/plugins/<id>/env.conf` 读取，可由 `instances.<id>.runtimeConfig` 覆盖。配置内容不进入发布包；`configRevision` 由维护者递增以声明需要重新应用的配置。

文件密钥非空时文件优先、网页只读，修改需受控重启；留空沿用官方来源且不删除旧值。无覆盖时，DeepSeek/智谱密钥由管理员在 `/auth` →“模型设置”填写或更换，也可执行 `bash deploy/scripts/set-api-key.sh --config .local/deployment.json` 隐藏输入。Windows 入口为 `node deploy/scripts/set-api-key.mjs --config .local/deployment.json`。脚本仅支持 DeepSeek；网页和脚本共用官方凭据服务，写入选定 home 的 `.credentials.yaml`，无需重启；页面只显示状态与不可逆指纹。脚本不选择模型，不把密钥放入 argv。运行条件、环境只读与问答验证见[首次登录与模型密钥](../doc/first-deployment.md#首次登录与模型密钥)。官方认证地址写入私有 `authUrlFile`，不输出令牌；插件 Auth 登录不会自动完成官方控制台认证，常见提示见 [FAQ](../doc/FAQ.md)。

## 安装与恢复

`start` 安装并监督 DSH 子进程；`stop` 请求原监督进程停止。`sync` 只同步，外部服务需要 `--host-mode external --stopped-file <json>`，并由原管理器重新启动。`verify --started-file <json>` 在检查安装与探针后完成状态提交。

停服证据字段为 `schemaVersion: 1`、目标 `home`、`profile`、`manager`、`instanceId`、`stopped: true`、`stoppedAt`；`manager` 支持 `process`、`compose` 或 `systemd`，进程证据还需 `pid`。工具核验实际管理状态，不以锁代替停服。启动证据对应使用 `started: true` 和 `startedAt`。

安装先在隔离 profile 预检，保护非受管依赖和用户 Bundle。未完成操作保留 pending：原清单和配置使用 `--resume`；变更修复目标需要 `--recover --data-compatible`，明确确认所选包能读取现有数据。运行环境变化需要 `--rebuild`。`unlock` 仅在本机锁拥有者已退出时移除遗留锁。

离线安装需要准备目标平台的包内容 store 和 registry 元数据 cache，分别用 `--offline-store`、`--offline-cache` 及独立可写 `--store-dir`、`--cache-dir` 指定，并启用 `--offline`。仅复制 tgz 不保证传递依赖可离线解析；管理器在修改目标 profile 前进行隔离安装预检。
