/**
 * 页面配置（src/web.ts 注入 `window.CLOSEDOFF_CONFIG`，批 0 骨架同形态）。
 * 路由前缀由服务端注入，前端不写死；地图配置批 1b 的 Cesium 飞地才消费，
 * 这里只透传形状。
 */
export interface MapConfig {
  terrainUrl: string
  tilesetUrl: string
  tilesetHeight: number
  trackDeviceRadiusMeters: number
}

export interface App {
  routePrefix: string
  map: MapConfig
}

const raw = (globalThis as { CLOSEDOFF_CONFIG?: App }).CLOSEDOFF_CONFIG

/** 与旧页面同口径：缺配置直接抛错（不渲染残缺页面）。 */
export const APP_CONFIG: App = (() => {
  if (raw === undefined || typeof raw.routePrefix !== 'string' || raw.routePrefix === '' || raw.map === undefined) {
    throw new Error('封闭化页面配置缺失')
  }
  return raw
})()

/** 业务接口路径：routePrefix + 相对路径（与旧 routePath 等价）。 */
export function routePath(path: string): string {
  return APP_CONFIG.routePrefix + path
}

/** 地图配置的兜底读取（CLOSEDOFF_CONFIG.map 缺失时给最小合法值——单测/降级环境）。 */
export function mapConfigOrFallback(): MapConfig {
  return (globalThis as { CLOSEDOFF_CONFIG?: { map?: MapConfig } }).CLOSEDOFF_CONFIG?.map
  ?? { terrainUrl: '', tilesetUrl: '', tilesetHeight: 0, trackDeviceRadiusMeters: 50 }
}
