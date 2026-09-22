/**
 * 待办交互区（用户反馈 1/2 的统一答案）：把所有「等用户处理」的交互（确认发布/
 * 确认删除/回复提问/确认材料）从消息流里抽出来，固定在输入框上方醒目呈现——
 * 消息体再长也不用滑动找按钮。数据从 entries 派生（prepared 态操作卡 + ask 提问）。
 * 所有智能体通用：不按 kind 硬编码，按钮文案取自协议字段。
 */
import { useMemo, useState } from 'react'
import { useTurnStore, resolveActionLocally, resolveAskLocally } from '../../stores/turn.ts'
import { useSessionStore, displayNameOf } from '../../stores/session.ts'
import { runActionDecision, runReply } from '../../hooks/use-turn.ts'
import { announce } from '../../lib/announce.ts'
import { newConversationId } from '../../lib/turn-event.ts'
import { RichText } from '../chat/RichText.tsx'
import { actionExpired } from '../chat/ActionCard.tsx'

interface PendingItem {
  key: string
  taskId: string
  subtaskId: string
  agentId: string
  kind: 'confirm' | 'reply'
  actionId?: string | undefined
  title?: string | undefined
  summary?: string | undefined
  detail?: string | undefined
  confirmLabel?: string | undefined
  cancelLabel?: string | undefined
  /** 确认有效期（绝对毫秒）：过期的卡显示已过期、不可点（恢复的历史卡常见）。 */
  expiresAt?: number | undefined
  /** reply 型：提问内容。 */
  question?: string | undefined
}

/** 从 entries 派生「待用户处理」清单（prepared 态操作卡 + waiting_user 提问）。 */
function usePendingItems(): PendingItem[] {
  const entries = useTurnStore(state => state.entries)
  return useMemo(() => {
    const items: PendingItem[] = []
    for (const entry of entries) {
      if (entry.kind !== 'subtask') continue
      const taskId = entry.taskId ?? ''
      if (entry.state === 'waiting_user' && entry.ask !== undefined) {
        items.push({
          key: `reply-${entry.subtaskId}`, kind: 'reply', taskId: entry.ask.taskId,
          subtaskId: entry.subtaskId, agentId: entry.agentId,
          question: entry.ask.question, detail: entry.ask.detail,
        })
      }
      if (Array.isArray(entry.actions)) {
        for (const action of entry.actions) {
          if (action.state === 'prepared' && !actionExpired(action)) {
            items.push({
              key: `action-${action.id}`, kind: 'confirm', taskId,
              subtaskId: entry.subtaskId, agentId: entry.agentId,
              actionId: action.id,
              title: action.title, summary: action.summary, detail: action.detail,
              confirmLabel: action.confirmLabel, cancelLabel: action.cancelLabel,
              expiresAt: action.expiresAt,
            })
          }
        }
      }
    }
    return items
  }, [entries])
}

function PendingCard({ item }: { item: PendingItem }) {
  const members = useSessionStore(state => state.members)
  const [locked, setLocked] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [noteText, setNoteText] = useState('')
  const agentName = displayNameOf(members, item.agentId)

  const runDecision = async (decision: 'confirm' | 'cancel') => {
    setLocked(true)
    setNote(decision === 'confirm' ? '正在办理…' : '正在撤回…')
    try {
      await runActionDecision({
        taskId: item.taskId, subtaskId: item.subtaskId,
        actionId: item.actionId ?? '', decision,
        note: noteText.trim() === '' ? undefined : noteText.trim(),
        requestId: newConversationId(),
      }, {
        // 受理即摘卡：后端把子任务重新调度要数分钟，prepared 卡挂着只会诱导重复点击。
        onAccepted: () => { resolveActionLocally(item.subtaskId, item.actionId ?? ''); setNote(decision === 'confirm' ? '已受理，正在办理' : '已撤回') },
        onRejected: error => { setNote(`${decision === 'confirm' ? '确认' : '撤回'}没成功：${error instanceof Error && error.message !== '' ? error.message : '网络异常'}`); setLocked(false) },
      })
    } catch (error) {
      setNote(`${decision === 'confirm' ? '确认' : '撤回'}没成功：${error instanceof Error && error.message !== '' ? error.message : '网络异常'}`)
      setLocked(false)
    }
  }
  const runReplyThis = async (text: string, decideByAgent: boolean) => {
    // streaming 占用时由 runReply 内部等待复位（确认卡出现先于回合收尾的窗口）。
    setLocked(true)
    setNote('正在送出回话…')
    try {
      await runReply(
        { taskId: item.taskId, subtaskId: item.subtaskId, text, decideByAgent, requestId: newConversationId() },
        {
          onAccepted: () => { resolveAskLocally(item.subtaskId); setNote(null); setLocked(false); setReplyText(''); announce(`已回复 ${agentName}`) },
          onRejected: error => { setNote(`没送出去：${error instanceof Error && error.message !== '' ? error.message : '网络异常'}`); setLocked(false) },
        },
      )
    } catch (error) {
      setNote(`没送出去：${error instanceof Error && error.message !== '' ? error.message : '网络异常'}`)
      setLocked(false)
    }
  }

  return (
    <div className="action-deck__card">
      <div className="action-deck__head">
        <span className="action-deck__agent">@{agentName}</span>
        <span className="action-deck__hint">
          {item.kind === 'reply' ? '在等你回话' : '等你确认操作'}
        </span>
      </div>
      {item.kind === 'reply' ? (
        <>
          <div className="action-deck__question md"><RichText text={item.question ?? '需要你补充点信息'} variant="ask" /></div>
          <div className="action-deck__row">
            <input
              type="text"
              value={replyText}
              placeholder="补充说明"
              disabled={locked}
              onChange={event => setReplyText(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && !locked) { event.preventDefault(); void runReplyThis(replyText, false) } }}
            />
            <button type="button" className="btn btn--tiny btn--primary" disabled={locked} onClick={() => { void runReplyThis(replyText, false) }}>
              我来说
            </button>
            <button type="button" className="btn btn--tiny" disabled={locked} onClick={() => { void runReplyThis('', true) }}>
              你看着办
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="action-deck__title">{item.title ?? item.summary ?? '待确认的操作'}</div>
          <input
            type="text"
            className="action-deck__note-input"
            value={noteText}
            placeholder="给这条决策带句话（可选，如：换成 5 月再发）"
            disabled={locked}
            onChange={event => setNoteText(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !locked) { event.preventDefault(); void runDecision('confirm') } }}
          />
          <div className="action-deck__row">
            <button type="button" className="btn btn--tiny btn--primary" disabled={locked} onClick={() => { void runDecision('confirm') }}>
              {item.confirmLabel ?? '确认'}
            </button>
            <button type="button" className="btn btn--tiny" disabled={locked} onClick={() => { void runDecision('cancel') }}>
              {item.cancelLabel ?? '先不办'}
            </button>
          </div>
        </>
      )}
      {note !== null && <p className="action-deck__note">{note}</p>}
    </div>
  )
}

export function ActionDeck() {
  const pending = usePendingItems()
  if (pending.length === 0) return null
  return (
    <div className="action-deck" role="region" aria-label="待处理的确认与提问">
      {pending.map(item => (
        <PendingCard key={item.key} item={item} />
      ))}
    </div>
  )
}
