/**
 * 文章设置弹窗（旧 #metadata-dialog 的组件化）：允许评论、标签、分类多选
 * （元数据未就绪时禁用并保留原分类——旧 categories.disabled + category-help）、
 * 链接别名。「管理此文章的评论」入口接管理弹窗（批 2b 的 ManagementDialog）。
 */
import { useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspace.ts'
import type { BlogDraft } from '../../lib/types.ts'
import type { ReactElement } from 'react'
import { Modal } from '../common/Modal.tsx'
import { ManagementDialog } from '../manage/ManagementDialog.tsx'

export interface MetadataPatch {
  slug?: string
  tags?: string
  allowComment?: boolean
  categories?: number[]
}

export function MetadataDialog({ open, onClose, draft, metadataReady, title, slug, tags, allowComment, selectedCategories, onPatch }: {
  open: boolean
  onClose: () => void
  draft: BlogDraft
  metadataReady: boolean
  title: string
  slug: string
  tags: string
  allowComment: boolean
  selectedCategories: number[]
  onPatch: (patch: MetadataPatch) => void
}): ReactElement {
  const categories = useWorkspaceStore(state => state.categories)
  const [manageComments, setManageComments] = useState(false)
  void title

  return (
    <Modal open={open} onClose={onClose} title="文章设置" label="文章设置">
      <div className="blg-metadata">
        <label className="blg-check">
          <input type="checkbox" checked={allowComment} onChange={event => onPatch({ allowComment: event.target.checked })} />
          允许评论（随草稿保存）
        </label>
        <button type="button" className="btn btn--tiny" onClick={() => setManageComments(true)}>管理此文章的评论</button>
        <label className="blg-field">
          标签
          <input placeholder="多个标签用逗号分隔" value={tags} onChange={event => onPatch({ tags: event.target.value })} />
        </label>
        <label className="blg-field">
          分类
          <select
            multiple
            aria-label="文章分类"
            disabled={!metadataReady}
            value={selectedCategories.map(String)}
            onChange={event => {
              const values = [...event.target.selectedOptions].map(option => Number(option.value))
              onPatch({ categories: values })
            }}
          >
            {categories.map(category => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
          <small className="blg-muted">{metadataReady ? '可多选已有分类' : '分类加载中，暂时保留原分类'}</small>
        </label>
        <label className="blg-field">
          链接别名
          <input placeholder="发布时自动生成" maxLength={200} value={slug} onChange={event => onPatch({ slug: event.target.value })} />
        </label>
      </div>
      <p className="blg-preview-note">分类、标签与链接随草稿自动保存；公开内容通过发布确认提交。预览不执行 HTML 脚本，主题短代码的最终样式以博客为准。</p>
      {manageComments && (
        <ManagementDialog
          open
          initialKind="comment"
          articleCid={draft.remote?.published?.cid ?? draft.remote?.savedDraft?.cid ?? null}
          onClose={() => setManageComments(false)}
        />
      )}
    </Modal>
  )
}
