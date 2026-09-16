import { describe, expect, it } from 'vitest'
import {
  LAST_SCOPE_KEY, RecoveryStore, SNAPSHOT_FIELDS, STORAGE_PREFIX, parseSnapshot, scopeOf, snapshotOf,
  type StorageLike,
} from '../src/recovery.ts'
import type { Feet } from '../src/world-runtime.ts'

/**
 * 按用户恢复：localStorage 里只保留四项——地图、格子、朝向、偏好。
 * 任务正文、会话内容与凭据一律不落盘；坏快照按「没有快照」处理，人物回安全出生点。
 */

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
  /** 测试用：整个存储的文本，用来断言没有任务正文与身份原文。 */
  get dump(): string { return [...this.values.entries()].map(([k, v]) => k + '=' + v).join('\n') }
}

const feet: Feet = { map: 'street', cell: [8, 12], facing: 'east' }
const known = (id: string) => ['office', 'street', 'cafe'].includes(id)

describe('快照形状', () => {
  it('永远只有四项，字段顺序固定', () => {
    const snapshot = snapshotOf(feet, { taskBookOpen: true })
    expect(Object.keys(snapshot)).toEqual([...SNAPSHOT_FIELDS])
    expect(snapshot).toEqual({ map: 'street', cell: [8, 12], facing: 'east', preferences: { taskBookOpen: true } })
  })

  it('偏好只留布尔位，多余字段丢弃', () => {
    const snapshot = snapshotOf(feet, { taskBookOpen: true, token: 'secret', message: '不该存的正文' } as never)
    expect(Object.keys(snapshot.preferences)).toEqual(['taskBookOpen'])
    expect(JSON.stringify(snapshot)).not.toContain('不该存的正文')
    expect(snapshotOf(feet, undefined).preferences.taskBookOpen).toBe(false)
  })

  it('读盘形状不符一律判为坏快照', () => {
    expect(parseSnapshot(null)).toBeNull()
    expect(parseSnapshot('street')).toBeNull()
    expect(parseSnapshot([])).toBeNull()
    expect(parseSnapshot({})).toBeNull()
    expect(parseSnapshot({ map: 'street' })).toBeNull()
    expect(parseSnapshot({ map: 'street', cell: [1, 2], facing: 'up', preferences: { taskBookOpen: true } })).toBeNull()
    expect(parseSnapshot({ map: 'street', cell: [1, 2], facing: 'east' })).toBeNull()
    expect(parseSnapshot({ map: '../etc', cell: [1, 2], facing: 'east', preferences: { taskBookOpen: false } })).toBeNull()
    expect(parseSnapshot({ map: 'street', cell: [1, 2], facing: 'east', preferences: { taskBookOpen: 'yes' } })).toBeNull()
    // 只有格子形状不对时保留地图与偏好、丢弃格子：落点回该图出生格，不整份作废。
    expect(parseSnapshot({ map: 'street', cell: '1,2', facing: 'east', preferences: { taskBookOpen: false } })).toEqual({
      map: 'street', cell: null, facing: 'east', preferences: { taskBookOpen: false },
    })
    const good = parseSnapshot({ map: 'street', cell: [1, 2], facing: 'east', preferences: { taskBookOpen: true } })
    expect(good).toEqual({ map: 'street', cell: [1, 2], facing: 'east', preferences: { taskBookOpen: true } })
  })
})

describe('按用户隔离', () => {
  it('作用域由身份 key 派生，存储里不出现身份原文', () => {
    const scope = scopeOf('user:alice')
    expect(scope).toMatch(/^[0-9a-f]{8}$/)
    expect(scope).not.toContain('alice')
    expect(scopeOf('user:alice')).toBe(scope)
    expect(scopeOf('user:bob')).not.toBe(scope)
    expect(scopeOf('')).toBe('')
  })

  it('两个用户各存各的位置，互不覆盖', () => {
    const storage = new MemoryStorage()
    const store = new RecoveryStore(storage, known)
    const alice = scopeOf('user:alice'), bob = scopeOf('user:bob')
    store.save(alice, { map: 'office', cell: [34, 26], facing: 'south' }, { taskBookOpen: false })
    store.save(bob, { map: 'cafe', cell: [6, 11], facing: 'north' }, { taskBookOpen: true })
    expect(store.load(alice)).toEqual({ map: 'office', cell: [34, 26], facing: 'south', preferences: { taskBookOpen: false } })
    expect(store.load(bob)).toEqual({ map: 'cafe', cell: [6, 11], facing: 'north', preferences: { taskBookOpen: true } })
    expect(storage.dump).not.toContain('user:alice')
    expect(storage.dump).not.toContain('user:bob')
  })

  it('上次活跃作用域：记住后下次启动先按它恢复', () => {
    const storage = new MemoryStorage()
    const store = new RecoveryStore(storage, known)
    expect(store.lastScope()).toBe('')
    store.remember('abcd1234')
    expect(store.lastScope()).toBe('abcd1234')
    expect(storage.getItem(LAST_SCOPE_KEY)).toBe('abcd1234')
  })
})

describe('坏快照与不可用存储', () => {
  it('JSON 坏了、地图不认识、字段类型不对都按没有快照处理', () => {
    const storage = new MemoryStorage()
    const store = new RecoveryStore(storage, known)
    storage.setItem(STORAGE_PREFIX + 'aaaa0001', '{坏了')
    storage.setItem(STORAGE_PREFIX + 'aaaa0002', JSON.stringify({ map: 'moon', cell: [1, 1], facing: 'east', preferences: { taskBookOpen: false } }))
    storage.setItem(STORAGE_PREFIX + 'aaaa0003', JSON.stringify({ map: 'street', cell: [1, 1], facing: 'east', preferences: { taskBookOpen: 'yes' } }))
    expect(store.load('aaaa0001')).toBeNull()
    expect(store.load('aaaa0002')).toBeNull()
    expect(store.load('aaaa0003')).toBeNull()
    expect(store.load('')).toBeNull()
    expect(store.load('never-saved')).toBeNull()
  })

  it('存储不可用（隐私模式）时读写静默降级，不影响游戏', () => {
    const store = new RecoveryStore(null, known)
    expect(store.load('aaaa0001')).toBeNull()
    expect(store.lastScope()).toBe('')
    expect(() => store.save('aaaa0001', feet, { taskBookOpen: true })).not.toThrow()
    expect(() => store.remember('aaaa0001')).not.toThrow()
    expect(() => store.forget('aaaa0001')).not.toThrow()
  })

  it('写失败（配额满）不抛出', () => {
    const store = new RecoveryStore({
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => { throw new Error('QuotaExceededError') },
    }, known)
    expect(() => store.save('aaaa0001', feet, { taskBookOpen: false })).not.toThrow()
    expect(() => store.remember('aaaa0001')).not.toThrow()
    expect(() => store.forget('aaaa0001')).not.toThrow()
    expect(store.lastScope()).toBe('')
  })
})
