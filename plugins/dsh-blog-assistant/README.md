# 博客智能体

私有 DSH 业务插件，入口 `/blog`。通过 auth 授权后直接对话、查询博客、分析资料或写作；文章编辑视图提供手动编辑、候选合并和确认发布。博客端为 Typecho 1.2.1，图床端为 Lsky Pro 2.1 的固定存储策略。

## 配置

从 [配置模板](config/config.example.json) 创建本插件的 `config/config.json`，填入博客和图床地址、账号、密码。实际文件不提交、不进镜像或插件归档。生产站点设置 `instances.blog.runtimeConfig` 指向服务器本插件的该文件；管理器只读挂载后由 `BLOG_CONFIG_PATH` 指明读取路径。

本插件强制 `authenticated`。给需要写作的账号授予 `blog` 插件权限；备份管理另外检查 `backup.allowedUserIds` 中的 auth 稳定用户 ID，空列表拒绝所有交互备份和恢复。模型工具不能发布或恢复网站。配置更改通过管理器重新应用并重启生效。

管理器认证配置层覆盖 Bundle 默认配置时，插件仍从 `BLOG_CONFIG_PATH` 取得同一凭据文件的路径；显式 `runtimeConfig` 优先。该变量只存路径，不存账号或密码。

离线部署前需准备本插件新增依赖的包内容和对应 registry 元数据。pnpm 11 的已有可写 store 使用 SQLite 索引，仅复制新的只读包文件不会更新旧索引；应使用 pnpm 在独立临时项目中预热目标 store，保留已有索引，不能直接覆盖 `index.db`。准备完成后使用管理器原发布记录恢复。

## 宿主能力

通过官方 `dsh` profile 运行，不自建第二个宿主。宿主需提供 agents、agentDefaultModel、llm、tools、systemPrompt、webServer、jobs、attachments、sessions、sessionPersistence 和 messageFeedback。最终运行契约以仓库锁定的 DSH `0.1.3-alpha.1` 为准：原文件需要该版本的 `saveFileStream/readFileStream`，历史与用量依赖其公开子路径，不能仅凭较旧开发依赖的类型检查认定可用。

官方 web Bundle 已提供会话持久化、JSON storage-domain 和 messageFeedback，无需重复装配。博客接口将反馈备注限制为 4000 UTF-8 字节，沿用宿主共享反馈服务的配置，不改变其他应用的备注上限。

模型接入复用官方 `dsh-llm-pi-ai`，Bundle 在已有适配器中声明 `blog-zhipu` 专属路由，使用智谱普通模型 API。管理员从 auth“模型设置 → 智谱 GLM”保存 `ZHIPU_API_KEY`，密钥只写官方 credentials 存储；不复制到博客配置。此密钥为宿主共享凭据，与 DeepSeek 的密钥分别管理。

博客配置的 `models.text` 和 `models.vision` 只保存 provider/model 引用。模板使用 GLM-5.3 写作、GLM-5V-Turbo 看图；未配置模型引用的旧部署沿用宿主默认模型。含图的本轮附件或已发送历史会选视觉模型，分支和重启后的续聊同样保留该能力。缺少智谱密钥时明确提示配置，不悄悄改用其他模型；其他插件的默认模型不变。GLM-5.3 始终开启思考，路由默认 high；GLM-5V-Turbo 只发送文档支持的思考开关。每次输出上限配置为 8192 Token。

AI 任务使用官方 Jobs controller 和真实 Agent owner。文章编辑器的单次写作建立独立 Agent；对话每轮恢复同一官方 Session，并在结束时持久化、释放 Agent。任务结果、幂等请求、候选稿和原用户归属保存在本插件 SQLite 中。服务重启会将未完成任务标记中断，不自动重新调用模型。

对话全文使用官方 Session 日志。点赞、点踩及备注使用官方 messageFeedback 的版本校验；Token 使用官方 token-meter 的单轮统计，缺失用量显示“未提供”。分支保留完成轮次之前的消息，重新生成在分支中追加新请求并沿用逻辑文章绑定，不回滚原文章。消息中的文章卡是不可变候选快照，当前正文和可应用状态以编辑器为准。

对话附件不要求先创建文章。发送时冻结资料版本及阅读范围；移除待发送选择不删除历史消息中的原件引用。新对话不继承旧资料，分支只继承切点之前的消息与资料。

