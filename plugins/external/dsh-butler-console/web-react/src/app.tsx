import { AppShell } from './components/app/AppShell.tsx'

// 服务端注入的部署配置（routePrefix/分页上限/附件上限），与旧前端同一来源。
declare const globalThis: { __BUTLER_CONFIG__?: Record<string, unknown> }
void globalThis

export function App() {
  return <AppShell />
}
