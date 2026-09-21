import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'

// StrictMode 开启（方案 §3.3 批 0 决策）：开发态暴露副作用问题。
// 代价与对策：useEventStream 的 effect 双调用 = 双订阅 SSE，订阅侧必须幂等
// （abort+cleanup 完整、after=lastSeq 不重复消费）——该约束在批 1 的 hook 设计里落地。
const container = document.getElementById('root')
if (container === null) throw new Error('butler: 页面缺少 #root 挂载点')
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
