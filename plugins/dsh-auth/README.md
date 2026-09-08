# dsh-auth

## 会话管理

登录后通过左侧“会话管理”按已授权业务插件管理本人对话，支持搜索、日期与状态筛选、分页、右侧只读预览及批量删除。删除同步移除插件历史和官方 DSH 列表，底层记录仍保留；运行中的会话不可删除。完整行为、旧历史如何处理，以及插件如何接入见[会话管理](../../doc/conversation-management.md)。

通过管理器部署时，本插件按 `configuration.auth: provider` 提供认证，站点 origin 统一配置。实例配置为 `<DSH home>/plugins/auth/plugin.json`，不接受 `accessMode`；其他插件各自决定是否要求认证。配置与部署步骤见管理器包内 DELIVERY.md。

可选统一认证插件，在宿主 WebServer 提供 `/auth` 页面、账号管理与逐插件授权。默认包含在所选插件中，不改变业务插件的访问模式，不替代 DSH 官方控制台认证。

管理员可以管理账号，自动拥有已加载插件和控制台权限。普通用户需要逐项授权。账号角色、密码、启停或授权变化会撤销该用户登录会话；最后一个有效管理员不能被停用或降级。

“查看插件工具”的卡片标题和插件工具预览使用插件声明的中文显示名；英文工具编码放在展开详情中，与描述、执行权限及参数一起展示。搜索支持中文名称、英文编码、描述和参数；未声明显示名的旧插件兼容显示编码。

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

## 对话默认模型

管理员在“模型设置”顶部选择模型卡片右上角的单选项，保存后立即成为整个宿主的新会话默认模型。卡片由官方模型目录动态生成，按宽度自动排列；同一服务商的多个模型可以分别选择。当前默认有明确标记，保存失败保留原选择并显示错误。

`GET/POST /auth/api/conversation-model` 复用管理员、Origin、CSRF 和撤权检查。目录与路由校验由官方 `sessionController` / `llm` 提供，保存委托 `agentDefaultModel.saveSelection()` 与官方 `settings` 持久化；auth 不维护第二份配置。仅检查路由可用性，不发送模型请求或验证额度。无可写设置服务时禁用选择；已配置的默认不在目录时明确提示，不自动替换。

插件使用 kit 的 `conversationModel()` 接入相同规则：新会话读取当前默认，已有会话恢复官方记录中的模型，分支沿用分支位置的模型。读取失败，或宿主无法从日志整理出模型选择时，拒绝恢复，避免意外切换。第三方插件须采用此接口或实现等价规则，硬编码模型的插件不会自动改变。专用识图等任务可保留能力匹配的路由；选为默认的服务商必须保持安装且凭据可用。详见[通用接入](../../packages/plugin-kit/README.md)。

## 模型密钥

管理员完成初始改密后可展开“模型设置”下方的“服务商 API 密钥”，配置或更换 DeepSeek、智谱对应的 `DEEPSEEK_API_KEY`、`ZHIPU_API_KEY`。每张凭据卡片独立读取、刷新和保存；桌面最多两列，窄屏单列。新密钥输入不回填已有值，退出或离开页面即清空；指纹与来源位于“凭据详情”。页面只展示配置状态及不可逆 SHA-256 指纹，不返回原密钥，不验证余额或模型调用；此配置作用于整个宿主。普通用户和未完成初始改密的管理员不能读取或写入此接口。

`GET/POST /auth/api/model-key/deepseek`、`/auth/api/model-key/zhipu`（旧 `/auth/api/deepseek-key` 保留兼容） 复用现有会话、Origin、CSRF 及管理员校验，调用 kit 的共享凭据逻辑与宿主 `credentials` 服务。网页支持上述两种提供方，`set-api-key` 脚本仅支持 DeepSeek；无环境覆盖时调用同一官方存储，默认无需重启，后续请求使用新密钥；外部环境覆盖显示只读。

没有官方凭据服务时明确禁用，不另建业务配置文件。智谱入口面向普通模型 API，密钥支持 GLM-5.3 和 GLM-5V-Turbo 等模型；实际模型路由由宿主或应用配置，保存密钥不改变全局默认模型。其他提供方仍由官方控制台管理。

框架私有 env 的相应密钥非空时文件优先、网页只读，修改须受控重启；留空不删除官方凭据，若仍有启动环境覆盖也会只读。规则见[统一配置](../../doc/framework-configuration.md)。

## 控制台代理

`GET /auth/api/console-access` 可供反向代理 `auth_request` 检查控制台授权，返回 204、401、403 或 503，不发行官方 token。代理必须覆盖页面、API 和 WebSocket，并用原始请求 URI 覆盖 `X-Original-URI`。已登记插件的路由前缀交回插件自行鉴权；未知路由和控制台要求 `dsh-console`。已建立 WebSocket 不会因撤权自动断开。

源码开发时运行 `pnpm --filter dsh-auth test` 检查账号、授权、持久化、撤权与页面逻辑；日常 check 只做类型与 Web 脚本语法检查。

本插件采用随附 [Apache-2.0](LICENSE)。

模型服务商图标使用 DeepSeek Harness 官方鱼形图标及智谱 BigModel 官网资源，随归档本地提供；来源与许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。
