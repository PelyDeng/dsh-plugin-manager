# 独立发布物交付

适用于 manager 0.3.0。部署者只需管理工具、匹配的官方 DSH、应用与认证插件各自的发布目录，以及作者提供的配置模板；无需作者源码。以下 `dsh-plugin-manager` 指已安装 CLI，本地工具目录安装时用 `pnpm exec dsh-plugin-manager`。需要 Node.js `^22.19.0 || >=24`、pnpm `11.19.0` 和系统 tar。

## 1. 准备与组合

核对提供方记录的工具、宿主版本及归档 SHA-256；包名不表示已发布到公共 registry。首次安装管理工具：

```sh
pnpm add --ignore-workspace /path/to/plugin-manager-0.3.0.tgz
pnpm exec dsh-plugin-manager --version
```

官方宿主可在独立工具目录安装固定版本（Windows HTTP 接入验收使用 0.1.2-alpha.5）：

```sh
pnpm add --ignore-workspace @deepseek-ai/dsh@0.1.2-alpha.5
node node_modules/@deepseek-ai/dsh/lib/bin.js --version
```

若 pnpm 报依赖构建脚本待批准，执行 `pnpm approve-builds` 按官方依赖要求选择，再重新安装。保存生成的 pnpm-lock.yaml，后续使用冻结安装；不要将固定 CLI 版本等同于全部间接依赖也已固定。配置中的 dshCliJs 指向该工具目录下 `node_modules/@deepseek-ai/dsh/lib/bin.js` 的绝对路径。具体应用应采用其交付说明中验证过的宿主版本。

将每个应用的完整发布目录放到交付根的 `incoming/`。例如 auth、knowledge、sales 分别来自不同作者；这些是目录示意，插件 ID 以各自清单为准。组合完整候选集合：

```sh
dsh-plugin-manager compose-release --root /path/to/site --output releases/site-v1 --manifest incoming/auth/manifest.json --manifest incoming/knowledge/manifest.json --manifest incoming/sales/manifest.json
```

组合不构建、不安装依赖、不执行应用代码；同 ID 或包名重复时请只保留要交付的版本。新目录内保留清单和全部引用归档，不能单独移动 manifest.json。原始分项发布目录保留，方便下次替换某个应用版本。

仅演示最小接入时，可以用独立 kit 示例代替 sales，省略 knowledge。该示例返回当前账号身份，不是销售查询应用。

## 2. 填写实例配置

在交付根创建 `.local/deployment.json`，替换官方 CLI 位置与实际站点 origin：

```json
{
  "manifest": "releases/site-v1/manifest.json",
  "plugins": "all",
  "mode": "release",
  "home": ".local/data/dsh-home",
  "dshCliJs": "/path/to/dsh/lib/bin.js",
  "port": 7902,
  "publicOrigin": "http://127.0.0.1:7902"
}
```

