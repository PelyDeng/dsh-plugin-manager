import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ["src/index.ts","src/store.ts"],
  format: 'esm',
  dts: true,
  clean: true,
  deps: { alwaysBundle: ['@dsh-plugin/plugin-kit'] },
})
