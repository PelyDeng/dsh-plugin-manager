/**
 * PG 连接配置来源的解析优先级（方案 §2.5 / §4.4）。
 *
 * 钉住三件事：环境变量优先于文件；两处都没有返回 undefined（由 apply 按装载失败说明，
 * 绝不静默回退）；文件存在但读不出合法 DSN 属配置错误，如实抛出不当作「没有配置」。
 */
import { describe, expect, it } from 'vitest'
import { resolveStorageDsn } from '../src/storage/dsn.ts'

const noFile = async () => { throw new Error('ENOENT') }

describe('存储 DSN 的来源解析', () => {
  it('环境变量 BUTLER_PG_DSN 优先于配置文件', async () => {
    const resolved = await resolveStorageDsn(
      { BUTLER_PG_DSN: 'postgres://from-env', BUTLER_PG_CONFIG: '/x/storage.json' },
      '/home/default.json',
      async () => JSON.stringify({ dsn: 'postgres://from-file' }),
    )
    expect(resolved).toEqual({ dsn: 'postgres://from-env', origin: 'env' })
  })

  it('BUTLER_PG_CONFIG 指定的文件其次；未指定时用缺省路径', async () => {
    const byEnv = await resolveStorageDsn({ BUTLER_PG_CONFIG: '/x/storage.json' }, '/home/default.json',
      async path => (path === '/x/storage.json' ? JSON.stringify({ dsn: 'postgres://by-env-path' }) : '不该读到'))
    expect(byEnv).toEqual({ dsn: 'postgres://by-env-path', origin: 'file' })

    const byDefault = await resolveStorageDsn({}, '/home/default.json',
      async path => (path === '/home/default.json' ? JSON.stringify({ dsn: 'postgres://by-default' }) : '不该读到'))
    expect(byDefault).toEqual({ dsn: 'postgres://by-default', origin: 'file' })
  })

  it('两处都没有时返回 undefined，让装载方按「缺配置」拒绝', async () => {
    expect(await resolveStorageDsn({}, '/home/default.json', noFile)).toBeUndefined()
    // 空白字符串等于没有配置。
    expect(await resolveStorageDsn({ BUTLER_PG_DSN: '   ' }, '/home/default.json', noFile)).toBeUndefined()
  })

  it('文件存在但不是合法 JSON 或缺少 dsn 时如实抛出，不当成「没有配置」', async () => {
    await expect(resolveStorageDsn({}, '/home/default.json', async () => '{not json'))
      .rejects.toThrow(/不是有效 JSON/)
    await expect(resolveStorageDsn({}, '/home/default.json', async () => '{"host":"only-host"}'))
      .rejects.toThrow(/缺少非空的 "dsn" 字段/)
  })
})
