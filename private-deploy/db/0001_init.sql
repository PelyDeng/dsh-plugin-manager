-- 牛马生态单库 `dsh` 初始 DDL（v1，一次性建库）。
--
-- 用途
--   在空库（或与目标库同名、但尚无任何 `butler_` / `blog_` / `closedoff_` / `dsh_` 表的新库）里
--   一次建出全部 15 张表、20 个显式 `CREATE INDEX`，并在结尾写入 `dsh_schema_versions` 四行
--   （`butler` / `blog` / `closedoff` / `runtime` = 1）。
--   表与列逐字取自《牛马生态数据库重构设计》§5（§5.1 框架级、§5.2 管家、§5.3 会话索引与轮次幂等、
--   §5.4 blog 业务表）——**本文件是那份 DDL 的落地，不在这里做设计决策**。
--
-- ⚠️ 与 §5 唯一的顺序差异（必需，不是可选）
--   §5 按"框架 → 管家 → 会话索引 → blog"的**叙述顺序**给 DDL，但外键要求**被引用表先存在**：
--   `butler_tasks.conversation_id` 指向 `dsh_conversations`，而后者在 §5.3 才定义。按 §5 的
--   叙述顺序执行会报 `42P01: relation "dsh_conversations" does not exist`（已在本机 PG18 实测）。
--   因此本文件把**建表顺序**调整为「被引用者在前」，**表、列、索引、约束一字未改**：
--     ① `dsh_schema_versions`（§5.1）→ ② 三张框架表（§5.3）→ ③ 管家五表（§5.2）→ ④ blog 六表（§5.4）。
--   本文件已改用这个顺序；`blog_attachments` 的两个外键（草稿 / 会话）也因此都能落地。
--
-- 执行方式
--   推荐：`node private-deploy/db/create.mjs`（读 DSH_PG_DSN，入库不存在则先 CREATE DATABASE）。
--   等价的手工方式（DSH_APPLIED_AT 传 `Date.now()` 的毫秒值，缺省 0）：
--     psql "$DSH_PG_DSN" -v ON_ERROR_STOP=1 -v applied_at="$DSH_APPLIED_AT" \
--          -f private-deploy/db/0001_init.sql
--   整个文件是**一个事务**（首尾 `BEGIN;` / `COMMIT;`）：要么 15 张表全部建出，要么一行不改。
--   `:applied_at` 是**唯一的占位符**——psql 用 `-v` 供给；`create.mjs` 在执行前把它替换成
--   `Date.now()` 的字面量（它是数字，替换后仍是合法 SQL，文件本身因此可以原样用 psql 跑）。
--
-- 只建一次；不自动建表
--   1. 这是**建库脚本**，不是迁移脚本：新库直接是这个形状，旧库/旧数据不在此路径上（设计 §0）。
--   2. 脚本**不含** `CREATE DATABASE`；库由 `create.mjs` 在应用本文件之前单独创建。
--   3. 各 `CREATE TABLE` **刻意不写 `IF NOT EXISTS`**：重复执行时 PostgreSQL 报 42P07
--      （`relation ... already exists`），整个事务回滚 → **重复建库被明确拒绝，不会半建**。
--      重复执行的语义就是"失败且零改动"，不做幂等跳过——避免"部分表已是新形状、部分表还是旧形状"
--      这种最难排查的现场。
--   4. 运行期任何组件都**不得自动建表**：缺表由存储层报稳定码 `storage_schema_missing`（设计 §10.1），
--      版本不符报 `storage_schema_version`。表形状只由本文件（及后续显式升级脚本）决定。
--
-- 版本行归属
--   `dsh_schema_versions` 四行分别归属：`butler_*` → `butler`、`blog_*` → `blog`、
--   `closedoff_*` → `closedoff`、`dsh_*` 三张框架表 → `runtime`（设计 §3.1：框架表由 runtime
--   独占管理，版本行由**建库脚本**写，不由插件启动时写）。
--   `applied_at` 是 `Date.now()` 同空间的**毫秒** BIGINT（设计 §4：毫秒时间保留 BIGINT）。
--
-- 与另一套 DDL 的关系（先读这一条，否则版本号会被误读）
--   仓库里同时存在两套建库 DDL，**不是同一层的两个版本**：
--     ① `plugins/external/dsh-butler-console/migrations/postgres/0001_init.sql`
--        ——**管家单插件**的库：7 张表（`conversations` / `tasks` / `subtasks` / `agent_aliases` /
--        `requests` / `task_inputs` + 单行 `schema_version`），无表前缀，`schema_version.version = 9`
--        （对应源 SQLite 的 `PRAGMA user_version = 9`；v9 就是给 `tasks` / `subtasks` 各加一列
--        `acceptance` 的那一版，P0 为了让 CI 的 PG 契约测试继续跑而保留）。
--        它**是过渡态**：P5 把管家切到本文件的 `butler_*` 表之后退役。
--     ② 本文件 ——**目标态**：单库 `dsh`、15 张表、统一前缀（`butler_` / `blog_` / `closedoff_` /
--        `dsh_`），`dsh_schema_versions` **四行版本全为 1**。
--   ⚠️ **两套的版本号语义不同、数字不可比**：`9` 是"管家单插件第 9 版结构"（含 v1..v8 的历史累积），
--   而本文件的 `1` 是"新库的初始形状"——它不是"第 1 次迁移"，也不表示比 9 旧。看到 9 vs 1
--   不要当成漂移，两者分别在各自的库上生效（`dsh` 库由本文件建，管家旧库由 ① 建）。
--
-- 写路径须知（已写进 §8.1，此处只留指针）
--   六张业务表的 `payload` **不给 DEFAULT**；提升列里**6 个生成列分布在 4 张表**——
--   `blog_drafts`（`title` / `updated_at`）、`blog_jobs`（`draft_id` / `status`）、
--   `blog_operations`（`status`）、`blog_attachments`（`status`）；`blog_translations.status`
--   是**镜像列**（INSERT 要写）、`blog_audit` **两者皆无**（无提升列）。
--   **INSERT 不能写生成列**（写了报 428C9），只需保证 `payload` 里有对应键——由紧跟的
--   `CHECK (payload ? 'x')` 形状守卫强制；键**存在但值为 JSON null** 时生成列为 NULL。
--   ⚠️ 例外不是生成列：`blog_operations` 的 **scope 是两列**（`draft_id` = 真实草稿 id、
--   `scope_id` = 管理 / 远端操作的合成 scope，`blog_operations_one_scope` 保证恰好一支非空），
--   两列都由**写入侧**填（`scope_id` 还有 DEFAULT ''）——INSERT 必须自己判是哪一支。
--   `blog_translations.status`（镜像列）同理必须写。
--
-- 文件内出现的一切错误码都是**本机 PG18 实测**的（428C9 写生成列 / 23514 形状守卫 /
-- 22P02 生成列 cast 失败 / 23503 外键 / 23001 RESTRICT / 42P07 重复建库）。

