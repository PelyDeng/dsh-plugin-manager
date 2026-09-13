# 牛马大总管（dsh-butler-console）

DSH 生态里的智能体群聊。你当老板，牛马大总管负责听懂你的目标、把活拆开、在群里 @ 对应的
成员，各成员自己干活并实时把进度和结果说出来，最后牛马大总管汇总交差。

界面参考飞书群聊的形态，但画风是手绘涂鸦：奶油纸底、歪边框、贴纸和小涂鸦。做成这样
是有意的 —— 这是个「我说了算」的地方，不该长得像公司内部工具。

## 群里有什么

- **左栏**：派活记录。会话标题取用户的第一句提问（由宿主首句标题服务生成），每行还带
  最新一条消息预览，所以一眼能看出这次派的是什么活。可搜索、可切换。
- **中栏**：群聊。你的话右对齐，牛马大总管和每位成员各占一个气泡，头像与名字颜色区分身份。
  顶部一条协同链路：`老板发话 → 牛马大总管听懂 → 派活 → 牛马干活 → 交差`。
- **右栏**：牛马档案。给每位成员改外号、换头像、挑配色；下面是状态计数与最近的失败记录。
- 窄屏下右栏收成抽屉、左栏收成侧边栏，主要流程仍然可用。

页面不做服务器发布、插件安装和版本升级 —— 那些归 DSH Plugin Manager。

## 职责边界

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| 牛马大总管 | 听懂、拆解、分发、汇总 | 决定成员用什么工具 |
| 成员（子 Agent） | 自己完成任务、自己调用工具、自己输出进度 | 决定别人怎么做 |
| 本插件 | 展示状态、保存历史、转发回复 | 改写宿主会话日志 |

边界在代码里是强制的：牛马大总管只注册一个 `butler_plan` 工具，不创建也不释放成员 Agent —— 成员
由各自插件在收到派单时创建，牛马大总管没有那条代码路径。

它能直接调用的工具只有**通用工具**（分类标签 `通用工具` 的公共集，例如天气查询），所以它没有
能力绕过计划去执行任何业务查询。这段限制有三条不显然的约束，写错都会让牛马大总管整轮失效：

- **只能限制全局工具名**。`butler_plan` 注册在本 Agent 作用域里，把它写进
  `restrict({ allow })` 会以 `names unknown global tool` 直接失败；局部工具本来就只对这个
  Agent 可见，不必列入。
- **不能拿空 allow 去限制**。`allow: []` 会遮蔽**所有**工具，连 `butler_plan` 都没有，牛马大总管于是
  连计划都提交不了。目录读不到时宁可不施加限制 —— 最坏是多看到几个工具，仍受提示词与鉴权约束。
- **必须在 agent 作用域里限制**。插件级 `restrict` 会波及所有 Agent，宿主直接拒绝。

从目录实时读而不是写死名单：新增通用工具时牛马大总管自动就能用，不需要改这里。

## 怎么接一个新成员

**这是本插件最重要的扩展点：新增 Agent 不需要改本插件的代码。**

名单每次都从插件目录（kit 的 `ecosystem/catalog`）实时读，所以插件装上就出现。能不能
接活、能接什么活，由插件自己声明：

```ts
import type { ButlerAgentExecutor } from 'dsh-butler-console'

ctx.effect(() => ctx.on('butler/executors', (accept: (executor: ButlerAgentExecutor) => void) => {
  accept({
    protocol: 1,
    agentId: 'closedoff',                       // 必须与 deepseekPlugin.id 一致
    capabilities: ['园区数据查询', '车辆轨迹'],   // 牛马大总管据此决定把什么活派给你
    async dispatch(request) {
      request.onProgress?.({ stage: '翻资料', phase: 'tool', tool: '查询通行记录' })
      const answer = await runMyOwnAgent(request.brief, {
        signal: request.signal,
        onText: chunk => request.onProgress?.({ delta: chunk, stage: '说话' }),
      })
      return { status: 'succeeded', summary: answer, conversationId: 'closedoff-web-…' }
    },
    // 可选：想被中途追问就实现它
    async reply(request) {
      return { status: 'succeeded', summary: await answerFollowUp(request.text) }
    },
  })
}, { global: true }))
```

要点：

