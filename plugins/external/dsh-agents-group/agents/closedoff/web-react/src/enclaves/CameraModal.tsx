/**
 * 摄像头弹窗（旧 web/trajectory-camera.js 的 React 等价）：设备组列表、搜索、
 * 摄像头选择、详情信息行、@hy-media 视频预览、同组条带切换。
 *
 * 两个入口共用本弹窗（旧码同构）：
 * - 轨迹设备组（图例/三维弹窗 billboard）：列出组内 deviceType=6 摄像头；
 * - 车辆抓拍媒体（captureMode）：单条抓拍片段的「查看抓拍视频」——旧
 *   renderVehicleMedia 把片段包装成单摄像头设备组打开本弹窗。
 *
 * 播放器是 Vue 受控飞地（hy-player.ts）：host div 渲染权归 Vue，切换摄像头/
 * 关弹窗即 unmount（旧 destroyCameraPlayer 同口径）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { routePath } from '../lib/config.ts'
import { cameraName, cameraOnline, camerasFor, fmtDT } from '../lib/trajectory-data.ts'
import { useEnclaveStore } from '../stores/enclave.ts'
import { loadHyPlayer, mountHyPlayer, prewarmHyPlayer } from './hy-player.ts'
import type { TrackDeviceGroup } from '../lib/types.ts'
import type { ReactElement } from 'react'

type CameraRecord = Record<string, unknown>

export function CameraModalEnclave(): ReactElement | null {
  const camera = useEnclaveStore(state => state.camera)
  if (camera === null) return null
  return <CameraModal key={cameraKey(camera.group)} group={camera.group} captureMode={camera.captureMode === true} />
}

function cameraKey(group: TrackDeviceGroup): string {
  return String(group.groupId ?? group.groupName ?? group.name ?? group.captureMode ?? 'camera')
}

function CameraModal({ group, captureMode }: { group: TrackDeviceGroup; captureMode: boolean }): ReactElement {
  const closeCamera = useEnclaveStore(state => state.closeCamera)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const cameras = useMemo<CameraRecord[]>(() => camerasFor(group), [group])
  const [selected, setSelected] = useState<CameraRecord | null>(cameras[0] ?? null)
  const [query, setQuery] = useState('')

  // 打开时聚焦关闭按钮 + 记录触发焦点（旧 showGroupPopup/closeCameraModal 口径）。
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null
    closeRef.current?.focus({ preventScroll: true })
    // 可播摄像头存在时预热播放器脚本（旧 scheduleCameraPlayerPrewarm）。
    prewarmHyPlayer([group as unknown as Record<string, unknown>], routePath)
    return () => { previousFocusRef.current?.focus({ preventScroll: true }) }
  }, [group])

  // Esc 关闭（stopPropagation：摄像头弹窗叠在三维弹窗上时只关本层，旧码同口径）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeCamera()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [closeCamera])

  const keyword = query.trim().toLowerCase()
  const visible = keyword === ''
    ? cameras
    : cameras.filter(camera =>
      `${cameraName(camera)} ${camera.code ?? ''} ${camera.cameraCode ?? ''}`.toLowerCase().includes(keyword))

  const online = cameras.filter(cameraOnline).length
  const title = captureMode ? '车辆抓拍视频' : `${group.groupName ?? group.name ?? '设备组'} 的摄像头`

  return (
    <div
      className={`co-modal-overlay co-camera-overlay${captureMode ? ' co-camera-overlay--capture' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={event => { if (event.target === event.currentTarget) closeCamera() }}
    >
      <div className="co-camera-modal">
        <div className="co-modal-head">
          <span className="co-modal-title">{title}</span>
          <button ref={closeRef} type="button" className="co-modal-close" aria-label="关闭摄像头详情" onClick={closeCamera}>×</button>
        </div>
        <div className="co-camera-body">
          {/* 抓拍形态隐藏整个侧栏（旧 camera-overlay.capture-mode 的 display:none）。 */}
          {!captureMode && (
            <aside className="co-camera-sidebar" aria-label="摄像头列表">
              <div className="co-camera-stats">
                <span>摄像头 <strong>{cameras.length}</strong></span>
                <span className="co-camera-stats-online">在线 <strong>{online}</strong></span>
              </div>
              <input
                type="search"
                className="co-camera-search"
                placeholder="搜索摄像头名称或编码"
                aria-label="搜索摄像头名称或编码"
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
              <div className="co-camera-list">
                {visible.length === 0
                  ? <div className="co-camera-list-empty">{cameras.length === 0 ? '该设备组下没有摄像头' : '没有匹配的摄像头'}</div>
                  : visible.map((camera, index) => (
                    <CameraChoice key={index} camera={camera} shape="list" selected={camera === selected} onSelect={() => setSelected(camera)} />
                  ))}
              </div>
            </aside>
          )}
          <section className="co-camera-main">
            <div className="co-camera-toolbar">
              <span className="co-camera-selected-name">{selected === null ? '暂无摄像头' : (captureMode ? '抓拍片段' : `摄像头 - ${cameraName(selected)}`)}</span>
              {selected !== null && !captureMode && (
                <span className={`co-camera-online${cameraOnline(selected) ? ' co-camera-online--ok' : ''}`}>
                  {cameraOnline(selected) ? '● 在线' : '● 离线'}
                </span>
              )}
            </div>
            <div className="co-camera-detail">
              {selected === null
                ? (
                  <div className="co-camera-preview-state">
                    <div className="co-camera-preview-title">暂无摄像头</div>
                    <div className="co-camera-preview-copy">该设备组只包含其他类型设备，本弹窗按要求不予展示。</div>
                  </div>
                )
                : (
                  <>
                    <CameraPreview camera={selected} captureMode={captureMode} />
                    <CameraInfo camera={selected} group={group} captureMode={captureMode} />
                  </>
                )}
            </div>
            {!captureMode && selected !== null && (
              <>
                <div className="co-camera-strip-title">同组摄像头</div>
                <div className="co-camera-strip">
                  {cameras.map((camera, index) => (
                    <CameraChoice key={index} camera={camera} shape="thumb" selected={camera === selected} onSelect={() => setSelected(camera)} />
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

/** 列表项/条带缩略（旧 cameraChoice 的两种形态）。 */
function CameraChoice({ camera, shape, selected, onSelect }: {
  camera: CameraRecord
  shape: 'list' | 'thumb'
  selected: boolean
  onSelect: () => void
}): ReactElement {
  const online = cameraOnline(camera)
  return (
    <button
      type="button"
      className={shape === 'list' ? 'co-camera-list-item' : 'co-camera-thumb'}
      aria-current={selected}
      onClick={onSelect}
    >
      {shape === 'list'
        ? (
          <>
            <span className={`co-camera-status-dot${online ? ' co-camera-status-dot--online' : ''}`} aria-hidden="true" />
            <span className="co-camera-item-name">{cameraName(camera)}</span>
          </>
        )
        : (
          <>
            <span className="co-camera-thumb-name">{cameraName(camera)}</span>
            <span className="co-camera-thumb-status">
              <span className={`co-camera-status-dot${online ? ' co-camera-status-dot--online' : ''}`} aria-hidden="true" />
              {online ? '在线' : '离线'}
            </span>
          </>
        )}
    </button>
  )
}

/** 视频预览（旧 renderCameraPreview：加载态 → 播放器挂载 / 无地址与失败态）。 */
function CameraPreview({ camera, captureMode }: { camera: CameraRecord; captureMode: boolean }): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'loading' | 'player' | 'failed'>('loading')

  const stream = String(camera.accessAddress ?? camera.videoAddress ?? '')
  useEffect(() => {
    if (stream === '') return
    let cancelled = false
    let app: { unmount(): void } | null = null
    setPhase('loading')
    loadHyPlayer(routePath)
      .then(() => {
        if (cancelled || hostRef.current === null) return
        app = mountHyPlayer(hostRef.current, stream, routePath, '/assets/video-player/plugin/jessibuca')
        setPhase('player')
      })
      .catch(() => {
        if (!cancelled) setPhase('failed')
      })
    return () => {
      cancelled = true
      app?.unmount()
    }
  }, [stream])

  if (stream === '') {
    return (
      <div className="co-camera-preview-state">
        <div className="co-camera-preview-title">{cameraName(camera)}</div>
        <div className="co-camera-preview-copy">{captureMode ? '当前抓拍片段未返回可用的视频地址。' : '当前摄像头未返回可用的视频地址。'}</div>
      </div>
    )
  }
  if (phase === 'failed') {
    return (
      <div className="co-camera-preview-state">
        <div className="co-camera-preview-title">{cameraName(camera)}</div>
        <div className="co-camera-preview-copy">定制播放器加载失败，请检查本地播放器资源。</div>
      </div>
    )
  }
  return (
    <div className="co-camera-preview">
      {phase === 'loading' && (
        <div className="co-camera-preview-state">
          <div className="co-camera-preview-title">{cameraName(camera)}</div>
          <div className="co-camera-preview-copy">{captureMode ? '正在加载抓拍视频…' : '正在加载园区定制播放器…'}</div>
        </div>
      )}
      {/* Vue 受控飞地：host 渲染权归 @hy-media（Vue mount/unmount 见 hy-player.ts）。 */}
      <div ref={hostRef} className="co-camera-player-host" />
    </div>
  )
}

/** 详情信息行（旧 renderCameraInfo：抓拍片段与普通摄像头两套字段）。 */
function CameraInfo({ camera, group, captureMode }: { camera: CameraRecord; group: TrackDeviceGroup; captureMode: boolean }): ReactElement {
  const rows: Array<[string, string, boolean]> = camera.capture === true
    ? [
      ['抓拍开始', String(camera.startTime ?? '--'), false],
      ['片段时长', String(camera.timeLength ?? '--'), false],
      ['设备编号', String(camera.deviceId ?? '--'), false],
      ['媒体地址', '已隐藏', false],
    ]
    : [
      ['设备编码', String(camera.code ?? '--'), false],
      ['摄像机编码', String(camera.cameraCode ?? '--'), false],
      ['设备 IP', String(camera.deviceIp ?? '--'), false],
      ['视频地址', camera.hideAddress === true ? '已隐藏' : String(camera.accessAddress ?? camera.videoAddress ?? '--'), false],
      ['所属设备组', String(group.groupName ?? group.name ?? '--'), false],
      ['最后心跳', fmtDT(camera.lastHeartbeatTime) || '--', false],
      ['运行状态', cameraOnline(camera) ? '在线' : '离线', cameraOnline(camera)],
    ]
  return (
    <dl className="co-camera-info">
      {rows.map(([k, v, ok]) => (
        <div className="co-camera-info-row" key={k}>
          <dt>{k}</dt>
          <dd className={ok ? 'co-camera-info-ok' : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
