import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({ cacheDir: fileURLToPath(new URL('../node_modules/.vite/butler-console', import.meta.url)) })