- `capabilities` 会写进牛马大总管的提示词，所以牛马大总管**只在你声明的范围内派活**，不会猜。
- 没声明 `capabilities` 就表示「什么都能接」，牛马大总管按子任务语义自行判断。
- `stage` 是必填的状态行，页面就显示这一句。跨插件载荷缺字段按空状态行处理（显示成「干活中」），不会把整轮打成失败 —— 但那样用户就看不出这一步在干什么，所以该给就给。
- `delta` 是**增量**：页面按到达顺序追加到同一条气泡里，不要每次发整段。
- `thinking` 是**完整覆盖**的可展示思考快照：页面用它替换该成员气泡里的思考行（默认收起，
  摘要只留最后一行）。内容由执行方自己脱敏，只放稳定语句与公开信息，不放原始推理与内部标识。
- 进度是**上报即产出**：`dispatch`／`reply` 还没返回，事件就已经送到页面，成员边干边出字；不需要为了流式去改返回时机。
- `needsReply: true` 让子任务进入 `waiting_user`，页面上就会出现回复框；用户回的内容
  会通过 `reply()` 交回给你。
- 没有登记执行入口的插件照样出现在右栏，只是标记为不在场，牛马大总管不会给它派活。

## 右侧「外号」为什么不改插件身份

右栏的昵称、头像、配色是**本地显示别名**：只覆盖你自己页面上的显示，按登录用户存储。
插件声明的 `displayName` 与 `id` 始终以次要文字保留在每个配置项下方（`插件声明：xxx`），
所以「页面上这个外号对应哪个插件」永远可追溯，也不会因为给某个 Agent 改名而破坏
「名单来自插件声明、不硬编码」这条约束。

## 配置

配置由管理器按实例 `plugin.json` 生成；字段全部有默认值，未配置时按默认运行。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accessMode` | `authenticated` | `standalone` 仅用于本机调试 |
| `publicOrigin` | 空 | 认证模式必填，HTTP(S) origin，不带路径 |
| `routePrefix` | `/butler` | 页面与接口前缀 |
| `subtaskTimeoutMs` | 300000 | 单个子任务超时，超时中止并释放成员 |
| `turnTimeoutMs` | 600000 | 单轮上限 |
| `maxMessageChars` | 8000 | 单条消息字符数上限 |
| `maxResultChars` | 8000 | 单个子任务结果写回页面的字符数上限 |
| `maxSubtasks` | 6 | 一次计划允许的子任务数 |
| `maxAvatarBytes` | 262144 | 成员头像大小上限 |
| `maxRequestBodyBytes` | 65536 | 请求体上限 |
| `maxActiveConversations` | 32 | 同时保留的会话数 |
| `maxHistoryPageSize` | 30 | 历史每页条数上限 |
| `maxConversationEvents` | 2000 | 每个会话最多保留的事件条数，供断线续传与第二个入口回放 |
| `idempotencyTtlMs` | 600000 | 写请求的幂等记录保留多久；记录只在内存里 |

## 接口

除公开探针外，所有路由每次访问都重新核对登录身份。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/butler/health`、`/butler/ready` | 存活与就绪探针，公开 |
| GET | `/butler` | 群聊页面 |
| POST | `/butler/chat` | 派活，SSE 事件流 |
| GET | `/butler/events` | **只读**订阅一个会话最近一轮的事件，可多入口同时观察 |
| POST | `/butler/reply` | 回应正在等你的成员，SSE 事件流 |
| POST | `/butler/stop` | 喊停当前这一轮，可带 `taskId` 精确到某个任务 |
| GET | `/butler/members` | 群成员（含别名与能力声明） |
| POST | `/butler/members/alias` | 保存外号与配色；空值恢复默认 |
| POST/DELETE | `/butler/members/avatar` | 上传或删除成员头像 |
| GET | `/butler/members/avatar?agentId=` | 读取成员头像；按当前登录用户鉴权，不能靠猜 id 读到别人的 |
| GET | `/butler/members/avatar` | 读取成员头像，按登录用户鉴权 |
| GET | `/butler/overview` | 状态计数与最近失败 |
| GET | `/butler/conversations` | 派活记录 |
| GET | `/butler/history` | 运行历史分页 |
| GET | `/butler/task` | 单次任务的完整记录 |
| GET | `/butler/models` | 宿主模型目录 |

`/butler/chat` 与 `/butler/reply` 的 SSE 事件类型：`conversation`、`user`、`chat`、`chat_delta`、
`plan`、`subtask`、`subtask_delta`、`subtask_thinking`、`summary`、`error`，以 `[DONE]` 结束。
`/butler/events` 还会先给一条 `run`（这一轮的头部）；游标接不上时给 `reset`。

