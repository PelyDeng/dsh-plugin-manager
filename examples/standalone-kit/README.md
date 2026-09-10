<!-- Generated from examples/standalone-kit/README.md.tmpl by scripts/version.mjs; edit the template. -->

# 独立鉴权起步插件

先按原名跑通登录与身份请求，再修改业务。此例复用 kit 返回可信账号标识，不提供聊天或业务数据库。读取业务数据时仍须以该身份检查数据归属，不接受浏览器或模型自行声明的 userId。

## 准备工具与 kit

<!-- Excerpt from doc/plugin-development.md.tmpl#author-tools; edit its source. -->
需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 tar。从同一框架 Release 取得 `dsh-plugin-manager-starters-0.16.0.zip`、`plugin-manager-0.16.0.tgz`；起步包的鉴权目录已带同版 kit；仅单独复制仓库示例或升级 kit 时另取 `plugin-kit-0.16.0.tgz`。核对随发行提供的 SHA-256，不假设这些包已发布到 npm registry。

起步 zip 内有 standalone-plugin、standalone-kit；选一个目录复制为自己的作者项目，不复制 node_modules、dist 或 .local。在作者项目以外创建独立工具目录 dsh-tools，在该工具目录安装实际 manager 归档：

```sh
pnpm init
pnpm add --ignore-workspace /absolute/path/plugin-manager-0.16.0.tgz
pnpm exec dsh-plugin-manager --version
```

将占位路径替换为实际绝对路径，含空格时加引号。以后 pnpm exec dsh-plugin-manager 都在这个工具目录执行，--root 明确指向作者项目。manager 不加入业务运行依赖；工具目录和作者项目各自保存锁文件。

Release 起步包已带同版 vendor/plugin-kit.tgz 和相对开发依赖，在本作者目录执行 `pnpm install --ignore-workspace`。仅单独复制仓库示例时，从 Release 取得 `plugin-kit-0.16.0.tgz` 并保存为 vendor/plugin-kit.tgz，再执行：

```sh
pnpm add --ignore-workspace --save-dev ./vendor/plugin-kit.tgz
```

保存 vendor 中公开的 kit 构建归档与作者 pnpm-lock.yaml。kit 内嵌到 dist，最终运行依赖不保留该 file 路径。

## 打包、部署与登录

<!-- Excerpt from doc/plugin-development.md.tmpl#author-pack; edit its source. -->
在工具目录执行，将作者项目换成实际绝对路径：

```sh
pnpm exec dsh-plugin-manager list --root /absolute/path/my-plugin --package .
pnpm exec dsh-plugin-manager pack --root /absolute/path/my-plugin --package . --output .local/artifacts/release/v1
```

list 只读声明，不要求锁文件；pack 要求作者根的 pnpm-lock.yaml，冻结安装后各执行一次 build/check，再校验并打包，无需事先重复 check。输出必须是新目录或空目录，路径相对作者 root；再次发布用新目录 v2。日常可独立运行 check，它会先 build，完整业务测试另行运行。

交付整个输出目录，其中有 manifest.json 和所有摘要命名 tgz。部署者把目录放到 incoming/my-plugin 后执行框架 build，不手写清单。不使用 prepare/prepack/postpack 重复构建。运行依赖不得指向作者机器或 workspace；pack 成功不是宿主、登录、模型或业务验收成功。

将本次完整目录放入部署包 incoming/independent-access-example，再将部署包 optional/auth 复制到 incoming/auth；已经存在其他含 auth 的清单时不重复复制。运行 build 后使用实际站点地址：

<!-- Excerpt from doc/getting-started.md.tmpl#first-login; edit its source. -->
需要认证的应用先确认已选入并启用 auth，再访问实际站点的 /auth；无认证应用跳过登录。空数据库首次管理员为 admin，初始密码 123456；首次登录按页面强制改密，然后重新登录。此后创建普通账号，为它勾选目标插件授权，再用该普通账号登录。

鉴权起步插件的实际请求为 /independent-access-example/identity，成功返回含 owner 的 JSON；匿名或无该应用授权的账号不应取得身份结果。无 kit 的起步插件请求 /independent-example/ready，成功返回其 README 定义的就绪 JSON。测试身份端点不需要模型。

已部署 example 时，普通账号打开 /example，新建对话，确认真实流式回答及历史恢复；需要先配置自己的模型。/auth 登录、官方根路径认证和模型 API 密钥分别管理，不能用填模型密钥修复根路径的认证提示。健康检查、登录和真实模型调用分别验证。

## 开始自己的业务

| 修改内容 | 位置与关系 |
| --- | --- |
| 包名、作者版本 | package.json；归档身份独立于框架版本 |
| 插件 ID | deepseekPlugin.id、src 的 name 和权限前缀 |
| 可配置入口 | cordis.patch.yml entry ID 与 configuration.entryId 保持一致 |
| 路由和权限 | src 中 routePrefix/identity 路径及 permissions，与真实访问检查一致 |

不需要重新实现登录。metadata 声明不自动保护自行注册的路由，应沿用 createAccess/createPluginHttp。需要共享匿名演示时，显式将 plugin.json 的 accessMode 改成 standalone 并受控部署；它返回共享本地身份，不是个人身份。

再次开发按“改代码→pack 新目录→整体替换 incoming 对应目录→build→普通用户请求”验证。更改业务配置导致加载失败时按 build 的 recover 指引处理；需要换修复包不属于同包配置快捷恢复。
