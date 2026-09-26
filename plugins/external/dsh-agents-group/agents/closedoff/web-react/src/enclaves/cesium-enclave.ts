/**
 * Cesium 受控飞地引擎（旧 web/trajectory.js 地图机制的整体迁移，方案 §2 不变量 4）。
 *
 * 【Cesium 飞地防护（参照 butler RichText 飞地四坑注释的思路）】三方库对 React 完全
 * 不透明，四个具体的坑与对策：
 * 1. 容器渲染权全归 Cesium：容器内的一切（canvas/截图 img/状态条）都由本引擎经 DOM
 *    API 写入，React 侧容器永不带 children、永不 touch container 内部——reconciliation
 *    不覆盖它正是设计意图；
 * 2. 不 remount / key 稳定：容器节点由组件首帧创建后不再换位；本引擎与容器一一绑定
 *    （TrackMapSession 持有 container），cameras 晚到等数据重排走同一容器的重挂载
 *    （内部 generation 计数顶替），绝不换容器节点；
 * 3. className 管辖权：容器 className 由组件固定传入且不随重渲变化（Cesium 不改容器
 *    class，但会注入子节点与内部 widget class——都归 Cesium/引擎，React 不读不写）；
 * 4. 卸载时 destroy + 清理容器属性：dispose 走 destroyMap 全链（readiness/capture 的
 *    事件监听与定时器、viewer.destroy()、容器自定义属性清空、innerHTML 清空、dataset
 *    复位）——viewer 是 WebGL 上下文持有者，漏 destroy 即上下文泄漏，反复开关弹窗
 *    会撞浏览器「Too many active WebGL contexts」上限。异步链（loadCesium→terrain→
 *    tileset→flyTo）每段 await 后核对 generation/disposed，过期即弃且就地销毁半成品。
 *
 * 与旧实现的机制对照：loadScript 按需挂 window.Cesium（不 bundling 不迁移）、
 * viewer/tileset 挂容器属性（泄漏排查可视）、快照串行队列（任意时刻至多一个 viewer
 * 在建）、截图的 requestRender/postRender/hasTile 链——语义照搬，形态从「模块内闭包」
 * 改成「每容器一个 session 对象」。
 *
 * 环境适配（对照表登记项）：mapConfig.terrainUrl/tilesetUrl 为空串时降级——椭球地形
 * + 跳过 3D Tiles。真实部署两项恒非空，路径不变；这是 mock/离线环境（无地形与
 * 三维模型服务）能真实渲染的最低限度适配。
 */
import type { MapConfig } from '../lib/config.ts'
import type { FenceGeometry, TrackDeviceGroup, TrackPoint } from '../lib/types.ts'
import { fencePoints, geoPoint } from '../lib/trajectory-data.ts'
import { errorTextOf } from '@dsh-agents-group/web-common'

// ── window 形状（三方库不 bundling 不迁移，静态服务直引；只声明用到的面）────

interface CesiumColorLike { withAlpha(alpha: number): CesiumColorLike }
interface CesiumEntityLike { id: string }
interface CesiumViewerLike {
  entities: { add(entity: unknown): CesiumEntityLike }
  scene: {
    pick(position: unknown): { id?: CesiumEntityLike } | undefined
    requestRender(): void
    postRender: { addEventListener(fn: () => void): () => void }
    screenSpaceCameraController: { enableInputs: boolean }
    globe: { baseColor: unknown; depthTestAgainstTerrain: boolean }
    primitives: { add(prim: unknown): void }
  }
  canvas: HTMLCanvasElement
  /** 按容器当前尺寸重设画布（构造时容器可能尚未布局，React effect 内需显式调一次）。 */
  resize(): void
  isDestroyed(): boolean
  destroy(): void
  flyTo(target: unknown, options: unknown): Promise<unknown>
  screenSpaceEventHandler: {
    setInputAction(action: (movement: { position: unknown }) => void, type: unknown): void
  }
}
interface CesiumTilesetLike {
  boundingSphere: { center: unknown }
  modelMatrix: unknown
  show: boolean
  tilesLoaded: boolean
  tileVisible: { addEventListener(fn: () => void): () => void }
  allTilesLoaded: { addEventListener(fn: () => void): () => void }
  destroy?(): void
  isDestroyed?(): boolean
}

