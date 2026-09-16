# 智能体群组（dsh-agents-group）

DSH 生态里的智能体群组。多个业务智能体合在一个插件项目里统一分包管理，共享一份公共
组件包；但**每个智能体仍然各自是一条独立条目**，有自己的页面地址、授权开关和会话管理。

这样做的目的：不再为每个新智能体单独维护一个插件项目，同时不牺牲「谁能访问哪个智能体」
这条权限边界。

> 当前状态：**两个业务智能体已迁入**（封闭化、博客），各自页面与授权独立。群组根
> `/agents` 的总览页尚未实现；模型白名单与工具分类分组也待做（见实施计划 P3–P5）。
> 尚未在真实宿主做端到端验证。

## 目录结构

```
plugins/external/dsh-agents-group/
├── package.json             # 群组的 DSH 声明（包 id = agents-group）
├── cordis.patch.yml         # Bundle 默认配置
├── dev/dev-hmr.patch.yml    # 开发期热重载（群组级统一开发根）
├── config/group.example.json# 业务配置模板；实际文件用 AGENTS_GROUP_CONFIG 指向
├── config/storage.example.json # 业务存储（PostgreSQL）配置模板；见「业务存储配置与迁移」
├── scripts/hmr-observer.mjs # 开发期工具，不随归档交付
├── scripts/migrate-blog-storage.ts # 存量迁移工具，构建成 dist/migrate-blog-storage.mjs
├── src/
│   ├── index.ts             # 群组装配：登记自身条目、装载各 Agent、挂探针
│   ├── host.ts              # 装载与失败隔离、就绪判定
│   ├── config.ts            # 群组 Config Schema
│   └── agents/
│       ├── registry.ts      # ★ Agent 静态清单与端点推导
│       ├── closedoff.ts     # 封闭化的装载适配层
│       └── blog.ts          # 博客的装载适配层
├── agents/                  # ★ 各 Agent 的实体，独立 pnpm 子包
│   ├── closedoff/           # @dsh-agents-group/closedoff
│   └── blog/                # @dsh-agents-group/blog（migrations/postgres/ 是业务库建表 SQL）
├── packages/common/         # ★ 群组内部共享组件包，构建期内联
└── tests/
```

## 两条必须理解的约定

### 1. 路径、权限、id 由同一处推导

每个 Agent 的三样东西不允许各处手写，否则会出现「授权了但页面进不去」或「会话管理找不到
provider」这类难查的问题。它们统一由 `endpointsOf()` 从 id 推导：

| 用途 | 形式 | 例子 |
| --- | --- | --- |
| 目录条目 id / 授权标识 / 会话管理 key | `<id>` | `closedoff` |
| 页面地址 | `<群组前缀>/<id>` | `/agents/closedoff` |
| 权限标识 | `<id>:access` | `closedoff:access` |

**目录条目 id 在整个 DSH 里必须唯一。** 所以迁移期新旧插件不能同时启用 —— 都注册
`closedoff` 会直接 `插件重复登记`，站点起不来。迁移是「关旧的、开新的」切换式。

### 2. `AGENT_MANIFESTS` 是唯一的名单

`src/agents/registry.ts` 里那份静态数组就是群组认识的全部 Agent。新增一个 Agent 只需要
在这里加一条，**牛马大总管（dsh-butler-console）那边不用改** —— 牛马大总管按「一个 Agent 一个执行
入口」工作，两条条目天然被识别成两个成员。

用静态清单而不是扫描目录：构建产物要可树摇、类型要可检查、装载顺序要确定，动态扫描在
打包后不可靠。

## 当前群组里的 Agent

| id | 显示名 | 页面 | 权限 | 说明 |
| --- | --- | --- | --- | --- |
| `closedoff` | 封闭化管理智能助手 | `/agents/closedoff` | `closedoff:access` | 园区业务查询、车辆轨迹、三维可视化 |
| `blog` | 博客智能体 | `/agents/blog` | `blog:access` | 写作、发布、图床、备份；**强制认证** |

`blog` 在清单里标了 `requiresAuthentication`：它的业务前提是必须可信身份（按用户隔离草稿、
附件与备份），所以即使在 standalone 模式的群里也会拿到 `authenticated` 的访问校验。缺提供者时
它照常挂载、路由照常注册，请求时才以「认证服务不可用」失败 —— 这样运维能看出是谁在那儿，
而不是子包凭空消失。

探针：群组级 `/agents/health`、`/agents/ready`（正文列出每个 Agent 的状态），
以及每个 Agent 自己的 `/agents/<id>/ready`。子包不再注册探针。

## 工具分类与可见性限制

每个 Agent **只能调用属于自己标签的工具，外加约定好的通用工具集**。这条限制是硬限制，用
`tools.restrict` 实现 —— 只在认证页面隐藏分类拦不住模型直接调用工具名。

