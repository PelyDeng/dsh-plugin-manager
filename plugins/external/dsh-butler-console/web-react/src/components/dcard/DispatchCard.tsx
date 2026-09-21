/**
 * 调度卡（批 4b 声明式重设计，语义对齐 web/modules/dcard.js mountDispatch 全家）：
 * **本次派活唯一的一张卡**——一行状态条 + 一行最多三个成员格子 + 选中成员的结果区。
 * 格子住进折叠头：收起时也看得见谁被调了、干到什么状态，收起来的只是交回的内容。
 *
 * 与旧实现的结构性差别：旧版把成员消息 DOM 整体搬进 slot；React 版按数据派生渲染——
 * 成员输出在 subtask entries（bubbleKeys 索引），本卡按 order 读取渲染，无双份状态。
 * 交互全保：点格子选中（再点不变，收起用折叠）、左右方向键换人、Esc 收起、折叠/只看
 * 结论/复制三工具、收起时的「有更新」、状态变化格描边脉冲、秒数全局唯一节拍。
 * 折叠与只看结论按 taskId 落本机（butler.card.* 键名格式沿用，方案批 5 核验项）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DispatchEntry, SubtaskEntry } from '../../stores/turn.ts'
import { saveCardPref } from '../../stores/turn.ts'
import { useTurnStore } from '../../stores/turn.ts'
import { displayNameOf, useSessionStore } from '../../stores/session.ts'
import { Avatar } from '../common/Avatar.tsx'
import { RichText } from '../chat/RichText.tsx'
import { AskCard } from '../chat/AskCard.tsx'
import { STREAM_RICH_LIMIT } from '../../lib/config.ts'
import { cardElapsedText, cardSettled, cardStateText, CARD_RESULT_TITLE, DISPATCH_TONE, emptySlotHint } from './card-text.ts'

/** 全页唯一的秒数节拍（旧 syncCardTicker 的 React 形态：一个 tick 状态驱动所有 live 格）。 */
function useCardTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export function DispatchCard({ entry }: { entry: DispatchEntry }) {
  const entries = useTurnStore(state => state.entries)
  const members = useSessionStore(state => state.members)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle')
  const gridRef = useRef<HTMLDivElement>(null)

  const memberBySubtask = useMemo(() => {
    const map = new Map<string, SubtaskEntry>()
    for (const item of entries) {
      if (item.kind === 'subtask' && entry.order.includes(item.subtaskId)) map.set(item.subtaskId, item)
    }
    return map
  }, [entries, entry.order])

  const states = entry.order.map(id => memberBySubtask.get(id)?.state)
  const hasLive = states.some(value => cardSettled(value) === false)
  const now = useCardTicker(hasLive)

  const patchCard = (patch: Partial<DispatchEntry>) => {
    useTurnStore.setState(state => ({
      entries: state.entries.map(item => item.key === entry.key && item.kind === 'dispatch' ? { ...item, ...patch } : item),
    }))
  }

  const setOpen = (open: boolean) => {
    // 重新展开时「有更新」收掉（更新已经看得见了）；折叠状态落本机偏好。
    patchCard({ open, fresh: open ? false : entry.fresh })
    saveCardPref(entry.taskId ?? '', { open })
  }

  const select = (id: string) => patchCard({ active: id })

  const copyCurrent = async () => {
    const current = entry.active === null ? undefined : memberBySubtask.get(entry.active)
    const text = current?.body ?? ''
    try {
      if (text.trim() === '') throw new Error('还没有可复制的内容')
      await navigator.clipboard.writeText(text)
      setCopied('ok')
    } catch {
      // 剪贴板不可用（非安全上下文等）时如实报失败，不假装成功。
      setCopied('fail')
    }
    setTimeout(() => setCopied('idle'), 1500)
  }

  // 状态条：几位成员、几个还在干、几个排队、几个在等、几个交回了——一行看完。
  const running = states.filter(value => ['dispatched', 'running', 'summarizing'].includes(value ?? '')).length
  const queued = states.filter(value => value === 'queued' || value === undefined).length
  const waiting = states.filter(value => value === 'waiting_user' || value === 'external_pending').length
  const done = states.filter(value => value === 'succeeded' || value === 'completed').length
  const failedCount = states.filter(value => value === 'failed' || value === 'cancelled').length
  const parts = [`${entry.order.length} 位成员`]
  if (running > 0) parts.push(`${running} 位进行中`)
  if (queued > 0) parts.push(`${queued} 位排队`)
  if (waiting > 0) parts.push(`${waiting} 位在等`)
  if (done > 0) parts.push(`${done} 位已交回`)
  if (failedCount > 0) parts.push(`${failedCount} 位没成`)
  const barText = parts.join(' · ')
  const wavyIdx = barText.lastIndexOf('位已交回')

  const activeEntry = entry.active === null ? undefined : memberBySubtask.get(entry.active)
  const activeHandle = activeEntry !== undefined ? `@${activeEntry.agentId}` : ''
  const activeState = activeEntry?.state
  const idPrefix = `dcard-${entry.taskId || entry.key}`

  // Esc 收起整卡：焦点不能留在看不见的格子里，交给还看得见的折叠按钮。
  const toolsRef = useRef<HTMLDivElement>(null)
  const onCardKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && entry.open) {
      event.preventDefault()
      setOpen(false)
      const foldButton = toolsRef.current?.querySelector('button:last-child') as HTMLElement | null
      foldButton?.focus()
    }
  }
  return (
    <details className="dcard" open={entry.open} data-task-id={entry.taskId} onKeyDown={onCardKeyDown}
      onToggle={event => { const open = (event.target as HTMLDetailsElement).open; if (open !== entry.open) setOpen(open) }}>
      <summary className="dcard__bar">
        <div className="dcard__barline">
          <span className="dcard__bar-text">
            {wavyIdx === -1 ? barText : (
              <>
                {barText.slice(0, wavyIdx)}
                <span className="red-wavy">位已交回</span>
                {barText.slice(wavyIdx + '位已交回'.length)}
              </>
            )}
          </span>
          {/* 「有更新」：收起之后又有了新进展；展开即收掉。 */}
          <span className="dcard__fresh" hidden={entry.open || !entry.fresh} title="收起之后又有了新进展">
            <span className="dot dot--running" /><span>有更新</span>
          </span>
          <div className="dcard__tools" ref={toolsRef}>
            <button
              type="button"
              className={`dcard__tool${entry.resultOnly ? ' dcard__tool--on' : ''}`}
              title="隐藏成员的思考与工具过程，只留它交回的结论"
              onClick={event => {
                event.preventDefault(); event.stopPropagation()
                const next = !entry.resultOnly
                patchCard({ resultOnly: next })
                saveCardPref(entry.taskId, { resultOnly: next })
              }}
            >
              {entry.resultOnly ? '看完整过程' : '只看结论'}
            </button>
            <button
              type="button"
              className="dcard__tool"
              title="复制当前这位成员交回的内容"
              onClick={event => { event.preventDefault(); event.stopPropagation(); void copyCurrent() }}
            >
              {copied === 'ok' ? '已复制' : copied === 'fail' ? '复制失败' : '复制'}
            </button>
            <button
              type="button"
              className="dcard__tool"
              aria-expanded={entry.open}
              title="收起或展开这张卡（Esc 也能收起）"
              onClick={event => { event.preventDefault(); event.stopPropagation(); setOpen(!entry.open) }}
            >
              {entry.open ? '折叠' : '展开'}
            </button>
          </div>
        </div>
        {/* 成员格子（tabs）：点格子只换人，不顺带展开/收起卡片。 */}
        <div
          className="dcard__grid"
          role="tablist"
          aria-label="本次派出的成员"
          ref={gridRef}
          onKeyDown={event => {
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
            if (step === 0) return
            const index = entry.order.indexOf(entry.active ?? '')
            if (index < 0) return
            event.preventDefault()
            const next = entry.order[(index + step + entry.order.length) % entry.order.length]
            if (next === undefined) return
            select(next)
            // 焦点跟着走（roving tabindex）：aria-selected 在哪、焦点环就在哪，读屏不失配。
            const target = gridRef.current?.querySelector(`[data-id="${next}"]`)
            target?.scrollIntoView({ block: 'nearest' })
            ;(target as HTMLElement | null)?.focus()
          }}
        >
          {entry.order.map(subtaskId => {
            const subtask = memberBySubtask.get(subtaskId)
            const value = subtask?.state ?? 'queued'
            const tone = DISPATCH_TONE[value] ?? 'queued'
            const since = typeof subtask?.startedAt === 'number' ? subtask.startedAt : undefined
            const until = cardSettled(value) ? (typeof subtask?.finishedAt === 'number' ? subtask.finishedAt : undefined) : undefined
            const elapsed = cardElapsedText(since, until, now)
            const selected = subtaskId === entry.active
            const pulsing = entry.pulses.includes(subtaskId)
            return (
              <button
                key={subtaskId}
                type="button"
                id={`${idPrefix}-tab-${subtaskId}`}
                data-id={subtaskId}
                data-handle={`@${subtask?.agentId ?? ''}`}
                role="tab"
                aria-selected={selected ? 'true' : 'false'}
                tabIndex={selected ? 0 : -1}
                aria-controls={`${idPrefix}-panel-${subtaskId}`}
                className={`dcard__cell${selected ? ' dcard__cell--active' : ''}${pulsing ? ' dcard__cell--pulse' : ''}`}
                title={`${subtask?.goal ?? ''} @${subtask?.agentId ?? ''}`.trim()}
                onClick={event => { event.preventDefault(); event.stopPropagation(); select(subtaskId) }}
              >
                <Avatar agentId={subtask?.agentId ?? ''} />
                <span className="dcard__col">
                  <span className="dcard__head">
                    <span className="dcard__name">{displayNameOf(members, subtask?.agentId ?? '')}</span>
                    <span className="dcard__handle">@{subtask?.agentId ?? ''}</span>
                  </span>
                  <span className="dcard__meta">
                    <span className="dcard__goal">{subtask?.goal ?? ''}</span>
                    <span className="dcard__status">
                      <span className={`dot dot--${tone}`} />
                      <span className="dcard__statetext">{cardStateText(value)}</span>
                      {elapsed !== '' && <span className="dcard__elapsed" data-live={until === undefined && typeof since === 'number' ? '1' : undefined}>{elapsed}</span>}
                    </span>
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </summary>
      <div className="dcard__result">
        <div className="dcard__result-title">《{activeHandle}》{CARD_RESULT_TITLE[activeState ?? ''] ?? ''}</div>
        <div className={`dcard__slots${entry.resultOnly ? ' dcard__slots--result-only' : ''}`}>
          {entry.order.map(subtaskId => {
            const subtask = memberBySubtask.get(subtaskId)
            const hidden = subtaskId !== entry.active
            const hasBody = subtask !== undefined && subtask.body !== ''
            return (
              <section
                key={subtaskId}
                id={`${idPrefix}-panel-${subtaskId}`}
                role="tabpanel"
                aria-labelledby={`${idPrefix}-tab-${subtaskId}`}
                className="dcard__slot"
                hidden={hidden}
              >
                {subtask === undefined || !hasBody ? (
                  <p className="dcard__empty">{emptySlotHint(subtask?.state)}</p>
                ) : (
                  <div className={`bubble${subtask.state === 'succeeded' ? ' bubble--done' : ''}${subtask.state === 'failed' ? ' bubble--fail' : ''}${subtask.state === 'waiting_user' || subtask.state === 'external_pending' ? ' bubble--wait' : ''}`}>
                    {subtask.thinking !== '' && !entry.resultOnly && (
                      <details className="think" open>
                        <summary className="think__summary"><span className="think__title">思考</span></summary>
                        <div className="think__body"><RichText text={subtask.thinking} variant="thinking" /></div>
                      </details>
                    )}
                    {subtask.toolLine !== null && !entry.resultOnly && (subtask.toolLine.tool !== undefined || subtask.toolLine.detail !== undefined) && (
                      <div className="tool-line">
                        <span>{subtask.toolLine.tool !== undefined ? '正在翻资料：' : ''}</span>
                        <span className="tool-line__name">{subtask.toolLine.tool ?? subtask.toolLine.detail}</span>
                      </div>
                    )}
                    {subtask.body.length > STREAM_RICH_LIMIT
                      ? <span>{subtask.body}</span>
                      : <RichText text={subtask.body} streaming={subtask.live && !subtask.terminal} />}
                    <span className="caret" hidden={subtask.terminal || !subtask.live} />
                    {subtask.state === 'external_pending' && <div className="msg__meta">待外部处理，办好之后可以新开一轮</div>}
                  </div>
                )}
                {subtask?.ask !== undefined && (
                  <AskCard
                    subtaskId={subtask.subtaskId}
                    agentId={subtask.agentId}
                    taskId={subtask.ask.taskId}
                    question={subtask.ask.question}
                    detail={subtask.ask.detail}
                  />
                )}
                {subtask !== undefined && subtask.artifacts.length > 0 && (
                  <div className="dcard__materials">
                    {(subtask.artifacts as Array<{ title?: string; link?: string; state?: string }>).map((artifact, index) => (
                      <span key={index} className="attach__item" data-phase="ready">
                        <span className="attach__name">{artifact.title ?? artifact.link ?? '材料'}</span>
                        {artifact.link !== undefined && <a className="attach__note" href={artifact.link} target="_blank" rel="noreferrer">打开</a>}
                        {artifact.state !== undefined && <span className="attach__note">{artifact.state}</span>}
                      </span>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </details>
  )
}