牛马大总管自己的发言也是边收边上的：`chat_delta` 开一条气泡并逐段追加，回合结束时到达的
`chat` 用它落定后的正文**替换**预览，所以被重试掉的那一版不会留在页面上。

### 执行与观察是分开的

提交之后，任务在服务端跑，事件写进该会话的事件日志，`/chat` 那条连接只是众多观察者之一。

- **关掉页面不等于取消。** 断开连接只结束这一次观察；想停下来要显式调 `/stop`。
- **同一轮可以被多方同时观察。** `/butler/events?conversationId=…` 是只读的，新增观察者不会
  重跑任务；第二个入口、刷新后的页面都用它接上。
- **每条事件都带 `seq`**，会话内从 1 单调递增。带着上次收到的 `seq` 用 `?after=` 续传。
  游标已经滚出窗口时返回 `reset`，这时应当重新读 `/butler/task?id=` 取快照 —— 中间的事件
  确实没有了，接口不会假装补齐。
- 不传 `after` 表示只看从现在开始的新事件。

`/butler/stop` 接受可选的 `taskId`：只有当前这一轮确实在跑那个任务时才中止，旧任务迟到的
取消请求不会碰到该会话随后开的新任务。响应里的 `accepted` 只表示中止请求已经发出，
执行方是否真的停下要看后续状态。

`/butler/chat` 与 `/butler/reply` 接受可选的 `requestId`：同一登录身份下重复提交同一个 id
只会执行一次，重试拿回的是同一轮的凭据；同一个 id 换了正文则返回 `409`。不带 `requestId` 时
每次提交都是新的一轮。这份记录只在内存里、默认保留十分钟，挡的是网络重试与连点两次。

## 状态语义

子任务状态：`queued`、`dispatched`、`running`、`waiting_user`、`external_pending`、
`succeeded`、`failed`、`cancelled`；任务状态另含 `summarizing`、`completed`。合法迁移定义在
`src/task-model.ts`，非法迁移会被拒绝。

`waiting_user` 与 `external_pending` 是两种不同的「没办完」，不合并：

| 状态 | 在等什么 | 这一轮 |
| --- | --- | --- |
| `waiting_user` | 用户在**这里**补一句话 | 停住等回复，不补就进行不下去 |
| `external_pending` | 用户去**别处**办（原页面采用、确认、发布） | 到此结束，可以开新活；**不是成功** |

判定来源只有一个：成员返回的结构化声明 `externalPending`。管家**不解析正文措辞**，也不因为
「结果里带着材料」就自行把这一轮当成可以在外部收尾。声明缺失或没写清在等什么时记
`protocol_error` 式的失败并保留材料，而不是替它编一个外部事项。

成员交回的材料（正文、`artifacts` 引用、原会话标识）与待办理由一起落在子任务记录上，
`/butler/task` 读得到。

页面上的每个状态都能追到一次真实事件：`plan` 事件点上「牛马大总管听懂」，「派活」来自
`subtask.dispatched`，「牛马干活」来自 `subtask.running` 或执行方上报的
`phase: 'tool'`，「交差」来自汇总轮结束。状态先写库再上报，刷新后重建结果一致。

进程异常退出时，上次遗留的执行中任务会在下次启动收敛为失败，不会永远转圈。
`external_pending` 是终态，不会被这次收敛改写。

## 数据放在哪里

工作台索引在 DSH home 下的 `plugins/butler/butler.sqlite`：会话归属、任务计划、子任务
状态、材料引用、成员别名与头像。牛马大总管与用户的对话正文仍然存放在 DSH 官方会话日志里，本插件不复制
一份，也不改写宿主日志。

数据结构版本目前是 **2**（子任务增加材料引用与原会话两列）。旧库在启动时就地增列，已有数据不动；
但**旧版本代码读到新版本会拒绝启动**，所以回滚插件版本之前要先把库降回去，不能直接换回旧包。

## 本地开发

```sh
pnpm install                      # 首次新增插件后需要，用于写入 workspace 锁
pnpm list:plugins                 # 应看到 butler 一行
pnpm build --plugins "butler"
pnpm check --plugins "butler"
pnpm test --filter dsh-butler-console
```

纳入源码部署选集时，在私有 `.local/env.conf` 的 `DSH_PLUGINS` 里加入 `butler`（不要改
公开的根 `env.conf`）。发版到服务器需要用户明确要求后才执行。
