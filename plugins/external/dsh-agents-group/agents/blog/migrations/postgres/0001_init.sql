-- blog 业务库 PostgreSQL 初始结构（版本 1，对应「blog 业务 schema 初版」）。
-- 源库：blog.sqlite 的业务 5 表（drafts/jobs/operations/audit/attachments，源 PRAGMA
-- user_version=1）+ reasoning-translations.sqlite 的单表 translations，一次性建出全量形状，
-- 不走逐版迁移链。库为群组单库 agents_group，表平铺加 `blog_` 前缀（方案 §1/Q1）。
--
-- 列类型映射约定（沿用管家 butler-console 的 0001_init.sql）：
--   毫秒时间戳 → bigint；JSON 记录列 → text（保持 TEXT + 读时 JSON.parse，不迁 JSONB）；
--   状态与文本 → text。本 schema 没有 BLOB 数据：现状附件原文件由宿主附件服务保存，
--   表内只存 JSON 记录（含字节数），因此无 bytea 列。
--
-- 与源 SQLite 形状的差异（保持语义等价）：
--   - SQLite 隐式 rowid 的插入序（jobs/operations/attachments 的 ORDER BY rowid、
--     translations 的 ORDER BY rowid DESC）以 `seq` 标识列显式化：BIGSERIAL 自增，
--     迁移导入时按源库 rowid 顺序显式写入；
--   - audit 的 `id INTEGER PRIMARY KEY`（rowid 别名）对应 BIGSERIAL 主键；
--   - 约束与源一致：jobs 唯一 (owner,caller,request_id)（jobStart 幂等），
--     其余表主键 id；首批不加外键，表间关联靠应用层核验归属。
--
-- 版本表 `blog_schema_version` 带 blog_ 前缀：库内表按插件前缀平铺，后续若有其他
-- Agent 迁入，各自维护自己的版本行，互不干扰。单行约束（CHECK id=0）保证任何时刻
-- 至多一行版本记录；版本号与建表在同一批语句内完成，与结构同事务的性质由迁移工具保持。

CREATE TABLE blog_drafts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated BIGINT NOT NULL,
  data TEXT NOT NULL
);

CREATE INDEX blog_drafts_owner ON blog_drafts(owner, updated DESC);

CREATE TABLE blog_jobs (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  caller TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  seq BIGSERIAL NOT NULL UNIQUE,
  data TEXT NOT NULL,
  UNIQUE (owner, caller, request_id)
);

CREATE INDEX blog_jobs_owner ON blog_jobs(owner, seq DESC);

CREATE TABLE blog_operations (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  seq BIGSERIAL NOT NULL UNIQUE,
  data TEXT NOT NULL
);

CREATE INDEX blog_operations_owner ON blog_operations(owner, seq);
CREATE INDEX blog_operations_draft ON blog_operations(owner, draft_id, seq DESC);

CREATE TABLE blog_audit (
  id BIGSERIAL PRIMARY KEY,
  at BIGINT NOT NULL,
  owner TEXT NOT NULL,
  action TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE blog_attachments (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  seq BIGSERIAL NOT NULL UNIQUE,
  data TEXT NOT NULL
);

CREATE INDEX blog_attachments_scope ON blog_attachments(owner, draft_id, seq);

CREATE TABLE blog_translations (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL,
  seq BIGSERIAL NOT NULL UNIQUE,
  data TEXT NOT NULL
);

CREATE INDEX blog_translation_cache ON blog_translations(cache_key, status);

-- 单行版本表：id 固定 0 并用 CHECK 锁死。
CREATE TABLE blog_schema_version (
  id SMALLINT NOT NULL PRIMARY KEY CHECK (id = 0),
  version INTEGER NOT NULL,
  applied_at BIGINT NOT NULL
);

INSERT INTO blog_schema_version(id, version, applied_at)
VALUES (0, 1, (CAST(EXTRACT(EPOCH FROM now()) AS BIGINT) * 1000));