BEGIN;

-- ---------------------------------------------------------------------------
-- ① §5.1 框架级：版本表
-- ---------------------------------------------------------------------------

CREATE TABLE dsh_schema_versions (
  plugin_id  TEXT    NOT NULL PRIMARY KEY,
  version    INTEGER NOT NULL,
  applied_at BIGINT  NOT NULL
);

-- ---------------------------------------------------------------------------
-- ② §5.3 框架级：会话索引 / 轮次幂等 / 结果卡（从 SQLite 迁入 PG，靠 `agent_id` 区分 Agent）
--    必须先于 ③：`butler_tasks` 的复合外键指向 `dsh_conversations`。
-- ---------------------------------------------------------------------------

CREATE TABLE dsh_conversations (
  id              TEXT    NOT NULL PRIMARY KEY,
  -- ⚠️ 无默认值：任何 Agent 的 INSERT 都必须显式写它（漏写报 23502）。
  agent_id        TEXT    NOT NULL,
  owner_namespace TEXT    NOT NULL,
  owner_id        TEXT    NOT NULL,
  request_id      TEXT    NOT NULL DEFAULT '',
  title           TEXT    NOT NULL DEFAULT '',
  title_source    TEXT    NOT NULL DEFAULT 'automatic'
                    CHECK (title_source IN ('automatic','generated','manual')),
  -- ⚠️ 陷阱列：三个消费方都拿它当"可见 / 可删"的门；管家没有"会话 ready"概念，
  -- 建会话时必须显式写 `ready = TRUE` 一步到位（设计 §8.1）。
  ready           BOOLEAN NOT NULL DEFAULT FALSE,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  removal_state   TEXT    NOT NULL DEFAULT ''
                    CHECK (removal_state IN ('','pending','failed','removed')),
  deleted_at      BIGINT,
  parent_id       TEXT,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL,
  payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (id, owner_namespace, owner_id)
);
-- 创建幂等必须用**部分**唯一索引：管家会话没有 requestId 语义，`request_id` 全为 ''
-- 时若用表级 UNIQUE 会互相冲突。
CREATE UNIQUE INDEX dsh_conversations_request
  ON dsh_conversations (agent_id, owner_namespace, owner_id, request_id)
  WHERE request_id <> '';
