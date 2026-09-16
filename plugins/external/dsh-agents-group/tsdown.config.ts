import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // 迁移工具的独立入口：归档内没有 TS 运行器，产物必须能直接 node 执行（pg 驱动已 bundle）。
    'migrate-blog-storage': 'scripts/migrate-blog-storage.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  // 群组内部的共享包必须内联：运行时归档里不能留 workspace 依赖。
  // kit 同理，它一直是构建期内联的。
  // pg 是运行时外部依赖，显式声明后必须 alwaysBundle，否则会被当成外部依赖留在 import
  // 语句里——归档的内联安装目录（无 node_modules）跑不起来。
  deps: { alwaysBundle: ['@dsh-plugin-manager/plugin-kit', '@dsh-agents-group/common', 'pg'] },
})
