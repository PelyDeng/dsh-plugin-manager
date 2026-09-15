import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webApp, webCards, webHtml, webStyles, webTrajectory } from './web-source.ts'

const server = readFileSync(fileURLToPath(new URL('../src/web.ts', import.meta.url)), 'utf8')
const copyAssets = readFileSync(fileURLToPath(new URL('../scripts/copy-web-assets.mjs', import.meta.url)), 'utf8')
const watcher = readFileSync(fileURLToPath(new URL('../scripts/dev-watch.mjs', import.meta.url)), 'utf8')

describe('web asset modules', () => {
  it('keeps the HTML shell separate from first-party styles and behavior', () => {
    expect(webHtml).toContain('<link rel="stylesheet" href="/closedoff-qa/assets/app.css">')
    expect(webHtml).toContain('<script>window.CLOSEDOFF_CONFIG = __WEB_CONFIG__;</script>')
    // 轨迹视图也是页面模块：由 app.js 用 import 拉起，不再走经典脚本 + 全局。
    expect(webHtml).not.toContain('/assets/trajectory.js')
    expect(webHtml).toContain('<script type="module" src="/closedoff-qa/assets/app.js"></script>')
    expect(webHtml).not.toContain('<style>')
    expect(webHtml).not.toContain('(function () {')
    expect(webStyles).toContain(':root {')
    expect(webStyles).toContain('.modal-body { flex: 1; min-height: 0; overflow: auto; }')
    expect(webTrajectory).toContain('export function createTrajectoryView(options) {')
    expect(webApp).toContain("import {createTrajectoryView} from './trajectory.js';")
    expect(webApp).toContain('(function () {')
  })

  it('injects the route and map configuration without hardcoding the default route in assets', () => {
    expect(server).toContain("replace('__WEB_CONFIG__', webConfig)")
    expect(webApp).toContain('var APP_CONFIG = window.CLOSEDOFF_CONFIG;')
    expect(webApp).toContain("var routePath = function (path) { return APP_CONFIG.routePrefix + path; };")
    expect(webApp).not.toContain('/closedoff-qa')
    expect(webTrajectory).not.toContain('/closedoff-qa')
    expect(webStyles).not.toContain('/closedoff-qa')
  })

  it('copies and hot-reloads both first-party assets with revalidation', () => {
    expect(copyAssets).toContain("web/app.css")
    expect(copyAssets).toContain("web/trajectory.js")
    expect(copyAssets).toContain("web/app.js")
    expect(watcher).toContain("'conversation-history.js', 'chat-ui.js', 'chat-base.css'")
    expect(watcher).toContain('const dirtyWebSources = new Set()')
    expect(watcher).toContain('for (const dirtySource of sources)')
    // 页面自己写的资源按文件名直接引用，不能靠内容指纹失效：只要它在 assets 根下就必须回源核验。
    // 这条规则取代了原来手工维护的文件名清单——拆模块时清单必然被漏掉（cards.js 那次就是）。
    expect(server).toContain("const firstParty = !suffix.includes('/')")
    expect(server).toContain("firstParty ? 'no-cache' : 'public, max-age=31536000, immutable'")
    expect(server).not.toContain("['app.css', 'trajectory.js', 'app.js'")
    expect(server).toContain("? 'no-cache'")
  })

  it('copies every module the page imports, so the revalidation rule covers them all', () => {
    // 页面模块之间用相对路径互相引用；漏拷一个或挪进子目录，都会让上面那条规则失效。
    const imported = [...`${webApp}\n${webCards}\n${webTrajectory}`.matchAll(/from '\.\/([\w-]+\.js)'/g)].map(match => match[1])
    expect(imported.length).toBeGreaterThan(0)
    for (const name of new Set(imported)) {
      expect(name).not.toContain('/')
      expect(copyAssets).toContain(`'${name}'`)
    }
  })
})