/** Cesium 命名空间最小面（形状以静态服务的 CesiumJS 1.142.0 为准，只覆盖用到的 API）。 */
interface CesiumNamespace {
  VERSION: string
  Viewer: new (container: HTMLElement, options: Record<string, unknown>) => CesiumViewerLike
  CesiumTerrainProvider: { fromUrl(url: string, options?: Record<string, unknown>): Promise<unknown> }
  EllipsoidTerrainProvider: new () => unknown
  Cesium3DTileset: { fromUrl(url: string, options?: Record<string, unknown>): Promise<CesiumTilesetLike> }
  ImageryLayer: { fromProviderAsync(promise: Promise<unknown>): unknown }
  TileMapServiceImageryProvider: { fromUrl(url: unknown): Promise<unknown> }
  buildModuleUrl(path: string): string
  Color: { fromCssColorString(css: string): CesiumColorLike; WHITE: CesiumColorLike; BLACK: CesiumColorLike }
  Cartesian2: new (x: number, y: number) => unknown
  Cartesian3: {
    fromDegrees(lon: number, lat: number, h: number): unknown
    fromRadians(lon: number, lat: number, h: number): unknown
    subtract(left: unknown, right: unknown, result: unknown): unknown
    new (): unknown
  }
  Cartographic: { fromCartesian(cartesian: unknown): { longitude: number; latitude: number; height: number } }
  Matrix4: { fromTranslation(translation: unknown): unknown }
  Math: { toRadians(deg: number): number }
  HeadingPitchRange: new (heading: number, pitch: number, range: number) => unknown
  NearFarScalar: new (near: number, nearValue: number, far: number, farValue: number) => unknown
  DistanceDisplayCondition: new (near: number, far: number) => unknown
  VerticalOrigin: { BOTTOM: unknown }
  LabelStyle: { FILL_AND_OUTLINE: unknown }
  PolygonHierarchy: new (positions: unknown[]) => unknown
  ScreenSpaceEventType: { LEFT_CLICK: unknown }
}

declare global {
  interface Window {
    CESIUM_BASE_URL?: string
    Cesium?: CesiumNamespace
  }
}

// ── 飞地载荷 ─────────────────────────────────────────────────────────────────

export interface TrackMapPayload {
  /** 原始轨迹点（字段别名两套写法，geoPoint 收敛）。 */
  points: readonly TrackPoint[]
  /** 轨迹沿途设备组（billboard + 点击开摄像头弹窗）。 */
  groups: readonly TrackDeviceGroup[]
  /** 围栏几何（非空时画围栏、不画轨迹线——旧 renderFences 分支）。 */
  fences?: readonly FenceGeometry[]
  /** 车牌（快照 alt 与下载文件名）。 */
  vehicleNo?: string
}

export interface TrackMapOptions {
  mapConfig: MapConfig
  /** 业务资源路径（Cesium 静态根与设备组图标）。 */
  routePath: (path: string) => string
  /** 点击设备组 billboard 的回传（接摄像头弹窗）。 */
  onGroupClick?: (group: TrackDeviceGroup) => void
}

const CESIUM_SCRIPT = '/assets/cesium/Cesium.js?v=1.142.0'
/** 轨迹线/起终点/围栏的域色（旧 addMapContent/addFenceContent 原样）。 */
const ROUTE_COLOR = '#3370ff'
const ROUTE_DEPTH_FAIL = '#8bb5ff'
const START_COLOR = '#22a06b'
const END_COLOR = '#ef4b56'
const FENCE_COLORS = ['#12b8c4', '#f59e0b', '#a855f7', '#3370ff']
/** 截图链超时（旧 waitForCaptureFrame 10s / readiness 15s / snapshot 视角 7s）。 */
const CAPTURE_TIMEOUT_MS = 10000
const READINESS_TIMEOUT_MS = 15000
const SNAPSHOT_VIEW_TIMEOUT_MS = 7000

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`资源加载失败：${src}`))
    document.head.appendChild(script)
  })
}

let cesiumPromise: Promise<CesiumNamespace> | null = null

/** 按需加载 Cesium（模块级单例，旧 loadCesium 同形态；失败后允许重试）。 */
export function loadCesium(routePath: (path: string) => string): Promise<CesiumNamespace> {
  if (window.Cesium !== undefined) return Promise.resolve(window.Cesium)
  if (cesiumPromise === null) {
    window.CESIUM_BASE_URL = routePath('/assets/cesium/')
    cesiumPromise = loadScript(routePath(CESIUM_SCRIPT))
      .then(() => {
        if (window.Cesium === undefined) throw new Error('Cesium 资源未正确初始化')
        return window.Cesium
      })
      .catch((error: unknown) => {
        cesiumPromise = null
        throw error
      })
  }
  return cesiumPromise
}

// ── 快照串行队列（旧 snapshotQueue：任意时刻至多一个 viewer 在建）──────────

let snapshotTail: Promise<unknown> = Promise.resolve()

/** 串行排队一个地图作业；失败不断链（job 内部自兜，这里再兜一层）。 */
export function queueMapJob(job: () => Promise<void>): Promise<void> {
  const run = snapshotTail.then(job, job)
  snapshotTail = run.catch(() => {})
  return run
}

// ── 状态条（旧 mapStatus：加载/失败提示 + 重试按钮）─────────────────────────

