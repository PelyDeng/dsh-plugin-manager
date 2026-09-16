import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // 迁移工具的独立入口：归档内没有 TS 运行器，产物必须能直接 node 执行（pg 驱动已 bundle）。
    'migrate-storage': 'scripts/migrate-storage.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  deps: { alwaysBundle: ['@dsh-plugin-manager/plugin-kit', 'pg'] },
})
