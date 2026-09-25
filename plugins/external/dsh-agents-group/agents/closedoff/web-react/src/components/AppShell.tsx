/**
 * 工作台骨架（旧 web/index.html 的 header/main 结构）：顶栏、对话区、
 * 快捷提问侧栏、历史面板、批 1b 重交互飞地（三维弹窗/摄像头弹窗）。
 *
 * 全屏工作台布局（overflow hidden）与 prefers-reduced-motion 降级在成员 CSS
 * 里保留（方案 §3.2：不可破坏项）；内嵌轨迹快照飞地跟随消息流渲染
 * （TrackSnapshot），重交互弹窗按 enclave store 参数条件挂载。
 */
import { useEffect, useState } from 'react'
import { announce } from '@dsh-agents-group/web-common'
import { useSessionStore } from '../stores/session.ts'
import { useBoardStore } from '../stores/board.ts'
import { useTurnStore } from '../stores/turn.ts'
import { MOBILE_QUERY, isMobileViewport } from '../lib/viewport.ts'
import { useChatStream } from '../hooks/use-chat-stream.ts'
import type { ReactElement } from 'react'
import { CameraModalEnclave } from '../enclaves/CameraModal.tsx'
import { Modal3dEnclave } from '../enclaves/Modal3d.tsx'
import { Composer } from './Composer.tsx'
import { ConversationPanel } from './ConversationPanel.tsx'
import { MessageList } from './MessageList.tsx'

const QUICK_GROUPS: Array<{ title: string; items: string[] }> = [
  {
    title: '快捷提问 · 园区概览',
    items: ['园区现在整体情况怎么样？', '今天共有多少预约？各类型分别是多少？', '今天预约审批情况如何（待审数、通过率）？'],
  },
  {
    title: '快捷提问 · 预约审批',
    items: ['现在有哪些待审批的预约？', '有哪些危化车预约正在等待园区审批？', '最近有哪些预约被企业或园区驳回？'],
  },
  {
    title: '快捷提问 · 车辆轨迹',
    items: ['现在园区里有哪些车辆？', '查一下云A7D00M 今天的行驶轨迹'],
  },
  {
    title: '快捷提问 · 预警报警',
    items: ['现在有哪些还在持续的报警？', '最近有哪些危化车相关的报警？'],
  },
  {
    title: '快捷提问 · 路网停车',
    items: ['园区有哪些控制区/电子围栏？', '园区有哪些停车区？各还有多少空位？'],
  },
]

export function AppShell(): ReactElement {
  const { send, newConversation, openConversationById, signOut } = useChatStream()
  const status = useSessionStore(state => state.status)
  const identityReady = useSessionStore(state => state.identityReady)
  const identityLabel = useSessionStore(state => state.identityLabel)
  const identityMode = useSessionStore(state => state.identityMode)
  const restoreError = useBoardStore(state => state.restoreError)
  const turnActive = useTurnStore(state => state.active)
  // 桌面默认展开（旧 conversation-history.js 的 layout()：非 mobile 且未收起即 show。
  // 旧 storageKey 是空串、折叠记忆从未生效——对齐的是「每次进入默认展开」的可见行为，
  // 不复刻一个坏掉的记忆）。≤960px 走浮层形态，默认收起。
  const [historyOpen, setHistoryOpen] = useState(() => !isMobileViewport())
  const [notice, setNotice] = useState('')

  // 断点变化时面板形态跟随（旧码 mobile change → layout() 同口径）：
  // 窄屏转浮层即收起，宽屏恢复常驻展开。
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY)
    const onChange = (): void => setHistoryOpen(!media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  // 就地轻提示（announce 同步读屏；可见提示 2.4s 自清）。
  const notify = (text: string): void => {
    if (text === '') return
    announce(text)
    setNotice(text)
    window.setTimeout(() => setNotice(''), 2400)
  }

  useEffect(() => {
    if (!identityReady) return
    if (restoreError !== null) announce(`对话恢复失败：${restoreError}`)
  }, [identityReady, restoreError])

  return (
    <div className="co-workbench">
      <header className="co-header">
        <div className="co-logo" aria-hidden="true">封</div>
        <div className="co-brand">
          <div className="co-title">封闭化管理智能助手</div>
          <div className="co-subtitle">预约审批 · 人车物定位追踪 · 园区路网 · 预警报警</div>
        </div>
        <div className="co-spacer" />
        {identityLabel !== '' && <span className="co-account">{identityLabel}</span>}
        {identityMode === 'authenticated' && <a className="co-header-btn" href="/auth">账号</a>}
        {identityMode === 'authenticated' && <button type="button" className="co-header-btn" onClick={signOut}>退出</button>}
        <button type="button" className="co-header-btn" aria-expanded={historyOpen} aria-label={historyOpen ? '收起历史对话' : '展开历史对话'} onClick={() => setHistoryOpen(value => !value)}>
          历史对话
        </button>
        <div className="co-pill" role="status">
          <span className={`co-dot co-dot--${status.kind}`} aria-hidden="true" />
          <span>{status.text}</span>
        </div>
        <button type="button" className="co-header-btn" title="开始新对话" aria-label="开始新对话" disabled={!identityReady} onClick={newConversation}>
          ＋ 新对话
        </button>
        <button type="button" className="co-header-btn" title="清空当前对话" aria-label="清空当前对话" disabled={!identityReady} onClick={newConversation}>
          清空
        </button>
      </header>

      <div className="co-main">
        <div className="co-chat-col">
          <MessageList
            onRated={(index, rating) => {
              useBoardStore.getState().patchMessage(index, { rating })
            }}
            onBranch={conversationId => { void openConversationById(conversationId) }}
            onNotice={notify}
          />
          <Composer />
        </div>

        <aside className="co-side">
          {QUICK_GROUPS.map(group => (
            <div key={group.title}>
              <h4>{group.title}</h4>
              {group.items.map(item => (
                <button type="button" className="co-q-item" key={item} onClick={() => send(item)}>
                  {item}
                </button>
              ))}
            </div>
          ))}
          <h4>使用提示</h4>
          <div className="co-tips">
            <b>提问建议：</b><br />
            · 问题里带上<b>车牌号、时间、企业名</b>等具体条件，回答更精准<br />
            · 时间格式：2026-09-02 09:00:00<br />
            · 可追问：「只看危化车」「今天的数据」<br />
            · 数据来自园区业务系统实时接口
          </div>
        </aside>

        <ConversationPanel open={historyOpen} onClose={() => setHistoryOpen(false)} busy={turnActive} />
      </div>

      {notice !== '' && <span className="co-notice" role="status">{notice}</span>}

      {/* 批 1b 重交互飞地：三维弹窗与摄像头弹窗（打开=挂载，关闭=全链销毁）。 */}
      <Modal3dEnclave />
      <CameraModalEnclave />

      {/* announce() 的读屏播报区：容器常驻（live region 节点不卸载）。 */}
      <div id="sr-status" className="visually-hidden" role="status" aria-live="polite" />
    </div>
  )
}
