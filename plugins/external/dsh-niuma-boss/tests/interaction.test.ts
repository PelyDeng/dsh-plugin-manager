import { describe, expect, it } from 'vitest'
import {
  INTERACT_RADIUS_TILES, WALK_AWAY_TILES, dialogueStillInReach, npcDialogue, pickNpcAutoBubble, promptIdOf, resolvePrompt, staffNameplate,
  type InteractionState, type NearTarget,
} from '../src/interaction.ts'
import { rendezvousCell, seatOrigin, seatPosition } from '../src/world-runtime.ts'

/**
 * 就近交互与对白（interaction_rules.yaml / npc_rules.yaml）：全序优先级下只留一个提示；
 * 普通 NPC 打开作者预写对白且没有自由输入，业务员工只给名牌与权威状态。
 * 这里同时守住职责隔离：本模块没有任何模型或业务工具通路。
 */

const idle: InteractionState = { staffReplyPending: false, taskActive: false, stopping: false, inputOpen: false }
const target = (overrides: Partial<NearTarget> = {}): NearTarget =>
  ({ id: 'npc_hr', label: '沈禾', kind: 'npc', distanceTiles: 1, dialogueMode: 'authored_lines', ...overrides })

describe('就近提示的唯一性与优先级', () => {
  it('超过交互半径的对象不产生提示', () => {
    expect(resolvePrompt([target({ distanceTiles: INTERACT_RADIUS_TILES + 0.01 })], idle)).toBeNull()
    expect(resolvePrompt([target({ distanceTiles: INTERACT_RADIUS_TILES })], idle)?.id).toBe('npc_talk_hint')
  })

  it('老板同时站在牛马大总管和普通 NPC 旁边：牛马大总管的提示赢（conflicts 里写明）', () => {
    const prompt = resolvePrompt([
      target({ id: 'npc_hr', kind: 'npc', distanceTiles: 0.5 }),
      target({ id: 'butler', label: '牛马大总管', kind: 'butler', distanceTiles: 1.4, dialogueMode: undefined }),
    ], idle)
    expect(prompt).toMatchObject({ id: 'butler_idle_hint', label: '派活', kind: 'butler', action: 'open_task_book' })
  })

  it('有员工在等回话时牛马大总管提示变成「回答员工的问题」，收尾中只提示不开入口', () => {
    const near = [target({ id: 'butler', kind: 'butler', dialogueMode: undefined })]
    expect(resolvePrompt(near, { ...idle, staffReplyPending: true })?.id).toBe('butler_reply_hint')
    expect(resolvePrompt(near, { ...idle, staffReplyPending: true, stopping: true })?.action).toBe('hint_only')
    expect(resolvePrompt(near, { ...idle, taskActive: true })?.id).toBe('supplement_hint')
    // 正在收尾时不给派活入口，只提示（butler_busy_hint 只提示，不提供入口）。
    expect(resolvePrompt(near, { ...idle, taskActive: true, stopping: true })?.id).toBe('butler_busy_hint')
  })

  it('业务员工只给名牌与真实状态：没有搭话入口（首版无独立通道）', () => {
    const prompt = resolvePrompt([target({ id: 'blog', label: '博客', kind: 'staff', dialogueMode: undefined })], idle)
    expect(prompt).toMatchObject({ id: 'staff_busy_nametag', label: '看名牌·博客', action: 'staff_nameplate' })
    expect(prompt?.action).not.toBe('open_task_book')
  })

  it('普通 NPC 按作者声明的对白通道分流：预写对白给交谈，其余只给名牌', () => {
    expect(promptIdOf(target(), idle)).toBe('npc_talk_hint')
    expect(promptIdOf(target({ dialogueMode: 'unavailable' }), idle)).toBe('npc_status_hint')
  })

  it('任务本或对白开着时不出现就近提示（requires.input_open: false）', () => {
    const near = [target({ distanceTiles: 0.5 })]
    expect(resolvePrompt(near, { ...idle, inputOpen: true })).toBeNull()
    expect(resolvePrompt(near, idle)?.id).toBe('npc_talk_hint')
  })

  it('同类多个对象按距离与稳定 id 排序，只返回一个提示', () => {
    const prompt = resolvePrompt([
      target({ id: 'npc_admin', label: '陆小周', distanceTiles: 1.2 }),
      target({ id: 'npc_hr', label: '沈禾', distanceTiles: 0.4 }),
    ], idle)
    expect(prompt?.target).toBe('npc_hr')
    expect(resolvePrompt([
      target({ id: 'npc_b', distanceTiles: 0.8 }),
      target({ id: 'npc_a', distanceTiles: 0.8 }),
    ], idle)?.target).toBe('npc_a')
  })
})

