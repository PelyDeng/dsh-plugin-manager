/**
 * use-chat-stream（React 绑定薄层）：控制流的真相源在 chat-controller（纯 TS，
 * 可被单测直接驱动）；这里只把 store 状态接进 React 并承担页面级副作用
 * （启动序列、焦点身份复检、跨标签页登录变化）。
 */
import { useEffect } from 'react'
import { bootstrap, logout, openConversation, refreshConversations, sendMessage, startFreshConversation, stopSend } from '../chat-controller.ts'
import { checkIdentity } from '../lib/api.ts'
import { useBoardStore } from '../stores/board.ts'
import { useComposerStore } from '../stores/composer.ts'
import { usePickerStore } from '../stores/picker.ts'
import { useSessionStore } from '../stores/session.ts'
import { useTurnStore } from '../stores/turn.ts'

export function useChatStream(): {
  send: (text: string) => void
  stop: () => void
  running: boolean
  openConversationById: (id: string) => void
  newConversation: () => void
  signOut: () => void
} {
  const running = useTurnStore(state => state.active)

  // 启动序列只在挂载时跑一次；bootstrap 首步是身份核验，重复调用无害
  // （StrictMode 双挂载时第二次会被 identityReady/stale 守卫自然收敛）。
  useEffect(() => {
    if (!useSessionStore.getState().identityReady) void bootstrap()
  }, [])

  // 窗口重新聚焦时复检身份（旧码 focus 监听同口径）。
  useEffect(() => {
    const onFocus = (): void => {
      if (useSessionStore.getState().identityReady) void checkIdentity().catch(() => {})
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  // 其他标签页的登录变化（旧码 storage 监听）。
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === 'dsh_auth_changed' && useSessionStore.getState().identityReady) {
        useSessionStore.getState().clearPrivateView()
        window.location.reload()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // bfcache 恢复（pageshow persisted）：内存态可能已落后于服务端，强制整页重载
  // 走一遍身份核验与复原（旧码 pageshow 监听同口径；storage 的 reload 只覆盖跨标签页）。
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) window.location.reload()
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [])

  return {
    send: text => { void sendMessage(text) },
    stop: stopSend,
    running,
    openConversationById: id => { void openConversation(id) },
    newConversation: () => { void startFreshConversation() },
    signOut: () => { void logout() },
  }
}

// re-export：组件层统一从这里取会话操作与 store 挂钩，避免散装 import。
export { refreshConversations, sendMessage, startFreshConversation, stopSend }
export { useBoardStore, useComposerStore, usePickerStore, useSessionStore, useTurnStore }
