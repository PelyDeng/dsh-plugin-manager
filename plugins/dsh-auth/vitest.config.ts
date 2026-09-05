import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({ cacheDir: fileURLToPath(new URL('../node_modules/.vite/auth', import.meta.url)) })
