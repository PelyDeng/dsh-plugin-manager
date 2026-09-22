-- 单库 `dsh`：牛马生态的记忆表（v2.6 设计 §4.3，P1 最小闭环）。
--
-- 用途
--   给**已按 `0001_init.sql` 建过库**的站点补上记忆功能的三张表。全新站点不需要本文件——
--   `0001_init.sql` 已经包含同样的表与索引（保证"新库直接一次建全"）。
--
-- 为什么与 0001 分开、为什么是幂等的
--   建库脚本刻意不含 `IF NOT EXISTS`：重复执行报 42P07 并整体回滚，用来拒绝"重复建库"。
--   那条语义是对的，所以它不能用来做增量。本文件相反——**它就是增量的**，因此写成幂等：
--   重复执行零改动，便于"跑没跑过不确定"时直接再跑一次（沿 0002/0003 先例；v2.5 曾误写
--   "沿 0001 拒绝式"，那会让误删表后没有恢复路径）。
--
-- 幂等性的依据
--   1. `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`：已存在即跳过；
--   2. 版本行用 `ON CONFLICT (plugin_id) DO NOTHING`：已登记即跳过。
--
-- 版本行：`('agent-memories', 1)`
--   本表是**站点级跨插件共享表**（butler 与 agents-group 都读写），不挂任何单插件前缀——
--   这是"前缀 ↔ 版本域"惯例的**显式例外**：无前缀表名 + 独立登记主体 `agent-memories`，
--   核验方 = 所有消费插件（启动时读该行做严格相等比对 + 核验 dedup/short_id 两个唯一索引）。
--   结构变更唯一入口 = 本目录新编号迁移 + 版本升位，各消费插件同步发版（设计 §4.2/§6.3）。
--
-- 执行方式（在能连到目标库的机器上；先跑本文件再发消费插件的新版，顺序不能反——
--   新插件的 EXPECTED_TABLES 核验缺表会以 `storage_schema_missing` 拒绝激活）：
--   psql "$DSH_PG_DSN" -v ON_ERROR_STOP=1 -v applied_at="$(date +%s)000" -f private-deploy/db/0004_agent_memories.sql
--
-- 与 0001 的关系
--   表、列、索引逐字等同 `0001_init.sql` 的记忆段。**两处必须一起改**：本文件是给现有库的
--   补丁，那份是新库的初始形状，漏改任何一处都会让"新库"与"旧库补完"变成两种形状。
--
-- 三张表的分工
--   agent_memories          记忆本体（semantic / episodic / instruction 三 kind）。
--   agent_memories_audit    删除/变更审计：只记「谁在哪个 agent 上动了什么」，不含 content
--                           （与「删除=遗忘」的隐私语义兼容），保留 90 天，由定期清理删除。
--   agent_memory_counters   短 id 计数器：按 (agent_id, owner) 一行原子自增、永不重置——
--                           「已删编号不复用」由此保证。v2.5 曾设想"同表加计数行"，不可行：
--                           过不了 agent_memories 自家的 kind/content CHECK，还会被注入查询捞进清单。
--
-- 隔离口径（v2.5 红灯线分层，改这张表的人必须知道）
--   `(owner_namespace, owner_id)` 区分人；`agent_id` 区分智能体。⚠️ 本表与 `dsh_conversations`
--   同构：同人多 Agent 共用一张表 ⇒ **注入与工具查询**的每一条语句 WHERE 都强制三元组等值
--   （agent_id + owner 双列）；**治理查询**（设置页筛选/统计）owner 等值强制 + agent_id 作
--   过滤/分组维度，禁止跨 owner。治理 Tab 的跨 agent 写入是「用户终裁豁免」（以用户身份
--   代管全 agent 行），同样走 kit 单实现。漏 agent_id 的三个后果（串 Agent / 误改他行 /
--   误列清单）在 butler postgres.ts 对 dsh_conversations 的注释里实测在案。
--
-- 刻意不做的（与全库口径一致）
--   - embedding 列：不建。vector 类型依赖 pgvector 扩展，"建列不启用"不可执行；二期随
--     检索方案选型一并迁移（ADD COLUMN 可空列是 O(1) 目录操作，无提前建列收益）。
--   - 软删列：不建。删除=遗忘（隐私语义），溯源由 source_ref 指向既有账本；删除动作本身
--     进 agent_memories_audit（不含内容）。
--   - updated_at 触发器：不建。全库零触发器，更新时间由存储层单入口应用侧维护。
--   - 外键：不建。source_ref 是多态弱引用（会话/任务/无），沿 butler_attachments 口径，
--     "引用对象不存在"由读侧兜住。

