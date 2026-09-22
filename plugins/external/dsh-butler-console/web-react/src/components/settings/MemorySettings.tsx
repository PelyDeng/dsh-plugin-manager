/**
 * 设置页「记忆」Tab 三分区（v2.6 设计 §4.6 + 0.14.1 使用反馈修正）：
 *
 * 分区一「产品资产」（procedural，只读）：persona 六段，卡片默认折叠；正文走 <RichText>
 *   通用 markdown 渲染（用户反馈①：裸 <pre> 不可读）+ 展开区固定高度内滚动（反馈①）。
 * 分区二「老大的要求」（instruction，可编辑）：上限 10 条、单条 60 字；输入区强化可见性
 *   （用户反馈②：输入框不明显被当成页面说明）；少于 4 字时按钮禁用**并给出原因提示**
 *   （用户反馈②：按钮置灰但不可知原因）。
 * 分区三「记忆库」（semantic/episodic，可编辑）：容量透明化 + 截断分隔线 + 行操作。
 *
 * 三分区搜索（0.14.1 新需求）：关键字模糊匹配（大小写不敏感、空格分词 AND）+ 命中
 * 高亮定位（产品资产命中卡片自动展开、列表行内 <mark>）；「AI 搜索」为向量检索预留
 * 占位（P2 启用，当前点击提示未开通）。
 */
import { useEffect, useMemo, useState } from 'react'
import { api, type MemoryItem } from '../../lib/api.ts'
import { announce } from '../../lib/announce.ts'
import { errorTextOf } from '../../lib/error-text.ts'
import { RichText } from '../chat/RichText.tsx'

const INSTRUCTION_LIMIT = 10
const INSTRUCTION_CONTENT_LIMIT = 60
/** 存储层 content CHECK 下限 4 字（DB 是最后防线，前端提前拦截并说明原因）。 */
const CONTENT_MIN = 4

type Tab = 'procedural' | 'instructions' | 'library'

function formatDate(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 搜索分词：小写、按空白切、空串剔除。多词 = AND（每词都要命中）。 */
function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(term => term !== '')
}

/** 模糊匹配：所有分词都在目标文本里（大小写不敏感）。空查询 = 全部命中。 */
function fuzzyMatch(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true
  const lowered = text.toLowerCase()
  return terms.every(term => lowered.includes(term))
}

