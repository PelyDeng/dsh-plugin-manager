/**
 * 过渡适配器：用现有同步 TaskStore（node:sqlite）实现异步 ButlerStorage 接口。
 *
 * **仅测试与迁移前存量用途**：方法体把同步调用包成 Promise，语义直通、不做任何改写；
 * T1-4 随测试改造删除，生产装配（index.ts）只允许 PostgresTaskStorage，绝不回退到这里。
 *
 * 两处例外说明：
 *
 * - `init()` 是空操作：TaskStore 在构造函数里同步完成建库与版本校验（含不支持版本的
 *   同步 throw），启动序列里没有第二次校验可做；
 * - `expireWaitingSubtask()` 退回「读-核-写」：TaskStore 没有条件更新原语，但整段在
 *   同一个同步调用里完成、没有 await 窗口，与原 butler.ts 实现语义一致；§3 的单条
 *   条件 UPDATE 语义由 PostgresTaskStorage 提供。
 */

import type { Actor } from '@dsh-plugin-manager/plugin-kit'
import { TaskStore } from '../store.ts'
import type {
  ButlerStorage,
  ConversationSummary,
  HistoryQuery,
  NewSubtask,
  RequestRecord,
  TaskCounts,
  TaskInput,
  TaskRecord,
  TaskSummary,
} from './types.ts'

export class SqliteButlerStorage implements ButlerStorage {
  constructor(private readonly store: TaskStore) {}

  async init(): Promise<void> {
    // TaskStore 构造函数已同步完成结构与版本校验（不支持版本直接 throw），这里无事可做。
  }

  async expireWaitingSubtask(taskId: string, subtaskId: string, error: string): Promise<boolean> {
    if (this.store.subtaskState(taskId, subtaskId) !== 'waiting_user') return false
    this.store.setSubtaskState(taskId, subtaskId, 'failed', { error })
    return true
  }

  async aliases(actor: Actor): Promise<Map<string, { displayName: string; accent: string }>> {
    return this.store.aliases(actor)
  }

  async setAlias(actor: Actor, agentId: string, displayName: string, accent: string): Promise<void> {
    this.store.setAlias(actor, agentId, displayName, accent)
  }

  async setAvatar(actor: Actor, agentId: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.store.setAvatar(actor, agentId, bytes, contentType)
  }

  async avatar(actor: Actor, agentId: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined> {
    return this.store.avatar(actor, agentId)
  }

  async clearAvatar(actor: Actor, agentId: string): Promise<void> {
    this.store.clearAvatar(actor, agentId)
  }

  async reserveConversation(id: string, actor: Actor): Promise<void> {
    this.store.reserveConversation(id, actor)
  }

  async openOrReserveConversation(id: string, actor: Actor): Promise<void> {
    this.store.openOrReserveConversation(id, actor)
  }

  async assertOwner(conversationId: string, actor: Actor): Promise<void> {
    this.store.assertOwner(conversationId, actor)
  }

  async touchConversation(conversationId: string, actor: Actor, title?: string): Promise<void> {
    this.store.touchConversation(conversationId, actor, title)
  }

  async listConversations(actor: Actor, limit: number): Promise<ConversationSummary[]> {
    return this.store.listConversations(actor, limit)
  }

  async createTask(input: {
    id: string
    conversationId: string
    actor: Actor
    goal: string
    note: string
    subtasks: readonly NewSubtask[]
  }): Promise<void> {
    this.store.createTask(input)
  }

  async setTaskState(id: string, state: TaskRecord['state'], patch?: { note?: string; summary?: string; error?: string }): Promise<void> {
    this.store.setTaskState(id, state, patch)
  }

  async commitTaskState(id: string, state: TaskRecord['state'], patch?: { note?: string; summary?: string; error?: string }): Promise<boolean> {
    return this.store.commitTaskState(id, state, patch)
  }

  async setSubtaskState(
    taskId: string,
    subtaskId: string,
    state: Parameters<TaskStore['setSubtaskState']>[2],
    patch?: Parameters<TaskStore['setSubtaskState']>[3],
  ): Promise<void> {
    this.store.setSubtaskState(taskId, subtaskId, state, patch)
  }

  async task(actor: Actor, id: string): Promise<TaskRecord | undefined> {
    return this.store.task(actor, id)
  }

  async history(actor: Actor, query: HistoryQuery): Promise<{ items: TaskSummary[]; total: number; nextOffset: number | null }> {
    return this.store.history(actor, query)
  }

  async busy(actor: Actor): Promise<Map<string, { taskId: string; subtaskId: string; state: TaskRecord['subtasks'][number]['state'] }>> {
    return this.store.busy(actor)
  }

  async addInput(actor: Actor, taskId: string, text: string, source: 'chat' | 'supplement', expectedVersion?: number): Promise<number> {
    return this.store.addInput(actor, taskId, text, source, expectedVersion)
  }

  async inputVersions(taskId: string): Promise<{ accepted: number; processed: number } | undefined> {
    return this.store.inputVersions(taskId)
  }

  async inputs(taskId: string): Promise<TaskInput[]> {
    return this.store.inputs(taskId)
  }

  async setProcessedVersion(taskId: string, version: number): Promise<void> {
    this.store.setProcessedVersion(taskId, version)
  }

  async appendSubtasks(actor: Actor, taskId: string, subtasks: readonly NewSubtask[]): Promise<string[]> {
    return this.store.appendSubtasks(actor, taskId, subtasks)
  }

  async counts(actor: Actor): Promise<TaskCounts> {
    return this.store.counts(actor)
  }

  async recentFailures(actor: Actor, limit: number): Promise<{ id: string; goal: string; error: string; updatedAt: number }[]> {
    return this.store.recentFailures(actor, limit)
  }

  async failInterrupted(): Promise<number> {
    return this.store.failInterrupted()
  }

  async request(actor: Actor, kind: string, requestId: string): Promise<RequestRecord | undefined> {
    return this.store.request(actor, kind, requestId)
  }

  async claimRequest(actor: Actor, kind: string, requestId: string, digest: string, runId: string, conversationId: string, ttlMs: number): Promise<RequestRecord | undefined> {
    return this.store.claimRequest(actor, kind, requestId, digest, runId, conversationId, ttlMs)
  }

  async bindRequest(actor: Actor, kind: string, requestId: string, runId: string, conversationId: string): Promise<void> {
    this.store.bindRequest(actor, kind, requestId, runId, conversationId)
  }

  async finishRequest(actor: Actor, kind: string, requestId: string): Promise<void> {
    this.store.finishRequest(actor, kind, requestId)
  }

  async releaseRequest(actor: Actor, kind: string, requestId: string): Promise<void> {
    this.store.releaseRequest(actor, kind, requestId)
  }

  async close(): Promise<void> {
    this.store.close()
  }
}
