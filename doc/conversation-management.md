# 会话管理

在 `/auth` 左侧选择“会话管理”，按业务插件查看本人对话。只展示当前登录用户拥有且仍有插件访问权限的记录；管理员也不自动获得其他用户的聊天。这里管理业务对话，不管理登录会话。

## 浏览与预览

按插件分类查看数量，按标题或会话 ID 搜索，按最近更新时间范围、状态筛选。每页 30、50 或 100 条，按更新时间倒序排列。分类数量是本人该插件待管理总数，表格数量包含当前筛选条件。

点击标题或“预览”打开右侧只读抽屉，默认查看最近 30 条消息，使用“加载更早消息”继续查看。用户提问和助手回答直接呈现，思考过程和工具信息默认折叠。预览不启动模型、不恢复执行任务、不更新会话时间。长消息会明确标注截断。关闭抽屉保留分页、筛选和勾选状态；“选中待删除”只勾选，不立即删除。

## 批量删除

勾选会话或“选择本页”后点击“删除所选”，核对弹窗中的插件和标题，再确认。一次仅提交当前插件的 1–100 个明确 ID，不跨页自动扩大删除范围。换插件、分页或修改筛选会清空选择。

删除意味着**移除插件历史入口并调用 DSH 官方归档**，不永久销毁底层记录、不释放日志磁盘空间。本页没有恢复入口，也不删除博客文章、业务记录、备份或独立分支。

运行中、正在创建分支或存在未完成操作的会话会被阻止。部分成功会逐项报告，未完成项可刷新后重试；网络超时显示结果待核实。官方归档失败不会被降级为成功的插件隐藏。

“仅插件已移除”表示旧版本已隐藏插件历史、但尚未同步官方归档，可在这里补齐清理。“移除未完成”表示状态尚未收敛，保留 owner 证据和禁止写入标记，重试不会重复创建会话。升级不会自动清空这些记录。

官方原生对话、standalone 模式记录及没有可信 owner 的历史不分配给当前账号。插件未接入时显示“未接入”；服务故障显示“暂不可用”，不能当成没有会话。

## 插件接入

从 `@dsh-plugin-manager/plugin-kit` 导入 `registerConversations`，通过 Cordis 生命周期注册 `{ protocol: 1, pluginId, list, preview, remove }`。pluginId 必须与插件目录和授权标识一致。

auth 提供受保护的 `GET /auth/api/conversation-plugins`、`GET /auth/api/conversations`、`GET /auth/api/conversations/preview` 和 `POST /auth/api/conversations/remove`。POST 沿用 Origin、Cookie 和 CSRF 校验。用户身份只由服务端 Actor 提供，插件在操作前后重新校验授权与 owner。

`list(actor, query)` 返回 `{ items, total, nextOffset }`；query 为 offset、limit、q、from、to、state，时间区间为 `[from,to)`。统一摘要包含 id、title、updatedAt、state、canRemove 及可选 blockedReason，不携带正文。

`preview(actor, id, before?)` 返回 `{ messages, previousBefore, total }`。只读日志通过 `readConversationEvents` 或官方 read handle 获取；用插件现有投影生成用户可见消息，不能回传配置、凭据或原始内部事件。`previewPage` 按消息位置向前分页。查询和返回前都校验权限，不用预览恢复 Agent。

`remove(actor, ids)` 使用 `conversationRemover`，返回逐项 removed、alreadyRemoved、blocked 或 failed。索引适配器提供 `record` 和 `mark`；`record` 包含旧 tombstone 的 owner 证据，普通聊天的 assertOwner 仍必须排除 tombstone 和移除阶段。发送、恢复、分支及其他变更入口共用这份生命周期约束。

移除过程先写入 pending 围栏，释放空闲句柄，等待官方 `ctx.workspaceRegistry.archiveSession`，然后完成插件标记。异常保留可重试状态；两侧存储没有跨库事务。官方服务是宿主的外部依赖，缺失时报告不可用。不得另写官方归档文件、让 auth 扫描业务数据库，或将全局归档集合发给浏览器。

公共实现和可复制示例见 `packages/plugin-kit/src/conversations.ts`、`plugins/dsh-auth/src/http.ts`、`plugins/dsh-example/src/index.ts` 和 `src/history.ts`。各业务插件自行维护 owner 索引、查询 SQL、预览投影与活动任务检查。
