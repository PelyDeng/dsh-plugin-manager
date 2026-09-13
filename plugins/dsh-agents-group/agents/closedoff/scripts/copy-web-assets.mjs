import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assets = resolve(root, 'web/assets')
const require = createRequire(import.meta.url)
const packageRoot = name => dirname(require.resolve(`${name}/package.json`))

await rm(assets, { recursive: true, force: true })
await mkdir(assets, { recursive: true })
await cp(resolve(root, 'web/app.css'), resolve(assets, 'app.css'))
await cp(resolve(root, 'web/trajectory.js'), resolve(assets, 'trajectory.js'))
await cp(resolve(root, 'web/app.js'), resolve(assets, 'app.js'))
for (const file of ['model-picker.js','media/icon-check.svg','media/icon-chevron-down.svg']) await cp(resolve(root,'web',file),resolve(assets,file.replace('media/','')))
for (const file of ['conversation-history.js', 'chat-ui.js', 'chat-base.css', 'render-text.js', 'format.js', 'labels.js']) await cp(resolve(root, 'web', file), resolve(assets, file))
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
