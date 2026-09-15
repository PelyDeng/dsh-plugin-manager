import { defineConfig } from 'tsdown'

// 页面产物在 web/；tsdown 只负责 dist/ 的服务端入口，不清理其它目录。
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  outDir: 'dist',
  deps: { alwaysBundle: ['@dsh-plugin-manager/plugin-kit'] },
})
