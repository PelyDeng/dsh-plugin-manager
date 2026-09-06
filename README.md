# DSH Plugin

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的应用接入与交付管理框架，面向将插件或智能体应用交付给团队、客户使用的独立开发者和小团队。沿用官方 Cordis 插件、Bundle 和 Agent，通过管理 CLI 统一打包、配置和部署，按需使用 kit 和基础认证。

独立仓库单包开发与内部 `plugins/*` 批量开发均受支持。新增插件通过声明接入，无需修改管理器名单或 DSH 源码；统一鉴权需要作者显式接入 kit，管理声明不会自动保护业务路由。官方运行时负责执行，本框架负责接入约定和交付管理，不承诺所有社区插件或任意宿主版本自动兼容。

## 独立仓库接入

从[独立插件示例](examples/standalone-plugin/README.md)开始；需要统一身份时参考[可选 kit 示例](examples/standalone-kit/README.md)。先按[作者指南](doc/plugin-development.md)取得并安装 manager `.tgz`，再执行：

```sh
dsh-plugin list --root /path/to/author-project --package .
dsh-plugin pack --root /path/to/author-project --package . --output .local/artifacts/release
```

`pack` 安装锁定依赖，并依次执行一次 `build`、一次 `check` 和打包。发布目录可以独立交付，运行端无需作者源码。当前外部入口支持 pnpm 单包项目及 release 部署；内部扫描与 development/link 继续保留。

## 内部工作区开发

需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0`。归档校验使用系统 `tar`。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm list:plugins
pnpm package --plugins auth,example --output .local/artifacts/release/plugins
```

普通构建和测试无需初始化宿主子模块、配置模型密钥或启动 Docker。源码默认选集包含 `auth` 和 `example`；示例默认要求登录，部署时选择 `auth,example` 并配置公开访问 origin。安装现成清单默认选中其中全部插件，可用 `--plugins` 限定。

`check` 保留编译、类型和浏览器脚本语法检查，不运行完整业务测试；`pack` 不额外追加测试。开发回归显式执行 `pnpm test`（先构建再运行测试）；CI 单独执行测试步骤，保留测试覆盖。

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

Linux 服务器取得完整仓库源码后，首次部署执行 `bash deploy/build.sh`，自动生成本机配置、构建宿主及插件并启动；以后更新仓库代码后仍执行同一命令。部署直接使用已有官方源码，不主动拉取或要求匹配预设版本。默认无需镜像仓库，监听 `http://127.0.0.1:7902`。环境要求和失败恢复见[一键部署](doc/first-deployment.md)。

## 贡献与许可

参见 [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)。本仓库自有代码采用 [Apache-2.0](LICENSE)，第三方归属见 [NOTICE](NOTICE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目由社区维护，不是 DeepSeek 官方发布渠道。
