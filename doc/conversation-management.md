# 会话管理

在 `/auth` 左侧选择“会话管理”，按业务插件查看本人对话。只展示当前登录用户拥有且仍有插件访问权限的记录；管理员也不自动获得其他用户的聊天。这里管理业务对话，不管理登录会话。

## 浏览与预览

按插件分类查看数量，按标题或会话 ID 搜索，按最近更新时间范围、状态筛选。每页 30、50 或 100 条，按更新时间倒序排列。分类数量是本人该插件待管理总数，表格数量包含当前筛选条件。

点击标题或“预览”打开右侧只读抽屉，默认查看最近 30 条消息，使用“加载更早消息”继续查看。用户提问和助手回答直接呈现，思考过程和工具信息默认折叠。预览不启动模型、不恢复执行任务、不更新会话时间。长消息会明确标注截断。关闭抽屉保留分页、筛选和勾选状态；“选中待删除”只勾选，不立即删除。

从业务应用继续已有对话时，example 按官方会话记录恢复模型选择；从某条消息创建分支时，按分支点之前的记录恢复。管理员修改新会话默认模型不会改写这些记录。会话管理页的只读预览也不会触发模型切换。

## 批量删除

勾选会话或“选择本页”后点击“删除所选”，核对弹窗中的插件和标题，再确认。一次仅提交当前插件的 1–100 个明确 ID，不跨页自动扩大删除范围。换插件、分页或修改筛选会清空选择。

删除意味着**移除插件历史入口并调用 DSH 官方归档**，不永久销毁底层记录、不释放日志磁盘空间。本页没有恢复入口，也不删除博客文章、业务记录、备份或独立分支。

运行中、正在创建分支或存在未完成操作的会话不能删除。系统会逐项显示删除结果，未完成项可刷新后重试；网络超时时显示“结果待核实”。即使插件已隐藏这条历史，只要 DSH 官方归档失败，整项删除就仍算未完成。

“仅插件已移除”表示旧版本已隐藏插件历史，但尚未完成官方归档，可在这里补做归档。“移除未完成”表示删除流程还没走完：系统保留会话所属用户（owner）的记录，并阻止继续写入。重试不会重复创建会话，升级也不会自动清空这些记录。

官方原生对话、standalone 模式记录及没有可信 owner 的历史不分配给当前账号。插件未接入时显示“未接入”；服务故障显示“暂不可用”，不能当成没有会话。

## 自动标题

example 新对话先显示首句的回退标题，再接收官方宿主提炼的简短标题。只按第一条提问自动生成一次，后续提问不会反复改名。宿主的标题请求可能晚于回答结束；失败时保留回退标题。插件复用这一结果，不重复发起标题模型请求；宿主辅助请求本身仍有模型用量，当前预算见[宿主接口](host-compatibility.md#插件接口)。

页面创建首个会话后立即刷新历史，只为当前新会话中等待自动标题的记录每 2 秒刷新一次，最多 65 秒。取得生成标题、手动改名、切换或新建会话后停止等待，不额外保持一条长期连接。超过等待时间的标题仍会保存，下一次刷新历史时可见。

手动重命名优先于自动结果；分支标题和升级前的既有标题也不会被自动覆盖。用户之后在应用或可信宿主中再次明确改名，可以更新已有手动标题。example 的历史索引自动迁移到 schema 4，用 `titleSource` 区分等待自动生成（`automatic`）、已生成（`generated`）和手动保护（`manual`）；消息正文仍由官方会话保存。

升级前结束写入并备份插件历史索引、官方会话和私有配置。仅支持到 schema 3 的旧版 example 会拒绝 schema 4；不提供自动降级，也不能手工降低 `user_version` 绕过检查。需要回退时按[数据迁移规则](migration.md)核对兼容性，从升级前一致备份恢复到独立目录，保留升级后数据供核验。

### 接入标题同步

从 `@dsh-plugin-manager/plugin-kit/conversations` 导入 `registerConversationTitles(ctx, accept)`，其中回调为 `(id, title, manual, complete) => void`，返回值用于取消监听。它在插件整个生命周期监听可信宿主的 `session/event`，不随一轮回答结束而释放。

只接收 `session/title`：用户来源 `source.kind=user` 表示明确改名；自动来源只接受 `fallback` 或 `provider`，且 `messageSeqs` 必须恰有一项。标题折叠空白、去除首尾空白，最长 100 个 Unicode 码点，空标题丢弃。`manual` 仅对 user 为 true，`complete` 仅对 user/provider 为 true。

回调收到的是宿主全局事件，插件必须只更新自己已有、owner 非空、已就绪、未删除且未在移除中的索引记录，不能据事件创建 owner 或恢复会话。example 仅允许自动结果更新 `automatic` 记录，provider 完成后标为 `generated`；可信 user 可以再次更新手动标题。HTTP 改名先持久化 `manual` 再同步已打开的宿主会话，晚到的自动结果不能覆盖它。当前回答的 SSE 可发送标题通知，回答结束后的标题由全局监听入库，前端复用历史刷新获取。

## 插件接入

从 `@dsh-plugin-manager/plugin-kit` 导入 `registerConversations`，通过 Cordis 生命周期注册 `{ protocol: 1, pluginId, list, preview, remove }`。pluginId 必须与插件目录和授权标识一致。

auth 提供受保护的 `GET /auth/api/conversation-plugins`、`GET /auth/api/conversations`、`GET /auth/api/conversations/preview` 和 `POST /auth/api/conversations/remove`。POST 沿用 Origin、Cookie 和 CSRF 校验。用户身份只由服务端 Actor 提供，插件在操作前后重新校验授权与 owner。

`list(actor, query)` 返回 `{ items, total, nextOffset }`；query 为 offset、limit、q、from、to、state，时间区间为 `[from,to)`。统一摘要包含 id、title、updatedAt、state、canRemove 及可选 blockedReason，不携带正文。

`preview(actor, id, before?)` 返回 `{ messages, previousBefore, total }`。通过 `readConversationEvents` 或官方只读句柄（read handle）读取日志，再用插件已有的消息转换逻辑（投影）整理成用户可见消息。不能返回配置、凭据或原始内部事件。`previewPage` 按消息位置向前分页。查询和返回前都校验权限，预览不恢复 Agent。

`remove(actor, ids)` 使用 `conversationRemover`，逐项返回 removed、alreadyRemoved、blocked 或 failed。索引适配器提供 `record` 和 `mark`；`record` 也要返回旧删除标记（tombstone）中的用户归属，以便确认谁有权补做归档。普通聊天的 assertOwner 仍须拒绝已标记删除或正在移除的会话。发送、恢复、创建分支及其他修改操作都要遵守这一检查。

移除时先写入 pending 标记，阻止新的写入，再释放空闲句柄，等待官方 `ctx.workspaceRegistry.archiveSession` 完成，最后更新插件的删除标记。插件与官方存储不在同一个数据库事务中，出错时须保留进度供重试。归档服务由宿主提供，缺失时报告不可用。不得自行写入官方归档文件、让 auth 扫描业务数据库，或把所有用户的归档列表发给浏览器。

公共实现和可复制示例见 `packages/plugin-kit/src/conversations.ts`、`plugins/dsh-auth/src/http.ts`、`plugins/dsh-example/src/index.ts` 和 `src/history.ts`。各业务插件自行维护 owner 索引、查询 SQL、预览投影与活动任务检查。
