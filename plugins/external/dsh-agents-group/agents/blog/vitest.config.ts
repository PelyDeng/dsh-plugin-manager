import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// React 前端等价单测（群组二期批 2a，closedoff vitest.config.ts 同款形态）。
// include 只圈 web-react：子包既有 .test.ts 走 `node --test`（package.json test
// 清单），两套运行器不混跑（群组根 vitest.config.ts 同一口径）。
export default defineConfig({
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/blog', import.meta.url)),
  test: {
    include: ['web-react/src/__tests__/**/*.test.ts'],
  },
})