| 概念 | 值 | 说明 |
| --- | --- | --- |
| 通用工具标签 | `通用工具` | 由 kit 的 `UNIVERSAL_TOOL_CATEGORY` 定义，每个 Agent 都能调 |
| 封闭化标签 | `封闭化园区` | 与清单里的 `category` 一致 |
| 博客标签 | `博客工作台` | 同上 |

**分类只有一个权威来源。** 子包注册工具用的标签由群组从 `AGENT_MANIFESTS[i].category`
注入（`AgentMountContext.category`），子包不自己写字符串。两处各写一份会漂移，而漂移的后果是
**该 Agent 的工具全部对它自己不可见**，且这种失效在界面上完全看不出来。

可见性列表由 `toolsForCategory(全部条目, 本分类)` 算出，规则是「本分类 + 通用集」。两个容易
写错的地方：通用集必须并进来（否则 Agent 连天气都查不了）；**未分类的工具不自动放行** ——
把它们悄悄塞给每个 Agent 会让限制形同虚设。

子包装载时必须在返回值里如实带上 `tools`，群组靠它算限制；漏报会让对应工具对该 Agent 不可见。

## 通用工具

通用工具是约定好的公共集，不依赖任何单一 Agent 的业务数据、也不需要额外凭据，所以可以安全地
全局可见。当前一个：

| 工具 | 说明 |
| --- | --- |
| `common_weather` | 按省、市、区县名查询当前天气与 1–7 天预报 |

数据源是 Open-Meteo，**不需要 API Key** —— 群组因此不必引入凭据管理，也就没有密钥泄漏面。

实测确认了数据源的三条真实行为，都在实现里做了处理：

| 行为 | 处理方式 |
| --- | --- |
| 按**专名**匹配：「重庆市」「四川省」直接查是零结果，「重庆」「成都」才行 | 先按原样查，再去掉末尾行政区划通名重试；按去后缀才命中时会提示标准写法 |
| **没有省级条目**：「四川」查不到 | 回退到省会取代表点，并在结果里明确写出「这不是全省数据」 |
| **只收录城镇，不覆盖全部市辖区**：北京朝阳区查不到 | 如实报「没找到」，不拿同名异地顶上 |

第二条尤其不能省：省内南北温差可能很大，让使用者以为拿到了全省天气是错的。第三条的典型
表现是同名行政区 —— 数据源里有重庆的「朝阳」，但没有北京朝阳区；这时用 `region` 限定后
如实报错，比静默给一个别处的天气安全得多。

新增通用工具只需在 `src/tools/` 写定义、在群组 `apply()` 里注册并传
`UNIVERSAL_TOOL_CATEGORY`：所有 Agent 与牛马大总管都会自动获得它，不需要改它们的代码（牛马大总管是按
标签从目录实时筛选的）。

## 新增一个 Agent 的步骤

1. 建子包 `agents/<id>/`，包名 `@dsh-agents-group/<id>`，**不要声明 `deepseekPlugin`**
   （声明了就会变成独立插件）。
2. 在 `src/agents/registry.ts` 的 `AGENT_MANIFESTS` 加一条。
3. 写适配层 `src/agents/<id>.ts`，导出 `mount(context)`：
   用 `context.access` 做访问校验、`context.http` 注册路由、`registerPlugin()` 登记目录条目、
   `registerConversations()` 注册会话管理 provider。**id、路径、权限都从
   `endpointsOf()` 取，不要手写。**
4. 子包在 `mount()` 的返回值里必须带上两样东西，**漏一样都会静默失效**：
   - `tools`：本次注册的工具条目，用 `context.category` 作为分类标签。漏了分类，该 Agent
     的工具会全部对它自己不可见。
   - `participant`：协作参与者（`AgentParticipant`）。群组把它桥接成牛马大总管的执行入口；漏了
     这位 Agent 在牛马大总管名单里会变成「不可调度」，牛马大总管于是不会把专业活派给它。
     参与者的进度由 `src/butler-bridge.ts` 翻译：状态正文从 `text` 改名成对方必读的 `stage`
     （少了它对方会拿 undefined 去压平空白，整轮子任务当场失败），`delta` 与 `thinking` 原样搬。
     两边靠**字段名**对齐、不互相导入源码，所以改任一侧的字段都要同时改桥接与
     `tests/butler-progress-contract.test.ts`。
5. 在 `src/index.ts` 的 `loadAgent()` 里加一个 `case`。
6. 跑 `pnpm install`（写入 workspace 锁）、`pnpm check --external --plugins "agents-group"`、`pnpm test`。
7. **打包一次并检查归档**（`pnpm package --external --plugins "agents-group"`）：子包在运行时读取的文件
   （人格文件、`runtime/`、`web/`）必须都在归档里。这一步不能省 —— 「不入库」与「不随包发布」
   是两件事，而漏文件的后果是装载期直接抛错、站点起不来。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `accessMode` | `authenticated` | `standalone` 仅用于本机调试 |