CREATE INDEX dsh_conversations_owner
  ON dsh_conversations (agent_id, owner_namespace, owner_id, updated_at DESC, id);
CREATE INDEX dsh_conversations_parent
  ON dsh_conversations (agent_id, owner_namespace, owner_id, parent_id)
  WHERE parent_id IS NOT NULL;

CREATE TABLE dsh_turns (
  id              TEXT   NOT NULL PRIMARY KEY,
  agent_id        TEXT   NOT NULL,
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  conversation_id TEXT   NOT NULL,
  request_id      TEXT   NOT NULL DEFAULT '',
  input_hash      TEXT   NOT NULL,
  status          TEXT   NOT NULL,
  created_at      BIGINT NOT NULL,
  payload         JSONB  NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (conversation_id, owner_namespace, owner_id)
    REFERENCES dsh_conversations (id, owner_namespace, owner_id) ON DELETE CASCADE
);
-- 与 `dsh_conversations` 对称：这里也必须是**部分**唯一索引。
CREATE UNIQUE INDEX dsh_turns_request
  ON dsh_turns (agent_id, owner_namespace, owner_id, request_id)
  WHERE request_id <> '';
CREATE INDEX dsh_turns_conversation
  ON dsh_turns (agent_id, owner_namespace, owner_id, conversation_id, id);

CREATE TABLE dsh_turn_results (
  id              TEXT   NOT NULL PRIMARY KEY,
  agent_id        TEXT   NOT NULL,
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  conversation_id TEXT   NOT NULL,
  -- ⚠️ 这一列装的是 **turn 的行 id**，不是幂等键（两者在旧结构里同名不同义）——故不改叫 request_id。
  turn_id         TEXT   NOT NULL,
  operation_id    TEXT   NOT NULL,
  seq             BIGINT GENERATED ALWAYS AS IDENTITY,
  created_at      BIGINT NOT NULL,
  payload         JSONB  NOT NULL DEFAULT '{}'::jsonb,
  -- ⚠️ **刻意不加** `(turn_id, operation_id)` 唯一约束：一轮同一操作可以有多条结果
  -- （不同 `kind` / `revision`），结果的真实身份就是 `id`；防重复不需要额外约束。
  FOREIGN KEY (conversation_id, owner_namespace, owner_id)
    REFERENCES dsh_conversations (id, owner_namespace, owner_id) ON DELETE CASCADE
);
CREATE INDEX dsh_turn_results_conversation
  ON dsh_turn_results (agent_id, owner_namespace, owner_id, conversation_id, seq);

