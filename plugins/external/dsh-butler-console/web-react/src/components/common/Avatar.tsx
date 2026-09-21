/**
 * 成员头像（旧 avatarNode 语义）：上传图 → 默认涂鸦 → 首字配色圆。
 * img 失败用 state 隐藏（React fiber 仍持引用，不能直接 remove 节点）。
 */
import { type CSSProperties, useState } from 'react'
import { DEFAULT_AVATAR_FILES } from '../../lib/config.ts'
import { accentOf, displayNameOf, useSessionStore } from '../../stores/session.ts'
import { ROUTE_PREFIX } from '../../lib/api.ts'

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
