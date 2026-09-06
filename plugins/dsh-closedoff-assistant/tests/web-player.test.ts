import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webSource as web } from './web-source.ts'

const copyAssets = readFileSync(fileURLToPath(new URL('../scripts/copy-web-assets.mjs', import.meta.url)), 'utf8')
const webServer = readFileSync(fileURLToPath(new URL('../src/web.ts', import.meta.url)), 'utf8')
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

describe('custom camera player', () => {
  it('ships the private player runtime and mounts it for returned stream URLs', () => {
    const snapshot = readFileSync(fileURLToPath(new URL('../vendor/hy-media-video-player-0.0.37.tgz', import.meta.url)))
    expect(createHash('sha256').update(snapshot).digest('hex').toUpperCase())
      .toBe('B6445DE8F7F969AAC999683158AB95EF270A799E0013A8D9EA8A3F1EA780AE0E')
    expect(copyAssets).toContain("packageRoot('@hy-media/video-player')")
    expect(copyAssets).toContain("packageRoot('vue')")
    expect(packageJson.dependencies).not.toHaveProperty('@hy-media/video-player')
    expect(packageJson.devDependencies?.['@hy-media/video-player'])
      .toBe('file:vendor/hy-media-video-player-0.0.37.tgz')
    expect(webServer).toContain("const webAssetPath = `${config.routePrefix}/assets`")
    expect(webServer).toContain("'.cjs': 'text/javascript; charset=utf-8'")
    expect(web).toContain("routePath('/assets/video-player/vue.global.prod.js?v=3.5.42')")
    expect(web).toContain("routePath('/assets/video-player/plugin/jessibuca/jessibuca-pro.js?v=0.0.37')")
    expect(web).toContain("routePath('/assets/video-player/index.umd.cjs?v=0.0.37')")
    expect(web).toContain("camera.accessAddress || camera.videoAddress")
    expect(web).toContain("resUrl: routePath('/assets/video-player/plugin/jessibuca')")
    expect(web).toContain('cameraPlayerApp.unmount()')
    expect(web).toContain('cameraPlayerPromise = null')
    expect(web).toContain("if (!window.Vue || !window.hyVideoPlayer || !window.JessibucaPro)")
    expect(web).toContain("case 'media':")
    expect(web).toContain('function renderVehicleMedia(callId, items, astObj)')
    expect(web).toContain("button.textContent = '查看抓拍视频'")
    expect(web).toContain("camera.hideAddress ? '已隐藏'")
    expect(web).toContain("camera.capture ? '抓拍片段'")
    expect(web).toContain("group.captureMode ? '车辆抓拍视频'")
    expect(web).toContain("camera-overlay.capture-mode .camera-sidebar")
    expect(web).not.toContain('capture: true, hideAddress: true, name: selected.startTime || \'抓拍片段\', code: selected.deviceId')
  })

  it('prewarms the player runtime during an idle period after camera groups arrive', () => {
    expect(web).toContain('function scheduleCameraPlayerPrewarm(cams)')
    expect(web).toContain("window.requestIdleCallback(run, { timeout: 2000 })")
    expect(web).toContain('scheduleCameraPlayerPrewarm(cams)')
  })

  it('keeps stop actionable and clears browser-owned resources between conversations', () => {
    expect(web).toContain("label.textContent = TOOL_LABELS[name] || '业务查询'")
    expect(web).toContain("sendBtn.setAttribute('aria-label', '停止回答')")
    expect(web).toContain('activeChatController.abort()')
    expect(web).toContain('signal: controller.signal')
    expect(web).toContain('activeRestoreController.abort()')
    expect(web).toContain('function resetViewState()')
    expect(web).toContain("if (modal) modal.style.display = 'none'")
    expect(web).toContain('trackData = {}')
    expect(web).toContain('localStorage.removeItem')
  })
})
