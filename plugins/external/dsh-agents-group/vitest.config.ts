import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/agents-group', import.meta.url)),
  test: {
    // 只跑群组自己的 TypeScript 测试。子包的 .mjs 测试由 `node --test` 运行
    // （见各子包的 test 脚本），混在一起会让同一批用例被跑两遍、且用错运行器。
    include: ['tests/**/*.test.ts'],
  },
})