BEGIN;

CREATE TABLE IF NOT EXISTS agent_memories (
  id              TEXT    NOT NULL PRIMARY KEY,
  owner_namespace TEXT    NOT NULL,
  owner_id        TEXT    NOT NULL,
  -- 记忆归属的智能体（butler / blog / ...）。注入短标识的命名空间之一，见 short_id。
  agent_id        TEXT    NOT NULL,
  -- 注入短标识（M3 / I2 式：前缀+序号），由 agent_memory_counters 原子分配（v2.5 曾误作
  -- "同表计数行"，v2.6 修正——那过不了自家 CHECK 且会被注入查询捞进清单）；分配域 = 本三元组。
  short_id        TEXT    NOT NULL,
  -- 'semantic'（偏好与稳定事实）| 'episodic'（事件与决策结论）| 'instruction'（用户手写行为指令）。
  -- 读路径按字面量消费，CHECK 钉死取值。
  kind            TEXT    NOT NULL CHECK (kind IN ('semantic','episodic','instruction')),
  -- 一条记忆=一句独立、自包含陈述。DB 只守可判定的形状：非空、无换行、≤200 字
  -- （与注入预算咬合：记忆清单子段 ≤1500 整行字符）；"单句性"是语义约束，由 memory_write
  -- 工具校验与工具描述承担，DB 不装懂。
  content         TEXT    NOT NULL
                    CHECK (content <> ''
                       AND char_length(content) <= 200
                       AND position(chr(10) in content) = 0
                       AND position(chr(13) in content) = 0),
  -- 规范化文本（trim + 连续空白折叠 + NFC + lower）的 sha256 hex；规范化规则单处实现并附
  -- golden-vector 测试钉死（它是持久化数据格式的一部分，改动属破坏性变更）。
  -- 精确重复在 DB 层拦死（并发双写经 ON CONFLICT 消 TOCTOU），近似重复归应用层（只提示不阻断）。
  content_hash    TEXT    NOT NULL,
  -- 来源甄别（v2.5）：'user_statement'（老大原话）| 'reference'（转述资料/网页/工具结果）。
  -- 事实形污染的第一道可见性防线：reference 类写入回复中说破、source_ref 强制非空（应用层）、
  -- importance 压上限（下方复合 CHECK）。
  origin          TEXT    NOT NULL DEFAULT 'user_statement'
                    CHECK (origin IN ('user_statement','reference')),
  -- 1-5，写入时定；用户可在面板调整（origin=reference 被 CHECK 压在 ≤3，提权先升格 origin）。
  importance      SMALLINT NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  -- 'tool'（模型显式写）| 'manual'（用户手写/面板）。P3 蒸馏加 'distill' 时与本文件、
  -- 0001、版本升位一起改（全链条演习，见设计 §6.3 步骤 5）。
  source          TEXT    NOT NULL CHECK (source IN ('tool','manual')),
  -- 来源会话/任务 id；多态弱引用，空串=无（manual 常态）。不设外键（butler_attachments 口径）。
  -- origin='reference' 与（将来的）distill 来源强制非空——由应用层单入口强制。
  source_ref      TEXT    NOT NULL DEFAULT '',
  -- 可选过期（毫秒）；NULL=不过期。读路径永远过滤（正确性的一部分），物理清理归定期清理。
  expires_at      BIGINT,
  created_at      BIGINT  NOT NULL,
  updated_at      BIGINT  NOT NULL,
  -- v2.5 复合约束（DB 层是双插件、多工具路径下唯一不可绕的锚点）：
  --   instruction 只能用户手写（模型不能给自己下指令）；
  --   reference 来源压低权重（记错代价高原则）。
  CONSTRAINT agent_memories_instruction_manual_only
    CHECK (kind <> 'instruction' OR source = 'manual'),
  CONSTRAINT agent_memories_reference_importance_cap
    CHECK (origin <> 'reference' OR importance <= 3)
);
-- 防重键：同 owner+agent+kind 下规范化内容唯一（撞重=可判定的重复；supersedes 撞它时
-- 中止事务、旧行保留，见存储层）。普通唯一索引即可（hash 全量有值，无 NULL 分支）。
CREATE UNIQUE INDEX IF NOT EXISTS agent_memories_dedup
  ON agent_memories (agent_id, owner_namespace, owner_id, kind, content_hash);
