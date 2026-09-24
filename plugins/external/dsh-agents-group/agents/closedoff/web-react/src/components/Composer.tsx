/**
 * 输入区（旧 composer 段）：textarea 自动增高 + 模型选择器 + 发送/停止一体按钮。
 * Enter 发送、Shift+Enter 换行（旧 keydown 口径；输入法组合态不拦截）。
 */
import { useRef } from 'react'
import { useChatStream } from '../hooks/use-chat-stream.ts'
import { useComposerStore } from '../stores/composer.ts'
import { useTurnStore } from '../stores/turn.ts'
import type { ReactElement } from 'react'
import { Icon } from '@dsh-agents-group/web-common'
import { ModelPicker } from './ModelPicker.tsx'

const MAX_INPUT_HEIGHT = 140

export function Composer(): ReactElement {
  const { send, stop, running } = useChatStream()
  const draft = useComposerStore(state => state.draft)
  const setDraft = useComposerStore(state => state.setDraft)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const wasRunning = useRef(running)

  // 一轮结束后聚焦回输入框（旧码停止后按钮复位的可用性等价）。
  if (wasRunning.current && !running) areaRef.current?.focus()
  wasRunning.current = running

  const autoGrow = (): void => {
    const node = areaRef.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }

  return (
    <div className="co-composer">
      <div className="co-composer-inner">
        <div className="co-input-box">
          <textarea
            ref={areaRef}
            rows={1}
            value={draft}
            placeholder="请输入您的问题，例如：今天有哪些待审批的危化车预约？"
            aria-label="问题输入框"
            onChange={event => { setDraft(event.target.value); autoGrow() }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                send(draft)
              }
            }}
          />
          <div className="co-input-meta">
            <ModelPicker />
            <p className="co-hint">Enter 发送 · Shift+Enter 换行 · 智能体会自动调用园区业务接口取数并分析</p>
          </div>
        </div>
        <button
          type="button"
          className={`co-send${running ? ' co-send--stop' : ''}`}
          title={running ? '停止回答' : '发送'}
          aria-label={running ? '停止回答' : '发送'}
          onClick={() => (running ? stop() : send(draft))}
        >
          {running ? <Icon name="x" size={18} /> : <Icon name="arrow_up_right" size={18} />}
        </button>
      </div>
    </div>
  )
}
