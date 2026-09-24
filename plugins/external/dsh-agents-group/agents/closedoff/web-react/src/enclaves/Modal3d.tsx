/**
 * 三维轨迹弹窗飞地（旧 open3DView + modal3d 弹窗 DOM 的 React 等价）。
 *
 * 打开=组件挂载（container 首帧就是空 div，渲染权随后归 Cesium 引擎）；关闭=组件
 * 卸载（session.dispose() 全链销毁——反复开关的 viewer 重建/销毁时序是本批最高
 * 风险点，防护四坑与异步链过期核对见 cesium-enclave.ts 文件头）。
 *
 * 交互语义照旧：Esc/遮罩点击关闭、焦点陷阱（Tab 循环）、打开即聚焦关闭按钮、
 * 关闭还原触发焦点；截图链 = 就绪监听解锁按钮 → capture（锁定相机 → 等 tile
 * 进帧 → toBlob → 下载）。
 */
import { useEffect, useRef } from 'react'
import { DshIcon } from '../components/DshIcon.tsx'
import { mapConfigOrFallback, routePath } from '../lib/config.ts'
import type { BoardTrack } from '../lib/restore.ts'
import type { FenceGeometry, TrackDeviceGroup } from '../lib/types.ts'
import { fmtDT, groupNameOf, vt } from '../lib/trajectory-data.ts'
import { useEnclaveStore } from '../stores/enclave.ts'
import { TrackMapSession } from './cesium-enclave.ts'
import type { TrackMapPayload } from './cesium-enclave.ts'
import type { ReactElement } from 'react'

export function Modal3dEnclave(): ReactElement | null {
  const modal3d = useEnclaveStore(state => state.modal3d)
  const openCamera = useEnclaveStore(state => state.openCamera)
  if (modal3d === null) return null
  return (
    <Modal3dOverlay
      key={`${modal3d.callId}-${modal3d.track !== undefined ? 'track' : 'fences'}`}
      callId={modal3d.callId}
      {...(modal3d.track !== undefined ? { track: modal3d.track } : {})}
      {...(modal3d.fences !== undefined ? { fences: modal3d.fences } : {})}
      onGroupClick={group => openCamera({ group })}
    />
  )
}

