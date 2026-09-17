/**
 * 运行时 DSN 来源解析（`packages/runtime/src/storage/dsn.ts`）的优先级与错误边界。
 *
 * 钉住四件事：
 *
 * 1. 环境变量 `AGENTS_GROUP_PG_DSN` 优先，且**根本没读文件**（注入的读函数会抛）；
 * 2. 空白环境变量等于没配：回落到 `AGENTS_GROUP_PG_CONFIG`，再回落到传入的缺省路径；
 * 3. 两处都没有返回 `undefined`（由装载方按「未就绪」处理，绝不静默回退 SQLite）；
 * 4. 文件存在但读不出合法 DSN 属配置错误，如实抛出（消息带路径），不当成「没有配置」。
 *
 * 读文件是注入的，所以每条分支都能在纯内存里判定「选中的是哪一个路径」。
 */
import { describe, expect, it } from 'vitest'
import { resolveStorageDsn } from '../packages/runtime/src/storage/dsn.ts'

/** 文件不存在时的读函数；顺手用来证明某些分支**确实没有读文件**。 */
const noFile = async () => { throw new Error('ENOENT') }

/** 只允许读某个路径：读到别的就抛，于是「用了哪条优先级」是可判定的。 */
const onlyPath = (expected: string, body: string) => async (path: string): Promise<string> => {
  if (path !== expected) throw new Error(`读到了不该读的路径：${path}`)
  return body
}

