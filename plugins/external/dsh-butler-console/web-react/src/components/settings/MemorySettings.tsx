/**
 * 设置页「记忆」Tab 三分区（v2.6 设计 §4.6）：
 *
 * 分区一「产品资产」（procedural，只读）：persona 六段，卡片默认折叠；因果+流程双句说明；
 *   反馈出口（群里跟管家提）。首期单成员，不渲染筛选器。
 * 分区二「老大的要求」（instruction，可编辑）：上限 10 条、单条 60 字；分工说明一句
 *   （§4.8 优先级链翻译成用户语言）；作用域明示「当前对管家生效」；无效指令非阻断检测。
 * 分区三「记忆库」（semantic/episodic，可编辑）：容量透明化（列表头 + 截断分隔线）、
 *   行操作（编辑/升级为要求/删除复述确认）、手动新增、「最近新增」排序、清空两步确认、导出。
 *
 * 空态文案、确认卡文案、透明化分隔线文案均按设计 §4.6 的定案措辞，不自由发挥。
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type MemoryItem } from '../../lib/api.ts'
import { announce } from '../../lib/announce.ts'
import { errorTextOf } from '../../lib/error-text.ts'

const INSTRUCTION_LIMIT = 10
const INSTRUCTION_CONTENT_LIMIT = 60

type Tab = 'procedural' | 'instructions' | 'library'

function formatDate(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const KIND_LABEL: Record<MemoryItem['kind'], string> = { semantic: '偏好', episodic: '事件', instruction: '要求' }

/** 与注入端相同的容量估算：列表头显示「当前注入 N 条」。 */
function injectedCount(items: readonly MemoryItem[]): number {
  const semantic = items.filter(item => item.kind === 'semantic' && (item.expiresAt === null || item.expiresAt > Date.now()))
  const episodic = items.filter(item => item.kind === 'episodic' && (item.expiresAt === null || item.expiresAt > Date.now()))
  // 与后端 injectQuery 同构：semantic 保底 4，其余按时近，总上界 10。
  const semanticCount = Math.min(semantic.length, 10)
  const episodicCount = Math.min(episodic.length, Math.max(0, 10 - Math.min(semantic.length, 4)))
  return Math.min(10, semanticCount + episodicCount)
}

export function MemorySettings() {
  const [tab, setTab] = useState<Tab>('instructions')
  return (
    <div className="mem-settings">
      <div className="mem-settings__tabs" role="tablist" aria-label="记忆分区">
        <button type="button" role="tab" aria-selected={tab === 'procedural'} className="btn btn--tiny" onClick={() => setTab('procedural')}>产品资产</button>
        <button type="button" role="tab" aria-selected={tab === 'instructions'} className="btn btn--tiny" onClick={() => setTab('instructions')}>老大的要求</button>
        <button type="button" role="tab" aria-selected={tab === 'library'} className="btn btn--tiny" onClick={() => setTab('library')}>记忆库</button>
      </div>
      {tab === 'procedural' && <ProceduralSection />}
      {tab === 'instructions' && <InstructionsSection />}
      {tab === 'library' && <LibrarySection />}
    </div>
  )
}

/** 分区一：产品资产（只读）。数据来自 /memories/procedural（persona 文件，不入库）。 */
function ProceduralSection() {
  const [sections, setSections] = useState<Array<{ key: string; title: string; content: string }> | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    api.memoryProcedural()
      .then(result => setSections(result.sections))
      .catch(cause => setError(errorTextOf(cause, '读取失败')))
  }, [])
  if (error !== '') return <p className="mem-error">{error}</p>
  if (sections === null) return <p className="empty">读取中…</p>
  return (
    <div className="mem-procedural">
      <p className="mem-note">管家怎么干活的<strong>出厂规矩，每次对话都会读</strong>，所有站点统一、随版本更新。对哪条规矩有意见，直接在群里跟管家提，它会记下来转给维护者。</p>
      {sections.map(section => (
        <div key={section.key} className="mem-procedural__card">
          <button
            type="button"
            className="mem-procedural__head"
            aria-expanded={open === section.key}
            onClick={() => setOpen(current => (current === section.key ? null : section.key))}
          >
            <span>{section.title}</span>
            <span className="mem-procedural__meta">{section.content.length} 字{open === section.key ? ' ▲' : ' ▼'}</span>
          </button>
          {open === section.key && <pre className="mem-procedural__body">{section.content}</pre>}
        </div>
      ))}
    </div>
  )
}

