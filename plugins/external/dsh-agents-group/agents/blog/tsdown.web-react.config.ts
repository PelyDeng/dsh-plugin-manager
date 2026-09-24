import { defineConfig } from 'tsdown'

// React 前端构建（群组二期批 0，照 butler tsdown.web-react.config.ts 同款）：
// - oxc JSX automatic runtime（react-jsx）：产物应为 react/jsx-runtime 形态（批 0 grep 对象）；
// - NODE_ENV define 必做：react/react-dom 的 CJS 入口大量引用它，platform: browser
//   不 polyfill process，漏 define 浏览器直接 ReferenceError；
// - 产物仍叫 dist/web/app.js：复用 /blog/app.js 资源路由特例；
// - alwaysBundle 写**显式包名**（方案 §3.1 定案，不写 [/./]，可审计）：web-common
//   是群组内部共享包，运行时归档里不能留 workspace 依赖。
export default defineConfig({
  entry: ['web-react/src/main.tsx'],
  outDir: 'dist/web',
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  dts: false,
  clean: true,
  deps: { alwaysBundle: ['@dsh-agents-group/web-common'] },
  inputOptions: {
    transform: { jsx: 'react-jsx' },
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  outputOptions: {
    entryFileNames: 'app.js',
  },
})
