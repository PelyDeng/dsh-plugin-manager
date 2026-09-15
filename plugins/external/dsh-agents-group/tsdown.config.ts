import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  // 群组内部的共享包必须内联：运行时归档里不能留 workspace 依赖。
  // kit 同理，它一直是构建期内联的。
  deps: { alwaysBundle: ['@dsh-plugin-manager/plugin-kit', '@dsh-agents-group/common'] },
})
