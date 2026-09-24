/**
 * @hy-media/video-player 播放器飞地（旧 web/trajectory-camera.js 的播放器段迁移）。
 *
 * 三方链 @hy-media(Vue 组件)+JessibucaPro 与 Cesium 同规：不 bundling 不迁移，
 * loadScript 按需挂 window（Vue/hyVideoPlayer/JessibucaPro 三件齐才可用），React 侧
 * 只给一个 host div——Vue createApp 的 mount/unmount 与 React 渲染完全隔离（同一套
 * 飞地防护：容器渲染权归 Vue、host 不带 children 不换节点、卸载必 unmount）。
 *
 * 预热（旧 scheduleCameraPlayerPrewarm）：列表里出现可播摄像头时在空闲时隙预载脚本，
 * 首次点开弹窗少等三段 script。
 */

/** Vue 3 应用面（@hy-media 播放器组件经 createApp 挂载；只声明用到的链）。 */
interface HyVueApp {
  provide(key: string, value: unknown): HyVueApp
  mount(host: HTMLElement): void
  unmount(): void
}

interface HyVueLike {
  createApp(component: unknown): HyVueApp
  h(component: unknown, props: Record<string, unknown>): unknown
}

interface HyWindow {
  Vue?: HyVueLike
  hyVideoPlayer?: { hyVideoPlayer: unknown }
  JessibucaPro?: unknown
}

export interface HyPlayerHost {
  host: HTMLElement
  app: { unmount(): void } | null
}

function hyWindow(): HyWindow {
  return globalThis as HyWindow
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`资源加载失败：${src}`))
    document.head.appendChild(script)
  })
}

let playerPromise: Promise<void> | null = null

/** 按需加载播放器三件（旧 loadCameraPlayer 同顺序：vue → jessibuca-pro → 组件 umd）。 */
export function loadHyPlayer(routePath: (path: string) => string): Promise<void> {
  const win = hyWindow()
  if (win.Vue !== undefined && win.hyVideoPlayer !== undefined && win.JessibucaPro !== undefined) return Promise.resolve()
  if (playerPromise === null) {
    playerPromise = loadScript(routePath('/assets/video-player/vue.global.prod.js?v=3.5.42'))
      .then(() => loadScript(routePath('/assets/video-player/plugin/jessibuca/jessibuca-pro.js?v=0.0.37')))
      .then(() => loadScript(routePath('/assets/video-player/index.umd.cjs?v=0.0.37')))
      .then(() => {
        if (win.Vue === undefined || win.hyVideoPlayer === undefined || win.JessibucaPro === undefined) {
          throw new Error('定制播放器资源未正确初始化')
        }
      })
      .catch((error: unknown) => {
        playerPromise = null
        throw error
      })
  }
  return playerPromise
}

/** 列表里是否存在可播摄像头（旧 hasPlayableCamera：accessAddress/videoAddress 任一）。 */
export function hasPlayableCamera(groups: ReadonlyArray<Record<string, unknown>>): boolean {
  return groups.some(group => {
    const devices = Array.isArray(group.devices) ? group.devices : []
    return devices.some(device => {
      const record = device as Record<string, unknown>
      return Boolean(record.accessAddress || record.videoAddress)
    })
  })
}

/** 空闲时隙预载（旧 scheduleCameraPlayerPrewarm：requestIdleCallback 优先）。 */
export function prewarmHyPlayer(groups: ReadonlyArray<Record<string, unknown>>, routePath: (path: string) => string): boolean {
  if (!hasPlayableCamera(groups)) return false
  const run = (): void => { void loadHyPlayer(routePath).catch(() => { /* 预热失败静默，点开时再报 */ }) }
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 2000 })
  else window.setTimeout(run, 600)
  return true
}

/**
 * 在 host 上挂播放器（旧 renderCameraPreview 的 Vue app 段原样：URL/自动播放/
 * AI 增强/工具条配置与 hyPlayerGconfig provide）。
 */
export function mountHyPlayer(
  host: HTMLElement,
  url: string,
  routePath: (path: string) => string,
  resUrlPath: string,
): { unmount(): void } {
  const win = hyWindow()
  if (win.Vue === undefined || win.hyVideoPlayer === undefined) throw new Error('定制播放器资源未正确初始化')
  const resUrl = routePath(resUrlPath)
  const app = win.Vue.createApp({
    render: () => win.Vue?.h(win.hyVideoPlayer?.hyVideoPlayer, {
      url,
      autoPlay: true,
      isAi: true,
      controlAutoHide: true,
      resUrl,
      configOperates: { ai: true, ptz: false, close: false, fullscreen: true, screenshot: true, record: false, zoom: true },
    }),
  })
  app.provide('hyPlayerGconfig', { isDev: false, resUrl, isAi: false })
  app.mount(host)
  return app
}
