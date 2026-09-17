-- 牛马大总管工作台 PostgreSQL 初始结构。
-- 对应源 schema 9（原 node:sqlite 版 store.ts 的 PRAGMA user_version = 9），一次性建出
-- 全量形状（六张业务表 + schema_version 版本表），不走源库 v1..v8 的逐版迁移链。
--
-- 列类型映射约定（方案 §3 方言差异）：
--   毫秒时间戳 → bigint；JSON 列 → text（保持 TEXT + 读时解析分类，不迁 JSONB）；
--   布尔 → smallint（0/1）；BLOB → bytea；状态与文本 → text。
-- 主键与唯一约束与源库一致：requests 唯一 (owner_namespace, owner_id, kind, request_id)、
--   task_inputs 主键 (task_id, version)、subtasks 主键 (task_id, id)、
--   agent_aliases 主键 (owner_namespace, owner_id, agent_id)、conversations/tasks 主键 id。
-- 首批不加外键（方案 D7）：表间关联（task_id、conversation_id）靠应用层核验归属，
--   导入顺序实测后再复核是否补约束。
--
-- 缺列默认投影约定（从源库 v1..v7 导入旧数据时的等价投影）：
--   - 源库各版迁移加列时使用的默认值即导入投影：文本列默认 ''，数值列默认 0，
--     requires_external_action 默认 0（不需要），accepted_version / processed_version 默认 1；
--   - v5 加 logical_id 时的回填规则：logical_id 为空的旧行按 `logical_id = 'g' || seq`
--     回填（每条子任务各自当一个目标）；
--   - v8 加 input_refs / member_return 时旧值一律留空 '' = 未知（unknown），不反推、不补造；
--   - v9 加 acceptance（验收口径）时旧值一律留空 '' = 没有声明口径（**不是**「默认通过」）：
--     协调方据此不施加「口径提到的产出物必须交回」那条校验，与加这一列之前的行为一致；
--   - 子任务 artifacts / depends_on 留空 = 空数组；tasks.finished_at 允许 NULL；
--   - v10 加裁决四列（verdict / verdict_reason / verdict_evidence / observation）时旧值一律留空：
--     verdict 留空 = **还没裁决过**（不是「默认通过」），与加这四列之前的行为一致；
--     ⚠️ 新库（private-deploy/db/0001_init.sql）的 verdict_evidence / observation 是 JSONB
--     （默认 [] / {}），本文件的对应列是 TEXT（默认 ''）—— 空值形态与返回类型都不同，
--     切库时必须按 pg 驱动对 JSONB 的返回形状（数组/对象，不是字符串）调整解析，
--     否则会与 artifacts / member_return 一样走「损坏即拒」。
--
-- 版本号与建表在同一批语句内完成：schema_version 用 id=0 单行约束（CHECK 保证只有一行），
-- 版本号最后写、与结构同事务的性质由迁移工具保持。

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  owner_namespace TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX conversations_owner
  ON conversations(owner_namespace, owner_id, updated_at DESC, id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_namespace TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  accepted_version INTEGER NOT NULL DEFAULT 1,
  processed_version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  finished_at BIGINT
);

CREATE INDEX tasks_owner
  ON tasks(owner_namespace, owner_id, created_at DESC, id);
CREATE INDEX tasks_conversation
  ON tasks(conversation_id, created_at);

CREATE TABLE subtasks (
  task_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  goal TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  artifacts TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  logical_id TEXT NOT NULL DEFAULT '',
  supersedes TEXT NOT NULL DEFAULT '',
  depends_on TEXT NOT NULL DEFAULT '',
  requires_external_action SMALLINT NOT NULL DEFAULT 0,
  input_refs TEXT NOT NULL DEFAULT '',
  member_return TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '',
  verdict_reason TEXT NOT NULL DEFAULT '',
  verdict_evidence TEXT NOT NULL DEFAULT '',
  observation TEXT NOT NULL DEFAULT '',
  started_at BIGINT,
  finished_at BIGINT,
  PRIMARY KEY (task_id, id)
);

CREATE INDEX subtasks_task ON subtasks(task_id, seq);

CREATE TABLE agent_aliases (
  owner_namespace TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT '',
  avatar BYTEA,
  avatar_type TEXT NOT NULL DEFAULT '',
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (owner_namespace, owner_id, agent_id)
);

CREATE TABLE requests (
  owner_namespace TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (owner_namespace, owner_id, kind, request_id)
);

CREATE TABLE task_inputs (
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (task_id, version)
);

-- 单行版本表：id 固定 0 并用 CHECK 锁死，保证任何时刻至多一行版本记录。
CREATE TABLE schema_version (
  id SMALLINT NOT NULL PRIMARY KEY CHECK (id = 0),
  version INTEGER NOT NULL,
  applied_at BIGINT NOT NULL
);

INSERT INTO schema_version(id, version, applied_at)
VALUES (0, 10, (CAST(EXTRACT(EPOCH FROM now()) AS BIGINT) * 1000));