function setStatusLine(container: HTMLElement, text: string, failed: boolean, retry?: () => void): void {
  container.querySelector('.co-map-status')?.remove()
  if (text === '') return
  const status = document.createElement('div')
  status.className = `co-map-status${failed ? ' co-map-status--error' : ''}`
  status.setAttribute('role', failed ? 'alert' : 'status')
  status.setAttribute('aria-live', failed ? 'assertive' : 'polite')
  const span = document.createElement('span')
  span.textContent = text
  status.appendChild(span)
  if (retry !== undefined) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'co-map-3d-btn'
    button.textContent = '重新加载三维地图'
    button.onclick = () => {
      button.disabled = true
      container.setAttribute('aria-busy', 'true')
      retry()
    }
    status.appendChild(button)
  }
  container.appendChild(status)
}

// ── TrackMapSession：一个容器一个会话，渲染权全归引擎 ────────────────────────

export class TrackMapSession {
  private readonly container: HTMLElement
  private readonly options: TrackMapOptions
  private generation = 0
  private disposed = false
  private viewer: CesiumViewerLike | null = null
  private tileset: CesiumTilesetLike | null = null
  private snapshotToken = 0
  private readinessCleanup: (() => void) | null = null
  private snapshotCancel: ((error: Error) => void) | null = null
  private captureCancel: ((error: Error) => void) | null = null
  private captureUnlock: (() => void) | null = null
  private pendingDownloadUrls: string[] = []
  /** 下载文件名前缀（含 callId，旧 captureTrajectoryMap 的 download 字段口径）。 */
  private downloadPrefix = '车辆轨迹'
  /** 截图按钮/状态行宿主（modal3d 组件传入；快照模式保持 null=非交互）。 */
  scaffold: { captureButton: HTMLButtonElement | null; captureStatus: HTMLElement | null } =
    { captureButton: null, captureStatus: null }

  constructor(container: HTMLElement, options: TrackMapOptions) {
    this.container = container
    this.options = options
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** 数据重排顶替令牌（旧 snapshotToken：只认最新一次排队）。 */
  takeSnapshotToken(): number {
    this.snapshotToken += 1
    return this.snapshotToken
  }

  isCurrentSnapshot(token: number): boolean {
    return !this.disposed && token === this.snapshotToken
  }

  /** 全链销毁（旧 cancelMap+destroyMap 合并体）：此后一切异步链过期即弃。 */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.destroyMap()
    this.releaseDownloadUrls()
  }

  private releaseDownloadUrls(): void {
    for (const url of this.pendingDownloadUrls.splice(0)) URL.revokeObjectURL(url)
  }

  /** 容器内全清（监听/定时器/viewer/容器属性/dataset/innerHTML，旧 destroyMap 原样）。 */
  private destroyMap(): void {
    const container = this.container
    if (this.readinessCleanup !== null) this.readinessCleanup()
    this.readinessCleanup = null
    if (this.snapshotCancel !== null) this.snapshotCancel(new Error('轨迹截图已取消'))
    this.snapshotCancel = null
    if (this.captureCancel !== null) this.captureCancel(new Error('三维视图已离开当前页面'))
    this.captureCancel = null
    if (this.captureUnlock !== null) this.captureUnlock()
    this.captureUnlock = null
    const slots = containerSlots(container)
    if (slots.viewer !== null && !slots.viewer.isDestroyed()) slots.viewer.destroy()
    slots.viewer = null
    slots.tileset = null
    container.dataset.mapReady = 'false'
    container.dataset.captureReady = 'false'
    container.dataset.snapshotReady = 'false'
    if (this.scaffold.captureButton !== null) this.scaffold.captureButton.disabled = true
    container.innerHTML = ''
    this.viewer = null
    this.tileset = null
  }

  /** 开新的一代（旧 mountMap/cancelMap 开头的 generation bump 同语义）。 */
  private nextGeneration(): number {
    this.generation += 1
    const generation = this.generation
    this.destroyMap()
    return generation
  }

  private expired(generation: number): boolean {
    return this.disposed || generation !== this.generation
  }

  // ── 快照模式（内嵌静态三维截图，旧 mountMap 的 snapshot 分支）────────────

  /** 生成静态截图贴进容器（viewer 用完即毁——回答区的地图是图不是交互面）。 */
  mountSnapshot(payload: TrackMapPayload, callId: string, onError: (message: string, retry: () => void) => void): void {
    const token = this.takeSnapshotToken()
    const attempt = (): Promise<void> => this.runSnapshot(payload, callId, token, onError)
    void queueMapJob(async () => {
      if (!this.isCurrentSnapshot(token)) return
      this.container.dataset.snapshotState = 'loading'
      this.container.setAttribute('aria-busy', 'true')
      setStatusLine(this.container, '正在等待生成三维场景截图…', false)
      await attempt()
    })
  }

