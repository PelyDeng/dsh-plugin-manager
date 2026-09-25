/**
 * 文章库侧栏（旧 aside.library 的组件化）：搜索（防抖）、状态过滤、分页、
 * 列表行（已发布/草稿徽标、未发布修改）、删除（走 prepareLibraryDelete 确认链路）、
 * 旧版内容迁移入口。
 */
import { importArticle, openDraft, prepareLibraryDelete, loadList, scheduleSearch } from '../../workspace-controller.ts'
import { api } from '../../lib/api.ts'
import { createDraft } from '../../workspace-controller.ts'
import { useSessionStore } from '../../stores/session.ts'
import { useWorkspaceStore } from '../../stores/workspace.ts'
import type { ArticleListItem } from '../../lib/types.ts'
import type { ReactElement } from 'react'

export function LibraryPanel(): ReactElement {
  const articles = useWorkspaceStore(state => state.articles)
  const hasMore = useWorkspaceStore(state => state.articlesHasMore)
  const loading = useWorkspaceStore(state => state.articlesLoading)
  const error = useWorkspaceStore(state => state.articlesError)
  const search = useWorkspaceStore(state => state.search)
  const statusFilter = useWorkspaceStore(state => state.statusFilter)
  const migrationRemaining = useWorkspaceStore(state => state.migrationRemaining)
  const setSearch = useWorkspaceStore(state => state.setSearch)
  const setStatusFilter = useWorkspaceStore(state => state.setStatusFilter)
  const setPage = useWorkspaceStore(state => state.setPage)

  const onNotice = (text: string): void => useSessionStore.getState().setNotice({ text, tone: 'error' })

  const openRow = async (item: ArticleListItem): Promise<void> => {
    try {
      await importArticle(item.cid, item.hasSavedDraft === true ? 'savedDraft' : 'published')
    } catch (issue) {
      onNotice(issue instanceof Error ? issue.message : String(issue))
    }
  }

  const deleteRow = async (item: ArticleListItem): Promise<void> => {
    try {
      await prepareLibraryDelete(item.cid)
    } catch (issue) {
      onNotice(issue instanceof Error ? issue.message : String(issue))
    }
  }

  const migrate = async (): Promise<void> => {
    try {
      await api.migrateDrafts()
      // 迁移后当前草稿未脏则重新拉取装配（旧 migrate-drafts 的 fill 分支，A9）。
      const { draft, dirty } = useWorkspaceStore.getState()
      if (draft !== null && !dirty) await openDraft(draft.id)
      await loadList()
    } catch (issue) {
      onNotice(issue instanceof Error ? issue.message : String(issue))
    }
  }

  return (
    <aside className="blg-library" aria-label="文章与草稿">
      <div className="blg-section-heading">
        <h1>文章与草稿</h1>
        <button type="button" className="btn btn--primary" onClick={() => { void createDraft().catch(onNotice) }}>＋ 新建</button>
      </div>
      <div className="blg-library-filters">
        <label className="blg-library-search">
          <span className="visually-hidden">搜索文章</span>
          <input type="search" placeholder="搜索标题或内容…" value={search} aria-label="搜索文章"
            onChange={event => { setSearch(event.target.value); scheduleSearch() }} />
        </label>
        <label>
          <span className="visually-hidden">草稿状态</span>
          <select aria-label="草稿状态" title="草稿状态" value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value as 'all' | 'published' | 'draft')
              setPage(1)
              void loadList().catch(onNotice)
            }}>
            <option value="all">全部</option>
            <option value="published">已发布</option>
            <option value="draft">草稿</option>
          </select>
        </label>
      </div>
      <p className="blg-muted blg-library-scope">文章和草稿均保存在博客中。编辑已发布文章时，修改先保存为博客草稿，确认发布后才更新公开原文。</p>
      <div className="blg-article-list" aria-busy={loading}>
        {articles.map(item => (
          <div key={item.cid} className="blg-library-item">
            <button type="button" className="blg-article-row" onClick={() => { void openRow(item) }}>
              <span>{item.title === '' ? '未命名草稿' : item.title}</span>
              <span className="blg-article-badges">
                <span className={item.hasPublished === true ? 'blg-article-badge blg-article-badge--published' : 'blg-article-badge'}>
                  {item.hasPublished === true ? '已发布' : '草稿'}
                </span>
                {item.hasPublished === true && item.hasSavedDraft === true && <span className="blg-article-badge blg-article-badge--saved">有未发布修改</span>}
              </span>
            </button>
            <button
              type="button"
              className="blg-article-delete"
              aria-label={`删除文章：${item.title === '' ? '未命名草稿' : item.title}`}
              onClick={() => { void deleteRow(item) }}
            >
              删除
            </button>
          </div>
        ))}
        {articles.length === 0 && !loading && <p className="blg-muted">还没有匹配的文章或草稿</p>}
        {error !== null && <p className="blg-dialog-error" role="alert">{error}</p>}
      </div>
      {hasMore && (
        <button type="button" className="btn" onClick={() => { setPage(useWorkspaceStore.getState().page + 1); void loadList().catch(onNotice) }}>
          下一页
        </button>
      )}
      {migrationRemaining !== null && migrationRemaining > 0 && (
        <button type="button" className="btn" onClick={() => { void migrate() }}>
          将 {migrationRemaining} 份旧版内容转成博客草稿
        </button>
      )}
      <p className="blg-library-foot">草稿访问权限由博客账号决定<br />公开内容需确认发布</p>
    </aside>
  )
}