describe('运行时存储 DSN 的来源解析', () => {
  it('环境变量 AGENTS_GROUP_PG_DSN 非空即用，且根本不读文件', async () => {
    const resolved = await resolveStorageDsn(
      { AGENTS_GROUP_PG_DSN: 'postgres://from-env', AGENTS_GROUP_PG_CONFIG: '/x/env.conf' },
      '/home/default.json',
      noFile, // 真读了文件就会落进"没有配置"，这条断言随即变红。
    )
    expect(resolved).toEqual({ dsn: 'postgres://from-env', origin: 'env' })
  })

  it('环境变量是空白串时视为没配，回落到配置文件', async () => {
    const resolved = await resolveStorageDsn(
      { AGENTS_GROUP_PG_DSN: '   ', AGENTS_GROUP_PG_CONFIG: '/x/env.conf' },
      '/home/default.json',
      onlyPath('/x/env.conf', JSON.stringify({ dsn: 'postgres://by-env-path' })),
    )
    expect(resolved).toEqual({ dsn: 'postgres://by-env-path', origin: 'file' })
  })

  it('env 缺省时读 AGENTS_GROUP_PG_CONFIG 指定的路径', async () => {
    const resolved = await resolveStorageDsn(
      { AGENTS_GROUP_PG_CONFIG: '/x/env.conf' },
      '/home/default.json',
      onlyPath('/x/env.conf', JSON.stringify({ dsn: 'postgres://by-env-path' })),
    )
    expect(resolved).toEqual({ dsn: 'postgres://by-env-path', origin: 'file' })
  })

  it('没给 AGENTS_GROUP_PG_CONFIG（或只给空白）时读传入的缺省路径', async () => {
    const byDefault = await resolveStorageDsn(
      {},
      '/home/default.json',
      onlyPath('/home/default.json', JSON.stringify({ dsn: 'postgres://by-default' })),
    )
    expect(byDefault).toEqual({ dsn: 'postgres://by-default', origin: 'file' })

    // 空白串的路径等于没给：`||` 而不是 `??`。
    const byBlankPath = await resolveStorageDsn(
      { AGENTS_GROUP_PG_CONFIG: '   ' },
      '/home/default.json',
      onlyPath('/home/default.json', JSON.stringify({ dsn: 'postgres://by-default' })),
    )
    expect(byBlankPath).toEqual({ dsn: 'postgres://by-default', origin: 'file' })
  })

  it('配置文件不存在时返回 undefined，而不是抛错', async () => {
    // 没给路径：读缺省路径，文件不存在。
    expect(await resolveStorageDsn({}, '/home/default.json', noFile)).toBeUndefined()
    // 给了路径但那个文件不存在：同样是「没有配置」。
    expect(await resolveStorageDsn({ AGENTS_GROUP_PG_CONFIG: '/x/missing.json' }, '/home/default.json', noFile))
      .toBeUndefined()
    // 空白的环境变量 + 文件不存在：仍然是 undefined，不是抛错。
    expect(await resolveStorageDsn({ AGENTS_GROUP_PG_DSN: '   ' }, '/home/default.json', noFile)).toBeUndefined()
  })

  it('配置文件不是 JSON 时按 env.conf 的 KEY=VALUE 解析（不改名也能换成新格式）', async () => {
    const resolved = await resolveStorageDsn(
      {},
      '/home/default.json',
      async () => 'AGENTS_GROUP_PG_DSN=postgres://by-key-value\n',
    )
    expect(resolved).toEqual({ dsn: 'postgres://by-key-value', origin: 'file' })
  })

  it('env.conf 写法带注释与引号也能读出 DSN', async () => {
    const resolved = await resolveStorageDsn({}, '/home/default.json', async () => [
      '# 群组业务库（PostgreSQL）',
      '',
      'AGENTS_GROUP_PG_DSN="postgres://from-conf"',
      '',
    ].join('\n'))
    expect(resolved).toEqual({ dsn: 'postgres://from-conf', origin: 'file' })
  })

  it('两种写法都没有 DSN 时抛出，消息里带路径', async () => {
    // 既不是 JSON、K/V 里也没有那个键 ⇒ 配置错误，如实抛出（不能当成"没有配置"而静默未就绪）。
    await expect(resolveStorageDsn({}, '/home/default.json', async () => '# 只有注释\n'))
      .rejects.toThrow(/没有可用的 DSN/)
    await expect(resolveStorageDsn({}, '/home/default.json', async () => 'OTHER_KEY=x'))
      .rejects.toThrow(/\/home\/default\.json/)
  })

  it('JSON 合法但没有非空 dsn 时抛出（缺字段 / 空串 / 空白 / 非字符串 / 顶层非对象）', async () => {
    // ⚠️ 这一支**不**回退去按 K/V 再找一遍：文件已经明确是 JSON 了，还去按 KEY=VALUE 找只会把
    // "字段名写错"这种配置错误伪装成"格式不对"，而前者的提示更接近真因。
    const missing = /\/home\/default\.json/
    await expect(resolveStorageDsn({}, '/home/default.json', async () => '{"host":"only-host"}'))
      .rejects.toThrow(missing)
    await expect(resolveStorageDsn({}, '/home/default.json', async () => '{"dsn":""}'))
      .rejects.toThrow(missing)
    await expect(resolveStorageDsn({}, '/home/default.json', async () => '{"dsn":"   "}'))
      .rejects.toThrow(missing)
    await expect(resolveStorageDsn({}, '/home/default.json', async () => '{"dsn":123}'))
      .rejects.toThrow(missing)
    await expect(resolveStorageDsn({}, '/home/default.json', async () => '"postgres://top-level-string"'))
      .rejects.toThrow(missing)
  })

  it('群组业务配置里的 dsn 小节也能读出（DSH 把 AGENTS_GROUP_CONFIG 指向这类文件）', async () => {
    const resolved = await resolveStorageDsn({}, '/home/default.json', async () => JSON.stringify({
      closedoff: { CLOSEDOFF_BASE_URL: 'https://example.invalid' },
      dsn: { dsn: 'postgres://nested' },
    }))
    expect(resolved).toEqual({ dsn: 'postgres://nested', origin: 'file' })
  })

  it('origin 如实反映来源（env / file），dsn 两端的空白被去掉', async () => {
    const byEnv = await resolveStorageDsn({ AGENTS_GROUP_PG_DSN: '  postgres://padded  ' }, '/home/default.json', noFile)
    expect(byEnv?.origin).toBe('env')
    expect(byEnv?.dsn).toBe('postgres://padded')

    const byFile = await resolveStorageDsn({}, '/home/default.json', async () => JSON.stringify({ dsn: '  postgres://from-file  ' }))
    expect(byFile?.origin).toBe('file')
    expect(byFile?.dsn).toBe('postgres://from-file')
  })
})
