/**
 * 飞地 UI 状态 store：三个重交互面（三维弹窗 / 摄像头弹窗）的打开参数。
 *
 * 飞地组件按这里的参数条件挂载（open=有参数），关闭即清空并卸载——容器的
 * 渲染权在 Cesium/播放器（方案 §2 不变量 4），React 只负责挂载/卸载时机。
 * 快照飞地（内嵌图）不进这里：它跟随各自回合的数据面渲染。
 */
import { create } from 'zustand'
import type { BoardTrack } from '../lib/restore.ts'
import type { FenceGeometry, TrackDeviceGroup } from '../lib/types.ts'

/** 三维弹窗的入参：轨迹或围栏二选一（与旧 open3DView 的两分支对齐）。 */
export interface Modal3dRequest {
  callId: string
  track?: BoardTrack
  fences?: FenceGeometry[]
}

/** 摄像头弹窗入参：设备组原样（captureMode=车辆抓拍视频形态，旧 showGroupPopup）。 */
export interface CameraRequest {
  group: TrackDeviceGroup
  /** 抓拍片段形态：标题/统计/信息行按抓拍字段渲染。 */
  captureMode?: boolean
}

interface EnclaveState {
  modal3d: Modal3dRequest | null
  camera: CameraRequest | null
  openModal3d: (request: Modal3dRequest) => void
  openCamera: (request: CameraRequest) => void
  /** 只关摄像头弹窗（摄像头弹窗叠在三维弹窗上时 Esc 只关本层，旧码 stopPropagation 口径）。 */
  closeCamera: () => void
  /** 只关三维弹窗。 */
  closeModal3d: () => void
  closeAll: () => void
}

export const useEnclaveStore = create<EnclaveState>(set => ({
  modal3d: null,
  camera: null,
  openModal3d: modal3d => set({ modal3d }),
  openCamera: camera => set({ camera }),
  closeCamera: () => set({ camera: null }),
  closeModal3d: () => set({ modal3d: null }),
  closeAll: () => set({ modal3d: null, camera: null }),
}))
