/**
 * ask 确认卡（waiting_user 的回话入口，批 3）：问题正文走 ask 变体（无图卡），
 * 「我来说」带补充说明、「你看着办」是显式语义单独走按钮。
 * 回话幂等（S07）：同一次回话（含失败原样重试）复用同一 ID；改措辞即新回话换新 ID。
 * 受理成功才收卡；之前失败都在卡内恢复，输入不丢（I03）。
 */
import { useEffect, useRef, useState } from 'react'
import { runReply } from '../../hooks/use-turn.ts'
import { resolveAskLocally } from '../../stores/turn.ts'
import { errorTextOf } from '../../lib/error-text.ts'
import { newConversationId } from '../../lib/turn-event.ts'
import { announce } from '../../lib/announce.ts'
import { RichText } from './RichText.tsx'

export interface AskCardProps {
  subtaskId: string
  agentId: string
  taskId: string
  question?: string | undefined
  detail?: string | undefined
}

export function AskCard({ subtaskId, taskId, question, detail }: AskCardProps) {
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // 回话幂等身份：同一次回话（含失败重试）复用；改了措辞换新 ID。
  const requestIdRef = useRef<string | null>(null)
  const lastTriedRef = useRef<string | null>(null)
  // 到达播报（评审 #21）：视觉上靠调度卡自动展开+脉冲，读屏用户要听到「在等回话」。
  useEffect(() => { announce(`有成员在等你回话：${question ?? '需要你补充点信息'}`) }, [])

  const submit = async (text: string, decideByAgent: boolean) => {
    // streaming 占用时由 runReply 内部等待复位（确认卡出现先于回合收尾的窗口）。
    // 空文本不提交（I03）：「你看着办」是显式语义，单独走按钮。
    if (!decideByAgent && text === '') {
      inputRef.current?.focus()
      return
    }
    if (requestIdRef.current === null || lastTriedRef.current !== text) {
      requestIdRef.current = newConversationId()
      lastTriedRef.current = text
    }
    setLocked(true)
    setErrorText(null)
    setNote('正在送出回话…')
    await runReply(
      { taskId, subtaskId, text, decideByAgent, requestId: requestIdRef.current },
      {
        onAccepted: () => {
          // 受理只摘卡（0.13.8 收卡统一：resolveAskLocally 是唯一收卡动作）。状态回 running
          // 等界面变化交给服务端事件——这里乐观迁移会吞掉调度卡「有更新」判定（复审 #1）。
          setNote(null)
          resolveAskLocally(subtaskId)
        },
        onRejected: error => {
          setNote(null)
          setLocked(false)
          setErrorText(`${errorTextOf(error, '没送出去')}；输入还在，改一下再试。`)
          inputRef.current?.focus()
        },
      },
    )
  }

  return (
    <div className="ask">
      <div>
        <RichText text={question ?? detail ?? '需要你补充点信息'} variant="ask" />
      </div>
      <div className="ask__row">
        <input
          type="text"
          ref={inputRef}
          aria-label="给成员的回话"
          placeholder="补充说明"
          disabled={locked}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit((event.target as HTMLInputElement).value.trim(), false)
            }
          }}
        />
        <button type="button" className="btn btn--tiny btn--primary" disabled={locked} onClick={() => { void submit((inputRef.current?.value ?? '').trim(), false) }}>
          我来说
        </button>
        <button type="button" className="btn btn--tiny" disabled={locked} onClick={() => { void submit('', true) }}>
          你看着办
        </button>
      </div>
      {note !== null && <div className="msg__meta">{note}</div>}
      {errorText !== null && <div className="error-line">{errorText}</div>}
    </div>
  )
}
