import { defineStore } from 'pinia'
import type { ButlerState } from './butler-client'

export const useConnectionStore = defineStore('connection', {
  state: (): ButlerState => ({ connection: '未连接', sequence: 0, reconnects: [], resets: 0, snapshotReads: 0, idempotentExecutions: 0, forbiddenRetries: 0 }),
})
