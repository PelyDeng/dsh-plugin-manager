import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/niuma-boss/',
  plugins: [vue()],
  // 页面产物进 web/（与管家一致），tsdown 的服务端入口进 dist/，两者共同构成发布包。
  build: { outDir: 'web', emptyOutDir: true },
})
