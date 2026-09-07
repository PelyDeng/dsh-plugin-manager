# 博客工作台

私有 DSH 业务插件，入口 `/blog`。通过 auth 授权后使用同一份草稿进行手动编辑、AI 写作、资料查证、候选合并和确认发布。博客端为 Typecho 1.2.1，图床端为 Lsky Pro 2.1 的固定存储策略。

## 配置

从 [配置模板](config/config.example.json) 创建本插件的 `config/config.json`，填入博客和图床地址、账号、密码。实际文件不提交、不进镜像或插件归档。生产站点设置 `instances.blog.runtimeConfig` 指向服务器本插件的该文件；管理器只读挂载后由 `BLOG_CONFIG_PATH` 指明读取路径。

本插件强制 `authenticated`。给需要写作的账号授予 `blog` 插件权限；备份管理另外检查 `backup.allowedUserIds` 中的 auth 稳定用户 ID，空列表拒绝所有交互备份和恢复。模型工具不能发布或恢复网站。配置更改通过管理器重新应用并重启生效。

## 宿主能力

通过官方 `dsh` profile 运行，不自建第二个宿主。宿主需提供 agents、agentDefaultModel、llm、tools、systemPrompt、webServer、jobs 和 attachments。最终运行契约以仓库锁定的 DSH `0.1.3-alpha.1` 为准：原文件需要该版本的 `saveFileStream/readFileStream`，不能仅凭较旧开发依赖的类型检查认定可用。

AI 任务使用官方 Jobs controller 和真实 Agent owner；每次写作建立新 Agent，避免上一次已移除的附件仍进入上下文。任务结果、幂等请求、候选稿和原用户归属保存在本插件 SQLite 中。服务重启会将未完成任务标记中断，不自动重新调用模型。

联网查证复用宿主 `web`，需要挂载一个明确的搜索 provider 和抓取 provider。多个未指定默认 provider 的配置会报歧义，不能当作已有联网能力。公开网页抓取应使用官方限制私网地址和重定向的 `web-fetch-http`。来源记录区分搜索摘要和实际抓取原文。

## 编辑与附件

- 手动和 AI 模式共用草稿；支持原文、分屏、预览、标签、已有分类、图片和自动保存。预览不执行脚本，主题短代码以博客最终渲染为准。
- AI 输出先成为候选，用户按标题、正文、标签选择应用。草稿基线变化时禁止覆盖，可人工比较后合并。
- 私有资料支持 UTF-8 TXT、Markdown、CSV、JSON、文本层 PDF、DOCX、PNG/JPEG/WebP/GIF。单文件 20 MiB、每稿 10 个、本次选中 40 MiB；模型资料文本限 100000 字符。可选择页、段或行范围。
- 原文件复用官方 File API；模型图片复用 Image API。GIF 的模型输入为规范化单帧，原文件完整保留。图片模型能力按实际 provider/model 检查。
- PDF/DOCX 在有限内存的可终止 worker 中提取，解析限时 30 秒。扫描 PDF 提示需要 OCR；部分解析明确展示覆盖范围，不能默认声称全文读取。
- “添加资料”不会公开文件。“插入图片”才上传到配置的图床策略。Lsky 必须开启 API；Token 缓存放在插件运行数据中，不修改其他用户 Token。

## Typecho 桥接

将 [DshBlogBridge](typecho/DshBlogBridge/Plugin.php) 安装为 Typecho 插件并启用。启用时创建独立 InnoDB 回执表；不修改 Typecho 核心。接口为 `/action/dsh-blog-bridge`，仅接受固定 JSON 操作和 Typecho 原生账号认证。

公开版本与保存稿分开返回。提交使用版本比较、同连接事务及持久回执，客户端在超时后查回执，不盲目重复创建。编辑保留原文格式、自定义字段及既有开关。桥接调用原生文章 save/publish 组件，避免表单重定向和 ping；不执行依赖管理后台表单字段的主题写入回调。主题专属编辑行为需单独验证，不能从通用正文往返推断。

## 定时备份与恢复

备份执行器作为服务器独立 systemd 服务运行；不把 Docker socket、SSH 私钥或 root 数据库凭据挂进 DSH。阅读 [执行器说明](backup/README.md)，使用显式路径配置安装。API 仅监听回环地址并校验 Token；本部署依赖 DSH 使用 host 网络。

备份包含 Typecho、Lsky 数据库和网站文件、pelyblog 桶数据、工作台草稿和引用的官方附件。恢复可选择隔离演练或生产恢复；生产恢复需输入备份 ID，再次校验原用户会话，先备份当前状态并保留旧目录和数据库。其他图床策略不会被覆盖；共享引用或存储策略发生不兼容变化时拒绝恢复。

同机备份不提供整机故障后的容灾能力。备份含站点配置和私有资料，仅在受限目录保管；异机目的地由管理员另外配置。

## 后续智能体协作

公开导出 `dsh-blog-assistant/protocol`，协议版本 1。受信任的同宿主插件通过 `blog-assistant/service` 发现 `start/get/cancel`，传入原用户的有效 Actor。请求包括 callerId、requestId、草稿修订、指令、联网选项及冻结的附件选择；相同用户和调用方的 requestId 不重复执行，相同标识不能换输入。

`blog-assistant/task` 事件仅发送任务引用；读取内容必须再次携带有效 Actor 调用 get。原会话失效会取消运行任务。这个协议是博客能力边界，不实现未来的意图路由管理器，也不能绕过工作台发布确认。

## 开发检查

```sh
pnpm --filter dsh-blog-assistant check
pnpm --filter dsh-blog-assistant build
pnpm --filter dsh-blog-assistant test
python3 -m unittest discover -s plugins/dsh-blog-assistant/backup -p 'test_*.py'
```

上述检查分别覆盖类型/语法、构建、本地行为及归档边界；不能替代真实宿主、模型、图床上传、定时触发、恢复和浏览器验收。过程记录位于仓库忽略的 `.local/dsh-blog-assistant/docs/`。
