-- 单库 `dsh`：加入管家的附件表（v1 补丁）。
--
-- 用途
--   给**已按 `0001_init.sql` 建过库**的站点补上 `butler_attachments`。全新站点不需要本文件——
--   `0001_init.sql` 已经包含同样的表与索引（保证"新库直接一次建全"）。
--
-- 为什么与 0001 分开
--   建库脚本刻意不含 `IF NOT EXISTS`：重复执行报 42P07 并整体回滚，用来拒绝"重复建库"。
--   那条语义是对的，所以它不能用来做增量。本文件相反——**它就是增量的**，因此写成幂等：
--   重复执行零改动，便于"跑没跑过不确定"时直接再跑一次。
--
-- 幂等性的依据
--   1. `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`：已存在即跳过；
--   2. **不动版本行**：`dsh_schema_versions` 里管家仍是 1（与 0002_huiyu.sql 同一口径——
--      版本号描述的是"这一版设计"，不是一个迁移计数器；0001 与 0003 跑完得到的是同一个形状）。
--      没跑本文件的站点不会静默半可用：插件启动时核验业务表清单，缺 `butler_attachments`
--      会以稳定码 `storage_schema_missing` 拒绝激活。
--
-- 执行方式（在能连到目标库的机器上）
--   手工：  psql "$DSH_PG_DSN" -v ON_ERROR_STOP=1 -f private-deploy/db/0003_butler_attachments.sql
--   或用 create.mjs 的同一套环境变量拼 DSN（`DSH_PG_DSN`）。
--   本文件**没有占位符**（不写版本行），所以不需要 `-v applied_at=…`。
--
-- 与 0001 的关系
--   表、列、索引逐字等同 `0001_init.sql` 的 ③ 段。**两处必须一起改**：本文件是给现有库的补丁，
--   那份是新库的初始形状，漏改任何一处都会让"新库"与"旧库补完"变成两种形状。
--
-- 关于列的一个说明（照 0001 的口径重述一次，改这张表的人必须知道）
--   `conversation_id` / `task_id` **都不给外键、都允许空串**，这是有意的：
--   · 上传发生在"还没开新会话"的时刻（输入框里先拖文件、再写需求），此时 `dsh_conversations`
--     里还没有那一行，挂外键会让"先传文件"这条正常路径报 23503；
--   · `task_id` 在计划落库之后才回填（同一轮里附件先于任务存在）。
--   代价是"引用对象不存在"数据库拦不住，改由读路径按 owner 过滤兜住——跨用户读不到，这一点
--   比"会话/任务不存在"重要得多。

BEGIN;

CREATE TABLE IF NOT EXISTS butler_attachments (
  id              TEXT    NOT NULL PRIMARY KEY,
  owner_namespace TEXT    NOT NULL,
  owner_id        TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL DEFAULT '',
  task_id         TEXT    NOT NULL DEFAULT '',
  name            TEXT    NOT NULL,
  -- 解析种类（`text` / `markdown` / `pdf` / `docx` / `image` / `binary` …），由字节与扩展名共同判定。
  kind            TEXT    NOT NULL,
  -- HTTP 媒体类型，只用于回放下载与展示；类型判定**不看它**（客户端声明不可信）。
  media_type      TEXT    NOT NULL DEFAULT '',
  bytes           BIGINT  NOT NULL DEFAULT 0,
  -- `uploading` → `parsing` → `ready`；失败 `failed`，用户删除 `removed`。失败与删除都留行。
  -- 取值用 CHECK 钉住：读路径按字面量用这一列，允许写进第六种值会让页面拿到一个它不认识的态。
  status          TEXT    NOT NULL
                    CHECK (status IN ('uploading','parsing','ready','failed','removed')),
  message         TEXT    NOT NULL DEFAULT '',
  -- 由 URL 抓取而来时记下原地址（本地上传为空串）；只用于展示，不参与任何请求。
  source_url      TEXT    NOT NULL DEFAULT '',
  -- 宿主附件服务写回的引用（不透明结构，管家只负责原样交回读接口）。
  original        JSONB,
  -- 解析结果（`units` / `totalUnits` / `unit` / `characters` / `partial`）。
  parsed          JSONB,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL
);

-- 列表按会话倒序翻页，与 blog 各表的索引口径一致。
CREATE INDEX IF NOT EXISTS butler_attachments_owner
  ON butler_attachments (owner_namespace, owner_id, conversation_id, created_at DESC);
-- 派单时按任务找附件；部分索引，因为绝大多数行的 task_id 是空串（还没派出去）。
CREATE INDEX IF NOT EXISTS butler_attachments_task
  ON butler_attachments (task_id) WHERE task_id <> '';

COMMIT;