-- ---------------------------------------------------------------------------
-- ③ §5.2 管家（协调者）
--    管家没有 `butler_conversations`：它的会话并进框架级 `dsh_conversations`
--    （`agent_id = 'butler'`），见 §5.3。
-- ---------------------------------------------------------------------------

CREATE TABLE butler_tasks (
  id                TEXT    NOT NULL PRIMARY KEY,
  conversation_id   TEXT    NOT NULL,
  owner_namespace   TEXT    NOT NULL,
  owner_id          TEXT    NOT NULL,
  goal              TEXT    NOT NULL,
  acceptance        TEXT    NOT NULL DEFAULT '',
  state             TEXT    NOT NULL,
  note              TEXT    NOT NULL DEFAULT '',
  summary           TEXT    NOT NULL DEFAULT '',
  error             TEXT    NOT NULL DEFAULT '',
  accepted_version  INTEGER NOT NULL DEFAULT 1,
  processed_version INTEGER NOT NULL DEFAULT 1,
  created_at        BIGINT  NOT NULL,
  updated_at        BIGINT  NOT NULL,
  finished_at       BIGINT,
  UNIQUE (id, owner_namespace, owner_id),
  FOREIGN KEY (conversation_id, owner_namespace, owner_id)
    REFERENCES dsh_conversations (id, owner_namespace, owner_id)
    ON DELETE RESTRICT
);
CREATE INDEX butler_tasks_owner        ON butler_tasks (owner_namespace, owner_id, created_at DESC, id);
CREATE INDEX butler_tasks_conversation ON butler_tasks (conversation_id, created_at);

CREATE TABLE butler_subtasks (
  task_id                  TEXT    NOT NULL,
  id                       TEXT    NOT NULL,
  seq                      INTEGER NOT NULL,
  goal                     TEXT    NOT NULL,
  agent_id                 TEXT    NOT NULL DEFAULT '',
  reason                   TEXT    NOT NULL DEFAULT '',
  state                    TEXT    NOT NULL,
  acceptance               TEXT    NOT NULL DEFAULT '',
  result                   TEXT    NOT NULL DEFAULT '',
  error                    TEXT    NOT NULL DEFAULT '',
  artifacts                JSONB   NOT NULL DEFAULT '[]'::jsonb,
  conversation_id          TEXT    NOT NULL DEFAULT '',
  logical_id               TEXT    NOT NULL DEFAULT '',
  supersedes               TEXT    NOT NULL DEFAULT '',
  depends_on               JSONB   NOT NULL DEFAULT '[]'::jsonb,
  requires_external_action BOOLEAN NOT NULL DEFAULT FALSE,
  input_refs               JSONB   NOT NULL DEFAULT '[]'::jsonb,
  member_return            JSONB   NOT NULL DEFAULT '{}'::jsonb,
  verdict                  TEXT    NOT NULL DEFAULT '',
  verdict_reason           TEXT    NOT NULL DEFAULT '',
  verdict_evidence         JSONB   NOT NULL DEFAULT '[]'::jsonb,
  observation              JSONB   NOT NULL DEFAULT '{}'::jsonb,
  started_at               BIGINT,
  finished_at              BIGINT,
  PRIMARY KEY (task_id, id),
  FOREIGN KEY (task_id) REFERENCES butler_tasks (id) ON DELETE CASCADE
);
CREATE INDEX butler_subtasks_task    ON butler_subtasks (task_id, seq);
CREATE INDEX butler_subtasks_logical ON butler_subtasks (task_id, logical_id);

CREATE TABLE butler_task_inputs (
  task_id    TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  created_at BIGINT  NOT NULL,
  PRIMARY KEY (task_id, version),
  FOREIGN KEY (task_id) REFERENCES butler_tasks (id) ON DELETE CASCADE
);