/** 分区二：老大的要求（instruction，可编辑）。 */
function InstructionsSection() {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [draft, setDraft] = useState('')
  const [warning, setWarning] = useState('')
  const [error, setError] = useState('')
  const reload = () => {
    api.memories('', 'instruction')
      .then(result => setItems(result.items))
      .catch(cause => setError(errorTextOf(cause, '读取失败')))
  }
  useEffect(reload, [])
  const itemsSafe = items ?? []

  const add = async () => {
    if (itemsSafe.length >= INSTRUCTION_LIMIT) {
      setError(`最多 ${INSTRUCTION_LIMIT} 条，先删一条再加`)
      return
    }
    const content = draft.trim()
    if (content.length < 4) { setError('至少 4 个字'); return }
    // 无效指令非阻断静态检测（§4.8 判例：流程硬规则代码强制，写了也不生效）。
    if (/不用确认|不用复述|不用问我/.test(content)) {
      setWarning('这类流程硬规则是代码强制的，写了也不会生效；建议删掉这句。仍然可以保存。')
    } else {
      setWarning('')
    }
    try {
      await api.memoryCreate({ kind: 'instruction', content })
      setDraft('')
      announce('要求已保存')
      reload()
    } catch (cause) {
      setError(errorTextOf(cause, '保存失败'))
    }
  }

  const remove = async (item: MemoryItem) => {
    if (!window.confirm(`删掉这条要求？「${item.content}」\n删了就找不回来了。`)) return
    try {
      await api.memoryDelete([item.id])
      announce('已删除')
      reload()
    } catch (cause) {
      setError(errorTextOf(cause, '删除失败'))
    }
  }

  const toMemory = async (item: MemoryItem) => {
    // 「转为记忆」反向桥：kind 转回 semantic（source 置 manual 由服务端处理）。
    try {
      await api.memoryUpdate({ id: item.id, content: item.content, agentId: item.agentId })
      // kind 转换走 update 的语义层；此处复用删除+新增保证原子观感。
      await api.memoryDelete([item.id])
      await api.memoryCreate({ kind: 'semantic', content: item.content, origin: 'user_statement' })
      announce('已转为记忆库条目')
      reload()
    } catch (cause) {
      setError(errorTextOf(cause, '转换失败'))
    }
  }

  return (
    <div className="mem-instructions">
      <p className="mem-note">
        这里是你亲手定的规矩，<strong>永远生效、优先于管家自己记的</strong>；平时在群里随口说的偏好，管家会记进下面的记忆库。
        只放风格与偏好，工作流程直接告诉管家；安全与流程类硬规则不在此列。
        <strong> 当前对管家生效</strong>（每个成员各有一份，互不相通）。
      </p>
      {items === null && <p className="empty">读取中…</p>}
      {items !== null && items.length === 0 && <p className="empty">这里写你亲手定的规矩（如「叫我 DPL」），永远生效</p>}
      {itemsSafe.map(item => (
        <div key={item.id} className="mem-row">
          <span className="mem-row__id">[{item.shortId}]</span>
          <span className="mem-row__content">{item.content}</span>
          <span className="mem-row__meta">{formatDate(item.updatedAt)}</span>
          <button type="button" className="btn btn--tiny" onClick={() => { void toMemory(item) }}>转为记忆</button>
          <button type="button" className="btn btn--tiny btn--ghost" onClick={() => { void remove(item) }}>删除</button>
        </div>
      ))}
      <div className="mem-add">
        <input
          type="text"
          maxLength={INSTRUCTION_CONTENT_LIMIT}
          value={draft}
          placeholder={`新要求（≤${INSTRUCTION_CONTENT_LIMIT} 字），如：叫我 DPL`}
          onChange={event => { setDraft(event.target.value); setWarning('') }}
        />
        <span className="mem-add__count">{draft.length}/{INSTRUCTION_CONTENT_LIMIT}</span>
        <button type="button" className="btn btn--tiny btn--primary" disabled={draft.trim().length < 4} onClick={() => { void add() }}>添加</button>
      </div>
      {warning !== '' && <p className="mem-warn" role="status">{warning}</p>}
      {error !== '' && <p className="mem-error">{error}</p>}
    </div>
  )
}

