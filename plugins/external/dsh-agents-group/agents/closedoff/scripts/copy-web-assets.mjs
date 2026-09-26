import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = resolve(root, 'web/assets')
const require = createRequire(import.meta.url)
const packageRoot = name => dirname(require.resolve(`${name}/package.json`))

// 前端资产落位（React 二期批 C1 起单轨）：dist/web/app.js/app.css 由 React 构建链
// （tsdown.web-react.config.ts + tailwindcss）产出，本脚本把产物落位到 web/assets/
// 由既有 /assets 前缀路由服务；app.css 里 @font-face 的 url 是产物相对形态
// （media/fonts/…），字体分片随之落位（唯一源在群组共享包 web-common/media/fonts/）。
// 三方资产（Cesium/@hy-media/vue）与 DSH 图标照旧复制，web/media/ 是它们的唯一源。
await rm(assets, { recursive: true, force: true })
await mkdir(assets, { recursive: true })
await cp(resolve(root, 'dist/web/app.js'), resolve(assets, 'app.js'))
await cp(resolve(root, 'dist/web/app.css'), resolve(assets, 'app.css'))
const fonts = resolve(root, '../web-common/media/fonts')
await cp(resolve(fonts, 'lxgw'), resolve(assets, 'media/fonts/lxgw'), { recursive: true })
await cp(resolve(fonts, 'ma-shan-zheng'), resolve(assets, 'media/fonts/ma-shan-zheng'), { recursive: true })
await cp(resolve(packageRoot('cesium'), 'Build/Cesium'), resolve(assets, 'cesium'), { recursive: true })
await cp(resolve(root, 'web/media/device-group-marker.png'), resolve(assets, 'cesium/device-group-marker.png'))
await cp(resolve(root, 'web/media/icon-think-outline-14.svg'), resolve(assets, 'icon-think-outline-14.svg'))
await cp(resolve(root, 'web/media/icon-api-outline-14.svg'), resolve(assets, 'icon-api-outline-14.svg'))
for (const icon of [
  'icon-copy-outline-16.svg',
  'icon-check-outline-16.svg',
  'icon-like-outline-16.svg',
  'icon-dislike-outline-16.svg',
  'icon-branch-outline-16.svg',
  'icon-database-outline-16.svg',
  'icon-clock-outline-16.svg',
]) {
  await cp(resolve(root, `web/media/${icon}`), resolve(assets, icon))
}
await cp(resolve(packageRoot('@hy-media/video-player'), 'lib'), resolve(assets, 'video-player'), { recursive: true })
await cp(resolve(packageRoot('vue'), 'dist/vue.global.prod.js'), resolve(assets, 'video-player/vue.global.prod.js'))
