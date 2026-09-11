import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web', base: './', plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
})
