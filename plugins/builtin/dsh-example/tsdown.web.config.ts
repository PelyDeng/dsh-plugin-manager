import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['web/app.js'],
  outDir: 'dist/web',
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  dts: false,
  clean: true,
  deps: { alwaysBundle: [/./] },
})
