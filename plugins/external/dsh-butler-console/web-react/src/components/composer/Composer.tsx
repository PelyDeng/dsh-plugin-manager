/**
 * 输入区（批 3 基础发送链路）：autosize、Enter 发送/Shift+Enter 换行、IME 组合不拦、
 * 字数统计、失败草稿回填。@提及与附件在批 4a。
 *
 * 只锁发送不锁输入（I02）：执行中可以写下一句，这句草稿不会被异步完成/恢复/切换清掉
 * ——清空只发生在真正送出的那次提交。
 */
import { useEffect, useRef, useState } from 'react'
import { registerDraftRestore, sendMessage, stopTurn } from '../../hooks/use-turn.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useTurnStore } from '../../stores/turn.ts'
import { registerTearTap } from '../chat/entries.tsx'

export function Composer() {
  const streaming = useTurnStore(state => state.streaming)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const composingRef = useRef(false)

  // 失败草稿回填（hook 层在未受理失败时调用；用户后来打过字就不覆盖由 hook 判断时机，
  // 这里只负责把值放回并聚焦）。欢迎板撕条点击也走同一通道填入完整话。
  useEffect(() => {
    registerDraftRestore(text => {
      setDraft(current => (current === '' ? text : current))
      inputRef.current?.focus()
    })
    registerTearTap(text => {
      setDraft(text)
      inputRef.current?.focus()
    })
  }, [])

  const autosize = () => {
    const input = inputRef.current
    if (input === null) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
  }

  const submit = () => {
    const text = draft
    if (text.trim() === '') return
    setDraft('')
    window.requestAnimationFrame(autosize)
    void sendMessage(text)
  }

  const length = [...draft].length
  const hint = streaming
    ? '正在处理；下一句可以先写好，这轮完事再发'
    : null

  return (
    <div className="composer" id="composer">
      <div className="composer__box">
        <label className="visually-hidden" htmlFor="message-input">说句话</label>
        <textarea
          id="message-input"
          ref={inputRef}
          rows={1}
          placeholder="说说你要做什么"
          autoComplete="off"
          value={draft}
          onChange={() => { setDraft(inputRef.current?.value ?? ''); autosize() }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={event => {
            // 点名簿（批 4a）优先；Enter 发送，Shift+Enter 换行；输入法组合期间不拦截。
            if (event.key === 'Enter' && !event.shiftKey && !composingRef.current) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer__actions">
          <button
            type="button"
            className="send"
            aria-label="发送"
            disabled={streaming}
            onClick={submit}
          >
            <svg width="20" height="18" viewBox="0 0 20 18" fill="none" aria-hidden="true">
              <path d="M18.2 2.2 C 12.6 4.6, 7 7.4, 2.4 10.2 C 5.2 11.2, 7.6 12.2, 9.6 13.4 C 12.4 9.6, 15.2 5.8, 18.2 2.2 Z M9.6 13.4 C 10 12.4, 10.6 10.8, 11.4 9 C 13.6 6.6, 15.8 4.4, 18.2 2.2 Z" fill="#fff" />
            </svg>
          </button>
        </div>
      </div>
      <div className="composer__hint">
        <span>
          {hint !== null
            ? hint
            : <>牛马大总管<span className="red-wavy">先听明白需求</span>，再替你分派成员</>}
        </span>
        <span id="composer-count">{length > 0 ? `${length} 字` : ''}</span>
      </div>
    </div>
  )
}

/** 喊停（执行中显形，I04/I08）：停止对象绑定当前会话；结果以这一轮最终状态为准。 */
export function StopButton() {
  const streaming = useTurnStore(state => state.streaming)
  const [disabled, setDisabled] = useState(false)
  const setTopStatus = useSessionStore(state => state.setTopStatus)
  if (!streaming) return null
  return (
    <button
      type="button"
      className="btn btn--tiny btn--ghost"
      id="stop-button"
      disabled={disabled}
      onClick={() => {
        setDisabled(true)
        setTopStatus('正在请求停止')
        void stopTurn().finally(() => setDisabled(useTurnStore.getState().streaming))
      }}
    >
      喊停
    </button>
  )
}
