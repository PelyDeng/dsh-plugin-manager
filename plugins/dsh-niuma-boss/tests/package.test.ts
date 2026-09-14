import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 发布清单一致性：files 必须覆盖服务端与页面产物，verifyFiles 不得指向包外路径。 */
const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  files: string[]
  deepseekPlugin: { verifyFiles: string[]; entryPath: string; healthPath: string; permissions: string[] }
}

describe('发布清单', () => {
  it('files 同时包含服务端 dist 与页面 web 产物', () => {
    expect(manifest.files).toContain('dist/')
    expect(manifest.files).toContain('web/')
  })

  it('verifyFiles 都落在 files 声明的目录内', () => {
    const roots = manifest.files.filter(f => f.endsWith('/'))
    for (const file of manifest.deepseekPlugin.verifyFiles) {
      expect(roots.some(root => file.startsWith(root)), `verifyFile 不在发布目录内：${file}`).toBe(true)
    }
  })

  it('入口与健康检查路径及权限声明完整', () => {
    expect(manifest.deepseekPlugin.entryPath).toBe('/niuma-boss')
    expect(manifest.deepseekPlugin.healthPath.startsWith(manifest.deepseekPlugin.entryPath + '/')).toBe(true)
    expect(manifest.deepseekPlugin.permissions).toContain('niuma-boss:access')
  })
})
