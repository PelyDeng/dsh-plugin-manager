/**
 * 输入区（批 3 基础发送 + 批 4a 完整化）：@提及选择器（键盘导航/IME/aria）、附件条
 * （回形针/链接/拖拽/粘贴三通道三态）、autosize、字数、快捷键。
 *
 * 语义对齐旧 composer.js/attachments.js/app.js：
 * - 提及检测：光标前未闭合 @，其前须是行首/空白/非 ASCII（中文不打空格），@ 与光标间
 *   无空白；英文数字后不触发（防邮箱）。
 * - 键盘：菜单开着时 ↑↓ 移动、Enter/Tab 选中、Esc 关闭；输入法组合期间一概不拦。
 * - 落纸用外号：服务端成员清单就是「id（外号）」对照表，外号即点名。
 * - 附件三通道最后都落到一份服务端记录；拖拽区挂整块输入区（用户瞄的是"那一片"）。
 * - I02：只锁发送不锁输入，执行中可写下一句，草稿不被异步动作清掉。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { runSupplement, sendMessage, stopTurn } from '../../hooks/use-turn.ts'
import { announce } from '../../lib/announce.ts'
import { Icon } from '../common/Icon.tsx'
import { useSessionStore, type MemberItem } from '../../stores/session.ts'
import { useTurnStore } from '../../stores/turn.ts'
import { useComposerStore } from '../../stores/composer.ts'
import { addFiles, addUrl, dropAttachment } from '../../flows/attachments.ts'
import { fileSizeText, useAttachmentsStore } from '../../stores/attachments.ts'

interface MentionState {
  start: number
  query: string
  index: number
}

/** 光标前是否有一个未闭合的 @（旧 detectMention 口径）。 */
function detectMention(text: string, pos: number): { start: number; query: string } | null {
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = text[i] ?? ''
    if (ch === '@') {
      const prev = i === 0 ? '' : text[i - 1] ?? ''
      if (prev === '' || /[^\x00-\x7f]/.test(prev) || /\s/.test(prev)) {
        return { start: i, query: text.slice(i + 1, pos) }
      }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/** 过滤口径：外号、报名名、agentId 任一命中即可。 */
function mentionCandidates(members: MemberItem[], query: string): MemberItem[] {
  const q = query.trim().toLowerCase()
  return members.filter(member =>
    member.displayName.toLowerCase().includes(q)
    || member.declaredName.toLowerCase().includes(q)
    || member.agentId.toLowerCase().includes(q))
}

export function Composer() {
  const streaming = useTurnStore(state => state.streaming)
  const conversationId = useTurnStore(state => state.conversationId)
  const members = useSessionStore(state => state.members)
  const attachments = useAttachmentsStore(state => state.items)
  const urlInputVisible = useAttachmentsStore(state => state.urlInputVisible)
  const [draft, setDraft] = useState('')
  // 补充模式（/supplement）：有进行中的任务才可切；输入原样送当前任务作补充材料。
  const [supplementMode, setSupplementMode] = useState(false)
  const supplementTaskId = useTurnStore(state => state.lastRunTaskId)
  const [mention, setMention] = useState<MentionState | null>(null)
  const [dropping, setDropping] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)
  const composerRef = useRef<HTMLDivElement>(null)
  const mentionItemsRef = useRef<HTMLDivElement>(null)

  const candidates = useMemo(() => (mention === null ? [] : mentionCandidates(members, mention.query)), [mention, members])
  const mentionItems = candidates.length > 0 ? candidates : members

  // 回填单通道 pendingFill（评审 #10 步 4）：撕条/追问芯片/发送失败回填都从 store 来，
  // 组件不再互相注册回调。restore 只在输入框为空时回填（I02——用户后来打过字就不覆盖）。
  const pendingFill = useComposerStore(state => state.pendingFill)
  useEffect(() => {
    if (pendingFill === null) return
    setDraft(current => pendingFill.mode === 'restore' && current !== '' ? current : pendingFill.text)
    inputRef.current?.focus()
    useComposerStore.getState().clearFill()
  }, [pendingFill])

  const autosize = () => {
    const input = inputRef.current
    if (input === null) return
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`
  }
  // 高度自适应统一在此（评审 #20）：draft 变化后 DOM 更新完、绘制前调整——
  // 各调用点 setDraft 后同步调 autosize 量的是旧 DOM，时机本来就是错的。
  useLayoutEffect(() => { autosize() })

  /** 提及检测入口（input 时）：光标挪走、补空格都等于放弃这次提及。 */
  const updateMention = () => {
    const input = inputRef.current
    if (input === null) return
    const hit = detectMention(input.value, input.selectionStart ?? input.value.length)
    if (hit === null) { setMention(null); return }
    if (mention === null || hit.start !== mention.start) {
      setMention({ start: hit.start, query: hit.query, index: 0 })
      return
    }
    setMention({ start: mention.start, query: hit.query, index: 0 })
  }

  const closeMention = () => setMention(null)

  /** 落纸用外号：@外号 + 空格，光标落在插入之后。 */
  const acceptMention = () => {
    const input = inputRef.current
    if (mention === null || input === null) return
    const member = (candidates.length > 0 ? candidates : mentionItems)[mention.index]
    if (member === undefined) { setMention(null); return }
    const text = input.value
    const pos = input.selectionStart ?? text.length
    const insert = `@${member.displayName} `
    const next = text.slice(0, mention.start) + insert + text.slice(pos)
    const caret = mention.start + insert.length
    setDraft(next)
    closeMention()
    window.requestAnimationFrame(() => {
      if (inputRef.current === null) return
      inputRef.current.setSelectionRange(caret, caret)
      inputRef.current.focus()
    })
  }

  const submit = () => {
    const text = draft
    if (text.trim() === '') return
    setDraft('')
    closeMention()
    window.requestAnimationFrame(autosize)
    if (supplementMode && supplementTaskId !== '') {
      // 补充模式（评审 B7）：给进行中的一轮补话，不开新一轮、任务记录不分家。
      void runSupplement(
        { taskId: supplementTaskId, text },
        { onAccepted: () => { announce('已补充给当前任务') }, onRejected: () => { setDraft(text) } },
      )
      setSupplementMode(false)
      return
    }
    void sendMessage(text)
  }

  const length = [...draft].length
  const hint = streaming
    ? '正在处理；下一句可以先写好，这轮完事再发'
    : null

  return (
    <div
      className={`composer${dropping ? ' composer--drop' : ''}`}
      id="composer"
      ref={composerRef}
      onDragOver={event => {
        if (event.dataTransfer?.types?.includes('Files') !== true) return
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={event => {
        // 在子元素之间移动也会触发 dragleave：真的离开整块区域才撤反馈。
        const next = event.relatedTarget
        if (next !== null && next instanceof Node && composerRef.current?.contains(next) === true) return
        setDropping(false)
      }}
      onDrop={event => {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (files.length === 0) return
        event.preventDefault()
        setDropping(false)
        void addFiles(files, conversationId)
      }}
      onPaste={event => {
        // 粘贴：截图与复制过来的文件走同一条路；纯文字不拦（用户可能就在贴一段话）。
        const files = [...(event.clipboardData?.files ?? [])]
        if (files.length === 0) return
        event.preventDefault()
        void addFiles(files, conversationId)
      }}
    >
      {/* 待发附件条：选文件、拖进来、粘链接都落到这里；空时整块收起。 */}
      {(attachments.length > 0 || urlInputVisible) && (
        <div className="attach" id="attach-strip">
          <div className="attach__items" id="attach-items">
            {attachments.map(entry => (
              <span key={entry.key} className="attach__item" data-phase={entry.phase}
                title={(() => {
                  // 附件元数据悬浮（评审 中11）：解析了多少页/段、大概是什么、来自哪个链接。
                  const item = entry.item
                  if (item === null) return entry.name
                  const parts = [item.name]
                  if (item.kind !== undefined && item.kind !== '') parts.push(item.kind)
                  if (item.totalUnits !== undefined) parts.push(`${item.totalUnits} 页/段`)
                  if (item.characters !== undefined) parts.push(`${item.characters} 字`)
                  if (item.preview !== undefined && item.preview !== '') parts.push(item.preview.slice(0, 80))
                  if (item.sourceUrl !== undefined && item.sourceUrl !== '') parts.push(item.sourceUrl)
                  return parts.join(' · ')
                })()}>
                <span className="attach__name">{entry.name}</span>
                {fileSizeText(entry.size) !== '' && <span className="attach__size">{fileSizeText(entry.size)}</span>}
                {(entry.phase !== 'ready' || entry.message !== '') && (
                  <span className="attach__note">
                    {entry.phase === 'uploading' ? (entry.message === '' ? '上传中…' : entry.message)
                      : entry.phase === 'failed' ? (entry.message === '' ? '没成' : entry.message)
                        : entry.message}
                  </span>
                )}
                <button
                  type="button"
                  className="attach__remove"
                  title="移除"
                  aria-label={`移除 ${entry.name}`}
                  onClick={() => { void dropAttachment(entry.key) }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          {urlInputVisible && (
            <div className="attach__url" id="attach-url">
              <input
                ref={urlInputRef}
                type="url"
                id="attach-url-input"
                placeholder="粘贴文件或图片的链接，回车取回"
                aria-label="附件链接"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={event => {
                  if (event.key === 'Escape') { event.preventDefault(); useAttachmentsStore.getState().setUrlInputVisible(false); return }
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                  // 回车是「取回这个链接」，不是发送（不该把没写完的消息发出去）。
                  event.preventDefault()
                  const url = urlInputRef.current?.value ?? ''
                  useAttachmentsStore.getState().setUrlInputVisible(false)
                  void addUrl(url, conversationId)
                }}
              />
              <button type="button" className="btn btn--tiny btn--ghost" id="attach-url-cancel" onClick={() => useAttachmentsStore.getState().setUrlInputVisible(false)}>
                取消
              </button>
            </div>
          )}
        </div>
      )}
      <div className="composer__box">
        {/* @ 提及选择器（aria：listbox/option/activedescendant）。 */}
        {mention !== null && (
          <div className="mention" id="mention-pop" role="listbox" aria-label="点名成员" aria-activedescendant={`mention-option-${mention.index}`}>
            <p className="mention__hint" aria-hidden="true">↑↓ 选 · 回车点名 · Esc 关</p>
            <div className="mention__items" id="mention-items" ref={mentionItemsRef}>
              {candidates.length === 0 && (
                <p className="mention__none">
                  {members.length === 0 ? '还没有可点名的成员' : '没有对得上的成员'}
                </p>
              )}
              {candidates.map((member, index) => (
                <div
                  key={member.agentId}
                  id={`mention-option-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === mention.index}
                  className={`mention__item${index === mention.index ? ' mention__item--active' : ''}`}
                  onMouseEnter={() => { if (mention.index !== index) setMention({ ...mention, index }) }}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => {
                    setMention({ ...mention, index })
                    // 点击选中：先同步 index 再落纸（acceptMention 读当前 state）。
                    window.requestAnimationFrame(() => acceptMentionWithIndex(index))
                  }}
                >
                  <span className="avatar avatar--sm" style={{ background: 'var(--bt-ink-faint)' }}>
                    <span>{[...member.displayName][0] ?? '?'}</span>
                  </span>
                  <div className="member__col">
                    <div className="member__name">{member.displayName}</div>
                    <div className="member__declared">{member.declaredName}</div>
                  </div>
                  <span className="mention__handle">@{member.agentId}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* 输入框可达名统一 aria-label 口径（评审 #21）：不用 visually-hidden label。 */}
        <textarea
          id="message-input"
          ref={inputRef}
          rows={1}
          placeholder="说说你要做什么"
          aria-label="说句话"
          autoComplete="off"
          value={draft}
          onChange={() => { setDraft(inputRef.current?.value ?? ''); updateMention() }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onBlur={() => {
            // 点名簿上的交互在 mousedown 已拦默认，blur 到菜单项不会发生；真失焦即放弃提及。
            window.requestAnimationFrame(() => {
              if (mentionItemsRef.current?.contains(document.activeElement) !== true) setMention(null)
            })
          }}
          onKeyDown={event => {
            // 点名簿开着先服务导航（输入法组合期间一概不拦：选字要用这些键）。
            if (mention !== null && !event.nativeEvent.isComposing) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const list = candidates.length > 0 ? candidates : members
                const count = list.length
                if (count > 0) {
                  const delta = event.key === 'ArrowDown' ? 1 : -1
                  setMention({ ...mention, index: (mention.index + delta + count) % count })
                }
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                acceptMention()
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMention(null)
                return
              }
            }
            // Enter 发送，Shift+Enter 换行；输入法组合期间不拦截。
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer__actions">
          <button
            type="button"
            className="doodle-btn"
            id="at-button"
            title="插入 @，点名成员"
            aria-label="插入 @"
            /* mousedown 不夺焦：textarea 保持焦点，点名簿不被 onBlur 清掉。 */
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              const input = inputRef.current
              if (input === null) return
              const start = input.selectionStart ?? input.value.length
              const end = input.selectionEnd ?? start
              const next = input.value.slice(0, start) + '@' + input.value.slice(end)
              setDraft(next)
              input.setSelectionRange(start + 1, start + 1)
              input.focus()
              setMention({ start, query: '', index: 0 })
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M13.6 5.4 C 12.4 4.2, 10.8 3.8, 9.2 4.4 C 6.4 5.4, 4.8 8.2, 5.6 11 C 6.4 13.8, 9.2 15.4, 12 14.6 C 13.4 14.2, 14.4 13.2, 14.9 12 M14.6 8.4 C 14.9 9.9, 14.7 11.5, 15.4 12.6 C 16 13.4, 17.2 13.2, 17.8 12.2 C 18.9 10.2, 18.6 7.4, 16.9 5.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
          {/* 回形针：选文件。拖拽与粘贴也走同一条路。 */}
          <button
            type="button"
            className="doodle-btn"
            id="attach-button"
            title="上传文件（也可以直接把文件拖进来）"
            aria-label="上传文件"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M13.4 8.2 9 12.6 C 8 13.6, 8 15, 9 15.8 C 10 16.7, 11.4 16.6, 12.3 15.7 L 16.6 11.3 C 18.2 9.7, 18.2 7.2, 16.6 5.7 C 15 4.2, 12.5 4.3, 10.9 5.8 L 6.5 10.2 C 4.9 11.7, 4.9 14.3, 6.4 15.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/* 链接：把远处的文件取回来，和上传落到同一条路。 */}
          <button
            type="button"
            className="doodle-btn"
            id="attach-link-button"
            title="粘贴链接，把远处的文件取回来"
            aria-label="从链接取回文件"
            onClick={() => {
              useAttachmentsStore.getState().setUrlInputVisible(true)
              window.requestAnimationFrame(() => urlInputRef.current?.focus())
            }}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M8.4 11.6 C 7.2 10.4, 7.3 8.5, 8.5 7.3 L 11 4.8 C 12.2 3.6, 14.1 3.6, 15.3 4.8 C 16.5 6, 16.5 7.9, 15.3 9.1 L 14.2 10.2 M11.6 8.4 C 12.8 9.6, 12.7 11.5, 11.5 12.7 L 9 15.2 C 7.8 16.4, 5.9 16.4, 4.7 15.2 C 3.5 14, 3.5 12.1, 4.7 10.9 L 5.8 9.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <input
            type="file"
            id="attach-input"
            multiple
            hidden
            ref={fileInputRef}
            onChange={() => {
              const files = [...(fileInputRef.current?.files ?? [])]
              // 清空 value：同一个文件选第二次也要能触发 change。
              if (fileInputRef.current !== null) fileInputRef.current.value = ''
              void addFiles(files, conversationId)
            }}
          />
          {supplementTaskId !== '' && !streaming && (
            <button
              type="button"
              className={`btn btn--tiny${supplementMode ? ' btn--primary' : ''}`}
              aria-pressed={supplementMode}
              title={supplementMode ? '正在给当前任务补充材料，点击退出' : '这句话补给正在跑的任务（不开新一轮）'}
              onClick={() => setSupplementMode(value => !value)}
            >
              {supplementMode ? '正在补充' : '补充'}
            </button>
          )}
          <button
            type="button"
            className="send"
            id="send-button"
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
            : <>牛马大总管<span className="red-wavy">先听明白需求</span>，再替你分派成员<Icon name="heart" size={11} className="composer__hint-heart" /></>}
        </span>
        <span id="composer-count">{length > 0 ? `${length} 字` : ''}</span>
      </div>
    </div>
  )

  /** 点击菜单项时的落纸：React 闭包取不到最新 index，这里按传入下标直接完成。 */
  function acceptMentionWithIndex(index: number) {
    const input = inputRef.current
    if (mention === null || input === null) return
    const member = (candidates.length > 0 ? candidates : members)[index]
    if (member === undefined) { setMention(null); return }
    const text = input.value
    const pos = input.selectionStart ?? text.length
    const insert = `@${member.displayName} `
    const next = text.slice(0, mention.start) + insert + text.slice(pos)
    const caret = mention.start + insert.length
    setDraft(next)
    setMention(null)
    window.requestAnimationFrame(() => {
      if (inputRef.current === null) return
      inputRef.current.setSelectionRange(caret, caret)
      inputRef.current.focus()
    })
  }
}

/** 喊停（执行中显形，I04/I08）：停止对象绑定当前会话；结果以这一轮最终状态为准。 */
export function StopButton() {
  const streaming = useTurnStore(state => state.streaming)
  const [disabled, setDisabled] = useState(false)
  if (!streaming) return null
  return (
    <button
      type="button"
      className="btn btn--tiny btn--ghost"
      id="stop-button"
      disabled={disabled}
      onClick={() => {
        setDisabled(true)
        // 顶栏过渡态由 stopTurn 自己置（TOP_STOPPING），此处不重复写。
        void stopTurn().finally(() => setDisabled(useTurnStore.getState().streaming))
      }}
    >
      喊停
    </button>
  )
}
