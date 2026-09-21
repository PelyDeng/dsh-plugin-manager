/**
 * ask 确认卡（waiting_user 的回话入口，批 3）：问题正文走 ask 变体（无图卡），
 * 「我来说」带补充说明、「你看着办」是显式语义单独走按钮。
 * 回话幂等（S07）：同一次回话（含失败原样重试）复用同一 ID；改措辞即新回话换新 ID。
 * 受理成功才收卡；之前失败都在卡内恢复，输入不丢（I03）。
 */
import { useRef, useState } from 'react'
import { runReply } from '../../hooks/use-turn.ts'
import { useTurnStore } from '../../stores/turn.ts'
import { newConversationId } from '../../lib/turn-event.ts'
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
          // 受理：收卡（ask 字段清掉由 waiting_user → 新状态事件或这里显式清）。
          setNote(null)
          useTurnStore.setState(st => ({
            entries: st.entries.map(entry => entry.kind === 'subtask' && entry.subtaskId === subtaskId
              ? { ...entry, ask: undefined, state: 'running', live: true, terminal: false }
              : entry),
          }))
        },
        onRejected: error => {
          setNote(null)
          setLocked(false)
          setErrorText(`${error instanceof Error && error.message !== '' ? error.message : '没送出去'}；输入还在，改一下再试。`)
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