  private async runSnapshot(
    payload: TrackMapPayload,
    callId: string,
    token: number,
    onError: (message: string, retry: () => void) => void,
  ): Promise<void> {
    this.downloadPrefix = payload.fences !== undefined && payload.fences.length > 0 ? '电子围栏' : '车辆轨迹'
    const generation = this.nextGeneration()
    setStatusLine(this.container, '正在加载地形与三维模型…', false)
    this.container.dataset.mapReady = 'false'
    this.container.setAttribute('aria-busy', 'true')
    try {
      const context = await this.buildScene(payload, callId, generation)
      if (this.expired(generation)) return
      await this.waitForSnapshotView(context, generation)
      if (this.expired(generation)) return
      const { viewer, tileset } = context
      if (viewer.isDestroyed() || (tileset !== null && !tileset.show) || viewer.canvas.width === 0 || viewer.canvas.height === 0) {
        throw new Error('三维场景尚未准备完成')
      }
      const source = viewer.canvas.toDataURL('image/jpeg', 0.88)
      this.destroyMap()
      const image = document.createElement('img')
      image.className = 'co-track-snapshot'
      image.alt = `${snapshotAlt(payload)}三维场景截图`
      image.src = source
      this.container.appendChild(image)
      this.container.dataset.snapshotReady = 'true'
      this.container.dataset.snapshotState = 'ready'
      setStatusLine(this.container, '', false)
      this.container.setAttribute('aria-busy', 'false')
    } catch (error) {
      if (!this.isCurrentSnapshot(token) || this.expired(generation)) return
      this.destroyMap()
      this.container.setAttribute('aria-busy', 'false')
      this.container.dataset.snapshotState = 'error'
      const message = errorTextOf(error)
      onError(`三维截图生成失败：${message}`, () => { this.mountSnapshot(payload, callId, onError) })
    }
  }

