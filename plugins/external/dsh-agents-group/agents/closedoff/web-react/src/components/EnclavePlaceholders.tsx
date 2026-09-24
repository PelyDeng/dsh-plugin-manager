/**
 * 媒体飞地入口（批 1b 定稿形态）。
 *
 * 批 1a 的地图/三维/摄像头占位组件已由真实飞地取代（TrackSnapshot/Modal3d/
 * CameraModal，见 enclaves/）；这里只剩媒体引用行的「查看抓拍视频」按钮——点击
 * 把抓拍片段包装成单摄像头设备组打开摄像头弹窗（captureMode，旧 renderVehicleMedia
 * 的 onclick 语义原样）。
 */
import { useEnclaveStore } from '../stores/enclave.ts'
import type { MediaItem } from '../lib/types.ts'
import type { ReactElement } from 'react'

export function MediaPlayButton({ item }: { item: MediaItem }): ReactElement {
  const openCamera = useEnclaveStore(state => state.openCamera)
  const open = (): void => {
    // 旧 renderVehicleMedia 的包装形状：capture=true 的单设备组，地址字段收窄进
    // videoAddress（hideAddress 使详情行显示「已隐藏」）。
    openCamera({
      captureMode: true,
      group: {
        groupName: '车辆抓拍视频',
        captureMode: true,
        devices: [{
          deviceType: 6,
          capture: true,
          hideAddress: true,
          name: typeof item.startTime === 'string' && item.startTime !== '' ? item.startTime : '抓拍片段',
          deviceId: item.deviceId,
          startTime: item.startTime,
          timeLength: item.timeLength,
          videoAddress: item.mediaUrl,
        }],
      },
    })
  }
  const disabled = item.mediaUrl === undefined || item.mediaUrl === ''
  return (
    <button type="button" className="co-media-play" onClick={open} disabled={disabled}
      title={disabled ? '当前片段没有可用的视频地址' : '查看抓拍视频'}>
      查看抓拍视频
    </button>
  )
}
