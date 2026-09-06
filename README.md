# DSH Plugin

用于开发、打包和管理 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 外部插件的工作区。插件通过官方 Cordis 和 DSH Bundle 加载；本仓库提供可选接入库、管理 CLI、认证插件和 AI 对话示例。

## 开发

需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0`。归档校验使用系统 `tar`。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm list:plugins
pnpm package --plugins auth,example --output .local/artifacts/release/plugins
```

普通构建和测试无需初始化宿主子模块、配置模型密钥或启动 Docker。源码默认选集包含 `example`，`auth` 需显式选择；示例默认要求登录，部署时选择 `auth,example` 并配置公开访问 origin。安装现成清单默认选中其中全部插件，可用 `--plugins` 限定。

## 包与目录

| 位置 | 用途 |
| --- | --- |
| [packages/plugin-kit](packages/plugin-kit/README.md) | `@dsh-plugin/plugin-kit`：身份、权限、HTTP、工具登记 |
| [packages/plugin-manager](packages/plugin-manager/README.md) | `@dsh-plugin/plugin-manager`：发现、打包、安装和受控启停 |
| [plugins/dsh-auth](plugins/dsh-auth/README.md) | 可选账号、登录与插件授权 |
| [plugins/dsh-example](plugins/dsh-example/README.md) | AI 流式对话、历史与可选认证示例 |
| [integrations/docker](integrations/docker/README.md) | 官方宿主镜像与 Compose 集成 |
| [deploy](deploy/README.md) | Bash、PowerShell、Node 入口和配置模板 |
| [doc](doc/README.md) | 作者接入、架构与数据迁移说明 |
| `.local/data/` | 本机持久数据，不进入 Git |
| `.local/artifacts/` | 发布归档与恢复记录，不进入 Git |

运行示例见[示例说明](plugins/dsh-example/README.md)。独立管理器接受明确的 `--root` 项目根，安装现成发布清单不需要作者源码。npm 包可在本地构建为 `.tgz`；这里的包名不表示已经发布到公共 registry。

## 贡献与许可

参见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)。本仓库自有代码采用 [Apache-2.0](LICENSE)，第三方归属见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目由社区维护，不是 DeepSeek 官方发布渠道。
