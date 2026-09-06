# 部署与管理

标准插件的日常认证及启停只修改自身 `plugin.json`，然后执行 `apply-compose`；首次站点配置和旧 patch 迁移见[插件运行配置规范](../doc/plugin-configuration.md)。下方 `render-compose` 等基础操作用于自定义集成，不要求日常手工维护多份配置。

插件先构建成独立发布目录，再通过官方 DSH CLI 安装。普通插件交付无需 Docker。Bash 使用 `deploy/build.sh`，Node 使用 `deploy/scripts/deployment.mjs`；两者支持同一组参数。

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