| `publicOrigin` | 空 | 认证模式必填，HTTP(S) origin，不带路径 |
| `routePrefix` | `/agents` | 群组根前缀；各 Agent 是它的子路径 |
| `authRecheckMs` | 1000 | 认证复核间隔 |
| `agents.<id>.enabled` | true | 是否装载该 Agent |
| `agents.<id>.models.allow / .deny` | 空 | 模型白名单，留空＝不过滤 |

业务凭据走群组级 `runtimeConfig` 文件（`AGENTS_GROUP_CONFIG` 指向），不进 Git、不进镜像。

### 关于模型白名单这个代价

宿主的模型目录是**全局扁平的**，没有 scope 机制：provider 一旦注册，全进程可见。所以
「只让某个 Agent 看到某些模型」只能在群组侧过滤，白名单由**我们自己维护**，宿主新增
provider 时不会自动生效。

## 业务存储配置与迁移

博客的业务数据（草稿、写作任务、操作记录、审计、附件记录、译文留档）只存在 PostgreSQL
一种后端（Q4 口径）。索引库——会话、对话请求与结果、协作映射——仍是各自的 `blog.sqlite`，
与业务存储无关。

**缺配置或运行中连不上都算「blog 未就绪」，不算群组装载失败**：页面、目录条目、参与者照常
注册，群组探针照常在线，博客的业务端点以稳定错误码拒绝（PG 不可达是 503 + `storage_unreachable`），
`/agents/blog/ready` 正文写明原因与配置方法。**绝不静默回退 SQLite。**

### PostgreSQL 配置（三路来源，按优先级）

1. 环境变量 `AGENTS_GROUP_PG_DSN`：直接给连接串（开发/测试最方便）。
2. 私有配置文件 + 环境变量 `AGENTS_GROUP_PG_CONFIG` 指向它：文件内容形如
   `{"dsn":"postgresql://用户:密码@主机:5432/库名"}`。
3. 都没设时的缺省路径：`<DSH 主目录>/plugins/agents-group/storage.json`（存在才读，格式同上）。

模板见 `config/storage.example.json`（复制后填写，不要提交 Git）。凭据只走环境变量与私有
文件，**绝不写进 cordis 配置或 `plugin.json`**。注意：群组 manifest 的 `runtimeConfig` 槽位
已被 `AGENTS_GROUP_CONFIG`（`config/group.example.json`）占用，所以存储配置**不由管理器挂载
模板**——它是手写的私有文件或环境变量。每组独立数据库与独立运行账号，库内表按插件前缀平铺
（博客用 `blog_` 前缀），将来其他 Agent 迁入各管各的表与版本行。

### 初始化结构

对空库执行一次 `agents/blog/migrations/postgres/0001_init.sql`（迁移工具会自动完成，也可以
`psql -f` 手动执行）。版本行随建表写进 `blog_schema_version`；插件启动只核验版本，缺表或
版本不符即拒绝读写，不自动建表、不自动改版本。

### 存量迁移（SQLite → PostgreSQL）

拆库前 `blog.sqlite` 里的业务 5 表与译文库 `reasoning-translations.sqlite` 用一次性工具
`dist/migrate-blog-storage.mjs` 迁移（pg 驱动已打进产物，归档内可直接 `node` 运行）：

```sh
node dist/migrate-blog-storage.mjs --blog <旧 blog.sqlite 路径> [--translations <译文库路径>] \
  --dsn <目标 DSN> [--dry-run] [--clear-source --backup <快照路径>]
# DSN 也可以用环境变量 AGENTS_GROUP_MIGRATE_PG_DSN 传
```

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功（`--dry-run` 为盘点与校验完成、未写入；源库业务表已清时同样 0，并提示无需迁移） |
| 1 | 参数、连接、导入后校验、备份或清源失败 |
| 2 | 源库无法识别：业务 5 表只存在一部分，或表在但列不齐 |
| 3 | 目标库不是空库、结构版本不符，或有表却没有版本行 |
| 4 | 停写点复核失败：导入期间（或导入后、清源前）源库又有写入，导入已整体回滚 / 清源被拒绝 |

行为要点：

- 源库**只读**打开；业务 5 表全不存在 = 已迁移或无需迁移（退出码 0，连 DSN 都不用给）。
- 索引 3 表（conversations/chat_requests/chat_results）与协作映射表
  （pirate_blog_conversations）**迁后仍留在 `blog.sqlite` 里当索引库**：导入不读它们，清源
  不动它们，清源前后逐表核对行数。