`pnpm test` 运行可在已发布开发依赖上执行的行为测试；`pnpm test:host` 必须在锁定 DSH 0.1.3 运行环境中运行，覆盖真实公开 SDK 的历史/Token 投影及受保护 HTTP 路由。HTTP 测试使用隔离数据与身份替身，不等于正式浏览器或真实模型验收。

联网查证复用宿主 `web`，需要挂载一个明确的搜索 provider 和抓取 provider。多个未指定默认 provider 的配置会报歧义，不能当作已有联网能力。公开网页抓取应使用官方限制私网地址和重定向的 `web-fetch-http`。来源记录区分搜索摘要和实际抓取原文。

## 手机与桌面工作台

手机使用“对话、文章、管理”底部导航；历史对话和文章库按需打开为抽屉，选中后自动收起。输入框随内容增长，触屏 Enter 换行，点击发送按钮提交；桌面 Enter 发送、Shift+Enter 换行。浏览器可视区域缩小时收起底部导航，为键盘和输入框留出空间。

桌面对话采用侧栏和居中阅读区。复制、赞、踩位于回答下方，“更多回答操作”提供评价备注、分支和重新生成；反馈与 Token 数据沿用官方服务。流式更新保留未改变的消息节点、展开状态与阅读位置。界面图标来自官方 DSH，授权说明随插件归档发布。

手机编辑以原文或预览独占正文区域，标签、分类与链接收在“文章设置”；AI 写作助手按需打开。桌面保留原文/预览分屏与助手侧栏。三个保存出口分别为本地草稿、博客草稿和预览并发布，公开发布仍需核对版本并确认。管理入口提供备份、博客和账号设置。

## 编辑与附件

- 手动和 AI 模式共用草稿；支持原文、分屏、预览、标签、已有分类、图片和自动保存。预览不执行脚本，主题短代码以博客最终渲染为准。
- AI 输出先成为候选，用户按标题、正文、标签选择应用。草稿基线变化时禁止覆盖，可人工比较后合并。
- 私有资料支持 UTF-8 TXT、Markdown、CSV、JSON、文本层 PDF、DOCX、PNG/JPEG/WebP/GIF。单文件 20 MiB、每份草稿或对话 10 个、本次选中 40 MiB；模型资料文本限 100000 字符。可选择页、段或行范围。
- 原文件复用官方 File API；模型图片复用 Image API。GIF 的模型输入为规范化单帧，原文件完整保留。图片模型能力按实际 provider/model 检查。
- PDF/DOCX 在有限内存的可终止 worker 中提取，解析限时 30 秒。扫描 PDF 提示需要 OCR；部分解析明确展示覆盖范围，不能默认声称全文读取。
- “添加资料”不会公开文件。“插入图片”才上传到配置的图床策略。Lsky 必须开启 API；Token 缓存放在插件运行数据中，不修改其他用户 Token。

## Typecho 桥接

将 [DshBlogBridge](typecho/DshBlogBridge/Plugin.php) 安装为 Typecho 插件并启用。启用时创建独立 InnoDB 回执表；不修改 Typecho 核心。接口为 `/action/dsh-blog-bridge`，仅接受固定 JSON 操作和 Typecho 原生账号认证。

公开版本与保存稿分开返回。提交使用版本比较、同连接事务及持久回执，客户端在超时后查回执，不盲目重复创建。编辑保留原文格式、自定义字段及既有开关。桥接调用原生文章 save/publish 组件，避免表单重定向和 ping；不执行依赖管理后台表单字段的主题写入回调。主题专属编辑行为需单独验证，不能从通用正文往返推断。

## 定时备份与恢复

备份执行器作为服务器独立 systemd 服务运行；不把 Docker socket、SSH 私钥或 root 数据库凭据挂进 DSH。阅读 [执行器说明](backup/README.md)，使用显式路径配置安装。API 仅监听回环地址并校验 Token；本部署依赖 DSH 使用 host 网络。

备份包含 Typecho、Lsky 数据库和网站文件、pelyblog 桶数据、工作台草稿、引用的官方附件，以及博客会话的官方日志和反馈。聊天快照需要执行器显式配置官方存储路径；旧备份缺少聊天组件且当前已有会话时拒绝恢复。恢复可选择隔离演练或生产恢复；生产恢复需输入备份 ID，再次校验原用户会话，先备份当前状态并保留旧目录和数据库。其他图床策略、其他插件会话和反馈不会被旧备份覆盖；共享引用或存储策略发生不兼容变化时拒绝恢复。

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