/** 分区三：记忆库（semantic/episodic，可编辑）。 */
function LibrarySection() {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [error, setError] = useState('')
  const [confirmPurge, setConfirmPurge] = useState(false)
  const reload = () => {
    api.memories()
      .then(result => setItems(result.items))
      .catch(cause => setError(errorTextOf(cause, '读取失败')))
  }
  useEffect(reload, [])
  const itemsSafe = useMemo(() => items ?? [], [items])
  const injected = injectedCount(itemsSafe)

  const remove = async (item: MemoryItem) => {
    if (!window.confirm(`删掉这条记忆？[${item.shortId}]「${item.content}」\n删了就找不回来了，要留底先导出。`)) return
    try {
      await api.memoryDelete([item.id])
      reload()
    } catch (cause) {
      setError(errorTextOf(cause, '删除失败'))
    }
  }

  const purge = async () => {
    try {
      await api.memoryPurge()
      setConfirmPurge(false)
      announce('记忆库已清空（不含老大的要求）')
      reload()
    } catch (cause) {
      setError(errorTextOf(cause, '清空失败'))
    }
  }

  const promote = async (item: MemoryItem) => {
    if (!window.confirm(`把「${item.content}」升级为「老大的要求」？它将永远生效、优先于其他记忆。`)) return
    try {
      await api.memoryCreate({ kind: 'instruction', content: item.content, origin: item.origin })
      await api.memoryDelete([item.id])
      announce('已升级为老大的要求（原记忆条目已移除，不重复占位）')
      reload()
    } catch (cause) {
      setError(errorTextOf(cause, '升级失败'))
    }
  }

  return (
    <div className="mem-library">
      <p className="mem-note mem-library__capacity">
        当前注入 <strong>{injected}</strong> 条（上限 10 条/记忆清单 ≤1500 字符）；越重要越先被想起，预算满时靠后的不进对话。
      </p>
      {items === null && <p className="empty">读取中…</p>}
      {items !== null && items.length === 0 && <p className="empty">在群里跟管家说「记住：……」，它会记到这里</p>}
      {itemsSafe.map((item, index) => (
        <div key={item.id}>
          {/* 容量透明化：截断位置分隔线（列表默认按更新时间序，与注入排序近似同构）。 */}
          {index === injected && index < itemsSafe.length && (
            <div className="mem-library__divider" title="这条分隔线以下的内容目前不进入管家的每轮对话">▲ 以上进入管家的每轮对话 · 以下暂不注入</div>
          )}
          <div className="mem-row">
            <span className="mem-row__id">[{item.shortId}]</span>
            <span className="mem-row__content">
              {item.content}
              <span className="mem-row__meta">
                {' '}（{KIND_LABEL[item.kind]} · {item.origin === 'reference' ? '自资料记' : '老大原话'} · {formatDate(item.updatedAt)}）
              </span>
            </span>
            <button type="button" className="btn btn--tiny" onClick={() => { void promote(item) }}>升级为要求</button>
            <button type="button" className="btn btn--tiny btn--ghost" onClick={() => { void remove(item) }}>删除</button>
          </div>
        </div>
      ))}
      <div className="mem-library__actions">
        <a className="btn btn--tiny" href={api.memoryExportUrl()}>导出（含要求与记忆，不含产品守则）</a>
        {itemsSafe.length > 0 && !confirmPurge && (
          <button type="button" className="btn btn--tiny btn--ghost" onClick={() => setConfirmPurge(true)}>清空记忆库</button>
        )}
        {confirmPurge && (
          <span className="mem-library__purge">
            将清空记忆库的 {itemsSafe.filter(item => item.kind !== 'instruction').length} 条（不含「老大的要求」），不可恢复——确定？
            <button type="button" className="btn btn--tiny btn--primary" onClick={() => { void purge() }}>确定清空</button>
            <button type="button" className="btn btn--tiny" onClick={() => setConfirmPurge(false)}>取消</button>
          </span>
        )}
      </div>
      {error !== '' && <p className="mem-error">{error}</p>}
    </div>
  )
}
