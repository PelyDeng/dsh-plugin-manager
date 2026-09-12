import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnvConf, parseEnvConf } from '../src/env.ts'

const valid = [
  'CLOSEDOFF_BASE_URL=https://closedoff.example.test/root/',
  'CLOSEDOFF_OPEN_CLIENT_ID=open-id',
  'CLOSEDOFF_OPEN_CLIENT_SECRET=open-secret',
  'CLOSEDOFF_APP_CODE=app-code',
  'CLOSEDOFF_APP_CLIENT_ID=app-id',
  'CLOSEDOFF_APP_CLIENT_SECRET=app-secret',
  'CLOSEDOFF_USERNAME=operator',
  '',
].join('\n')

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('env.conf', () => {
  it('validates all private deployment values', () => {
    expect(parseEnvConf(valid)).toMatchObject({
      baseUrl: 'https://closedoff.example.test/root/',
      credentials: { openClientId: 'open-id', username: 'operator' },
    })
    expect(() => parseEnvConf(valid.replace('CLOSEDOFF_USERNAME=operator', 'CLOSEDOFF_USERNAME='))).toThrow('CLOSEDOFF_USERNAME')
    expect(() => parseEnvConf(valid.replace('CLOSEDOFF_USERNAME=operator', 'CLOSEDOFF_USERNAME=REPLACE_ME'))).toThrow('CLOSEDOFF_USERNAME')
    expect(() => parseEnvConf(valid.replace('https://', 'http://'))).toThrow('HTTPS')
    expect(() => parseEnvConf(valid.replace('closedoff.example.test/root/', 'your-gateway.example/'))).toThrow('configured CLOSEDOFF_BASE_URL')
  })

  it('loads the requested env.conf file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'closedoff-env-'))
    tempDirs.push(dir)
    const path = join(dir, 'env.conf')
    await expect(loadEnvConf(path)).rejects.toThrow('cannot load env.conf')
    await writeFile(path, valid, 'utf8')

    await expect(loadEnvConf(path)).resolves.toMatchObject({ baseUrl: 'https://closedoff.example.test/root/' })
  })
})
