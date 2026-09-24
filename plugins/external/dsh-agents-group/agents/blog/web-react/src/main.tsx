import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'

// StrictMode 开启（比照 butler 批 0 决策）：开发态暴露副作用问题。
// 代价与对策：批 2 的订阅-快照 hook 侧必须幂等（abort+cleanup 完整、
// epoch/refreshVersion 守卫不重复消费）——该约束在批 2 的 hook 设计里落地。
const container = document.getElementById('root')
if (container === null) throw new Error('blog: 页面缺少 #root 挂载点')
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
