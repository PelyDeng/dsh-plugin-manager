# @dsh-plugin-manager/plugin-kit

可选的 DSH 插件接入库，通过宿主 Cordis 事件通信，不启动服务。消费插件在构建时将 kit 内嵌到独立归档。独立作者可将维护者提供的版本化 tgz 安装为开发依赖，例如 `pnpm add --ignore-workspace --save-dev /path/to/plugin-kit-0.1.1.tgz`，再通过构建器内嵌。包名不表示版本已发布到公共 registry。

| 导出 | 用途 |
| --- | --- |
| `@dsh-plugin-manager/plugin-kit/access` | `createAccess`、身份、认证提供者、运行目录和撤权通知 |
| `@dsh-plugin-manager/plugin-kit/http` | `createPluginHttp`：受保护路由与显式公开探针 |
| `@dsh-plugin-manager/plugin-kit/tools` | `createPluginTools`、`guardTool`：执行前后鉴权与工具登记 |
| `@dsh-plugin-manager/plugin-kit/route-path` | 无宿主依赖的规范路由校验 |
| `@dsh-plugin-manager/plugin-kit/deepseek-key` | 默认 DeepSeek 凭据校验、状态与 SHA-256 指纹；写入委托给传入的官方 credentials 服务 |
| `@dsh-plugin-manager/plugin-kit` | 上述访问、HTTP 和工具 API 的统一导出 |

DSH 类型依赖是可选 peer，由使用相应接口的作者提供；只使用 access 或 route-path 不会加载工具运行实现。业务插件自行声明实际使用的 DSH/Cordis peer。

认证模式不可自动降级。提供者缺失、重复或协议不兼容时拒绝访问。协议版本为 1，通过结构字段识别跨归档的 `AccessError`。`actorKey` 以账号身份生成稳定数据所有者，不使用短期登录 ID。`dsh-console` 是保留授权项，不能作为业务插件 ID。

```sh
pnpm --filter @dsh-plugin-manager/plugin-kit build
pnpm --filter @dsh-plugin-manager/plugin-kit test
```
