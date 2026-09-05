# dsh-auth

可选统一认证插件，在宿主 WebServer 提供 `/auth` 页面、账号管理与逐插件授权。默认不安装，不改变业务插件的访问模式，不替代 DSH 官方控制台认证。

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

## 控制台代理

`GET /auth/api/console-access` 可供反向代理 `auth_request` 检查控制台授权，返回 204、401、403 或 503，不发行官方 token。代理必须覆盖页面、API 和 WebSocket，并用原始请求 URI 覆盖 `X-Original-URI`。已登记插件的路由前缀交回插件自行鉴权；未知路由和控制台要求 `dsh-console`。已建立 WebSocket 不会因撤权自动断开。

部署见[公共说明](../../deploy/README.md)。运行 `pnpm --filter dsh-auth check` 检查账号、授权、持久化、撤权与页面逻辑。

本插件基于 [deepseek-harness-auth](https://github.com/taichuy/deepseek-harness-auth/tree/4464052fc1dcae45622cfcef6f9cbbbaaa6004a6) 修改，采用随附 [Apache-2.0](LICENSE)。
