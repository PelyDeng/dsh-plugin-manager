# dsh-example · 开发者接入助手

在 `/example` 询问框架是什么、内部或独立仓库如何接入、可选鉴权、发布交付、错误排查，以及如何生成给其他 AI 的开发提示词。它也保留可复制的流式问答、停止、多轮和个人历史实现。就绪地址为 `/example/ready`。

## 启动与使用

需要应用交付说明中验证过的官方 DSH、manager 0.3.0 和 auth/example 发布目录。先组合完整候选集合，再配置同一实例的 home、CLI、port 和 publicOrigin。管理工具安装在 tools 目录时，从该目录执行：

```sh
pnpm exec dsh-plugin start --root <交付根> --config .local/deployment.json --plugins all
```

配置与获取发布物的完整步骤见[图文手册](https://github.com/PelyDeng/dsh-plugin/blob/main/doc/getting-started.md)和 manager 随包 DELIVERY.md；在线 main 可能领先于当前版本。Linux Docker 完整源码部署可使用仓库的 `bash deploy/build.sh`。

默认 authenticated。登录 `/auth`，首次 admin 必须改密；普通账号需要 example 授权，再打开 `/example`。同一个 DSH home 还需官方默认模型与凭据，插件不保存模型密钥。探针成功只说明基本可服务，不证明模型请求成功。

实例配置在 `<home>/plugins/example/plugin.json`。将 accessMode 改为 standalone 后受控重启可独立体验；这是安装级共享历史。enabled 控制停用；停用不删除数据。字段与可复制模板见随包[配置参考](examples/README.md)。

## 知识和回答范围

- [接入 FAQ](knowledge/guide.md)：定位、架构、命令、代码、鉴权、交付和限制。
- [五种开发提示词](knowledge/prompts.md)：工具、问答应用、已有项目、内部交付与故障诊断。

这两份 Markdown 同时是读者文档和模型知识，不另建副本。只加载包内固定路径，合计不超过 32 KiB；构建与启动时超限拒绝，不截断。页面展示插件版本及内容摘要；摘要标识资料内容，不证明远程仓库实时同步。维护者变更支持能力时同步这些文件、相关命令和来源，并检查打包内容、代表性问答与真实宿主请求。

职责、知识与部署者的 config.systemPrompt 分开注入官方 systemPrompt.section。补充提示默认空；已有配置不会被自动重写。改成其他业务助手时需替换内置职责、知识和建议问题，不能仅设置补充提示。未知版本、私有业务和未提供的 API 应明确待核实。助手不会执行命令或读取用户机器；工具白名单始终为空。

可用“我是外部作者，怎么取得工具？”开始，再追问“增加第二应用时原账号怎样保留？”；也可以让它生成带占位符的开发提示词。给出 OS、版本、目录角色和目标可获得更准确步骤，勿发送真实凭据。

## 历史与认证

回答支持 Markdown 标题、列表、表格、引用、链接、图片、行内代码和带语言标签的代码块；流式输出、停止后的部分回答和历史回放使用相同渲染。长代码和宽表格可横向滚动。代码块可单独复制，“复制回答”保留原始 Markdown，便于继续编辑。用户输入和思考过程保留纯文本；原始 HTML 不执行，Mermaid、公式等未启用的扩展按文本或代码展示。

浏览器脚本在构建时内嵌 markdown-it，不依赖外部 CDN；保留解析器的链接校验，禁用原始 HTML。第三方许可随发布包的 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 分发。开发时修改 web 源码后执行 `pnpm build`；正式部署需重新打包并更新实例。

SQLite 只存账号所有者、标题和时间等历史目录；消息正文使用 DSH 会话日志。账号历史与 standalone 共享历史分别保留，不迁移合并；同一账号的不同登录共享个人历史。沿用同一 home 才能恢复原数据。退出或撤权取消该登录的活动回合；停止生成取消模型工作，已持久化内容仍可从历史继续。

支持旧日志 chunk 与 DSH 0.1.3 瞬态流；思考和回答分开展示，无 reasoning 时不模拟。历史支持已发布宿主的 inspect 与早期源码宿主的 open/read/close，缺少这两种接口时明确拒绝。CLI、基础 Bundle 与间接依赖需要一起核对，不能只凭 CLI 版本保证兼容。宿主、模型和当前插件的组合仍需真实验证。

## 作者复制与检查

内部复制本目录，修改包名、ID、路由、权限、Bundle、会话前缀、提示词段名、知识、页面和测试。外部作者把 kit workspace:* 换成版本化 tgz 开发依赖、保留 tsdown 内嵌；移除原仓库 clean 入口及框架专用集成测试依赖。配置与知识输入都随包目录携带；[外部复制步骤](https://github.com/PelyDeng/dsh-plugin/blob/main/doc/plugin-development.md#复制完整问答应用到独立仓库)说明具体操作。

在包根运行 `pnpm build`、`pnpm check`，行为回归单独运行 `pnpm test`。框架内也可用 `pnpm --filter dsh-example ...`。测试使用隔离数据和 Agent 替身，不证明真实模型回答质量。`tests/host-smoke.mjs` 使用真实官方宿主和 auth/example tgz，但模型 HTTP 是明确标识的本地替身。
