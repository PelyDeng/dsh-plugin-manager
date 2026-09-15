import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { index: 'scripts/plugin.ts' }, format: 'esm', outDir: 'dist',
  clean: false, dts: false, deps: { alwaysBundle: ['@dsh-plugin-manager/plugin-kit'] },
})
