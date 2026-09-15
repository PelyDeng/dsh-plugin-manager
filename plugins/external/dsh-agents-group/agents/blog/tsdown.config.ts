import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/protocol.ts'], format: 'esm', dts: true, clean: true,
  deps: { alwaysBundle: ['@dsh-plugin-manager/plugin-kit'] },
})