CREATE TABLE butler_agent_aliases (
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  agent_id        TEXT   NOT NULL,
  display_name    TEXT   NOT NULL DEFAULT '',
  accent          TEXT   NOT NULL DEFAULT '',
  avatar          BYTEA,
  avatar_type     TEXT   NOT NULL DEFAULT '',
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (owner_namespace, owner_id, agent_id)
);

CREATE TABLE butler_requests (
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  kind            TEXT   NOT NULL,
  request_id      TEXT   NOT NULL,
  digest          TEXT   NOT NULL,
  state           TEXT   NOT NULL,
  run_id          TEXT   NOT NULL DEFAULT '',
  conversation_id TEXT   NOT NULL DEFAULT '',
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (owner_namespace, owner_id, kind, request_id)
);

-- ---------------------------------------------------------------------------
-- ④ §5.4 blog 业务表：提升查询列（生成列）+ `payload` 改 JSONB
--    6 张业务表的 `payload` **不给 DEFAULT**（忘记写就是报错，而不是静默写空）。
--    除 `blog_translations.status`（镜像列，INSERT 要写）外，提升列全是
--    `GENERATED ALWAYS AS (payload->>'x') STORED`：**INSERT 不能写它们**（写了报 428C9），
--    写路径只需保证 `payload` 里有对应键——由紧跟的 `CHECK (payload ? 'x')` 形状守卫强制。
-- ---------------------------------------------------------------------------

CREATE TABLE blog_drafts (
  id              TEXT    NOT NULL PRIMARY KEY,
  owner_namespace TEXT    NOT NULL,
  owner_id        TEXT    NOT NULL,
  revision        INTEGER NOT NULL,
  title           TEXT    GENERATED ALWAYS AS (payload->>'title') STORED,
  updated_at      BIGINT  GENERATED ALWAYS AS ((payload->>'updatedAt')::bigint) STORED,
  payload         JSONB   NOT NULL,
  UNIQUE (id, owner_namespace, owner_id),
  CHECK (payload ? 'title' AND payload ? 'updatedAt')
);
CREATE INDEX blog_drafts_owner ON blog_drafts (owner_namespace, owner_id, updated_at DESC);