每个配置型应用使用 `<home>/plugins/<id>/plugin.json`，认证消费者示例：

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "accessMode": "authenticated",
  "config": {}
}
```

将作者声明的业务字段填入 config。销售地址、超时等字段名称及值由销售应用说明定义；管理器不推测。凭据使用作者声明的 runtimeConfig 文件，默认 `<home>/plugins/<id>/env.conf`，格式按作者模板填写；没有声明 runtimeConfig 的应用无需此文件。不要把真实凭据放入发布归档或 Git。可用 `tar -xOf <应用.tgz> package/README.md` 阅读随版本发布的说明，模板路径见包内声明。

auth 的 plugin.json 不接受 accessMode；缺省配置即可提供认证。消费者使用 authenticated 时，候选清单必须包含一个启用的 provider。旧 profile 已安装 auth 但本次未选入，仍会在安装前拒绝。缺少必需 runtimeConfig 文件会提示应用 ID；业务字段缺失由应用加载校验提示具体字段。

## 3. 启动与验证

```sh
dsh-plugin-manager start --root /path/to/site --config .local/deployment.json --plugins all
```

start 在前台运行，保留该终端；另一个终端执行：

```sh
dsh-plugin-manager health --root /path/to/site --config .local/deployment.json
```

等待宿主与应用已声明探针通过。not-provided 表示作者未提供业务探针，不能当成业务已就绪。若安装成功但业务接口失败，先看启动错误及应用说明，再检查 origin、账号授权和业务配置；不要重写管理器名单。

打开 `<publicOrigin>/auth`。空数据库首次生成 admin，使用初始密码 123456 登录并立即完成强制改密，再重新登录。管理员创建角色为普通用户的账号，勾选该应用授权。用普通账号访问作者提供的应用入口，完成一次业务查询；未授权用户必须被拒绝。授予应用访问权限不会授予全部销售数据，应用仍须按当前身份限制部门、客户和报表。

停止使用 `dsh-plugin-manager stop --root /path/to/site --config .local/deployment.json`。配置与认证模式变化在受控重启后生效。

### 问答应用的模型准备

auth 登录和模型凭据是两件事。example 在新建会话时读取同一宿主的 agentDefaultModel；不要把模型密钥放进插件 config。

1. 管理器 start 打印“DSH 认证地址已保存至 …”。在本机编辑器打开该私有文件（默认 `<交付根>/.local/data/dsh-web-auth-url.txt`），仅在自己的浏览器访问其中地址；这是官方控制台入口，不能公开粘贴或截图 token。它对应本次启动的 home/profile。
2. 打开官方控制台左下角“设置”→“模型”，配置或编辑提供方凭据；由启动环境提供的密钥会显示只读。采用官方 DeepSeek 提供方时，也可在工具目录通过下列命令隐藏输入 `DEEPSEEK_API_KEY`；命令只保存到本次 home/.env，不选择模型，也不自动重启。

```sh
pnpm exec dsh-plugin-manager set-api-key --root /path/to/site --config .local/deployment.json
```

3. 新实例默认沿用宿主组合中的模型。需要切换时，可在官方会话输入框的模型选择器选择模型，保存为后续 Agent 的默认选择；该输入框要求先选择工作区。也可在停止服务后，向同一 `<home>/settings.yaml` 合并以下设置分节，保留文件其他设置；替换为实际提供方 ID 和它支持的模型 ID，不是显示名称。

```yaml
agent-default-model:
  provider: <已注册提供方ID>
  model: <该提供方支持的模型ID>
```

4. 由原管理器 stop/start，让环境配置生效；在 `/example` 新建对话并提问。其他提供方的凭据按该宿主版本的模型设置填写，不能套用只写 DeepSeek 密钥的命令。

模型选择以实际控制台为准，不根据文档中的模型名猜可用性；旧会话保留已创建 Agent 的选择，改变默认值后用新会话核实。健康探针不调用模型；真实问答失败时检查提供方、凭据、网络及具体模型是否可用。

## 4. 新增或升级应用

沿用原 home 和 plugin.json。替换 incoming 中该应用版本，保留其余应用输入，用新输出目录组合，并显式提供现用清单：

```sh
dsh-plugin-manager compose-release --root /path/to/site --output releases/site-v2 --previous releases/site-v1/manifest.json --manifest incoming/auth/manifest.json --manifest incoming/knowledge/manifest.json --manifest incoming/sales/manifest.json
```

previous 保留当前旧归档的相对路径，仅供安装器解析旧 file: 依赖，不加入新候选。保留旧目录供恢复。不要把旧整站清单与同 ID 新包直接叠加；从分项清单重新组合。未选入新集合的受管应用会被撤选，但数据保留。

将 deployment.json 的 manifest 改为新清单，再执行 start，始终显式 `--plugins all`，避免旧选集过滤新增应用；各实例 enabled=false 仍生效。确认新旧应用均可用、原普通账号仍能登录、授权及业务配置保留。应用自身数据格式升级仍需作者提供迁移/回滚说明，不能仅凭保留文件承诺跨版本兼容。

Docker 部署使用同版本 manager 的宿主镜像，在 deployment.json 补 containerImage（不可变镜像 ID 或 digest）和 composeProject，再执行 `dsh-plugin-manager apply-compose --root /path/to/site --config .local/deployment.json --plugins all`。管理器生成配置及挂载，不手改 Compose；升级时必须提供 previous，旧归档需在固定容器挂载内可见。镜像获取与实例参数由交付方提供，不能把任意 DSH 镜像视为已包含 manager。
