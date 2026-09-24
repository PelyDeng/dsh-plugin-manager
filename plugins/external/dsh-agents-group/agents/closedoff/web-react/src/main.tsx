import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app.tsx'

// StrictMode 开启（比照 butler 批 0 决策）：开发态暴露副作用问题。
// 代价与对策：批 1 的单向事件流（POST /chat 十类事件→多面板分发）订阅侧必须
// 幂等（abort+cleanup 完整、身份 epoch 守卫不重复消费）——该约束在批 1 落地。
const container = document.getElementById('root')
if (container === null) throw new Error('closedoff: 页面缺少 #root 挂载点')
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
