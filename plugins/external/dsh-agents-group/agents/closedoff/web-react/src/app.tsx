/**
 * 封闭化管理助手 · React 工作台（批 1a：数据层与主骨架）。
 *
 * 地图/轨迹/视频/弹窗是批 1b 的 Cesium 与 @hy-media 受控飞地——占位容器见
 * EnclavePlaceholders（id 锚点已留）。旧 web/ 前端保留到批 3 删码，作为回退与
 * 功能对照基准。
 */
import { AppShell } from './components/AppShell.tsx'

export function App() {
  return <AppShell />
}