-- 短 id 唯一性交给索引（并发正确性不靠"低并发"概率论证）；撞号 = 可重试的 unique violation。
-- 核验面含本索引：被误删时 ON CONFLICT 直接 42P10 响亮报错，但启动核验更早拦住。
CREATE UNIQUE INDEX IF NOT EXISTS agent_memories_short_id
  ON agent_memories (agent_id, owner_namespace, owner_id, short_id);
-- 注入查询全覆盖：三元组等值 + importance/时近排序，尾部 id 兜底同毫秒稳定性
-- （dsh_turns.seq 的教训：created_at 只到毫秒，不兜底会退化成按随机 UUID 排）。
CREATE INDEX IF NOT EXISTS agent_memories_inject
  ON agent_memories (agent_id, owner_namespace, owner_id, importance DESC, updated_at DESC, id);

-- 删除/变更审计：只记「谁在哪个 agent 上动了什么」，不含 content——与「删除=遗忘」的隐私
-- 语义兼容，给诱导删除留归因可能。写路径四动作：forget（工具路径，经页面确认卡）/
-- delete（面板单条与批量，批量逐行插）/ purge（清空，memory_id 空）/ update（面板编辑）。
-- 保留 90 天，与记忆过期物理删除共用同一「定期清理」位。
CREATE TABLE IF NOT EXISTS agent_memories_audit (
  id              TEXT    NOT NULL PRIMARY KEY,
  owner_namespace TEXT    NOT NULL,
  owner_id        TEXT    NOT NULL,
  -- 跨 agent 治理写入（用户终裁豁免）的归因维度。
  agent_id        TEXT    NOT NULL,
  action          TEXT    NOT NULL CHECK (action IN ('forget','delete','purge','update')),
  memory_id       TEXT    NOT NULL DEFAULT '',
  short_id        TEXT    NOT NULL DEFAULT '',
  created_at      BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_memories_audit_owner
  ON agent_memories_audit (owner_namespace, owner_id, created_at DESC);

-- 短 id 计数器：按 (agent_id, owner) 一行，`UPDATE … SET last_n = last_n + 1 RETURNING`
-- 原子自增（行锁下无并发缝隙），永不重置——「已删编号不复用」由此保证；I/M 序号共用
-- 同一计数器（同列存 I3/M7 完整字符串，shared 唯一约束见 agent_memories_short_id）。
CREATE TABLE IF NOT EXISTS agent_memory_counters (
  agent_id        TEXT    NOT NULL,
  owner_namespace TEXT    NOT NULL,
  owner_id        TEXT    NOT NULL,
  last_n          BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, owner_namespace, owner_id)
);

-- 版本行：独立登记主体 'agent-memories'（站点级跨插件共享表，不挂单插件——显式例外见文件头）。
INSERT INTO dsh_schema_versions (plugin_id, version, applied_at)
VALUES ('agent-memories', 1, :applied_at)
ON CONFLICT (plugin_id) DO NOTHING;

COMMIT;
