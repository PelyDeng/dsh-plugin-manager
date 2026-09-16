/**
 * 运行时就绪探针（`PostgresTaskStorage.readyProbe`，§2.5 运行期翻转）的无 PG 单测。
 *
 * 这里只测**不需要 PG 供给**的两种失败路径：连接拒绝（127.0.0.1:1，本机立即拒绝，
 * 无需 Docker）与 close 后拒绝。成功与版本不符路径需要真实 PG，放在
 * `acceptance-pg-contract.test.ts`（`BUTLER_TEST_PG_DSN` 门控），那里一并验证稳定码。
 */
import { describe, expect, it } from 'vitest'
import { StorageError } from '../src/storage/errors.ts'
import { PostgresTaskStorage } from '../src/storage/postgres.ts'

/** 连接必被拒绝的地址：端口 1 上没有监听者，本机回环立即 ECONNREFUSED。 */
const REFUSED_DSN = 'postgresql://127.0.0.1:1/butler_test'

describe('readyProbe（无 PG 供给的失败路径）', () => {
  it('PG 不可达（连接拒绝）：以 storage_unreachable 拒绝，且有界返回', async () => {
    const storage = new PostgresTaskStorage(REFUSED_DSN)
    try {
      const startedAt = Date.now()
      await expect(storage.readyProbe()).rejects.toSatisfy((error: unknown) =>
        error instanceof StorageError && error.code === 'storage_unreachable',
      )
      // 超时上限 1.5s：连接拒绝应远快于上限；断言收紧到 2s——留 0.5s 环境余量，
      // 超过即视为有界性回归。
      expect(Date.now() - startedAt).toBeLessThanOrEqual(2000)
    } finally {
      await storage.close()
    }
  })

  it('close 之后：readyProbe 与业务读写一样以 storage_closed 拒绝', async () => {
    const storage = new PostgresTaskStorage(REFUSED_DSN)
    await storage.close()
    await expect(storage.readyProbe()).rejects.toSatisfy((error: unknown) =>
      error instanceof StorageError && error.code === 'storage_closed',
    )
    // 重复 close 保持安全。
    await expect(storage.close()).resolves.toBeUndefined()
  })
})