CREATE TABLE blog_jobs (
  id              TEXT   NOT NULL PRIMARY KEY,
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  caller          TEXT   NOT NULL,
  request_id      TEXT   NOT NULL,
  input_hash      TEXT   NOT NULL,
  draft_id        TEXT   GENERATED ALWAYS AS (payload->'input'->>'draftId') STORED,
  status          TEXT   GENERATED ALWAYS AS (payload->>'status') STORED,
  seq             BIGINT GENERATED ALWAYS AS IDENTITY,
  payload         JSONB  NOT NULL,
  UNIQUE (owner_namespace, owner_id, caller, request_id),
  -- 与 status 对称：生成列的形状守卫（缺键会让 draft_id 静默变 NULL）。
  CHECK (payload ? 'status' AND payload->'input' ? 'draftId'),
  -- 租户隔离：与 `blog_operations` / `blog_attachments` 同一条复合外键（红队实测的缺口——
  -- 补之前，B 的 owner 用本表指向 A 的草稿能插进去，而另两张表被 23503 挡住）。
  --
  -- ⚠️ 语义（两条都必须先懂，否则会误判它"不生效"）：
  --   1. **MATCH SIMPLE（默认，故意不写 `MATCH FULL`）**：`draft_id` 是生成列且**可为 NULL**——
  --      `CHECK (payload->'input' ? 'draftId')` 只保证**键存在**，`{"input":{"draftId":null}}`
  --      同样通过（键在、值为 JSON null → 生成列 NULL）。MATCH SIMPLE 下只要有一列为 NULL
  --      就整条不校验，这正是想要的：**没有引用对象时无须校验**，不是隔离缺口。
  --      反过来 `MATCH FULL` 会因 `owner_namespace` / `owner_id` 是 NOT NULL 而**拒绝**这种行，
  --      把"合法地没有 draftId"变成 23503，与 §5.4.1"生成列留 NULL 语义"定稿相抵。
  --      另外：job 的 `draftId` 在现有写路径上**必然存在**——`jobs.mjs:157-166` 先 `storage.get`
  --      草稿（取不到就 404）再 `input = { draftId: d.id, … }`，没有"无草稿的 job"这条路径。
  --   2. **ON DELETE CASCADE**（与 `blog_operations` / `blog_attachments` 一致）：
  --      **不能选 RESTRICT**。删草稿是业务动作，RESTRICT 会让它变成 23503 失败；而且 job 的
  --      `payload.input` 是"针对某一版草稿的快照"，草稿没了这条记录也就失去读出的路径
  --      （`jobList` 按 draftId 过滤，它只会变成查不到的悬垂行）。历史留痕由**不级联**的
  --      `blog_audit` 承担，所以 CASCADE 不会丢掉审计面。
  --      已知窗口（如实记下，不是为了辩解）：草稿被硬删时正在跑的 job 会连行一起消失，
  --      其后的 `jobUpdate` 会 404。目前**全仓没有任何硬删草稿的语句**（`plugins/` 下
  --      `DELETE FROM` 零命中，与设计 §6 决策 4"三条 CASCADE 是死代码"同源），故这条分支
  --      不在现有路径上；将来若开硬删草稿的入口，须同时定义"在跑的 job 怎么办"。
  --      实测（本机 PG18）：删草稿后 job / operation / attachment 三张表的对应行都随草稿消失。
  FOREIGN KEY (draft_id, owner_namespace, owner_id)
    REFERENCES blog_drafts (id, owner_namespace, owner_id) ON DELETE CASCADE
);
CREATE INDEX blog_jobs_owner ON blog_jobs (owner_namespace, owner_id, seq DESC);
CREATE INDEX blog_jobs_draft ON blog_jobs (owner_namespace, owner_id, draft_id, seq DESC);

CREATE TABLE blog_operations (
  id              TEXT    NOT NULL PRIMARY KEY,
  owner_namespace TEXT    NOT NULL,
  owner_id        TEXT    NOT NULL,
  -- ⚠️ **多态 scope（与 `blog_attachments` 同一个标准解）**：这一列只装**真实草稿 id**；
  -- 管理 / 远端操作的合成 scope（`manage:<kind>:<id|new>` / `remote:<rootCid>`，
  -- 来自 `application.mjs:203` / `:239`）落 `scope_id`。
  -- 两义值装不进一列：装进去之后复合外键就会把"合法地指向远端文章"的操作判成 23503
  -- （本机 PG18 实测：`draft_id='manage:blog:new'` → 23503、`draft_id='remote:12345'` → 23503）。
  -- 这两列都是**普通列、不是生成列**（`scope_id` 还要 DEFAULT ''），所以 INSERT 必须自己写对是哪一支。
  draft_id        TEXT,
  scope_id        TEXT    NOT NULL DEFAULT '',
  revision        INTEGER NOT NULL,
  status          TEXT    GENERATED ALWAYS AS (payload->>'status') STORED,
  seq             BIGINT  GENERATED ALWAYS AS IDENTITY,
  payload         JSONB   NOT NULL,
  CHECK (payload ? 'status'),
  -- 恰好一支非空：`scope_id` 用空串表示"没有"，所以先 `NULLIF` 再数。
  CONSTRAINT blog_operations_one_scope
    CHECK (num_nonnulls(draft_id, NULLIF(scope_id, '')) = 1),
  -- 只对"真实草稿"那一支生效：MATCH SIMPLE 下 `draft_id` 为 NULL 时整条外键不检查，
  -- 所以合成 scope 的操作不受影响。删草稿只级联**真实草稿操作**；合成 scope 的记录**留下**——
  -- 它们的 scope 指向远端文章 / 管理对象而不是本地草稿，生命周期归各自的 `expiresAt` 与 `status`
  -- （级联掉它们等于静默丢弃一条"提交待核对"记录，而那条远端文章还在）。
  FOREIGN KEY (draft_id, owner_namespace, owner_id)
    REFERENCES blog_drafts (id, owner_namespace, owner_id) ON DELETE CASCADE
);
CREATE INDEX blog_operations_owner ON blog_operations (owner_namespace, owner_id, seq);
CREATE INDEX blog_operations_draft ON blog_operations (owner_namespace, owner_id, draft_id, seq DESC);
-- 活跃操作的部分索引：`pendingOperations()` 在每次 list / 每次 busy 都被调用，是热路径。
CREATE INDEX blog_operations_active ON blog_operations (status, seq DESC)
  WHERE status IN ('prepared','running','uncertain');