describe('对白与名牌的呈现（没有自由输入）', () => {
  it('普通 NPC 播放作者预写台词，明确不是模型回答，也不给输入框', () => {
    const view = npcDialogue({
      id: 'npc_hr', label: '沈禾',
      dialogue: { mode: 'authored_lines', name: '沈禾', role: '人事', lines: ['这页先留白，你说完我再记。', '真正要办的工作交给牛马大总管。'] },
    })
    expect(view).toMatchObject({ kind: 'npc', title: '沈禾', role: '人事', mode: 'authored_lines', inputAllowed: false })
    expect(view.lines).toHaveLength(2)
    expect(view.detail).toContain('不是模型回答')
  })

  it('没有对白通道的角色（设计示例）只给名牌与职责，不回退到员工通道', () => {
    const view = npcDialogue({ id: 'sample_explorer', label: '探险NPC示例', dialogue: { mode: 'unavailable', name: '探险NPC示例', role: '', lines: [] } })
    expect(view.mode).toBe('unavailable')
    expect(view.lines).toEqual([])
    expect(view.detail).toContain('没有可用的对白通道')
  })

  it('员工名牌只有名字与权威状态，并说明工作只经牛马大总管', () => {
    const view = staffNameplate({ id: 'blog', label: '博客' }, '进行中 · 开工')
    expect(view).toMatchObject({ kind: 'staff', mode: 'staff', stateLabel: '进行中 · 开工', inputAllowed: false })
    expect(view.detail).toContain('经牛马大总管')
    expect(view.lines).toEqual([])
  })
})

describe('作者锚点解析（map_rules.yaml#anchors）', () => {
  it('座姿精灵左上角 = 接触点 − 逐帧接触锚点，origin 用接触锚点', () => {
    const frame = { size: [32, 48] as [number, number], seat: [16, 39] as [number, number] }
    expect(seatPosition([176, 402], frame)).toEqual({ x: 160, y: 363 })
    expect(seatOrigin(frame)).toEqual({ x: 16 / 32, y: 39 / 48 })
    expect(seatOrigin({ size: [32, 48] })).toBeNull()
    expect(seatPosition([1, 2], { seat: undefined })).toBeNull()
  })

  it('会合点从语义目标向外取最近可站立格，永不选中目标脚下那一格', () => {
    const walkable = (cell: [number, number]) => cell[0] >= 0 && cell[1] >= 0 && !(cell[0] === 5 && cell[1] === 4)
    // 目标脚下的格子被占：取最近的相邻可站立格（距离相同按 y 小、x 小优先）。
    expect(rendezvousCell([[5, 4]], walkable)).toEqual([5, 3])
    // 到达半径按**欧氏距离 ≤ 1.5**（balance_params.yaml#interaction.arrival_radius_tiles）：
    // 斜邻 1.414 仍在半径内，隔两格的 2.0 不算，宁可返回 null 也不让员工站到半径外。
    const onlyDiagonal = (cell: [number, number]) => Math.abs(cell[0] - 5) === 1 && Math.abs(cell[1] - 4) === 1
    expect(rendezvousCell([[5, 4]], onlyDiagonal)).toEqual([4, 3])
    const onlyFar = (cell: [number, number]) => Math.hypot(cell[0] - 5, cell[1] - 4) >= 2 && cell[0] >= 0 && cell[1] >= 0
    expect(rendezvousCell([[5, 4]], onlyFar)).toBeNull()
    // 槽位已占用的格不再分配第二个人：`isFree` 表示「这一格此刻可用」。
    const isFree = (cell: [number, number]) => !(cell[0] === 5 && cell[1] === 3)
    expect(rendezvousCell([[5, 4]], walkable, isFree)).toEqual([4, 4])
  })

  it('就近会话到走远/换图/离场为止：大于 walk_away_tiles 才关（比交互半径宽，提示不闪）', () => {
    const near = [target({ distanceTiles: INTERACT_RADIUS_TILES + 0.1 })]
    // 已经走出交互半径但还没走远：会话留着（否则提示会反复闪）。
    expect(dialogueStillInReach(near, 'npc_hr', false)).toBe(true)
    expect(dialogueStillInReach([target({ distanceTiles: WALK_AWAY_TILES })], 'npc_hr', false)).toBe(true)
    expect(dialogueStillInReach([target({ distanceTiles: WALK_AWAY_TILES + 0.1 })], 'npc_hr', false)).toBe(false)
    // 换图与角色离场（不在本图近邻事实里）都算会话结束。
    expect(dialogueStillInReach([target({ distanceTiles: 0.5 })], 'npc_hr', true)).toBe(false)
    expect(dialogueStillInReach([target({ id: 'npc_admin' })], 'npc_hr', false)).toBe(false)
  })
})

describe('NPC 自动台词气泡选取（F4）', () => {
  const base = { distanceTiles: 1, dialogueMode: 'authored_lines' as const, authoredLines: ['台词一', '台词二'] }
  const npc = (overrides: Record<string, unknown> = {}) => ({
    id: 'npc_x', label: '谷雨', kind: 'npc' as const, ...base, ...overrides,
  } as Parameters<typeof pickNpcAutoBubble>[0][number])

  it('半径内取最近的预写台词 NPC,气泡=第一句+剩余句数', () => {
    const near = [npc({ distanceTiles: 0.8 }), { ...npc({ id: 'npc_far', distanceTiles: 1.4 }) }]
    const picked = pickNpcAutoBubble(near, 1.5, false)
    expect(picked).toMatchObject({ id: 'npc_x', line: '台词一', more: 1 })
  })
  it('半径外一律不选', () => {
    expect(pickNpcAutoBubble([npc({ distanceTiles: 1.6 })], 1.5, false)).toBeNull()
  })
  it('任一弹层打开时返回 null(轮1 P1:弹层优先避免叠字)', () => {
    const near = [npc()]
    expect(pickNpcAutoBubble(near, 1.5, true)).toBeNull()
  })
  it('非 npc 或无台词的对象不参与选取', () => {
    const staff = { ...npc({ id: 'blog', kind: 'staff' as const }), authoredLines: undefined }
    expect(pickNpcAutoBubble([staff], 1.5, false)).toBeNull()
  })
})
