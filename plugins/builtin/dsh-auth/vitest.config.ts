import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['tests/*.spec.ts'] }, cacheDir: fileURLToPath(new URL('../node_modules/.vite/auth', import.meta.url)) })
