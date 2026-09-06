import { defineConfig } from 'tsdown';
export default defineConfig({ entry: ['src/index.mjs'], format: 'esm', deps: { alwaysBundle: ['@dsh-plugin/plugin-kit'] } });
