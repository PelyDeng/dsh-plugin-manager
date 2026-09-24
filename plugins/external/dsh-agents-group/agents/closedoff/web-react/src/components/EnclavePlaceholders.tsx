/**
 * 批 1b 受控飞地的占位容器（内嵌 2D 地图 / 三维弹窗 / 摄像头弹窗 / 抓拍视频）。
 *
 * 批 1a 只立锚点：Cesium 的容器渲染权全归 Cesium（方案 §2 不变量 4），React 侧
 * 在批 1b 只做挂载/卸载——这里预留的 id 与数据面字段就是那一步的接手点：
 * - `co-map-stage`：内嵌轨迹地图容器（tracks/fences/cameras 数据已在 board/turn）；
 * - `co-modal3d`：三维轨迹弹窗宿主（旧 #modal3d / #modal3dCanvas）；
 * - `co-camera-modal`：设备组摄像头弹窗宿主（旧 #cameraModal）。
 * 样式占位用暗色域提示（真实色值批 1b 随白名单入库）。
 */
import type { ReactElement } from 'react'

export function MapPlaceholder(): ReactElement {
  return (
    <section className="co-map-placeholder" id="co-map-stage" aria-label="轨迹地图区域" data-enclave="map">
      <p className="co-map-placeholder-title">轨迹地图</p>
      <p className="co-map-placeholder-copy">地图视图将在批 1b 接入（Cesium 受控飞地），当前轨迹与围栏数据已在会话中保留。</p>
    </section>
  )
}

/** 三维弹窗宿主：批 1b 前 display:none，不影响布局。 */
export function Modal3dPlaceholder(): ReactElement {
  return (
    <div id="co-modal3d" className="co-enclave-hidden" data-enclave="modal3d" />
  )
}

/** 摄像头弹窗宿主：批 1b 前 display:none。 */
export function CameraModalPlaceholder(): ReactElement {
  return (
    <div id="co-camera-modal" className="co-enclave-hidden" data-enclave="camera" />
  )
}

/** 抓拍视频卡片的播放入口占位（批 1b 由 @hy-media 弹窗接管）。 */
export function MediaPlayStub({ label }: { label: string }): ReactElement {
  return (
    <button type="button" className="co-media-stub" disabled title="视频播放将在批 1b 接入">
      {label}
    </button>
  )
}
