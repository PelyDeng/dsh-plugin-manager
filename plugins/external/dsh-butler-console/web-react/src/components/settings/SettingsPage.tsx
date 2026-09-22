import { errorTextOf } from '../../lib/error-text.ts'
/**
 * 设置页（批 5）：改名/换头像/配色草稿语义（I14/I15/I16）。
 * 语义对齐旧 panels.js：外号与配色是**草稿**，显式保存才提交；每张卡自带状态行，
 * 保存只更新自己这张卡，其他卡里没保存的输入不被冲掉；保存回包按**提交时的草稿版本**
 * 核对（复核 1）——保存期间继续编辑不中断，也不会被回包吞掉。
 * 页面切换不是模态：焦点落到标题，关闭送回齿轮；执行中进来给「回群聊」提示（I18）。
 */
import { useEffect, useRef, useState } from 'react'
import { BUILTIN_AVATARS, PALETTE } from '../../lib/config.ts'
import { api, uploadAvatar, ROUTE_PREFIX } from '../../lib/api.ts'
import type { MemberItem } from '../../stores/session.ts'
import { accentOf, displayNameOf, useSessionStore } from '../../stores/session.ts'
import { useTurnStore } from '../../stores/turn.ts'
import { refreshPanelsData } from '../../hooks/use-turn.ts'
import { announce } from '../../lib/announce.ts'
import { Avatar } from '../common/Avatar.tsx'

type CardStatusKind = '' | 'dirty' | 'busy' | 'ok' | 'error'

interface SettingsCardProps {
  member: MemberItem
  onSaved: () => void
}

/** 单张设置卡：草稿态独立（外号+配色一起显式保存；头像动作独立）。 */
function SettingsCard({ member, onSaved }: SettingsCardProps) {
  const agentId = member.agentId
  const stamps = useSessionStore(state => state.avatarStamps)
  const stampAvatar = useSessionStore(state => state.stampAvatar)
  const hasCustom = stamps.has(agentId)
  const [name, setName] = useState(member.displayName)
  const [pendingAccent, setPendingAccent] = useState<string | null>(null)
  const [status, setStatus] = useState<{ kind: CardStatusKind; text: string }>({ kind: '', text: '' })
  const [busy, setBusy] = useState(false)
  const draftVersion = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const markDirty = () => {
    draftVersion.current += 1
    if (status.kind !== 'busy') setStatus({ kind: 'dirty', text: '未保存的改动' })
  }

  const save = async () => {
    if (busy) return
    // 只提交发起那一刻的草稿；保存期间用户继续编辑不中断、也不会被回包吞掉（复核 1）。
    const submittedName = name
    const submittedAccent = pendingAccent ?? accentOf(useSessionStore.getState().members, agentId)
    const submittedVersion = draftVersion.current
    setBusy(true)
    setStatus({ kind: 'busy', text: '保存中…可以先继续改' })
    try {
      await api.setAlias(agentId, submittedName, submittedAccent)
      onSaved()
      if (draftVersion.current === submittedVersion) {
        setPendingAccent(null)
        setStatus({ kind: 'ok', text: '已保存' })
        announce(`已保存 ${submittedName} 的设置`)
      } else {
        setStatus({ kind: 'dirty', text: '刚提交的已存上；之后的新改动还没保存' })
      }
    } catch (error) {
      setStatus({ kind: 'error', text: `没保存成功：${errorTextOf(error)}；改动还在，再试一次` })
    } finally {
      setBusy(false)
    }
  }

  const runAvatarAction = async (action: () => Promise<void>, doing: string, done: string) => {
    setStatus({ kind: 'busy', text: doing })
    try {
      await action()
      stampAvatar(agentId)
      setStatus({ kind: 'ok', text: done })
      announce(done)
      onSaved()
    } catch (error) {
      setStatus({ kind: 'error', text: `${done}没成：${errorTextOf(error, '再试一次')}` })
    }
  }

  const uploadAvatarFile = (file: File) => {
    void runAvatarAction(async () => {
      await uploadAvatar(agentId, file)
      stampAvatar(agentId)
    }, '上传中…', '头像已更新')
  }

  const pickBuiltin = (file: string, label: string) => {
    void runAvatarAction(async () => {
      const response = await fetch(`${ROUTE_PREFIX}/assets/media/avatars/builtin/${file}`)
      if (!response.ok) throw new Error('内置头像读取失败')
      const blob = await response.blob()
      await uploadAvatar(agentId, new File([blob], file, { type: 'image/png' }))
      stampAvatar(agentId)
    }, '换头像中…', '头像已更新')
  }

  return (
    <div className="set-card" data-agent-id={agentId}>
      <div className="set-card__head">
        <div className="member__avatar">
          <div className="member__avatar-slot"><Avatar agentId={agentId} size="lg" /></div>
          {/* 相机是按钮不是贴纸（I16）：键盘可达、有名字。 */}
          <button
            type="button"
            className="member__camera"
            title="换头像"
            aria-label={`给 ${displayNameOf(useSessionStore.getState().members, agentId)} 换头像`}
            onClick={() => fileRef.current?.click()}
          >
            📷
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="visually-hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={() => {
              const file = fileRef.current?.files?.[0]
              if (file) uploadAvatarFile(file)
              if (fileRef.current !== null) fileRef.current.value = ''
            }}
          />
        </div>
        <div className="set-card__titles">
          <div className="member__name">{member.displayName}</div>
          <div className="member__declared">插件声明：{member.declaredName}</div>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`alias-${agentId}`}>外号</label>
        <input
          type="text"
          id={`alias-${agentId}`}
          maxLength={24}
          value={name}
          placeholder={member.declaredName}
          onChange={event => { setName(event.target.value); markDirty() }}
        />
      </div>
      <div className="field">
        <label>配色</label>
        <div className="swatches">
          {PALETTE.map(color => (
            <button
              key={color}
              type="button"
              className="swatch"
              style={{ background: color }}
              title={color}
              aria-pressed={(pendingAccent ?? accentOf(useSessionStore.getState().members, agentId)).toLowerCase() === color}
              onClick={() => { setPendingAccent(color); markDirty() }}
            />
          ))}
        </div>
      </div>
      <div className="field">
        <label>内置头像</label>
        <div className="builtin-strip">
          {BUILTIN_AVATARS.map(item => (
            <button
              key={item.file}
              type="button"
              className="builtin-strip__item"
              title={item.label}
              aria-label={`换上${item.label}头像`}
              onClick={() => pickBuiltin(item.file, item.label)}
            >
              <img alt="" loading="lazy" src={`${ROUTE_PREFIX}/assets/media/avatars/builtin/${item.file}`} />
            </button>
          ))}
        </div>
      </div>
      <div className="set-card__actions">
        <button type="button" className="btn btn--tiny btn--primary" disabled={busy} onClick={() => { void save() }}>保存</button>
        {hasCustom && (
          <button
            type="button"
            className="btn btn--tiny btn--ghost"
            onClick={() => runAvatarAction(async () => {
              await api.clearAvatar(agentId)
            }, '删除中…', '已删除头像，恢复默认')}
          >
            删除头像
          </button>
        )}
      </div>
      <div className="set-card__status" data-kind={status.kind} hidden={status.text === ''}>{status.text}</div>
    </div>
  )
}

