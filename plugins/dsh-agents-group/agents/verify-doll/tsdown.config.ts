import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  platform: 'node',
  target: 'node22.19.0',
  format: 'esm',
  dts: { resolve: false },
  clean: true,
})
