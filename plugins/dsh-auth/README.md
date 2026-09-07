# dsh-auth

通过管理器部署时，本插件按 `configuration.auth: provider` 提供认证，站点 origin 统一配置。实例配置为 `<DSH home>/plugins/auth/plugin.json`，不接受 `accessMode`；其他插件各自决定是否要求认证。配置与部署步骤见管理器包内 DELIVERY.md。

可选统一认证插件，在宿主 WebServer 提供 `/auth` 页面、账号管理与逐插件授权。默认纳入插件选集，不改变业务插件的访问模式，不替代 DSH 官方控制台认证。

管理员可以管理账号，自动拥有已加载插件和控制台权限。普通用户需要逐项授权。账号角色、密码、启停或授权变化会撤销该用户登录会话；最后一个有效管理员不能被停用或降级。

## 配置与首次登录

| 环境变量 | 默认值或要求 |
| --- | --- |
| `DSH_PUBLIC_ORIGIN` | 必填 HTTP(S) origin，例如 `http://127.0.0.1:7902`，不含路径或尾部斜杠 |
| `DSH_AUTH_STATE_DIR` | `DSH_HOME/auth` |
| `DSH_AUTH_SESSION_TTL_SECONDS` | 86400 |
| `DSH_AUTH_MAX_ATTEMPTS` | 6 |
| `DSH_AUTH_LOCK_SECONDS` | 30 |

首次加载且不存在 `admin` 时创建该管理员，初始密码 `123456`，首次登录必须改密后才能使用受保护功能。已有 `admin` 不会被覆盖。密码长度为 8–256 个字符，强制改密后需要重新登录。

`auth.sqlite` 保存用户、授权和登录会话，密码使用带盐 scrypt，数据库只存登录令牌摘要。数据库 schema 为 2；旧 schema 1 自动增加首次改密标记，已有用户保持原状态。回滚到不支持 schema 2 的版本需要恢复升级前一致备份。

所有变更请求检查 Origin 与 CSRF。Cookie 使用 HttpOnly、SameSite=Strict，在 HTTPS 下启用 Secure。卸载插件不删除数据库。备份需要停止写入或使用 SQLite 一致备份。

## 模型密钥

管理员完成初始改密后可从左侧“模型设置”选择 DeepSeek 或智谱，配置或更换对应的 `DEEPSEEK_API_KEY`、`ZHIPU_API_KEY`。页面只展示配置状态及不可逆 SHA-256 指纹，不返回原密钥，不验证余额或模型调用；此配置作用于整个宿主。普通用户和未完成初始改密的管理员不能读取或写入此接口。

`GET/POST /auth/api/model-key/deepseek`、`/auth/api/model-key/zhipu`（旧 `/auth/api/deepseek-key` 保留兼容） 复用现有会话、Origin、CSRF 及管理员校验，调用 kit 的共享凭据逻辑与宿主 `credentials` 服务。网页支持上述两种提供方，`set-api-key` 脚本仅支持 DeepSeek；无环境覆盖时调用同一官方存储，默认无需重启，后续请求使用新密钥；外部环境覆盖显示只读。没有官方凭据服务时明确禁用，不另建业务配置文件。智谱入口面向普通模型 API，密钥支持 GLM-5.3 和 GLM-5V-Turbo 等模型；实际模型路由由宿主或应用装配，保存密钥不改变全局默认模型。其他提供方仍由官方控制台管理。

## 控制台代理

`GET /auth/api/console-access` 可供反向代理 `auth_request` 检查控制台授权，返回 204、401、403 或 503，不发行官方 token。代理必须覆盖页面、API 和 WebSocket，并用原始请求 URI 覆盖 `X-Original-URI`。已登记插件的路由前缀交回插件自行鉴权；未知路由和控制台要求 `dsh-console`。已建立 WebSocket 不会因撤权自动断开。

源码开发时运行 `pnpm --filter dsh-auth test` 检查账号、授权、持久化、撤权与页面逻辑；日常 check 只做类型与 Web 脚本语法检查。

本插件采用随附 [Apache-2.0](LICENSE)。

框架私有 env 的相应密钥非空时文件优先、网页只读，修改须受控重启；留空不删除官方凭据，若仍有启动环境覆盖也会只读。网页支持 DeepSeek/智谱，`set-api-key` 脚本仅支持 DeepSeek。规则见[统一配置](../../doc/framework-configuration.md)。
