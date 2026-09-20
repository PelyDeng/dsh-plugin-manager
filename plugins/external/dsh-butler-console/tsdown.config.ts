import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // 迁移工具的独立入口：归档内没有 TS 运行器，产物必须能直接 node 执行（pg 驱动已 bundle）。
    'migrate-storage': 'scripts/migrate-storage.ts',
  },
  format: 'esm',
  // `eager`：声明文件一次算完而不是增量推导。不打开时，从 workspace 包导入的**类型**会在
  // 生成的 .d.ts 里丢掉 `type` 修饰符，随后被当成值去找，报 `Missing export`。
  dts: { eager: true },
  clean: true,
  deps: {
    // `alwaysBundle` 里的包内联进产物；`pg` 也在这里，因为迁移入口要在没有 node_modules 的
    // 归档目录里直接执行。解析包同理——它是 workspace 包，运行时不能留 workspace 依赖。
    // 解析用的 mammoth / pdfjs-dist / yauzl **不内联**：它们由部署时的 pnpm 从 registry 装，
    // 解析包用变量说明符动态 import 它们（见该包 README）。
    alwaysBundle: ['@dsh-plugin-manager/plugin-kit', '@dsh-agents-group/document-parse', 'pg'],
  },
})
