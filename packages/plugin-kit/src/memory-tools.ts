/**
 * 记忆工具工厂（P1.5 上收：`defineMemoryTools`，v2.6 设计 §4.4/§6.3）。
 *
 * 纪律：
 * - **参数 schema 不得包含 owner / agent_id / source**（安全红线）：owner 由调用方
 *   传入的 `getActor()` 服务端闭包推导，agentId 在 store 构造期绑定，source 恒 'tool'。
 * - **kind 只允许 semantic / episodic**：instruction 禁写（模型不能给自己下指令）；
 *   禁写同时落在工具参数校验（此处）与 DB 复合 CHECK 两层；变异验证进验收。
 * - **memory_forget 不直接删**：登记待删、经页面确认卡（HTTP 层鉴权 actor 发起）才真删。
 * - **kind/userLabel 参数化**：description 与提示话术里的用户称谓随 agent 配置。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { AccessError, type Actor } from './access.ts'
import { MemoryStore, MEMORY_CONTENT_LIMIT, type MemoryKind, type MemoryOrigin, type MemoryRecord } from './memory.ts'

/** 待删除确认有效期（毫秒）：过期后确认卡点击按「已过期」处理。 */
export const MEMORY_FORGET_TTL_MS = 10 * 60 * 1000

export interface PendingForget {
  readonly memoryId: string
  readonly shortId: string
  readonly content: string
  readonly createdAt: number
}

export interface PendingForgetIndex {
  readonly set: (sessionId: string, pending: PendingForget) => void
  readonly take: (sessionId: string, memoryId: string) => PendingForget | undefined
}

export interface MemoryToolsDeps {
  readonly store: MemoryStore
  /** 会话 actor 推导（服务端闭包，不从模型参数读——§4.4 红线）。 */
  readonly getActor: () => Actor
  readonly pendingForgets: PendingForgetIndex
  readonly sessionId: string
  /** 用户称谓（工具话术与错误文案用；「老大」为 butler 缺省）。 */
  readonly userLabel?: string | undefined
  readonly now?: () => number
}

