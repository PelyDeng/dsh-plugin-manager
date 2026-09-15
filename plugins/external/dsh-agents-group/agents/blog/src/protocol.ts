/** Public contract only: consumers do not import the plugin's implementation. */
import type { Actor } from '@dsh-plugin-manager/plugin-kit'
export const BLOG_PROTOCOL_VERSION = 1 as const
export const BLOG_SERVICE_EVENT = 'blog-assistant/service' as const
export const BLOG_TASK_EVENT = 'blog-assistant/task' as const
export interface BlogAttachmentSelection { id: string; version: number; range?: { from: number; to: number } | null }
export interface BlogTaskRequest { requestId: string; callerId: string; draftId: string; expectedRevision: number; instruction: string; research: boolean; attachments?: BlogAttachmentSelection[] }
export interface BlogService {
  readonly protocolVersion: 1
  readonly capabilities: readonly string[]
  start(actor: Actor, request: BlogTaskRequest): Promise<unknown>
  get(actor: Actor, taskId: string): unknown
  cancel(actor: Actor, taskId: string): unknown
}
declare module '@deepseek-ai/cordis' {
  interface Events {
    'blog-assistant/service': (accept: (service: BlogService) => void) => void
    // References only; consumers must call get with a valid original actor to read results.
    'blog-assistant/task': (event: { protocolVersion: 1; taskId: string; updatedAt: number }) => void
  }
}
