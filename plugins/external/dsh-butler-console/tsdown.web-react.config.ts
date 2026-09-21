import { defineConfig } from 'tsdown'

// React 前端构建（批 0 定型）。与旧 web 构建的关键差异：
// - oxc JSX automatic runtime（react-jsx）：经 inputOptions.transform 直通 rolldown，
//   产物应为 react/jsx-runtime 形态（批 0 五项实测①的 grep 对象）；
// - NODE_ENV define 必做：react/react-dom 的 CJS 入口大量引用它，platform: browser
//   不 polyfill process，漏 define 浏览器直接 ReferenceError（实测②）；
// - 产物仍叫 dist/web/app.js（复用 /assets/app.js 服务特例，方案 §3.1）。
export default defineConfig({
  entry: ['web-react/src/main.tsx'],
  outDir: 'dist/web',
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  dts: false,
  clean: true,
  deps: { alwaysBundle: [/./] },
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
