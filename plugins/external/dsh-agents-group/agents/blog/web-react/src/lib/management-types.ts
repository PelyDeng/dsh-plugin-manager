/**
 * 管理弹窗的编辑态形状（组件间传递用；数据面形状见 lib/management.ts 与 types.ts）。
 */

/** 编辑器当前表单（category/tag/comment 三域共用袋；values 的键随域变化）。 */
export interface ManageRecord {
  kind: 'category' | 'tag' | 'comment'
  id: number | null
  isNew: boolean
  version?: number
  values: Record<string, string | number | undefined>
  count: number
  defaultCategory: boolean
}

/** manage-list 的评论行（页面消费面）。 */
export interface CommentRow {
  id: number
  cid: number
  author: string
  text: string
  status?: string
  parent?: number
}
