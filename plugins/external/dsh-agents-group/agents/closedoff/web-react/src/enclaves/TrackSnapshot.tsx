/**
 * 内嵌轨迹/围栏快照飞地（旧 renderTrajectory + redrawTrack 的 React 等价）。
 *
 * 回答区的地图是「静态三维场景截图 + 图例」，不是交互面（旧码注释：交互和手动
 * 保存只在大屏弹窗中提供）。React 侧结构：外壳（标题/操作/图例）数据驱动，
 * 截图容器是 Cesium 受控飞地——容器渲染权全归引擎（防护见 cesium-enclave.ts
 * 文件头），本组件只保证：容器节点稳定不 remount、className 固定、卸载时
 * session.dispose()。cameras 晚到（track 引用变化）触发 effect 重跑=同容器重挂载，
 * 由快照队列与 token 顶替收敛（旧 snapshotToken 同语义）。
 */
import { useEffect, useRef, useState } from 'react'
import { DshIcon } from '../components/DshIcon.tsx'
import { routePath } from '../lib/config.ts'
import type { BoardTrack } from '../lib/restore.ts'
import type { FenceGeometry, TrackDeviceGroup } from '../lib/types.ts'
import { fmtDT, groupNameOf, vt } from '../lib/trajectory-data.ts'
import { useEnclaveStore } from '../stores/enclave.ts'
import { TrackMapSession, fencesPayload } from './cesium-enclave.ts'
import type { TrackMapPayload } from './cesium-enclave.ts'
import type { ReactElement } from 'react'

/** 地图配置（CLOSEDOFF_CONFIG.map 的兜底读取：测试/未注入时给最小合法值）。 */
function mapConfig(): { terrainUrl: string; tilesetUrl: string; tilesetHeight: number; trackDeviceRadiusMeters: number } {
  return (globalThis as { CLOSEDOFF_CONFIG?: { map?: { terrainUrl: string; tilesetUrl: string; tilesetHeight: number; trackDeviceRadiusMeters: number } } }).CLOSEDOFF_CONFIG?.map
  ?? { terrainUrl: '', tilesetUrl: '', tilesetHeight: 0, trackDeviceRadiusMeters: 50 }
}

/** 快照内容视图：轨迹（含设备组）或围栏二选一。 */
export interface SnapshotContent {
  callId: string
  track?: BoardTrack
  fences?: FenceGeometry[]
}