  /** 等当前视角的瓦片进帧再截图（旧 waitForSnapshotView，最多重试一次）。 */
  private waitForSnapshotView(context: SceneContext, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempt = 0
      const self = this
      function run(): void {
        attempt += 1
        let settled = false
        let flyResolved = false
        let captureArmed = false
        let frameHasTile = false
        let settleTimer: ReturnType<typeof setTimeout> | undefined
        const { viewer, tileset } = context
        const removes: Array<() => void> = []
        function cleanup(): void {
          for (const remove of removes.splice(0)) remove()
          if (settleTimer !== undefined) clearTimeout(settleTimer)
          if (self.snapshotCancel === cancel) self.snapshotCancel = null
        }
        function cancel(error: Error): void {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
        function fail(error: Error): void {
          if (settled) return
          settled = true
          cleanup()
          if (attempt < 2 && !self.expired(generation)) {
            setStatusLine(self.container, '三维模型尚未进入当前视角，正在重试…', false)
            run()
          } else reject(error)
        }
        function armCapture(): void {
          if (settled || captureArmed || !flyResolved) return
          if (settleTimer !== undefined) {
            clearTimeout(settleTimer)
            settleTimer = undefined
          }
          captureArmed = true
          viewer.scene.requestRender()
        }
        function check(): void {
          if (settled || captureArmed || !flyResolved) return
          if (tileset === null || tileset.tilesLoaded) return armCapture()
          if (settleTimer === undefined) settleTimer = setTimeout(armCapture, 1000)
        }
        if (tileset !== null) {
          removes.push(tileset.tileVisible.addEventListener(() => {
            if (!self.expired(generation)) frameHasTile = true
          }))
          removes.push(tileset.allTilesLoaded.addEventListener(check))
        }
        removes.push(viewer.scene.postRender.addEventListener(() => {
          if (settled) return
          const currentFrameHasTile = tileset === null ? true : frameHasTile
          frameHasTile = false
          if (!captureArmed || !currentFrameHasTile) return
          settled = true
          cleanup()
          resolve()
        }))
        self.snapshotCancel = cancel
        const timer = setTimeout(() => { fail(new Error('等待当前视角三维模型超时')) }, SNAPSHOT_VIEW_TIMEOUT_MS)
        removes.push(() => clearTimeout(timer))
        viewer.flyTo(viewer.entities, { duration: 0, offset: trajectoryOffset(context.cesium) })
          .then(() => {
            if (self.expired(generation) || viewer.isDestroyed()) return fail(new Error('轨迹截图已取消'))
            flyResolved = true
            viewer.scene.requestRender()
            check()
          })
          .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
      }
      run()
    })
  }

  // ── 交互模式（modal3d 弹窗：真实 viewer 常驻 + 截图按钮）────────────────

  /** 挂交互 viewer（旧 open3DView → mountMap 非快照分支）。 */
  async mountInteractive(payload: TrackMapPayload, callId: string, onError: (message: string, retry: () => void) => void): Promise<void> {
    this.downloadPrefix = payload.fences !== undefined && payload.fences.length > 0 ? '电子围栏' : '车辆轨迹'
    const generation = this.nextGeneration()
    setStatusLine(this.container, '正在加载地形与三维模型…', false)
    this.container.dataset.mapReady = 'false'
    this.container.setAttribute('aria-busy', 'true')
    this.container.dataset.enclaveCallId = callId
    this.setCaptureState(false, '正在加载三维模型…', false)
    try {
      const context = await this.buildScene(payload, callId, generation)
      if (this.expired(generation)) return
      await context.viewer.flyTo(context.viewer.entities, { duration: 0, offset: trajectoryOffset(context.cesium) })
      if (this.expired(generation)) return
      setStatusLine(this.container, '', false)
      this.container.dataset.mapReady = 'true'
      this.container.setAttribute('aria-busy', 'false')
      this.container.dataset.cesiumVersion = context.cesium.VERSION
      this.container.dataset.mapEngine = 'CesiumJS@1.142.0'
      this.watchCaptureReadiness(context, generation)
    } catch (error) {
      if (this.expired(generation)) return
      this.destroyMap()
      this.container.setAttribute('aria-busy', 'false')
      const message = errorTextOf(error)
      onError(`地图加载失败：${message}`, () => { void this.mountInteractive(payload, callId, onError) })
      this.setCaptureState(false, '三维地图加载失败，请重试', true)
    }
  }

  /** 三维就绪监听（旧 watchCaptureReadiness：tile 就绪进帧后解锁截图按钮）。 */
  private watchCaptureReadiness(context: SceneContext, generation: number): void {
    const { viewer, tileset } = context
    const self = this
    let captureArmed = false
    let frameHasTile = false
    let settled = false
    let stableTimer: ReturnType<typeof setTimeout> | undefined
    const removes: Array<() => void> = []
    function arm(): void {
      if (settled || captureArmed || self.expired(generation)) return
      captureArmed = true
      viewer.scene.requestRender()
    }
    function check(): void {
      if (settled || captureArmed || self.expired(generation)) return
      if (tileset === null || tileset.tilesLoaded) arm()
      else if (stableTimer === undefined) stableTimer = setTimeout(arm, 1000)
    }
    if (tileset !== null) {
      removes.push(tileset.tileVisible.addEventListener(() => { frameHasTile = true }))
      removes.push(tileset.allTilesLoaded.addEventListener(check))
    }
    removes.push(viewer.scene.postRender.addEventListener(() => {
      const currentFrameHasTile = tileset === null ? true : frameHasTile
      frameHasTile = false
      if (settled || self.expired(generation) || !captureArmed || !currentFrameHasTile) return
      settled = true
      cleanup()
      self.setCaptureState(true, '三维模型已就绪，可截图并保存', false)
    }))
    const timer = setTimeout(() => {
      if (settled || self.expired(generation)) return
      self.setCaptureState(false, '三维模型仍在加载，暂不能截图', true)
    }, READINESS_TIMEOUT_MS)
    function cleanup(): void {
      for (const remove of removes.splice(0)) remove()
      if (stableTimer !== undefined) clearTimeout(stableTimer)
      clearTimeout(timer)
      if (self.readinessCleanup === cleanup) self.readinessCleanup = null
    }
    this.readinessCleanup = cleanup
    viewer.scene.requestRender()
    check()
  }

  private setCaptureState(ready: boolean, message: string, failed: boolean): void {
    this.container.dataset.captureReady = ready ? 'true' : 'false'
    const button = this.scaffold.captureButton
    if (button !== null) {
      button.disabled = !ready
      const label = button.querySelector('.co-capture-label')
      if (label !== null && message !== '' && !failed && ready) label.textContent = '截图并保存'
    }
    if (this.scaffold.captureStatus !== null) {
      this.scaffold.captureStatus.textContent = message
      this.scaffold.captureStatus.classList.toggle('co-capture-status--error', failed)
    }
  }

  /** 截图并保存（旧 captureTrajectoryMap：锁相机输入 → 等 tile 进帧 → toBlob → 下载）。 */
  async capture(): Promise<void> {
    const button = this.scaffold.captureButton
    if (button === null) return
    const label = button.querySelector('.co-capture-label')
    const setLabel = (text: string): void => {
      if (label !== null) label.textContent = text
    }
    const generation = this.generation
    const viewerAtStart = this.viewer
    const slots = containerSlots(this.container)
    button.disabled = true
    setLabel('正在准备当前视角…')
    try {
      const canvas = await this.waitForCaptureFrame(CAPTURE_TIMEOUT_MS)
      if (this.isSuperseded(generation, slots, viewerAtStart)) throw new Error('三维视图已更新，请重新截图')
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(current => {
          if (this.isSuperseded(generation, slots, viewerAtStart)) reject(new Error('三维视图已更新，请重新截图'))
          else if (current !== null) resolve(current)
          else reject(new Error('浏览器未能生成 PNG'))
        }, 'image/png')
      })
      if (this.isSuperseded(generation, slots, viewerAtStart)) throw new Error('三维视图已更新，请重新截图')
      const url = URL.createObjectURL(blob)
      this.pendingDownloadUrls.push(url)
      setTimeout(() => {
        const index = this.pendingDownloadUrls.indexOf(url)
        if (index >= 0) this.pendingDownloadUrls.splice(index, 1)
        URL.revokeObjectURL(url)
      }, 60000)
      const link = document.createElement('a')
      try {
        link.href = url
        link.download = `${this.downloadPrefix}-${this.container.dataset.enclaveCallId ?? ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`
        link.hidden = true
        link.tabIndex = -1
        document.body.appendChild(link)
        link.click()
      } finally {
        link.remove()
      }
      this.setCaptureState(true, '截图已开始保存到本机，三维视图保持不变', false)
    } catch (error) {
      if (!this.isSuperseded(generation, slots, viewerAtStart)) {
        const message = errorTextOf(error)
        this.setCaptureState(true, `截图失败：${message}`, true)
      }
    } finally {
      if (this.captureUnlock !== null) this.captureUnlock()
      if (!this.isSuperseded(generation, slots, viewerAtStart)) {
        button.disabled = this.container.dataset.captureReady !== 'true'
        setLabel('截图并保存')
      }
    }
  }

  /** 截图全程的代际核对：session 已销毁/换代/viewer 被顶替，任一即拒绝落盘。 */
  private isSuperseded(generation: number, slots: { viewer: CesiumViewerLike | null }, viewerAtStart: CesiumViewerLike | null): boolean {
    return this.disposed || generation !== this.generation || slots.viewer !== viewerAtStart
  }

  /** 等当前视角的一帧含 tile 的渲染（旧 waitForCaptureFrame 原样）。 */
  private waitForCaptureFrame(timeoutMs: number): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
      const viewer = this.viewer
      const tileset = this.tileset
      const generation = this.generation
      if (viewer === null || viewer.isDestroyed() || this.container.dataset.captureReady !== 'true') {
        reject(new Error('三维模型尚未就绪'))
        return
      }
      const self = this
      const activeViewer = viewer
      this.setCaptureState(false, '正在等待当前视角的三维模型完成渲染…', false)
      let captureArmed = false
      let frameHasTile = false
      let done = false
      let stableTimer: ReturnType<typeof setTimeout> | undefined
      const cameraController = activeViewer.scene.screenSpaceCameraController
      const inputsWereEnabled = cameraController.enableInputs
      cameraController.enableInputs = false
      function restoreInputs(): void {
        if (!activeViewer.isDestroyed()) cameraController.enableInputs = inputsWereEnabled
      }
      function arm(): void {
        if (done || captureArmed) return
        captureArmed = true
        activeViewer.scene.requestRender()
      }
      function check(): void {
        if (done || captureArmed) return
        if (tileset === null || tileset.tilesLoaded) arm()
        else if (stableTimer === undefined) stableTimer = setTimeout(arm, 1000)
      }
      const removes: Array<() => void> = []
      if (tileset !== null) {
        removes.push(tileset.tileVisible.addEventListener(() => { frameHasTile = true }))
        removes.push(tileset.allTilesLoaded.addEventListener(check))
      }
      removes.push(activeViewer.scene.postRender.addEventListener(() => {
        const currentFrameHasTile = tileset === null ? true : frameHasTile
        frameHasTile = false
        if (!captureArmed || !currentFrameHasTile) return
        finish(null)
      }))
      const timer = setTimeout(() => { finish(new Error('当前视角的三维模型尚未加载完成')) }, timeoutMs)
      function finish(error: Error | null): void {
        if (done) return
        done = true
        for (const remove of removes.splice(0)) remove()
        if (stableTimer !== undefined) clearTimeout(stableTimer)
        clearTimeout(timer)
        if (self.captureCancel === cancel) self.captureCancel = null
        if (error !== null) {
          restoreInputs()
          reject(error)
          return
        }
        self.captureUnlock = () => {
          restoreInputs()
          if (self.captureUnlock === unlock) self.captureUnlock = null
        }
        const unlock = self.captureUnlock
        resolve(activeViewer.canvas)
      }
      function cancel(error: Error): void { finish(error) }
      this.captureCancel = cancel
      activeViewer.scene.requestRender()
      check()
    })
  }

  // ── 场景构建（旧 mountMap 的 loadCesium→terrain→viewer→tileset 段）────────

  private async buildScene(payload: TrackMapPayload, callId: string, generation: number): Promise<SceneContext> {
    const { mapConfig, routePath } = this.options
    const cesium = await loadCesium(routePath)
    if (this.expired(generation)) throw new Error('三维视图已离开当前页面')
    // 地形：真实部署给地形服务；空配置（mock/离线）降级椭球面——真实路径不受影响。
    const terrain = mapConfig.terrainUrl === ''
      ? new cesium.EllipsoidTerrainProvider()
      : await cesium.CesiumTerrainProvider.fromUrl(mapConfig.terrainUrl)
    if (this.expired(generation)) throw new Error('三维视图已离开当前页面')
    this.destroyMap()
    const viewer = new cesium.Viewer(this.container, {
      terrainProvider: terrain,
      baseLayer: cesium.ImageryLayer.fromProviderAsync(
        cesium.TileMapServiceImageryProvider.fromUrl(cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')),
      ),
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
      baseLayerPicker: false,
      geocoder: false,
      animation: false,
      timeline: false,
      selectionIndicator: false,
      infoBox: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    })
    this.viewer = viewer
    containerSlots(this.container).viewer = viewer
    // 构造时容器可能还没完成布局（React effect 在 paint 前跑），显式重设画布一次；
    // 并在渲染循环里兜底：画布属性与容器实际尺寸不一致时才 resize（requestRenderMode
    // 下无谓的 resize 会强制重渲），弹窗动画/滚动造成的尺寸落定随之校正。
    viewer.resize()
    viewer.scene.postRender.addEventListener(() => {
      if (this.disposed) return
      const canvas = viewer.canvas
      if (canvas.clientWidth > 0 && (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight)) viewer.resize()
    })
    viewer.scene.globe.baseColor = cesium.Color.fromCssColorString('#d8e4d1')
    viewer.scene.globe.depthTestAgainstTerrain = true
    // 3D Tiles：空配置（mock/离线）跳过，只有底图与标绘——真实部署不受影响。
    let tileset: CesiumTilesetLike | null = null
    if (mapConfig.tilesetUrl !== '') {
      tileset = await cesium.Cesium3DTileset.fromUrl(mapConfig.tilesetUrl, { maximumScreenSpaceError: 2 })
      if (this.expired(generation)) {
        if (tileset.destroy !== undefined && (tileset.isDestroyed === undefined || !tileset.isDestroyed())) tileset.destroy()
        if (!viewer.isDestroyed()) viewer.destroy()
        throw new Error('三维视图已离开当前页面')
      }
      viewer.scene.primitives.add(tileset)
      this.tileset = tileset
      containerSlots(this.container).tileset = tileset
      setTilesetHeight(tileset, mapConfig.tilesetHeight, cesium)
    }
    if (payload.fences !== undefined && payload.fences.length > 0) {
      this.addFenceContent(viewer, cesium, payload.fences, callId)
    } else {
      this.addTrackContent(viewer, cesium, payload, callId)
    }
    return { cesium, viewer, tileset }
  }

  /** 轨迹线 + 起终点 + 设备组 billboard + 点击拾取（旧 addMapContent 原样）。 */
  private addTrackContent(viewer: CesiumViewerLike, cesium: CesiumNamespace, payload: TrackMapPayload, callId: string): void {
    const route = payload.points.map(geoPoint)
    const positions = route.map(p => cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h + 2))
    const interactive = this.scaffold.captureButton !== null
    const suffix = interactive ? 'interactive' : 'snapshot'
    viewer.entities.add({
      id: `route-${callId}-${suffix}`,
      polyline: {
        positions,
        width: interactive ? 6 : 5,
        material: cesium.Color.fromCssColorString(ROUTE_COLOR),
        depthFailMaterial: cesium.Color.fromCssColorString(ROUTE_DEPTH_FAIL),
      },
    })
    const endpoint = (id: string, point: GeoPointLite, label: string, color: CesiumColorLike): void => {
      viewer.entities.add({
        id: `${id}-${callId}-${suffix}`,
        position: cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.h + 5),
        point: {
          pixelSize: 13,
          color,
          outlineColor: cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: label,
          font: 'bold 15px Microsoft YaHei',
          fillColor: color,
          outlineColor: cesium.Color.WHITE,
          outlineWidth: 3,
          style: cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new cesium.Cartesian2(0, -24),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
    const start = route[0]
    const end = route[route.length - 1]
    if (start !== undefined) endpoint('start', start, `起点${start.t === '' ? '' : `\n${start.t}`}`, cesium.Color.fromCssColorString(START_COLOR))
    if (end !== undefined) endpoint('end', end, `终点${end.t === '' ? '' : `\n${end.t}`}`, cesium.Color.fromCssColorString(END_COLOR))
    const groupsByEntity = new Map<string, TrackDeviceGroup>()
    const marker = this.options.routePath('/assets/cesium/device-group-marker.png')
    payload.groups.forEach((group, index) => {
      const point = geoPoint(groupLocation(group))
      const entityId = `device-group-${callId}-${suffix}-${index}`
      groupsByEntity.set(entityId, group)
      viewer.entities.add({
        id: entityId,
        name: groupNameOf(group),
        position: cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.h + 2),
        billboard: {
          image: marker,
          width: interactive ? 58 : 48,
          height: interactive ? 113 : 94,
          verticalOrigin: cesium.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new cesium.NearFarScalar(400, 1.08, 15000, 0.62),
          distanceDisplayCondition: new cesium.DistanceDisplayCondition(0, 25000),
        },
        label: {
          text: groupNameOf(group),
          font: `${interactive ? 'bold 15px' : 'bold 13px'} Microsoft YaHei`,
          fillColor: cesium.Color.WHITE,
          outlineColor: cesium.Color.fromCssColorString('#071d2b'),
          outlineWidth: 2,
          style: cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: cesium.Color.fromCssColorString('#0b324d').withAlpha(0.76),
          pixelOffset: new cesium.Cartesian2(0, interactive ? -121 : -101),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new cesium.NearFarScalar(400, 1.05, 15000, 0.7),
          distanceDisplayCondition: new cesium.DistanceDisplayCondition(0, 25000),
        },
      })
    })
    viewer.screenSpaceEventHandler.setInputAction(movement => {
      const picked = viewer.scene.pick(movement.position)
      const entity = picked?.id
      const group = entity !== undefined ? groupsByEntity.get(entity.id) : undefined
      if (group === undefined) return
      this.options.onGroupClick?.(group)
    }, cesium.ScreenSpaceEventType.LEFT_CLICK)
  }

  /** 围栏线/墙/面 + 标签（旧 addFenceContent 原样）。 */
  private addFenceContent(viewer: CesiumViewerLike, cesium: CesiumNamespace, fences: readonly FenceGeometry[], callId: string): void {
    fences.forEach((fence, index) => {
      const color = cesium.Color.fromCssColorString(FENCE_COLORS[index % FENCE_COLORS.length] ?? '#3370ff')
      const points = fence.positions.map(p => geoPoint({ lon: p[0], lat: p[1], h: p[2] }))
      const positions = points.map(p => cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.h))
      const first = points[0] ?? { lon: 0, lat: 0, h: 0, t: '' }
      const entity: Record<string, unknown> = {
        id: `fence-${callId}-${index}`,
        name: fence.name,
        position: cesium.Cartesian3.fromDegrees(first.lon, first.lat, first.h + fence.height),
        label: {
          text: fence.name,
          font: 'bold 15px Microsoft YaHei',
          fillColor: color,
          outlineColor: cesium.Color.BLACK,
          outlineWidth: 2,
          style: cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new cesium.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        polyline: {
          positions: fence.kind === 'polygon' ? [...positions, positions[0]] : positions,
          width: 3,
          material: color,
          depthFailMaterial: color.withAlpha(0.5),
        },
      }
      if (fence.kind === 'wall' && fence.height > 0) {
        entity.wall = {
          positions,
          minimumHeights: points.map(p => p.h),
          maximumHeights: points.map(p => p.h + fence.height),
          material: color.withAlpha(0.45),
        }
      } else if (fence.kind === 'polygon') {
        entity.polygon = { hierarchy: new cesium.PolygonHierarchy(positions), perPositionHeight: true, material: color.withAlpha(0.25) }
      }
      viewer.entities.add(entity)
    })
  }
}

// ── 会话辅助类型与自由函数 ───────────────────────────────────────────────────

interface SceneContext {
  cesium: CesiumNamespace
  viewer: CesiumViewerLike
  tileset: CesiumTilesetLike | null
}

interface GeoPointLite {
  lon: number
  lat: number
  h: number
  t: string
}

/** 容器自定义属性槽（viewer/tileset 挂容器——泄漏排查可视，旧码同形态）。 */
interface ContainerSlots {
  viewer: CesiumViewerLike | null
  tileset: CesiumTilesetLike | null
}

const SLOT_KEY = '_coEnclaveSlots'

function containerSlots(container: HTMLElement): ContainerSlots {
  const owned = container as HTMLElement & { [SLOT_KEY]?: ContainerSlots }
  if (owned[SLOT_KEY] === undefined) owned[SLOT_KEY] = { viewer: null, tileset: null }
  return owned[SLOT_KEY]
}

function trajectoryOffset(cesium: CesiumNamespace): unknown {
  return new cesium.HeadingPitchRange(0, cesium.Math.toRadians(-55), 0)
}

function setTilesetHeight(tileset: CesiumTilesetLike, heightMeters: number, cesium: CesiumNamespace): void {
  const cartographic = cesium.Cartographic.fromCartesian(tileset.boundingSphere.center)
  const surface = cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 0)
  const offset = cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, heightMeters)
  const translation = cesium.Cartesian3.subtract(offset, surface, new cesium.Cartesian3())
  // 3D Tiles 与地形的基准面可能不同；必须先按数据集校高，再进行相机取景。
  tileset.modelMatrix = cesium.Matrix4.fromTranslation(translation)
}

function groupNameOf(group: TrackDeviceGroup): string {
  const name = group.groupName ?? group.name
  return typeof name === 'string' && name !== '' ? name : '设备组'
}

/** 设备组的空间位置（真实形状 lon/lat/h；宽松兜底 0）。 */
function groupLocation(group: TrackDeviceGroup): TrackPoint {
  return { lon: Number(group.lon) || 0, lat: Number(group.lat) || 0, h: Number(group.h) || 0 }
}

function snapshotAlt(payload: TrackMapPayload): string {
  if (payload.fences !== undefined && payload.fences.length > 0) return '电子围栏'
  return payload.vehicleNo === undefined || payload.vehicleNo === '' ? '车辆轨迹' : `${payload.vehicleNo} · 车辆轨迹`
}

/** 围栏 payload → 快照载荷（点位 = 边界点串，旧 fencePoints 同口径）。 */
export function fencesPayload(geometries: readonly FenceGeometry[]): TrackMapPayload {
  return { points: fencePoints(geometries), groups: [], fences: geometries }
}
