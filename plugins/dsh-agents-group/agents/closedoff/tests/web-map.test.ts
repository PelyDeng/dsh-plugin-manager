import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webSource as web } from './web-source.ts'

const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const copyAssets = readFileSync(fileURLToPath(new URL('../scripts/copy-web-assets.mjs', import.meta.url)), 'utf8')
// 部署配置搬到群组级 patch 了：群组只有一个 runtimeConfig、一行 Bundle 配置，
// 本子包的字段放在群组的 agents.closedoff.config 下。这条断言守的契约不变 ——
// 「tileset 高度仍然可以通过部署环境变量覆盖」，只是声明的位置换了。
const cordisPatch = readFileSync(fileURLToPath(new URL('../../../cordis.patch.yml', import.meta.url)), 'utf8')
const snapshotQueueStart = web.indexOf('  function queueTrajectorySnapshot(')
const snapshotQueueEnd = web.indexOf('  function redrawTrack(', snapshotQueueStart)
const snapshotQueueSource = web.slice(snapshotQueueStart, snapshotQueueEnd)

describe('Cesium map runtime', () => {
  it('ships public Cesium 1.142.0 and calibrates the tileset before framing the complete trajectory', () => {
    expect(packageJson.devDependencies?.cesium).toBe('1.142.0')
    expect(packageJson.dependencies).not.toHaveProperty('@prism-next/core')
    expect(copyAssets).not.toContain('@prism-next/core')
    expect(web).not.toContain('Prism')
    expect(web).toContain('new Cesium.Viewer')
    expect(web).toContain('Cesium.Cesium3DTileset.fromUrl')
    expect(web).toContain('viewer.scene.primitives.add(tileset)')
    expect(web).toContain('maximumScreenSpaceError: 2')
    expect(web).not.toContain('maximumScreenSpaceError: perspective ? 2 : 4')
    expect(web).toContain('tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation)')
    expect(web).toContain('new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), 0)')
    expect(web).toContain('await viewer.flyTo(viewer.entities, { duration: 0, offset: trajectoryOffset })')
    expect(web.indexOf('setTilesetHeight(tileset, MAP_CONFIG.tilesetHeight, Cesium)'))
      .toBeLessThan(web.indexOf('await viewer.flyTo(viewer.entities, { duration: 0, offset: trajectoryOffset })'))
    expect(web).not.toContain('viewer.flyTo(tileset')
    expect(web).not.toContain('depthTestAgainstTerrain = false')
    expect(web).toContain("container.dataset.mapEngine = 'CesiumJS@1.142.0'")
    expect(web).toContain('cesiumPromise = null')
    expect(web).toContain("if (!window.Cesium) throw new Error('Cesium 资源未正确初始化')")
    expect(web).toContain('function cancelMap(container)')
    expect(web).toContain('if (container._generation !== generation)')
    expect(web).toContain('container.dataset.tilesetHeight = String(MAP_CONFIG.tilesetHeight)')
    expect(cordisPatch).toContain('CLOSEDOFF_TILESET_HEIGHT')
    expect(cordisPatch).not.toContain('CLOSEDOFF_TILESET_FLY_TO_RANGE')
  })

  it('renders queued static snapshots inline and saves only the fullscreen view on demand', () => {
    expect(web).toContain('contextOptions: { webgl: { preserveDrawingBuffer: true } }')
    expect(web).toContain('requestRenderMode: true')
    expect(web).toContain('new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-55), 0)')
    expect(web).toContain("image: DEVICE_GROUP_MARKER")
    expect(web).toContain("text: group.groupName || '设备组'")
    expect(web).toContain("endpoint('start', route[0], '起点' + (route[0].t ? '\\n' + route[0].t : '')")
    expect(web).toContain("endpoint('end', route[route.length - 1], '终点' + (route[route.length - 1].t ? '\\n' + route[route.length - 1].t : '')")
    expect(web).toContain('function waitForSnapshotView(viewer, tileset, container, generation, target, offset)')
    expect(web).toContain("viewer.canvas.toDataURL('image/jpeg', 0.88)")
    expect(web).toContain("image.className = 'track-snapshot'")
    expect(web).toContain('.track-snapshot { display: block; width: 100%; height: 100%; object-fit: contain; }')
    expect(web).toContain('var snapshotQueue = Promise.resolve()')
    expect(web).toContain('function queueTrajectorySnapshot(render, cams, callId)')
    expect(web).toContain('snapshotQueue = snapshotQueue.then(runSnapshot, runSnapshot)')
    expect(web).toContain('return mountMap(render.map, render.pts, cams, callId, false, true, function ()')
    expect(web).toContain('queueTrajectorySnapshot(render, cams, callId)')
    expect(web).toContain("if (container._snapshotCancel) container._snapshotCancel(new Error('轨迹截图已取消'))")
    expect(web).toContain('container._snapshotCancel = cancel')
    expect(web).toContain('mountMap(container, pts, cams || [], callId, true, false, undefined, fences)')
    expect(web).toContain('function captureTrajectoryMap(container, callId, button)')
    expect(web).toContain('function waitForCaptureFrame(container, timeoutMs)')
    expect(web).toContain('cameraController.enableInputs = false')
    expect(web).toContain('container._captureCancel = cancel')
    expect(web).toContain("canvas.toBlob(function (blob)")
    expect(web).toContain('var url = URL.createObjectURL(blob)')
    expect(web).toContain('setTimeout(function () { releaseDownloadUrl(url); }, 60000)')
    expect(web).toContain('try {')
    expect(web).toContain('} finally {')
    expect(web).toContain("modalCapture.innerHTML = IC.camera + ' 截图并保存'")
    expect(web).toContain("modalCapture.onclick = function () { captureTrajectoryMap(container, callId, modalCapture); }")
    expect(web).not.toContain("capture.onclick = function () { captureTrajectoryMap(map")
    expect(web.match(/captureTrajectoryMap\(/g)).toHaveLength(2)
    expect(web).toContain("btn.innerHTML = IC.locate + ' 全屏查看'")
    expect(web).toContain("轨迹示意图（三维场景截图）")
    expect(web).not.toContain('new IntersectionObserver')
  })

  it('serializes snapshot jobs and continues after a failed job', async () => {
    type Render = { map: { isConnected: boolean, dataset: Record<string, string>, setAttribute: () => void }, pts: unknown[], snapshotToken: number }
    const starts: string[] = []
    const pending: Array<{ resolve: () => void, reject: (error: Error) => void }> = []
    const mountMap = (_map: unknown, _pts: unknown, _cams: unknown, callId: string) => {
      starts.push(callId)
      return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }))
    }
    const compile = new Function(
      'cancelMap', 'mapStatus', 'mountMap',
      `'use strict'; var snapshotQueue = Promise.resolve(); ${snapshotQueueSource}; return { queueTrajectorySnapshot, drain: function () { return snapshotQueue; } };`,
    ) as (...args: unknown[]) => { queueTrajectorySnapshot: (render: Render, cams: unknown[], callId: string) => void, drain: () => Promise<void> }
    const api = compile(() => undefined, () => undefined, mountMap)
    const render = (): Render => ({ map: { isConnected: true, dataset: {}, setAttribute: () => undefined }, pts: [], snapshotToken: 0 })

    api.queueTrajectorySnapshot(render(), [], 'first')
    api.queueTrajectorySnapshot(render(), [], 'second')
    await Promise.resolve()
    expect(starts).toEqual(['first'])

    pending[0]?.reject(new Error('snapshot failed'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(starts).toEqual(['first', 'second'])
    pending[1]?.resolve()
    await api.drain()
  })
})
