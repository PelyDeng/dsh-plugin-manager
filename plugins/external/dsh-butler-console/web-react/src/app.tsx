import { useState } from 'react'
import { Hello } from './hello.tsx'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog.tsx'
import { Button } from '@/components/ui/button.tsx'

// 服务端注入的部署配置（routePrefix/分页上限/附件上限），与旧前端同一来源。
declare const globalThis: { __BUTLER_CONFIG__?: Record<string, unknown> }

// 批 0 手账化样张（方案 §4 批 0）：shadcn/base-nova 产物一行不改，
// 「换皮可行」全部由 app.css 的 bt-overrides 层（data-slot 选择器）实现。
// 场景取 0.12.3 的两段式删除确认为样本。
export function App() {
  const [open, setOpen] = useState(false)
  return (
    <main className="bt-page">
      <Hello config={globalThis.__BUTLER_CONFIG__ ?? null} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button className="bt-sample-open">手账样张 · 打开对话框</Button>} />
        <DialogContent className="bt-sample-dialog">
          <DialogHeader>
            <DialogTitle>删掉这条任务记录？</DialogTitle>
            <DialogDescription>删除后这一页台账就不再显示它，已归档的回执不受影响。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">先留着</Button>} />
            <DialogClose render={<Button className="bt-sample-danger">删掉它</Button>} />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
