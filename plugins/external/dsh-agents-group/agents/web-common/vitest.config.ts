import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 基元层的行为护城河：richText/markdown 渲染断言（happy-dom 环境声明在测试文件内）。
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
  },
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite/web-common', import.meta.url)),
})