export function TrackSnapshot({ content }: { content: SnapshotContent }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<TrackMapSession | null>(null)
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null)
  const openCamera = useEnclaveStore(state => state.openCamera)
  const openModal3d = useEnclaveStore(state => state.openModal3d)

  const track = content.track
  const fences = content.fences
  const groups = track?.groups ?? []
  const points = track?.points ?? []
  const isFences = fences !== undefined && fences.length > 0

  // 飞地生命周期：容器挂载创建 session，卸载全链销毁（防泄漏第 4 坑的落点）。
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    const session = new TrackMapSession(container, {
      mapConfig: mapConfig(),
      routePath,
      onGroupClick: group => useEnclaveStore.getState().openCamera({ group }),
    })
    sessionRef.current = session
    return () => {
      session.dispose()
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [])

  // 数据重排：载荷变化（含 cameras 晚到）→ 排快照作业（队列串行 + token 顶替）。
  useEffect(() => {
    const session = sessionRef.current
    if (session === null) return
    const payload: TrackMapPayload = isFences
      ? fencesPayload(fences)
      : { points, groups, ...(track?.vehicleNo === undefined ? {} : { vehicleNo: track.vehicleNo }) }
    setError(null)
    session.mountSnapshot(payload, content.callId, (message, retry) => {
      setError({ message, retry })
    })
    // points/groups 引用变化（流式中 cameras 合并会产生新对象）即重排，同旧 redrawTrack。
  }, [content.callId, isFences, track, groups, points, fences])

  const timeRange = points.length > 0
    ? `${fmtDT(vt(points[0]))} 至 ${fmtDT(vt(points[points.length - 1]))}`
    : ''
  const title = isFences
    ? `电子围栏 · ${fences.length} 个边界`
    : `${track?.vehicleNo ?? '车牌未知'} · 车辆轨迹 ${timeRange}`

  const open3d = (): void => {
    openModal3d({
      callId: content.callId,
      ...(isFences ? { fences } : track === undefined ? {} : { track }),
    })
  }

  return (
    <div className="co-enclave-ref co-track-ref" data-enclave={isFences ? 'fences' : 'track'} id={`co-track-${content.callId}`}>
      <section className="co-trajectory">
        <h4 className="co-trajectory-title">
          {isFences
            ? title
            : <><strong className="co-trajectory-plate">{track?.vehicleNo ?? '车牌未知'}</strong><span className="co-trajectory-time">车辆轨迹 · {timeRange}</span></>}
        </h4>
        <div className="co-track-actions">
          <button type="button" className="co-map-3d-btn" aria-label={`全屏查看${title}`} onClick={open3d}>
            <DshIcon name="locate" /> 全屏查看
          </button>
        </div>
        <div className="co-track-fig">
          <div className="co-track-stage">
            {/* Cesium 飞地容器：渲染权全归引擎，React 不给 children（防护第 1/3 坑）。 */}
            <div
              ref={containerRef}
              className="co-track-map"
              role="region"
              aria-label={`${title}三维场景截图`}
            />
            {error !== null && (
              <div className="co-map-status co-map-status--error" role="alert">
                <span>{error.message}</span>
                <button type="button" className="co-map-3d-btn" onClick={error.retry}>重新生成截图</button>
              </div>
            )}
            <aside className="co-track-legend" aria-label={isFences ? '电子围栏' : '轨迹设备组'}>
              {isFences
                ? <FenceLegend fences={fences} />
                : <GroupLegend groups={groups} onOpen={group => openCamera({ group })} />}
            </aside>
          </div>
          <div className="co-track-cap">
            {isFences
              ? `电子围栏（三维场景截图） · ${fences.length} 个边界 · 按保存的边界坐标与围栏高度展示`
              : `轨迹示意图（三维场景截图） · ${points.length} 个点位${groups.length > 0 ? ` · 轨迹 ${mapConfig().trackDeviceRadiusMeters} 米内设备组 ${groups.length} 个 · 设备 ${groups.reduce((n, group) => n + (group.devices?.length ?? 0), 0)} 个 · 点击侧栏名称查看摄像头` : ''} · ${timeRange.replace(' 至 ', ' ~ ')}`}
          </div>
        </div>
      </section>
    </div>
  )
}

/** 图例：设备组列表（旧 camera.renderGroupList 的 React 等价）。 */
function GroupLegend({ groups, onOpen }: { groups: readonly TrackDeviceGroup[]; onOpen: (group: TrackDeviceGroup) => void }): ReactElement {
  if (groups.length === 0) return <div className="co-legend-empty">正在等待设备组标绘数据…</div>
  return (
    <>
      <div className="co-legend-head">
        <span className="co-legend-title">设备组 <small>点击查看摄像头</small></span>
        <span className="co-legend-total">{groups.length}</span>
      </div>
      <div className="co-legend-list">
        {groups.map((group, index) => (
          <button
            type="button"
            className="co-lg-item"
            key={index}
            title={`查看 ${groupNameOf(group)} 的摄像头`}
            onClick={() => onOpen(group)}
          >
            <span className="co-lg-no">{String(index + 1).padStart(2, '0')}</span>
            <span className="co-lg-name">{groupNameOf(group)}</span>
            <span className="co-lg-count">{group.devices?.length ?? 0} 路</span>
          </button>
        ))}
      </div>
    </>
  )
}

/** 图例：围栏列表（旧 renderFenceList 的 React 等价）。 */
function FenceLegend({ fences }: { fences: readonly FenceGeometry[] }): ReactElement {
  return (
    <>
      <div className="co-legend-head">
        <span className="co-legend-title">电子围栏</span>
        <span className="co-legend-total">{fences.length}</span>
      </div>
      {fences.map((fence, index) => (
        <div className="co-lg-item co-lg-item--static" key={index}>
          {`${fence.name} · ${fence.kind === 'wall' ? '围栏' : '区域'} · ${fence.positions.length} 个边界点`}
        </div>
      ))}
    </>
  )
}
