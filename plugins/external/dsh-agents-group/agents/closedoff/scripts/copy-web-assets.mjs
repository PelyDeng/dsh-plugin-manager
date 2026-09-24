import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = resolve(root, 'web/assets')
const require = createRequire(import.meta.url)
const packageRoot = name => dirname(require.resolve(`${name}/package.json`))

// 双轨开关（群组二期批 0，方案 §4.4）：dist/web/app.js 只由 React 构建链
// （tsdown.web-react.config.ts）产出，旧链完全不产 dist/web——构建哪个前端，
// 这个脚本就落位哪条链的资产。三方资产（Cesium/@hy-media/vue）两轨都需要，照旧复制。
const reactTrack = existsSync(resolve(root, 'dist/web/app.js'))

await rm(assets, { recursive: true, force: true })
await mkdir(assets, { recursive: true })
if (reactTrack) {
  // React 轨：构建产物（app.js/app.css）落 assets 根，由既有 /assets 前缀路由服务；
  // app.css 里 @font-face 的 url 是产物相对形态（media/fonts/…），字体分片随之落位
  // （唯一源在群组共享包 web-common/media/fonts/）。
  await cp(resolve(root, 'dist/web/app.js'), resolve(assets, 'app.js'))
  await cp(resolve(root, 'dist/web/app.css'), resolve(assets, 'app.css'))
  const fonts = resolve(root, '../web-common/media/fonts')
  await cp(resolve(fonts, 'lxgw'), resolve(assets, 'media/fonts/lxgw'), { recursive: true })
  await cp(resolve(fonts, 'ma-shan-zheng'), resolve(assets, 'media/fonts/ma-shan-zheng'), { recursive: true })
} else {
  // 旧轨：第一方页面模块照旧从 web/ 根拷入（React 迁移批 3 删码时此分支移除）。
  await cp(resolve(root, 'web/app.css'), resolve(assets, 'app.css'))
  await cp(resolve(root, 'web/trajectory.js'), resolve(assets, 'trajectory.js'))
  await cp(resolve(root, 'web/app.js'), resolve(assets, 'app.js'))
  for (const file of ['model-picker.js','media/icon-check.svg','media/icon-chevron-down.svg']) await cp(resolve(root,'web',file),resolve(assets,file.replace('media/','')))
  for (const file of ['conversation-history.js', 'chat-ui.js', 'chat-base.css', 'render-text.js', 'format.js', 'labels.js', 'cards.js', 'trajectory-data.js', 'trajectory-camera.js']) await cp(resolve(root, 'web', file), resolve(assets, file))
}
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