/** 纯文本命中高亮：按分词切分并包 <mark>（多词依次处理，前后段递归）。 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const terms = searchTerms(query)
  if (terms.length === 0) return <>{text}</>
  // 依长度降序处理，避免短词先切破坏长词命中。
  const ordered = [...terms].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`(${ordered.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  const loweredSet = new Set(ordered)
  const parts = text.split(pattern)
  return (
    <>
      {parts.map((part, index) =>
        loweredSet.has(part.toLowerCase())
          ? <mark key={index} className="mem-hit">{part}</mark>
          : <span key={index}>{part}</span>,
      )}
    </>
  )
}

/** 搜索框（三分区共用）：关键字输入 + AI 搜索预留占位。 */
function SearchBox({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  return (
    <div className="mem-search">
      <input
        type="search"
        className="mem-search__input"
        placeholder="搜索（关键字模糊匹配，空格分隔多个词）"
        value={query}
        onChange={event => onQuery(event.target.value)}
      />
      {query !== '' && (
        <button type="button" className="btn btn--tiny btn--ghost" onClick={() => onQuery('')}>清空</button>
      )}
      <button
        type="button"
        className="btn btn--tiny"
        title="向量检索将在后续版本启用（P2）"
        onClick={() => announce('AI 搜索（向量检索）将在后续版本启用')}
      >
        AI 搜索
      </button>
    </div>
  )
}

export function MemorySettings() {
  const [tab, setTab] = useState<Tab>('instructions')
  return (
    <div className="mem-settings">
      <div className="mem-settings__tabs" role="tablist" aria-label="记忆分区">
        <button type="button" role="tab" aria-selected={tab === 'procedural'} className={tab === 'procedural' ? 'btn btn--tiny mem-tab-active' : 'btn btn--tiny'} onClick={() => setTab('procedural')}>出厂规矩</button>
        <button type="button" role="tab" aria-selected={tab === 'instructions'} className={tab === 'instructions' ? 'btn btn--tiny mem-tab-active' : 'btn btn--tiny'} onClick={() => setTab('instructions')}>老大的要求</button>
        <button type="button" role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'btn btn--tiny mem-tab-active' : 'btn btn--tiny'} onClick={() => setTab('library')}>记忆库</button>
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
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set())
  const [query, setQuery] = useState('')
  useEffect(() => {
    api.memoryProcedural()
      .then(result => setSections(result.sections))
      .catch(cause => setError(errorTextOf(cause, '读取失败')))
  }, [])
  const terms = searchTerms(query)
  // 命中卡片：标题或正文匹配；搜索时自动展开命中的卡（定位），清空搜索恢复折叠态。
  const visible = useMemo(() => {
    if (sections === null) return []
    return sections.map(section => ({
      ...section,
      hits: terms.filter(term => section.content.toLowerCase().includes(term) || section.title.toLowerCase().includes(term)).length,
    })).filter(section => terms.length === 0 || section.hits > 0)
  }, [sections, terms])
  useEffect(() => {
    if (terms.length > 0) setOpenKeys(new Set(visible.map(section => section.key)))
  }, [query]) // eslint-disable-line react-hooks/exhaustive-deps -- visible 由 query 派生，跟 query 变即可
  if (error !== '') return <p className="mem-error">{error}</p>
  if (sections === null) return <p className="empty">读取中…</p>
  return (
    <div className="mem-procedural">
      <p className="mem-note">管家的<strong>出厂规矩，每次对话都会读</strong>。有意见？在群里跟管家提，它会转给维护者。</p>
      <SearchBox query={query} onQuery={setQuery} />
      <div className="mem-procedural__scroll">
        {visible.length === 0 && <p className="empty">没有命中的规矩（换个关键词试试）</p>}
        {visible.map(section => {
          const isOpen = terms.length > 0 || openKeys.has(section.key)
          const hitCount = terms.length === 0 ? 0 : section.hits
          return (
            <div key={section.key} className="mem-procedural__card" data-hit={hitCount > 0 || undefined}>
              <button
                type="button"
                className="mem-procedural__head"
                aria-expanded={isOpen}
                onClick={() => setOpenKeys(previous => {
                  const next = new Set(previous)
                  if (next.has(section.key)) next.delete(section.key)
                  else next.add(section.key)
                  return next
                })}
              >
                <span>
                  <Highlighted text={section.title} query={query} />
                  {hitCount > 0 && <span className="mem-procedural__hits"> 命中 {hitCount} 处</span>}
                </span>
                <span className="mem-procedural__meta">{isOpen ? ' ▲' : ' ▼'}</span>
              </button>
              {isOpen && (
                <div className="mem-procedural__body">
                  <RichText text={section.content} variant="card" />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 分区二：老大的要求（instruction，可编辑）。 */
function InstructionsSection() {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [draft, setDraft] = useState('')
  const [warning, setWarning] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const reload = () => {
    api.memories('', 'instruction')
      .then(result => setItems(result.items))
      .catch(cause => setError(errorTextOf(cause, '读取失败')))
  }
  useEffect(reload, [])
  const itemsSafe = items ?? []
  const terms = searchTerms(query)
  const visible = itemsSafe.filter(item => fuzzyMatch(item.content, terms))
  const draftLength = draft.trim().length
  const tooShort = draft.trim() !== '' && draftLength < CONTENT_MIN

  const add = async () => {
    if (itemsSafe.length >= INSTRUCTION_LIMIT) {
      setError(`最多 ${INSTRUCTION_LIMIT} 条，先删一条再加`)
      return
    }
    const content = draft.trim()
    if (content.length < CONTENT_MIN) { setError(`至少 ${CONTENT_MIN} 个字（当前 ${content.length} 字）`); return }
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
    // 「转为记忆」反向桥：kind 转回 semantic（单行 UPDATE 语义由服务端处理）。
    try {
      await api.memoryUpdate({ id: item.id, content: item.content, agentId: item.agentId })
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
      <p className="mem-section__title">老大的要求</p>
      <p className="mem-note"><strong>你亲手定的规矩：永远生效，优先于管家自己记的一切。</strong><br />只放风格与偏好；工作流程直接告诉管家。当前对管家生效。</p>
      <div className="mem-add">
        <div className="mem-add__main">
          <label className="mem-add__label" htmlFor="mem-instruction-input">✍ 写一条新规矩</label>
          <input
            id="mem-instruction-input"
            type="text"
            maxLength={INSTRUCTION_CONTENT_LIMIT}
            value={draft}
            placeholder={`例如：叫我 DPL（${CONTENT_MIN}-${INSTRUCTION_CONTENT_LIMIT} 字）`}
            onChange={event => { setDraft(event.target.value); setError('') }}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) void add() }}
          />
          <span className={`mem-add__count${draft.length >= INSTRUCTION_CONTENT_LIMIT ? ' mem-add__count--full' : ''}`}>{draft.length}/{INSTRUCTION_CONTENT_LIMIT}</span>
        </div>
        <button
          type="button"
          className="btn btn--tiny btn--primary"
          disabled={draftLength < CONTENT_MIN}
          title={draftLength < CONTENT_MIN ? `至少 ${CONTENT_MIN} 个字` : '保存这条规矩'}
          onClick={() => { void add() }}
        >
          添加
        </button>
      </div>
      {tooShort && <p className="mem-warn" role="status">还差 {CONTENT_MIN - draftLength} 个字：规矩要写成一句完整的话，太短管家对不上号。</p>}
      {warning !== '' && <p className="mem-warn" role="status">{warning}</p>}
      {error !== '' && <p className="mem-error">{error}</p>}
      <SearchBox query={query} onQuery={setQuery} />
      {items !== null && items.length === 0 && query === '' && <p className="empty">在上方输入框写下第一条规矩（如「叫我 DPL」），它永远生效</p>}
      {query !== '' && visible.length === 0 && <p className="empty">没有命中的要求（换个关键词试试）</p>}
      {visible.map(item => (
        <div key={item.id} className="mem-row">
          <span className="mem-row__id">[{item.shortId}]</span>
          <span className="mem-row__content"><Highlighted text={item.content} query={query} /></span>
          <span className="mem-row__meta">{formatDate(item.updatedAt)}</span>
          <button type="button" className="btn btn--tiny" onClick={() => { void toMemory(item) }}>转为记忆</button>
          <button type="button" className="btn btn--tiny btn--ghost" onClick={() => { void remove(item) }}>删除</button>
        </div>
      ))}
    </div>
  )
}

/** 分区三：记忆库（semantic/episodic，可编辑）。 */
function LibrarySection() {
  const [items, setItems] = useState<MemoryItem[] | null>(null)
  const [error, setError] = useState('')
  const [confirmPurge, setConfirmPurge] = useState(false)
  const [query, setQuery] = useState('')
  const reload = () => {
    api.memories()
      .then(result => setItems(result.items))
      .catch(cause => setError(errorTextOf(cause, '读取失败')))
  }
  useEffect(reload, [])
  const itemsSafe = useMemo(() => items ?? [], [items])
  const terms = searchTerms(query)
  // 分区边界（信息架构评审发现 1）：记忆库只放管家自记的（semantic/episodic），要求在分区二管。
  const library = itemsSafe.filter(item => item.kind !== 'instruction')
  const visible = library.filter(item => fuzzyMatch(`${item.content} ${item.kind} ${item.origin}`, terms))
  const injected = injectedCount(itemsSafe)
  const instructionCount = itemsSafe.filter(item => item.kind === 'instruction').length
  // 统计概览（§4.6 P1.5）：按智能体分组的条数——自然显性化「各成员记忆互不相通」。
  const groupStats = useMemo(() => {
    const AGENT_LABELS: Record<string, string> = { butler: '管家', blog: '博客智能体', huiyu: '绘语', closedoff: '封闭化管理' }
    const groups = new Map<string, number>()
    for (const item of itemsSafe) groups.set(item.agentId, (groups.get(item.agentId) ?? 0) + 1)
    return [...groups.entries()].map(([agentId, count]) => ({ label: AGENT_LABELS[agentId] ?? agentId, count }))
  }, [itemsSafe])

  const remove = async (item: MemoryItem) => {
    if (!window.confirm(`删掉这条记忆？[${item.shortId}]「${item.content}」\n删了就找不回来了，要留底先导出。`)) return
    try {
      await api.memoryDelete([item.id])
      announce('已删除')
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
        每轮对话生效：你的要求 {instructionCount} 条 + 管家的记忆 <strong>{injected}</strong> 条（记忆注入上限 10，越重要越靠前）。
      </p>
      {groupStats.length > 0 && (
        <p className="mem-note mem-library__groups">
          {groupStats.map(group => `${group.label} ${group.count} 条`).join(' · ')}——各成员的记忆互不相通（每份各自生效）。
        </p>
      )}
      <SearchBox query={query} onQuery={setQuery} />
      {items === null && <p className="empty">读取中…</p>}
      {items !== null && items.length === 0 && query === '' && <p className="empty">在群里跟管家说「记住：……」，它会记到这里</p>}
      {items !== null && items.length > 0 && visible.length === 0 && <p className="empty">没有命中的记忆（换个关键词试试）</p>}
      {visible.map((item, index) => {
        // 截断分隔线只按注入序画在未过滤的完整列表上（过滤态语义混乱，画在原位次）。
        const originalIndex = itemsSafe.indexOf(item)
        const showDivider = query === '' && originalIndex === injected && originalIndex < itemsSafe.length
        return (
          <div key={item.id}>
            {showDivider && (
              <div className="mem-library__divider" title="这条分隔线以下的内容目前不进入管家的每轮对话">▲ 以上进入管家的每轮对话 · 以下暂不注入</div>
            )}
            <div className="mem-row">
              <span className="mem-row__id">[{item.shortId}]</span>
              <span className="mem-row__content" title={`${item.origin === 'reference' ? '自资料记' : '老大原话'} · 记于 ${formatDate(item.updatedAt)}`}>
                <Highlighted text={item.content} query={query} />
                <span className="mem-row__meta">（{KIND_LABEL[item.kind]}）</span>
              </span>
              <button type="button" className="btn btn--tiny" onClick={() => { void promote(item) }}>升级为要求</button>
              <button type="button" className="btn btn--tiny btn--ghost" onClick={() => { void remove(item) }}>删除</button>
            </div>
          </div>
        )
      })}
      <div className="mem-library__actions">
        <a className="btn btn--tiny" href={api.memoryExportUrl()}>导出（含要求与记忆，不含出厂规矩）</a>
        {itemsSafe.length > 0 && !confirmPurge && (
          <button type="button" className="btn btn--tiny btn--ghost" onClick={() => setConfirmPurge(true)}>清空记忆库</button>
        )}
        {confirmPurge && (
          <span className="mem-library__purge">
            将清空记忆库的 {itemsSafe.filter(item => item.kind !== 'instruction').length} 条（不含「老大的要求」），不可恢复——确定？
            <button type="button" className="btn btn--tiny mem-danger" onClick={() => { void purge() }}>确定清空</button>
            <button type="button" className="btn btn--tiny" onClick={() => setConfirmPurge(false)}>取消</button>
          </span>
        )}
      </div>
      {error !== '' && <p className="mem-error">{error}</p>}
    </div>
  )
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