CREATE TABLE blog_audit (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              BIGINT NOT NULL,
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  action          TEXT   NOT NULL,
  payload         JSONB  NOT NULL
);
CREATE INDEX blog_audit_owner ON blog_audit (owner_namespace, owner_id, at DESC);

CREATE TABLE blog_attachments (
  id              TEXT   NOT NULL PRIMARY KEY,
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  -- ⚠️ scope 是**多态**的：草稿附件与对话附件共用这一张表，所以是
  -- 「两列可空 + 两个 MATCH SIMPLE 外键 + 恰好一个非空」的 CHECK，而不是丢掉引用完整性的 scope_kind。
  draft_id        TEXT,
  conversation_id TEXT,
  status          TEXT   GENERATED ALWAYS AS (payload->>'status') STORED,
  seq             BIGINT GENERATED ALWAYS AS IDENTITY,
  payload         JSONB  NOT NULL,
  CHECK (payload ? 'status'),
  CONSTRAINT blog_attachments_one_scope
    CHECK (num_nonnulls(draft_id, conversation_id) = 1),
  FOREIGN KEY (draft_id, owner_namespace, owner_id)
    REFERENCES blog_drafts (id, owner_namespace, owner_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, owner_namespace, owner_id)
    REFERENCES dsh_conversations (id, owner_namespace, owner_id) ON DELETE CASCADE
);
CREATE INDEX blog_attachments_draft
  ON blog_attachments (owner_namespace, owner_id, draft_id, seq) WHERE draft_id IS NOT NULL;
CREATE INDEX blog_attachments_conversation
  ON blog_attachments (owner_namespace, owner_id, conversation_id, seq) WHERE conversation_id IS NOT NULL;

CREATE TABLE blog_translations (
  id              TEXT   NOT NULL PRIMARY KEY,
  cache_key       TEXT   NOT NULL,
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  -- ⚠️ **例外：这一列仍是镜像列**（不是生成列）——本表是按 `(cache_key, status)` upsert 的缓存表，
  -- INSERT 时就已知 `status`，无需从 payload 反推。**6 个生成列分布在 4 张表**
  -- （`blog_drafts` / `blog_jobs` / `blog_operations` / `blog_attachments`），本表是镜像列、
  -- `blog_audit` 两者皆无——实施时**按本 DDL 为准，不要统一**。
  status          TEXT   NOT NULL,
  seq             BIGINT GENERATED ALWAYS AS IDENTITY,
  payload         JSONB  NOT NULL
);
CREATE INDEX blog_translation_cache ON blog_translations (cache_key, status, seq DESC);

-- ---------------------------------------------------------------------------
-- 版本行：每插件一行（`dsh_*` 框架表的归属是 `runtime`）
-- ---------------------------------------------------------------------------

INSERT INTO dsh_schema_versions (plugin_id, version, applied_at) VALUES
  ('butler',    1, :applied_at),
  ('blog',      1, :applied_at),
  ('closedoff', 1, :applied_at),
  ('runtime',   1, :applied_at);

COMMIT;
