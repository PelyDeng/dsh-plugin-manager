import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webApp, webHtml, webStyles, webTrajectory } from './web-source.ts'

const server = readFileSync(fileURLToPath(new URL('../src/web.ts', import.meta.url)), 'utf8')
const copyAssets = readFileSync(fileURLToPath(new URL('../scripts/copy-web-assets.mjs', import.meta.url)), 'utf8')
const watcher = readFileSync(fileURLToPath(new URL('../scripts/dev-watch.mjs', import.meta.url)), 'utf8')

describe('web asset modules', () => {
  it('keeps the HTML shell separate from first-party styles and behavior', () => {
    expect(webHtml).toContain('<link rel="stylesheet" href="/closedoff-qa/assets/app.css">')
    expect(webHtml).toContain('<script>window.CLOSEDOFF_CONFIG = __WEB_CONFIG__;</script>')
    expect(webHtml).toContain('<script src="/closedoff-qa/assets/trajectory.js"></script>')
    expect(webHtml).toContain('<script src="/closedoff-qa/assets/app.js"></script>')
    expect(webHtml).not.toContain('<style>')
    expect(webHtml).not.toContain('(function () {')
    expect(webStyles).toContain(':root {')
    expect(webStyles).toContain('.modal-body { flex: 1; min-height: 0; overflow: auto; }')
    expect(webTrajectory).toContain('global.ClosedoffTrajectory = { create: createTrajectoryView };')
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
    expect(watcher).toContain("['index.html', 'app.css', 'trajectory.js', 'app.js']")
    expect(watcher).toContain('const dirtyWebSources = new Set()')
    expect(watcher).toContain('for (const dirtySource of sources)')
    expect(server).toContain("suffix === 'app.css' || suffix === 'trajectory.js' || suffix === 'app.js'")
    expect(server).toContain("? 'no-cache'")
  })
})
