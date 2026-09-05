import { readdirSync } from 'node:fs'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: readdirSync('src').filter(file => file.endsWith('.mjs')).map(file => `src/${file}`),
  format: 'esm',
  clean: true,
  deps: { alwaysBundle: ['@dsh-plugin/plugin-kit'] },
})
