import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/huiyu', import.meta.url)),
  test: {
    // 只跑本子包的 TypeScript 测试。子包的 `.mjs` 页面回归由 `node --test` 运行，
    // 混在一起会让同一批用例被跑两遍、且用错运行器（与 blog 同一口径）。
    include: ['tests/**/*.test.ts'],
  },
})
