/**
 * 右栏「记忆」轻摘要（v2.6 设计 §4.6）：只读——计数拆口径（记忆/要求分列，与设置页
 * 统计同口径）+ 最近 3 条（只取记忆库）+ 跳转设置页入口。右栏是手账式紧凑面板，
 * 全量治理在设置页「记忆与要求」Tab。
 */
import { useEffect, useState } from 'react'
import { api, type MemoryItem } from '../../lib/api.ts'
import { useSessionStore } from '../../stores/session.ts'

export function MemorySummary() {
  const settingsOpen = useSessionStore(state => state.settingsOpen)
  const setSettingsOpen = useSessionStore(state => state.setSettingsOpen)
  const [summary, setSummary] = useState<{ memoryCount: number; instructionCount: number; recent: MemoryItem[] } | null>(null)
  // 设置页关闭时才轮询意义不大——挂载时拉一次，设置页关闭（可能改过）时再拉一次。
  useEffect(() => {
    if (settingsOpen) return
    api.memorySummary()
      .then(setSummary)
      .catch(() => setSummary(null)) // 记忆功能未部署（404）时整个分区不显示
  }, [settingsOpen])
  if (settingsOpen || summary === null) return null
  return (
    <div className="panel-section panel-section--memory" data-testid="memory-summary">
      <div className="failure-head">
        <h2 className="section-title">记忆</h2>
        <button type="button" className="btn btn--tiny" onClick={() => setSettingsOpen(true)}>管理</button>
      </div>
      <p className="panel-section__count">
        记忆 {summary.memoryCount} 条 · 要求 {summary.instructionCount} 条
      </p>
      {summary.recent.length > 0 && (
        <ul className="panel-section__recent">
          {summary.recent.map(item => (
            <li key={item.id} title={item.content}>
              [{item.shortId}] {item.content}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