- SQLite 的隐式 rowid 序在目标里显式化为 `seq`：jobs/operations/attachments/translations 用
  源 rowid 当 seq，audit 用源 rowid 当 id。导入后工具把五个 BIGSERIAL 序列 setval 到各自
  最大值（空表复位成「首次插入得 1」）——不复位的话，后续不带该列的 INSERT 会从 1 开始撞
  UNIQUE。
- 建结构、导入、导入后校验（版本行、逐表行数、主键集合、逐列校验和、记录身份 spot check）
  与序列复位都在**同一个 PG 事务**里；COMMIT 前复核源库指纹，不一致就整体回滚、目标库保持空。
- 报告会列出**人工核对清单**：jobs 里 queued/running、attachments 里 uploading/parsing 的
  id 与 owner。迁移不改这些状态；切换后首次启动的恢复序列会把它们收成 failed（任务记
  「服务已重启」，附件记「解析已中断，请移除后重新上传」）——要等它们跑完就先别切。
- `--translations` 省略时，若 `blog.sqlite` 同目录存在 `reasoning-translations.sqlite`，工具
  只提示、不导入译文（译文是派生缓存，重问即可再生成）。

### 停写、清源与回滚边界

生产按「停插件写入口 → `--dry-run` 预演 → 备份先行 → 导入 → 校验 → `--clear-source` → 切
配置」执行。`--clear-source` 必须先给 `--backup`：工具用 `VACUUM INTO` 出一致快照（**不裸拷
主文件与 WAL**），当场只读打开核验各表行数，再用单事务 DROP 业务 5 表；快照路径已存在时拒绝
覆盖。清源前工具会二次核对业务表清单与停写指纹——导入提交之后源库又被写入就拒绝清源，源库
原样保留。

回滚边界：**清源后 `blog.sqlite` 只剩索引表**，回退到 SQLite = 从停写快照**整库恢复**（索引
一并回退）或保持新版修复 PG——**不支持只回业务表**（业务表已不在源库，只在快照里）。切换后
PG 一旦接受新写入，就不再支持无损快速切回。

整库恢复的做法（少一步就会把业务表再次抹掉）：停宿主 → **先删除 `blog.sqlite-wal` 与
`blog.sqlite-shm`**（残留 WAL 会在新主文件上重放旧的 DROP 事务——本仓演练实测）→ 再用快照
覆盖 `blog.sqlite` → 打开核对 9 张表与行数。

#### 清源失败后的人工收尾

清源被拒（快照路径冲突、快照校验失败、清源前复核发现源库又被写入）时：**目标库已导入且非
空**，源库业务表原样保留；同一命令不能再跑一遍（导入会被退出码 3 拒绝）。两步收尾：

1. 先处置那批「导入后写入」——重导到目标库或人工合并，确认源库无事可做；
2. 手工清源（任选 SQLite 客户端，含 `node:sqlite`；**先自行出一致快照**，与工具同款）：

```sql
-- 1) 一致快照（不要裸拷主文件 + WAL）
VACUUM INTO '<快照路径>';
-- 2) 单事务清业务 5 表，索引 3 表与协作映射表保持不动
BEGIN IMMEDIATE;
DROP TABLE drafts;
DROP TABLE jobs;
DROP TABLE operations;
DROP TABLE audit;
DROP TABLE attachments;
COMMIT;
```

清源后回滚同样只能走「停写快照整库恢复」——不支持只回业务表。

## 探针

| 地址 | 含义 |
| --- | --- |
| `GET /agents/health` | 群组进程存活 |
| `GET /agents/ready` | 群组就绪；正文列出每个 Agent 的状态 |

**只要有一个 Agent 就绪就返回 200。** 如果任一 Agent 配置错就让整组 503，会把「某一个
Agent 挂了」升级成「全部不可用」，运维上更难判断。一个都没起来才算不就绪。

## 开发模式

群组只有一个 `development.rootVariable`（管理器要求变量名全局唯一），所以用同一个开发根
覆盖全部 Agent：`AGENTS_GROUP_DEV_ROOT`。`dev/dev-hmr.patch.yml` 里列出各子包的 `dist`，
改哪个、重建哪个，对应模块就会重载，不用重启服务。

## 本地命令

```sh
pnpm install                              # 首次或新增子包后，写入 workspace 锁
pnpm list:plugins --external                # 应看到 agents-group 一行
pnpm check --external --plugins "agents-group"
pnpm test --filter dsh-agents-group
```

纳入源码部署选集时，在私有 `.local/env.conf` 的 `DSH_PLUGINS` 里加入 `agents-group`
（不要改公开的根 `env.conf`）。发版到服务器需要用户明确要求后才执行。
