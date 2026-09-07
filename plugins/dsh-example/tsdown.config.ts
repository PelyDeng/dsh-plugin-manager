import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'

const knowledge = ['guide.md', 'prompts.md'].map(file => readFileSync(new URL(`knowledge/${file}`, import.meta.url), 'utf8')).join('\n\n')
if (Buffer.byteLength(knowledge) > 32 * 1024) throw new Error('example: 公开知识超过 32 KiB，请精简后构建。')

export default defineConfig({
  entry: ["src/index.ts"],
  format: 'esm',
  dts: true,
  clean: true,
  deps: { alwaysBundle: ['@dsh-plugin/plugin-kit'] },
})
