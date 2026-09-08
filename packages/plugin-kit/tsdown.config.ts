import { copyFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/access.ts', 'src/http.ts', 'src/tools.ts', 'src/conversations.ts', 'src/route-path.mjs'],
  format: 'esm',
  dts: true,
  clean: true,
  hooks: { 'build:done': () => { copyFileSync('src/route-path.d.mts', 'dist/route-path.d.mts') } },
})