export function makeMemoryTools(deps: MemoryToolsDeps) {
  const now = deps.now ?? Date.now
  const userLabel = deps.userLabel ?? '老大'

  const writeTool = defineTool({
    name: 'memory_write',
    description: [
      `把一条跨会话仍然成立、以后会影响答复的事记成长期记忆：${userLabel}的长期偏好、项目的稳定事实、重要决定。`,
      '不记：本次任务的过程与结果（那是任务账本的事）；对话原文；办完就作废的一次性安排；替用户总结的性格习惯（除非用户明说）。',
      '转述来的内容（网页、资料、工具结果）origin 必须填 reference，并且 sourceRef 带上出处，回复里要说明「从资料里记了一条：…」；用户亲口说的才填 user_statement。',
      '拿不准就不记：漏记的代价低（后面还能补），记错的代价高（每轮都在误导你）。',
      '与任务派发工具的分工：本次要做的事用派发工具；「以后都…」「记住…」这类跨会话偏好才用本工具——两者同轮可并存。',
    ].join(''),
    parameters: {
      kind: { type: 'string', required: true, description: '记忆大类：semantic（偏好与稳定事实，如「发布默认不配图」）或 episodic（事件与决策结论，如「发布卡在确认，用户说以后直接走草稿」）。' },
      content: { type: 'string', required: true, description: `一句独立、自包含的陈述，≤${MEMORY_CONTENT_LIMIT} 字，不抄原文、不带换行。超长就拆成多条分别记。` },
      origin: { type: 'string', required: true, description: '信息来源：user_statement（用户亲口说的）或 reference（转述自网页/资料/工具结果）。' },
      sourceRef: { type: 'string', description: 'origin=reference 时必填：出处（会话 id、任务 id 或地址）。' },
      importance: { type: 'string', description: '重要性 1-5：5=用户反复强调的核心偏好，3=一般事实（默认），1=可有可无。' },
      supersedes: { type: 'string', description: '要替换的旧记忆编号（如 M3）：用户纠正了之前记的内容时填它——旧条目会被这条替换。回复里要说破改了什么。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shortId: { type: 'string' },
          duplicated: { type: 'boolean', required: true },
          superseded: { type: 'boolean', required: true },
          kind: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const kind = String(args.kind ?? '') as MemoryKind
      if (kind !== 'semantic' && kind !== 'episodic') {
        // 变异验证锚点（设计 §6.2 步骤 7）：临时删除本行，测试必须变红。
        throw new Error(`kind 只能是 semantic 或 episodic；「${kind || '（空）'}」不是有效的记忆大类。用户手写的行为指令不归你管。`)
      }
      const origin = String(args.origin ?? '') as MemoryOrigin
      if (origin !== 'user_statement' && origin !== 'reference') {
        throw new Error('origin 必须是 user_statement（用户原话）或 reference（转述资料）')
      }
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (content.length < 4) throw new Error('记忆内容太短（至少 4 字）：一句能独立成立的话')
      if (content.length > MEMORY_CONTENT_LIMIT) {
        throw new Error(`记忆内容 ${content.length} 字，超过 ${MEMORY_CONTENT_LIMIT} 字上限——请浓缩成一句，或拆成多条分别记`)
      }
      const importanceRaw = Number.parseInt(String(args.importance ?? ''), 10)
      const importance = Number.isSafeInteger(importanceRaw) && importanceRaw >= 1 && importanceRaw <= 5 ? importanceRaw : undefined
      const supersedes = typeof args.supersedes === 'string' && args.supersedes.trim() !== '' ? args.supersedes.trim() : undefined
      const sourceRef = typeof args.sourceRef === 'string' ? args.sourceRef.trim() : undefined

      const record = await deps.store.write(deps.getActor(), {
        kind,
        content,
        origin,
        importance,
        sourceRef,
        supersedesShortId: supersedes,
        source: 'tool',
      })
      const label = kind === 'semantic' ? '偏好' : '事件'
      const note = record === undefined
        ? '这条内容此前已经记下，没有重复写入。'
        : supersedes !== undefined
          ? `已更新之前的${label}（原条目已替换，编号 ${record.shortId}）。`
          : `已记住（${label}，编号 ${record.shortId}）。`
      return { shortId: record?.shortId ?? '', duplicated: record === undefined, superseded: supersedes !== undefined, kind, note }
    },
  })

  const forgetTool = defineTool({
    name: 'memory_forget',
    description: [
      `让一条长期记忆作废。只在两种情况用：${userLabel}明确要求忘掉某条；你发现某条记忆明显过期或错误且无法用 memory_write 的 supersedes 修正。`,
      '必须引用注入清单里的稳定编号（如 M3）；「忘掉那个」这类模糊指代要先向用户确认是哪一条。',
      '用户手写的要求（I 编号）不归你删——请用户到设置页修改。',
      '提交后需要用户在确认卡上点头才真正删除；确认卡过期未确认则不会删。',
    ].join(''),
    parameters: {
      shortId: { type: 'string', required: true, description: '要作废的记忆编号（注入清单里的 M3、M7 式稳定 id）。' },
      reason: { type: 'string', description: '为什么这条要作废（会展示给用户，帮他判断对不对）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pending: { type: 'boolean', required: true },
          shortId: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const shortId = String(args.shortId ?? '').trim()
      if (!/^[MI][0-9]+$/.test(shortId)) {
        throw new Error(`编号格式不对（${shortId || '（空）'}）：应为注入清单里的 M3、I2 式稳定 id`)
      }
      if (shortId.startsWith('I')) {
        throw new Error(`${shortId} 是${userLabel}手写的要求，不归你删——请他到设置页「${userLabel}的要求」里修改`)
      }
      const actor = deps.getActor()
      const all = await deps.store.list(actor, {})
      const target = all.find(record => record.shortId === shortId)
      if (target === undefined) {
        throw new Error(`没有找到 ${shortId} 这条记忆（可能已删除，或不在本次注入清单里）`)
      }
      deps.pendingForgets.set(deps.sessionId, {
        memoryId: target.id,
        shortId,
        content: target.content,
        createdAt: now(),
      })
      return {
        pending: true,
        shortId,
        note: `已发起删除确认：${shortId}「${target.content}」。等用户在确认卡上点头后才会真正删除。`,
      }
    },
  })

  return { writeTool, forgetTool }
}

/** 确认卡消费：HTTP 层在鉴权 actor 下调用——真删 + 审计。 */
export async function confirmForget(
  deps: Pick<MemoryToolsDeps, 'store' | 'getActor' | 'sessionId' | 'pendingForgets'> & {
    readonly memoryId: string
    readonly now?: () => number
  },
): Promise<{ deleted: boolean; shortId: string; reason: string }> {
  const now = deps.now ?? Date.now
  const pendingItem = deps.pendingForgets.take(deps.sessionId, deps.memoryId)
  if (pendingItem === undefined) {
    return { deleted: false, shortId: '', reason: '没有这条待删除确认（可能已被处理或会话已重启）' }
  }
  if (now() - pendingItem.createdAt > MEMORY_FORGET_TTL_MS) {
    return { deleted: false, shortId: pendingItem.shortId, reason: '确认已过期（10 分钟），如仍要删除请重新发起' }
  }
  const actor = deps.getActor()
  const record = await deps.store.forgetByShortId(actor, pendingItem.shortId)
  return record === undefined
    ? { deleted: false, shortId: pendingItem.shortId, reason: '该记忆已不存在' }
    : { deleted: true, shortId: record.shortId, reason: '' }
}

// AccessError 为工具/存储层业务拒绝的标准形态（导出转引保持 kit 单一来源）。
export { AccessError }
export type { MemoryRecord }
