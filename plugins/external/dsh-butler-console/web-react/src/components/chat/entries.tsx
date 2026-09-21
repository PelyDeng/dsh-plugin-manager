/**
 * 消息条目组件群（旧类名 = 手账组件层样式同源，批 1 视觉保真策略，见 app.css 搬运段说明）。
 * 结构参照旧 speech.js/cards.js/history.js/member.js 的 DOM，渲染范式换成声明式。
 * 条目组件全部 memo：流式帧 flush 时未被更新的条目引用不变，跳过重渲（方案批 3 性能验收）。
 */
import { memo, type CSSProperties, useState } from 'react'
import { RichText } from './RichText.tsx'
import { AskCard } from './AskCard.tsx'
import { SUGGESTIONS, STATE_TEXT, DEFAULT_AVATAR_FILES, STREAM_RICH_LIMIT } from '../../lib/config.ts'
import type { ThreadEntry, SubtaskEntry } from '../../stores/turn.ts'
import { useTurnStore } from '../../stores/turn.ts'
import { accentOf, displayNameOf, useSessionStore } from '../../stores/session.ts'
import { ROUTE_PREFIX } from '../../lib/api.ts'
import { openTask, sendMessage } from '../../hooks/use-turn.ts'
import { DispatchCard } from '../dcard/DispatchCard.tsx'
import { fileSizeText } from '../../stores/attachments.ts'

