/**
 * 恢复快照：浏览器里只保留四项——地图、格子、朝向、偏好。
 *
 * - 按用户隔离：key 用登录身份 key 的短哈希，存储里不出现身份原文，更不出现凭据；
 * - 任务正文、会话内容、请求 ID 一律不落盘（权威在管家，浏览器丢弃后重新读取）；
 * - 坏快照（JSON 坏了、字段类型不对、地图 id 越界）按「没有快照」处理，人物回安全出生点；
 *   格子是否在墙上、是否越界由 MapRouter 拿到该图碰撞后再判。
 */
import { FACINGS, MAP_ID_PATTERN, type Cell, type Direction, type Feet } from './world-runtime.ts'

export type Preferences = { taskBookOpen: boolean }
/** 四项之外没有别的字段；cell 为 null 表示快照里的格子不可用（回出生格）。 */
export type WorldSnapshot = { map: string; cell: Cell | null; facing: Direction; preferences: Preferences }

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const SNAPSHOT_FIELDS = ['map', 'cell', 'facing', 'preferences'] as const
export const STORAGE_PREFIX = 'niuma-boss:world:'
/** 上次活跃的用户作用域：启动时先按它恢复，身份确认后再校对。 */
export const LAST_SCOPE_KEY = STORAGE_PREFIX + 'last'
const MAX_CELL = 4096

/** FNV-1a 32 位：把身份 key 变成稳定的短作用域，不落盘可读用户标识。 */
export function scopeOf(identityKey: string): string {
  if (identityKey === '') return ''
  let hash = 0x811c9dc5
  for (let i = 0; i < identityKey.length; i++) {
    hash ^= identityKey.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 写盘前的形状：永远只有四项，字段顺序固定，偏好只留布尔位。 */
export function snapshotOf(feet: Feet, preferences: Partial<Preferences> | undefined): WorldSnapshot {
  return {
    map: feet.map,
    cell: [feet.cell[0], feet.cell[1]],
    facing: FACINGS.includes(feet.facing) ? feet.facing : 'south',
    preferences: { taskBookOpen: preferences?.taskBookOpen === true },
  }
}

/** 读盘校验：坏快照返回 null（界面按没有快照处理，人物回出生点）。 */
export function parseSnapshot(raw: unknown): WorldSnapshot | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const map = typeof value.map === 'string' && MAP_ID_PATTERN.test(value.map) ? value.map : ''
  if (map === '') return null
  if (typeof value.facing !== 'string' || !FACINGS.includes(value.facing as Direction)) return null
  const cell = Array.isArray(value.cell) && value.cell.length === 2
    && value.cell.every(v => Number.isInteger(v) && (v as number) >= 0 && (v as number) < MAX_CELL)
    ? [value.cell[0] as number, value.cell[1] as number] as Cell
    : null
  const preferences = value.preferences
  if (typeof preferences !== 'object' || preferences === null || Array.isArray(preferences)) return null
  const open = (preferences as Record<string, unknown>).taskBookOpen
  if (typeof open !== 'boolean') return null
  return { map, cell, facing: value.facing as Direction, preferences: { taskBookOpen: open } }
}

/** 浏览器存储不可用时（隐私模式、被禁用）静默退化为「不恢复」，游戏照常运行。 */
export function browserStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage
    if (!storage) return null
    const probe = STORAGE_PREFIX + 'probe'
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return storage
  } catch {
    return null
  }
}

export class RecoveryStore {
  constructor(private readonly storage: StorageLike | null, private readonly isValidMap: (id: string) => boolean = id => MAP_ID_PATTERN.test(id)) {}

  /** 读某用户的快照；没有、损坏、地图不认识都算没有快照。 */
  load(scope: string): WorldSnapshot | null {
    if (scope === '' || this.storage === null) return null
    let text: string | null = null
    try { text = this.storage.getItem(STORAGE_PREFIX + scope) } catch { return null }
    if (text === null || text === '') return null
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { return null }
    const snapshot = parseSnapshot(parsed)
    if (!snapshot || !this.isValidMap(snapshot.map)) return null
    return snapshot
  }

  /** 写某用户的快照：只写四项，写失败不影响游戏。 */
  save(scope: string, feet: Feet, preferences: Partial<Preferences> | undefined): void {
    if (scope === '' || this.storage === null) return
    try {
      this.storage.setItem(STORAGE_PREFIX + scope, JSON.stringify(snapshotOf(feet, preferences)))
    } catch { /* 存储写满或被禁用：位置恢复降级，不影响本局 */ }
  }

  lastScope(): string {
    if (this.storage === null) return ''
    try { return this.storage.getItem(LAST_SCOPE_KEY) ?? '' } catch { return '' }
  }

  /** 记住当前用户作用域，供下次启动先恢复这一位的位置。 */
  remember(scope: string): void {
    if (this.storage === null) return
    try { this.storage.setItem(LAST_SCOPE_KEY, scope) } catch { /* 同上 */ }
  }

  forget(scope: string): void {
    if (scope === '' || this.storage === null) return
    try { this.storage.removeItem(STORAGE_PREFIX + scope) } catch { /* 同上 */ }
  }
}