function Modal3dOverlay({ callId, track, fences, onGroupClick }: {
  callId: string
  track?: BoardTrack
  fences?: FenceGeometry[]
  onGroupClick: (group: TrackDeviceGroup) => void
}): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const closeAll = useEnclaveStore(state => state.closeModal3d)

  const points = track?.points ?? []
  const groups = track?.groups ?? []
  const isFences = fences !== undefined && fences.length > 0
  const timeRange = points.length > 0 ? `${fmtDT(vt(points[0]))} ~ ${fmtDT(vt(points[points.length - 1]))}` : ''
  const title = isFences
    ? `三维电子围栏 · ${fences.length} 个边界`
    : `${track?.vehicleNo ?? '车牌未知'} 三维轨迹 · ${points.length} 点${timeRange === '' ? '' : ` · ${timeRange}`}`
  const foot = isFences
    ? '真实地形与三维模型 · 按保存的边界坐标与围栏高度展示'
    : `${footText(points, groups)}；点击设备组可查看组内摄像头。`

  // 飞地生命周期：挂载建 session + 挂交互 viewer；卸载全链销毁（防泄漏关键点）。
  // 失败态由引擎在容器内渲染状态条（带「重新加载三维地图」重试按钮），这里不接。
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const session = new TrackMapSession(container, { mapConfig: mapConfigOrFallback(), routePath, onGroupClick })
    // 截图按钮/状态行在弹窗脚部（容器外），由 closest 挂进 scaffold。
    const modal = container.closest('.co-modal')
    const captureButton = modal?.querySelector<HTMLButtonElement>('.co-capture-btn') ?? null
    const captureStatus = modal?.querySelector<HTMLElement>('.co-capture-status') ?? null
    session.scaffold.captureButton = captureButton
    session.scaffold.captureStatus = captureStatus
    if (captureButton !== null) {
      captureButton.disabled = true
      captureButton.onclick = () => { void session.capture() }
    }
    const payload: TrackMapPayload = isFences
      ? { points: [], groups: [], fences }
      : { points, groups, ...(track?.vehicleNo === undefined ? {} : { vehicleNo: track.vehicleNo }) }
    void session.mountInteractive(payload, callId, () => { /* 失败态引擎已渲染状态条+重试 */ })
    previousFocusRef.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      session.dispose()
      if (captureButton !== null) captureButton.onclick = null
    }
    // 载荷只在挂载时取用（弹窗每次打开按当前数据重建，开窗期间数据不变量与旧码一致）。
  }, [])

  // 卸载后还原触发焦点（旧 modal3dPreviousFocus 口径）。
  useEffect(() => () => {
    previousFocusRef.current?.focus({ preventScroll: true })
  }, [])

  // 焦点陷阱（旧 trapModalFocus 同口径：Tab 循环限制在弹窗可聚焦元素内）。
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeAll()
      return
    }
    if (event.key !== 'Tab') return
    const overlay = event.currentTarget
    const focusable = [...overlay.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(node => node.offsetParent !== null)
    if (focusable.length === 0) return
    const first = focusable[0] as HTMLElement
    const last = focusable[focusable.length - 1] as HTMLElement
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="co-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={event => { if (event.target === event.currentTarget) closeAll() }}
      onKeyDown={onKeyDown}
    >
      <div className="co-modal">
        <div className="co-modal-head">
          <span className="co-modal-title">{title}</span>
          <button ref={closeRef} type="button" className="co-modal-close" aria-label={`关闭${isFences ? '三维电子围栏' : '三维轨迹'}`} onClick={closeAll}>×</button>
        </div>
        <div className="co-modal-body">
          <div className="co-modal-stage">
            {/* Cesium 飞地容器：渲染权全归引擎（防护四坑见 cesium-enclave.ts）。 */}
            <div ref={containerRef} className="co-modal-map" data-enclave="modal3d-canvas" />
            <aside className="co-track-legend co-modal-legend" aria-label={isFences ? '电子围栏' : '轨迹设备组'}>
              {isFences
                ? fences.map((fence, index) => (
                  <div className="co-lg-item co-lg-item--static" key={index}>
                    {`${fence.name} · ${fence.kind === 'wall' ? '围栏' : '区域'} · ${fence.positions.length} 个边界点`}
                  </div>
                ))
                : groups.length === 0
                  ? <div className="co-legend-empty">该轨迹附近没有设备组</div>
                  : (
                    <>
                      <div className="co-legend-head">
                        <span className="co-legend-title">设备组 <small>点击查看摄像头</small></span>
                        <span className="co-legend-total">{groups.length}</span>
                      </div>
                      <div className="co-legend-list">
                        {groups.map((group, index) => (
                          <button type="button" className="co-lg-item" key={index} title={`查看 ${groupNameOf(group)} 的摄像头`} onClick={() => onGroupClick(group)}>
                            <span className="co-lg-no">{String(index + 1).padStart(2, '0')}</span>
                            <span className="co-lg-name">{groupNameOf(group)}</span>
                            <span className="co-lg-count">{group.devices?.length ?? 0} 路</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
            </aside>
          </div>
        </div>
        <div className="co-modal-foot">
          <span className="co-modal-foot-copy">{foot}</span>
          <div className="co-modal-capture">
            <span className="co-capture-status" role="status" aria-live="polite" />
            <button type="button" className="co-map-3d-btn co-capture-btn" disabled aria-label="截取并保存当前全屏三维视角">
              <DshIcon name="camera" /> <span className="co-capture-label">截图并保存</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function footText(points: ReadonlyArray<Record<string, unknown>>, groups: ReadonlyArray<Record<string, unknown>>): string {
  if (points.length === 0) return '真实地形与三维模型'
  const heights = points.map(p => Number(p.h ?? p.height ?? 0) || 0)
  const min = Math.round(Math.min(...heights))
  const max = Math.round(Math.max(...heights))
  const devices = groups.reduce((n, group) => n + (Array.isArray(group.devices) ? group.devices.length : 0), 0)
  return `真实地形与三维模型 · 海拔 ${min} ~ ${max} 米${groups.length > 0 ? ` · 设备组 ${groups.length} 个 · 设备 ${devices} 个` : ''}`
}