function formatTime(value?: number): string {
  if (value === undefined || value === 0) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date().toDateString()) return clock
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${clock}`
}

/** 成员头像：上传图 → 默认涂鸦 → 首字配色圆。img 失败用 state/样式隐藏（React fiber
 *  仍持引用，不能直接 remove 节点——stamp 变化后的属性更新会落在游离节点上）。 */
export function Avatar({ agentId, size = '' }: { agentId: string; size?: string }) {
  const members = useSessionStore(state => state.members)
  const stamps = useSessionStore(state => state.avatarStamps)
  const [failed, setFailed] = useState(false)
  const style: CSSProperties = { background: accentOf(members, agentId) }
  const file = DEFAULT_AVATAR_FILES.get(agentId)
  const stamp = stamps.get(agentId)
  const src = file === undefined || failed
    ? null
    : `${ROUTE_PREFIX}/assets/media/avatars/${file}${stamp === undefined ? '' : `?v=${stamp}`}`
  return (
    <div className={`avatar${size === '' ? '' : ` avatar--${size}`}`} style={style}>
      {src !== null && <img alt="" src={src} onError={() => setFailed(true)} />}
      <span>{[...displayNameOf(members, agentId)][0] ?? '?'}</span>
    </div>
  )
}

/** 成员行的状态色（旧 handleSubtask 的 status 颜色语义）。 */
function statusColor(state: string): string {
  if (state === 'failed') return 'var(--bt-error)'
  if (state === 'waiting_user' || state === 'external_pending') return 'var(--bt-warn)'
  if (state === 'succeeded') return 'var(--bt-ok)'
  return 'var(--bt-ink-soft)'
}

function UserEntryViewFn({ text, time, attachments }: {
  text: string
  time?: number | undefined
  attachments?: Array<{ key: string; name: string; size: number }> | undefined
}) {
  const file = DEFAULT_AVATAR_FILES.get('__boss__')
  return (
    <div className="msg msg--user">
      <div className="msg__col">
        <div className="bubble">{text}</div>
        {attachments !== undefined && attachments.length > 0 && (
          <div className="attach attach--sent">
            <div className="attach__items">
              {attachments.map(entry => (
                <span key={entry.key} className="attach__item" data-phase="ready">
                  <span className="attach__name">{entry.name}</span>
                  {fileSizeText(entry.size) !== '' && <span className="attach__size">{fileSizeText(entry.size)}</span>}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="msg__meta">{formatTime(time)}</div>
      </div>
      <div className="avatar avatar--sm avatar--boss">
        {file !== undefined && (
          <img
            alt=""
            src={`${ROUTE_PREFIX}/assets/media/avatars/${file}`}
            onError={event => { event.currentTarget.style.display = 'none' }}
          />
        )}
      </div>
    </div>
  )
}

function ButlerEntryViewFn({ text, thinking, streaming, time, interrupted }: {
  text: string
  thinking: string
  streaming: boolean
  time?: number | undefined
  interrupted?: boolean | undefined
}) {
  return (
    <div className="msg msg--butler">
      <div className="avatar avatar--sm avatar--butler">
        <img alt="" src={`${ROUTE_PREFIX}/assets/media/avatars/avatar-butler.png`} onError={event => { event.currentTarget.style.display = 'none' }} />
        <span>牛</span>
      </div>
      <div className="msg__col">
        <div className="msg__head">
          <span className="msg__name" style={{ color: 'var(--bt-ink)' }}>牛马大总管</span>
          <span className="msg__tag">负责听懂你的意图</span>
        </div>
        <div className="bubble">
          {thinking !== '' && (
            <details className="think" open={streaming}>
              <summary className="think__summary"><span className="think__title">思考</span></summary>
              <div className="think__body">
                <RichText text={thinking} variant="thinking" />
              </div>
            </details>
          )}
          {/* 分级降级（方案 §3.4 坑 4）：超长正文不逐帧 Markdown 重渲，降级纯文本。 */}
          {text.length > STREAM_RICH_LIMIT
            ? <span>{text}</span>
            : <RichText text={text} streaming={streaming} />}
          <span className="caret" hidden={!streaming} />
        </div>
        {interrupted === true && <div className="msg__meta">这一轮被打断，正文是已流出的部分</div>}
        {time !== undefined && <div className="msg__meta">{formatTime(time)}</div>}
      </div>
    </div>
  )
}

/** 成员子任务行（批 3：含等待回话入口；调度卡批 4b 收编同一数据面）。 */
function SubtaskEntryViewFn({ entry }: { entry: SubtaskEntry }) {
  const members = useSessionStore(state => state.members)
  return (
    <div className="msg">
      <Avatar agentId={entry.agentId} />
      <div className="msg__col">
        <div className="msg__head">
          <span className="msg__name" style={{ color: accentOf(members, entry.agentId) }}>
            {displayNameOf(members, entry.agentId)}
          </span>
          <span className="msg__handle">@{entry.agentId}</span>
          <span className="msg__tag" style={{ color: statusColor(entry.state) }}>
            {STATE_TEXT[entry.state] ?? entry.state}
          </span>
        </div>
        <div className={`bubble${entry.state === 'waiting_user' || entry.state === 'external_pending' ? ' bubble--wait' : ''}${entry.state === 'succeeded' ? ' bubble--done' : ''}${entry.state === 'failed' ? ' bubble--fail' : ''}`}>
          {entry.thinking !== '' && (
            <details className="think" open>
              <summary className="think__summary"><span className="think__title">思考</span></summary>
              <div className="think__body"><RichText text={entry.thinking} variant="thinking" /></div>
            </details>
          )}
          {entry.toolLine !== null && (entry.toolLine.tool !== undefined || entry.toolLine.detail !== undefined) && (
            <div className="tool-line">
              <span>{entry.toolLine.tool !== undefined ? '正在翻资料：' : ''}</span>
              <span className="tool-line__name">{entry.toolLine.tool ?? entry.toolLine.detail}</span>
            </div>
          )}
          {entry.body === ''
            ? entry.state === 'running' && <div className="typing"><i /><i /><i /></div>
            : entry.body.length > STREAM_RICH_LIMIT
              ? <span>{entry.body}</span>
              : <RichText text={entry.body} streaming={entry.live && !entry.terminal} />}
          <span className="caret" hidden={entry.terminal || !entry.live} />
        </div>
        {entry.ask !== undefined && (
          <AskCard
            subtaskId={entry.subtaskId}
            agentId={entry.agentId}
            taskId={entry.ask.taskId}
            question={entry.ask.question}
            detail={entry.ask.detail}
          />
        )}
        {entry.state === 'external_pending' && <div className="msg__meta">待外部处理，办好之后可以新开一轮</div>}
      </div>
    </div>
  )
}

function NoteEntryViewFn({ text }: { text: string }) {
  return <p className="msg__meta">{text}</p>
}

function ErrorEntryViewFn({ text, retryFor }: {
  text: string
  retryFor?: { requestText: string; requestId: string } | undefined
}) {
  if (retryFor === undefined) return <p className="error-line">{text}</p>
  return (
    <div className="error-line error-line--retry">
      <span>{text}。</span>
      <button
        type="button"
        className="btn btn--tiny"
        onClick={() => {
          // 撤掉失败的痕迹，原样重发同一句话（同一幂等身份，S07）。
          useTurnStore.getState().removeEntry(`error-${retryFor.requestId}`)
          // 失败的那条 user 预渲染一并撤掉：重发会重新就地呈现（旧 retryEntry 先撤气泡）。
          useTurnStore.getState().removeEntry(`user-send-${retryFor.requestId}`)
          void sendMessage(retryFor.requestText, retryFor.requestId)
        }}
      >
        重试
      </button>
    </div>
  )
}

/** 汇总卡（旧 summaryCard：标题按状态、正文受控 Markdown、去重后为空不显示占位）。 */
function SummaryEntryViewFn({ state, text, error, followups }: {
  state: string
  text: string
  error?: string | null
  followups?: string[] | undefined
}) {
  const title = state === 'completed' ? '已完成'
    : state === 'failed' ? '这一轮失败'
      : state === 'cancelled' ? '已喊停'
        : state === 'external_pending' ? '材料交回了，还有事在外面等着'
          : state === 'partial' ? '部分任务失败，成果已保留'
            : '等你回话'
  const body = text !== '' ? text : error ?? ''
  return (
    <div className="summary" data-state={state}>
      <div className="summary__title">{title}</div>
      {body !== '' && <div className="summary__body md"><RichText text={body} variant="card" /></div>}
      {/* 追问芯片样张（Suggestion 手账化占位，mock 驱动；点击把话填进输入框）。 */}
      {followups !== undefined && followups.length > 0 && (
        <div className="summary__followups">
          {followups.map(item => (
            <button key={item} type="button" className="follow-chip" onClick={() => tearTapFill(item)}>
              {item}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 历史任务摘要卡（点开详情批 3）：列表投影是 TaskSummary（无 subtasks），收尾计数 x/y。 */
function TaskEntryViewFn({ task }: { task: import('../../lib/api.ts').TaskSummary }) {
  return (
    <button type="button" className="task-card" data-state={task.state} onClick={() => { void openTask(task.id) }}>
      <div className="task-card__head">
        <span className="task-card__badge">任务摘要</span>
        <span className="task-card__state">{STATE_TEXT[task.state] ?? task.state}</span>
        <span className="task-card__time">{formatTime(Number(task.updatedAt) || undefined)}</span>
      </div>
      <div className="task-card__goal">{task.goal}</div>
      <div className="task-card__meta">{formatTime(Number(task.createdAt) || undefined)} 分派 · {task.subtaskDone}/{task.subtaskTotal} 项收尾</div>
    </button>
  )
}

/** 空状态欢迎板（旧 renderWelcome：告示可撕条 + 竖排边注 + 红波浪强调）。撕条点击把
 *  完整话填进输入框（composer 批 3 起由 draftRestore 承接；这里通过同一注册口回填）。 */
export function Welcome() {
  return (
    <div className="welcome welcome--board">
      <div className="board">
        <div className="board__top" style={{ backgroundImage: `url(${ROUTE_PREFIX}/assets/media/welcome/clean-top.png)` }} />
        <p className="board__note board__note--left">一些想法，也许就是下一个好的开始。</p>
        <p className="board__note board__note--right">好的开始，就是把想法说出来。</p>
        <h2 className="board__title">说说你要<span className="red-wavy">做什么</span></h2>
        <p className="board__sub">
          查资料、理思路、写文案、做总结
          <br />
          也可以盯进展、提建议，陪你把事做成
        </p>
        <div className="board__tears">
          {SUGGESTIONS.map((item, index) => (
            <button
              key={item.label}
              type="button"
              className="board__tear"
              title={item.text}
              onClick={() => { registerDraftRestoreTap(item.text) }}
            >
              <span className="board__tear-text">{item.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** 撕条点击的填入通道：composer 注册的草稿回填口在此复用（欢迎页没有别的输入路径）。 */
let tearTap: ((text: string) => void) | null = null
export function registerTearTap(handler: (text: string) => void): void {
  tearTap = handler
}
function tearTapFill(text: string): void {
  tearTap?.(text)
}
function registerDraftRestoreTap(text: string): void {
  tearTap?.(text)
}

const UserEntryView = memo(UserEntryViewFn)
const ButlerEntryView = memo(ButlerEntryViewFn)
const SubtaskEntryView = memo(SubtaskEntryViewFn)
const NoteEntryView = memo(NoteEntryViewFn)
const ErrorEntryView = memo(ErrorEntryViewFn)
const SummaryEntryView = memo(SummaryEntryViewFn)
const TaskEntryView = memo(TaskEntryViewFn)

export function renderEntry(entry: ThreadEntry): React.ReactNode {
  switch (entry.kind) {
    case 'user': return <UserEntryView key={entry.key} text={entry.text} time={entry.time} attachments={entry.attachments} />
    case 'butler': return <ButlerEntryView key={entry.key} text={entry.text} thinking={entry.thinking} streaming={entry.streaming} time={entry.time} interrupted={entry.interrupted} />
    case 'subtask': return <SubtaskEntryView key={entry.key} entry={entry} />
    case 'note': return <NoteEntryView key={entry.key} text={entry.text} />
    case 'error': return <ErrorEntryView key={entry.key} text={entry.text} retryFor={entry.retryFor} />
    case 'summary': return <SummaryEntryView key={entry.key} state={entry.state} text={entry.text} followups={entry.followups} />
    case 'task': return <TaskEntryView key={entry.key} task={entry.task} />
    case 'dispatch': return <DispatchCard key={entry.key} entry={entry} />
    default: return null
  }
}
