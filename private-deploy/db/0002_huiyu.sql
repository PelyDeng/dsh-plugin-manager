-- 单库 `dsh`：加入 huiyu（绘语图片智能体）的表（v1）。
--
-- 用途
--   给**已按 `0001_init.sql` 建过库**的站点补上 huiyu 那一部分。全新站点不需要本文件——
--   `0001_init.sql` 已经包含同样的表与版本行（保证"新库直接一次建全"）。
--
-- 为什么与 0001 分开
--   建库脚本刻意不含 `IF NOT EXISTS`：重复执行报 42P07 并整体回滚，用来拒绝"重复建库"。
--   那条语义是对的，所以它不能用来做增量。本文件相反——**它就是增量的**，因此写成幂等：
--   重复执行零改动，便于"跑没跑过不确定"时直接再跑一次。
--
-- 幂等性的依据
--   1. `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`：已存在即跳过；
--   2. 版本行用 `ON CONFLICT (plugin_id) DO NOTHING`：已有 `huiyu` 行时不改写它的 version
--      与 applied_at——改写会让"这行是什么时候写的"失真。
--
-- 执行方式（在能连到目标库的机器上）
--   手工：  psql "$DSH_PG_DSN" -v ON_ERROR_STOP=1 -v applied_at="$DSH_APPLIED_AT" \
--                -f private-deploy/db/0002_huiyu.sql
--   或用 create.mjs 的同一套环境变量拼 DSN（`DSH_PG_DSN`）。
--   `:applied_at` 与 0001 同口径：`Date.now()` 的**毫秒** BIGINT；缺省 0 时不代表真实时刻，
--   所以推荐显式传值。
--
-- 与本表结构的关系
--   列与索引逐字等同 `0001_init.sql` 的 ⑤ 段。**两处必须一起改**：本文件是给现有库的补丁，
--   那份是新库的初始形状，漏改任何一处都会让"新库"与"旧库补完"变成两种形状。

BEGIN;

CREATE TABLE IF NOT EXISTS huiyu_images (
  id              TEXT   NOT NULL PRIMARY KEY,
  owner_namespace TEXT   NOT NULL,
  owner_id        TEXT   NOT NULL,
  created_at      BIGINT NOT NULL,
  seq             BIGINT GENERATED ALWAYS AS IDENTITY,
  payload         JSONB  NOT NULL
);

CREATE INDEX IF NOT EXISTS huiyu_images_owner ON huiyu_images (owner_namespace, owner_id, seq DESC);

INSERT INTO dsh_schema_versions (plugin_id, version, applied_at)
VALUES ('huiyu', 1, :applied_at)
ON CONFLICT (plugin_id) DO NOTHING;

COMMIT;