/** 设置页（方案 I18）：齿轮进、回群聊出；执行中给提示留「喊停」出路。 */
export function SettingsPage() {
  const settingsOpen = useSessionStore(state => state.settingsOpen)
  const members = useSessionStore(state => state.members)
  const streaming = useTurnStore(state => state.streaming)
  const titleRef = useRef<HTMLHeadingElement>(null)
  // 显隐由 body[data-settings] 驱动（0.12.7 CSS：.settings 默认 display:none，
  // body[data-settings="open"] 才显示）——React 渲染面之外还要同步这个 dataset。
  useEffect(() => {
    document.body.dataset.settings = settingsOpen ? 'open' : 'closed'
  }, [settingsOpen])
  useEffect(() => {
    if (!settingsOpen) return
    // 等显示切换（body dataset → display:flex）与渲染提交都完成，焦点才落得上。
    const timer = setTimeout(() => titleRef.current?.focus(), 60)
    return () => clearTimeout(timer)
  }, [settingsOpen])
  if (!settingsOpen) return null
  return (
    <section className="settings paper" id="settings" aria-label="设置">
      <div className="settings__head">
        <button type="button" className="btn" onClick={() => useSessionStore.getState().setSettingsOpen(false)}>← 回群聊</button>
        <h2 className="settings__title" id="settings-title" ref={titleRef} tabIndex={-1}>设置</h2>
        <span className="settings__note">改外号、换头像、挑配色，只在你这里生效，不影响插件自己声明的身份。</span>
        {streaming && <span className="settings__live">有任务正在执行：回群聊可查看进度或喊停</span>}
      </div>
      <div className="settings__grid" id="settings-members">
        {members.length === 0
          ? <p className="empty">还没有可分派的成员</p>
          : members.map(member => <SettingsCard key={member.agentId} member={member} onSaved={() => { void refreshPanelsData() }} />)}
      </div>
    </section>
  )
}
