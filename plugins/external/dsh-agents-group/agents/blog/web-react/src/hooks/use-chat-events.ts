/**
 * use-chat-events：EventSource 订阅生命周期的 React 绑定（批 2a）。
 *
 * 分层（closedoff 批 1a 同款）：控制流真相源在 chat-controller（纯 TS，单测直接
 * 驱动）；本 hook 只做三件页面级副作用——
 * 1. 订阅生命周期：conversationId/viewToken 变化 → connect（幂等：内部先关旧流）。
 *    StrictMode 双挂载安全：effect 建立→清理→再建立，connect 每次全量重建且消息
 *    分发有代次守卫，不重复消费。
 * 2. 启动序列：bootstrap 首步是身份核验，identityReady 后的重复调用会被守卫收敛
 *    （StrictMode 双挂载第二次直接跳过）。
 * 3. 全局清理：卸载断流 + 停防抖（旧 beforeunload 断流的等价扩展）。
 * 4. 未保存警告：文章工作台 dirty 时关闭/刷新页面先拦截提示（旧 app.js:269 的
 *    beforeunload preventDefault 分支，A2）——非 dirty 时放行且只做断流清理。
 */
import { useEffect } from 'react'
import { bootstrap, clearScheduledRefresh, closeStream, connect } from '../chat-controller.ts'
import { useConversationStore } from '../stores/conversation.ts'
import { useSessionStore } from '../stores/session.ts'
import { useWorkspaceStore } from '../stores/workspace.ts'

export function useChatEvents(): void {
  const conversationId = useConversationStore(state => state.conversationId)
  const viewToken = useSessionStore(state => state.viewToken)

  useEffect(() => {
    if (conversationId === '') return undefined
    return connect(conversationId, viewToken)
  }, [conversationId, viewToken])

  useEffect(() => {
    if (!useSessionStore.getState().identityReady) void bootstrap().catch(() => {})
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // 文章工作台有未保存改动时先警告（旧 app.js:269 同语义）；断流照做。
      if (useWorkspaceStore.getState().dirty) event.preventDefault()
      closeStream()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      closeStream()
      clearScheduledRefresh()
    }
  }, [])
}
