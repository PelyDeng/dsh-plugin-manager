/**
 * 应用根（批 2a：hello 页验证面替换为真实工作台外壳）。
 * 订阅-快照的启动序列与 EventSource 生命周期在 useChatEvents（挂载一次）。
 */
import { AppShell } from './components/AppShell.tsx'
import { useChatEvents } from './hooks/use-chat-events.ts'

export function App() {
  useChatEvents()
  return <AppShell />
}
