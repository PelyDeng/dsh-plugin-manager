/**
 * butler 的记忆存储入口（P1.5：实现上收 plugin-kit，本文件只是**插件侧适配层**）。
 *
 * - 全部机制（SQL/规范化/红线/审计/注入查询）来自 `@dsh-plugin-manager/plugin-kit` 的
 *   memory 模块——但ler 与 agents-group 共用这一份实现，不出现第二份定义。
 * - 本文件仅剩两件事：①把插件既有的 pg Pool 适配成 kit 的 `MemoryExecutor`（kit 零
 *   数据库依赖，池生命周期留在插件侧）；②re-export 类型给 butler 内部各消费点。
 * - 语义与 P1 逐条等价；回归方式 = P1 验收清单（tests/memory-*.test.ts）原样通过。
 */
import type { Pool } from 'pg'
import {
  MemoryStore as KitMemoryStore,
  type MemoryExecutor,
} from '@dsh-plugin-manager/plugin-kit'

export type { MemoryKind, MemoryOrigin, MemorySource, MemoryRecord, MemoryWriteInput, MemoryUpdatePatch, MemoryAuditAction, MemoryActor } from '@dsh-plugin-manager/plugin-kit'
export { normalizeContent, contentHash, createMemoryStore, verifyAgentMemoriesSchema, MEMORY_CONTENT_LIMIT, MEMORY_TOOL_WRITABLE_KINDS } from '@dsh-plugin-manager/plugin-kit'

/** pg Pool → kit MemoryExecutor 适配：query 直通（pg 的返回形状天然匹配），事务用池客户端。 */
export function poolToExecutor(pool: Pool): MemoryExecutor {
  return {
    query: async (sql, params) => {
      // 对象形式调用：values 显式 any[]（pg 对 readonly unknown[] 会误入数组行模式重载）。
      const result = await pool.query({ text: sql, values: (params ?? []) as never[] })
      return { rows: result.rows as unknown as Array<Record<string, unknown>>, rowCount: result.rowCount }
    },
    withTransaction: async work => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await work({
          query: async (sql, params) => {
            const inner = await client.query({ text: sql, values: (params ?? []) as never[] })
            return { rows: inner.rows as unknown as Array<Record<string, unknown>>, rowCount: inner.rowCount }
          },
          withTransaction: inner => inner(txOf(client)),
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => { /* 连接已断，归还池后由池的错误监听兜底 */ })
        throw error
      } finally {
        client.release()
      }
    },
  }
}

function txOf(client: { query: Pool['query'] }): MemoryExecutor {
  return {
    query: async (sql, params) => {
      const inner = await client.query({ text: sql, values: (params ?? []) as never[] })
      return { rows: inner.rows as unknown as Array<Record<string, unknown>>, rowCount: inner.rowCount }
    },
    withTransaction: work => work(txOf(client)),
  }
}

export class MemoryStore extends KitMemoryStore {
  constructor(pool: Pool, agentId: string) {
    super(poolToExecutor(pool), agentId)
  }
}
