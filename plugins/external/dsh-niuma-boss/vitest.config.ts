import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/niuma-boss', import.meta.url)),
  // 只跑本插件自己的测试；docs/ 里的过程脚本不是 vitest 用例。
  test: { include: ['tests/**/*.test.ts'] },
})
