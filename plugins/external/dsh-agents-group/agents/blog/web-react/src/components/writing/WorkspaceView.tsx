/**
 * 文章工作台主视图（旧 .workspace 的组件化）：文章库 / 编辑器（含候选稿对照）/
 * AI 写作助手三栏。挂载时启动工作台数据面（列表+元数据+上次草稿）并消费 chat
 * 结果卡的待打开请求（旧 openDraft({proposal}) + view(false) 的组合）。
 */
import { useEffect } from 'react'
import { bootstrapWorkspace, consumePendingOpen } from '../../workspace-controller.ts'
import type { ReactElement } from 'react'
import { AssistantPanel } from './AssistantPanel.tsx'
import { CandidateReview } from './CandidateReview.tsx'
import { EditorPanel } from './EditorPanel.tsx'
import { LibraryPanel } from './LibraryPanel.tsx'
import { PublishDialog } from './PublishDialog.tsx'

export function WorkspaceView(): ReactElement {
  useEffect(() => {
    void bootstrapWorkspace()
  }, [])
  useEffect(() => {
    void consumePendingOpen()
  }, [])

  return (
    <main className="blg-workspace blg-writing" aria-label="文章工作台">
      <LibraryPanel />
      <section className="blg-writing-main" aria-label="文章编辑">
        <CandidateReview />
        <EditorPanel />
      </section>
      <AssistantPanel />
      <PublishDialog />
    </main>
  )
}
