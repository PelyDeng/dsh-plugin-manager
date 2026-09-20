/**
 * JSON 列的纯解析函数：PostgreSQL 实现（postgres.ts）与 SQLite 测试双实现
 * （tests/helpers/sqlite-test-store.ts）共用同一份，行为逐字保持（damaged/unknown 分类
 * 语义不因换库改变）。
 *
 * 原则：输出是「能信的记录」或明确的分类结论，**不静默补造**，合法值也不被重算。
 * **有分类结论的那两个**（`parseInputRefs` / `parseDependsOnStrict`）不把损坏降级为空值——那会把
 * 「有材料但读不出来」伪装成「没有材料」；而 `parseArtifacts` / `parseDependsOn` 是**宽松**解析
 * （读不出来按空数组，历史行为）。两者的差别在各函数自己的注释里写明，别再把前者的话套到后者上。
 *
 * ⚠️ **入参一律是 `unknown`，不再是"落库的 TEXT"**：新库这几列是 **JSONB**，pg 驱动直接返回
 * 数组/对象而不是文本。老实现一律 `JSON.parse(raw)`，拿到对象会抛 ⇒ 三种各不相同、**静默或误导**
 * 的后果：`parseInputRefs` 判 `damaged`（编排层拒派，而数据其实没坏）· `parseArtifacts` 返回空数组
 * （"有材料"变"没材料"）· `parseMemberReturn` 返回 `undefined`（自检、外部待办、协作原文**全丢**）。
 *
 * 对齐说明：`parseDependsOnStrict` 给出的分类是编排层拒派的唯一依据；`damaged` 时记录侧的
 * `dependsOn` 取值走宽松的 {@link parseDependsOn}（能过滤出的字符串项照常给出），两条
 * 实现在这一点上保持一致。
 */

import type { AgentAction, AgentArtifact, AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
import { SUBTASK_STATES, type SubtaskState } from '../task-model.ts'
import type {
  ButlerAttachmentParsed,
  ButlerAttachmentUnit,
  ButlerDependsOnKind,
  ButlerInputRef,
  ButlerInputRefsKind,
  ButlerMemberReturn,
} from './types.ts'

/**
 * 校验外部待办声明。
 *
 * `undefined` 表示「没有声明」；对象但字段类型不对返回 `null`（非法）。不做修补：`null`、
 * 非字符串的 `reason`、非字符串的 `next` 都不能变成一份看起来合法的待办交给下游。
 */
function parsePending(value: unknown): { reason: string; next?: string } | null | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as { reason?: unknown; next?: unknown }
  if (typeof candidate.reason !== 'string') return null
  if (candidate.next !== undefined && typeof candidate.next !== 'string') return null
  return candidate.next === undefined ? { reason: candidate.reason } : { reason: candidate.reason, next: candidate.next }
}

/**
 * 校验位置型材料列表：必须是数组，且每一项都有字符串的标题、路径与种类。
 *
 * 非法返回 `null`。**不静默补成空数组** —— 那会把「有材料但读不出来」伪装成「没有材料」。
 */
function parseArtifactList(value: unknown): readonly AgentArtifact[] | null {
  if (!Array.isArray(value)) return null
  const items: AgentArtifact[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null
    const candidate = item as Partial<AgentArtifact>
    if (typeof candidate.title !== 'string' || typeof candidate.path !== 'string' || typeof candidate.kind !== 'string') return null
    items.push({ title: candidate.title, path: candidate.path, kind: candidate.kind })
  }
  return items
}

/**
 * 解析派单材料快照，并说清结论是「还没固定」「已固定」「旧已派出未知」还是「损坏」。
 *
 * 空串本身分不出来源：从没派过是「还没固定」，派出过却留空是旧记录的未知。所以调用方要把
 * 「这条记录确实没派出去过」这个事实传进来（`neverDispatched`）。
 *
 * 解析失败、形状或版本非法一律算**损坏**：既不降级为空数组（那会被当成「已核验无需材料」
 * 而放行派单），也不允许重算一份盖上去（那和这条记录已经发出去过的东西对不上）。逐层核验到
 * 嵌套字段（状态取值、每条材料的位置列表、外部待办）。
 */
export function parseInputRefs(
  raw: unknown,
  neverDispatched: boolean,
): { readonly kind: ButlerInputRefsKind; readonly inputRefs?: readonly ButlerInputRef[] } {
  // 空串与"什么都没写"是同一件事（列没落过值）；JSONB 的 `null` 也走这里。
  //
  // ⚠️ **空数组也是"什么都没写"**：新库这几列是 JSONB、默认值是 `'[]'::jsonb`（旧库是 TEXT、默认
  // 空串）。少了这一句，默认值会被下面判成 `fixed`（"已固定"）——而 `fixed` **不允许首次固定**，
  // 于是派单材料快照**永远固定不上**，且不报错（静默）。同理 `'{}'::jsonb` 对 `member_return`。
  if (raw === '' || raw === null || raw === undefined) return { kind: neverDispatched ? 'unfixed' : 'unknown' }
  if (Array.isArray(raw) && raw.length === 0) return { kind: neverDispatched ? 'unfixed' : 'unknown' }
  try {
    // ⚠️ **入参是 `unknown` 而不是 `string`**：新库的 `input_refs` / `artifacts` / `member_return` /
    // `verdict_evidence` / `observation` 是 **JSONB**，pg 驱动直接返回数组/对象、**不是文本**。
    // 老实现一律 `JSON.parse(raw)`：拿到对象会抛 ⇒ 这里判成 `damaged` ⇒ 编排层**拒派**——而数据
    // 其实完全正常。同类三处后果各不相同，切库前必须先改解析（见交接文档 §35 的切库静默面）：
    // 这一处是"响亮但语义错"，`parseArtifacts` 是"有材料变没材料"，`parseMemberReturn` 是
    // "自检/外部待办/协作原文全丢"。
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return { kind: 'damaged' }
    const items: ButlerInputRef[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return { kind: 'damaged' }
      const candidate = item as Partial<ButlerInputRef>
      if (typeof candidate.subtaskId !== 'string' || typeof candidate.logicalId !== 'string'
        || typeof candidate.state !== 'string' || typeof candidate.text !== 'string') return { kind: 'damaged' }
      if (!SUBTASK_STATES.includes(candidate.state as SubtaskState)) return { kind: 'damaged' }
      const artifacts = parseArtifactList(candidate.artifacts)
      if (artifacts === null) return { kind: 'damaged' }
      const pending = parsePending(candidate.externalPending)
      if (pending === null) return { kind: 'damaged' }
      items.push({
        subtaskId: candidate.subtaskId,
        logicalId: candidate.logicalId,
        state: candidate.state as SubtaskState,
        text: candidate.text,
        artifacts,
        ...(pending === undefined ? {} : { externalPending: pending }),
      })
    }
    return { kind: 'fixed', inputRefs: items }
  } catch {
    return { kind: 'damaged' }
  }
}

/** 解析协作返回留存；空串或非法形状按未知处理（`undefined`），不降级为「无材料」。 */
export function parseMemberReturn(raw: unknown): ButlerMemberReturn | undefined {
  if (raw === '' || raw === null || raw === undefined) return undefined
  try {
    // 入参放宽为 `unknown`：JSONB 列读回的是对象（见 `parseInputRefs` 上的说明）。
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as Partial<ButlerMemberReturn>
    if (candidate.protocol !== 1 || typeof candidate.text !== 'string') return undefined
    const pending = parsePending(candidate.externalPending)
    if (pending === null) return undefined
    const selfCheck = parseSelfCheck(candidate.selfCheck)
    const actions = parseActions(candidate.actions)
    if (actions === null) return undefined
    return {
      protocol: 1,
      text: candidate.text,
      ...(pending === undefined ? {} : { externalPending: pending }),
      ...(actions === undefined ? {} : { actions }),
      ...(selfCheck === undefined ? {} : { selfCheck }),
    }
  } catch {
    return undefined
  }
}

/** 一条待确认操作最多留几条：防止一条异常记录把留存撑成无界载荷。 */
const ACTION_LIMIT = 50

/**
 * 校验待确认操作（写入口是 `memberReturnOf`，读入口只有这一个）。
 *
 * ⚠️ **这一条是本批端到端验证抓出来的**：列是 JSONB，写入时带上了 `actions`，但读路径的校验
 * 白名单当时没有它 ⇒ `member_return->'actions'` 在库里躺着，页面拿到的却是空数组（"确认卡
 * 又不见了"，而这次不是没生成）。**加字段时读写两侧都要过一遍**，只改写入面等于没改。
 *
 * 口径与 `externalPending` 一致：缺字段 = 没有待办（`undefined`）；形状非法（不是数组、
 * 条数超限、某条缺必需字段、`state` 不在已知集合里）= `null`，由调用方按"这份留存损坏"处理
 * ——不逐条静默丢弃：那会让"少了一条待办"永远没人发现。
 */
function parseActions(value: unknown): ButlerMemberReturn['actions'] | null | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > ACTION_LIMIT) return null
  const states = new Set(['prepared', 'executing', 'succeeded', 'failed', 'cancelled', 'expired'])
  const actions: AgentAction[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const action = item as Partial<AgentAction>
    if (typeof action.id !== 'string' || action.id === '') return null
    if (typeof action.kind !== 'string' || action.kind === '') return null
    if (typeof action.title !== 'string' || typeof action.summary !== 'string') return null
    if (typeof action.state !== 'string' || !states.has(action.state)) return null
    if (action.detail !== undefined && typeof action.detail !== 'string') return null
    if (action.fields !== undefined) {
      if (!Array.isArray(action.fields)) return null
      for (const field of action.fields) {
        if (typeof field !== 'object' || field === null) return null
        const pair = field as { label?: unknown; value?: unknown }
        if (typeof pair.label !== 'string' || typeof pair.value !== 'string') return null
      }
    }
    actions.push(action as AgentAction)
  }
  return actions
}

/**
 * 解析自检结论。
 *
 * 四种合法取值之外的一切（缺字段、拼错的状态名、不是对象）都返回 `undefined`——它表示
 * **「这一轮没有自检结论」**，而不是任何一档结论。**绝不降级成 `passed`**：那会把一次没人
 * 核验过的交付显示成已核验，正是这条判据要防的事。
 *
 * ⚠️ `absent` 必须留在白名单里：运行时把内部四态透出边界时写的就是它（执行方没有自检能力）。
 * 漏掉它，这个区分会在**落库这一刻**退化成"没有自检结论"——上游改了、下游没接，正是本仓
 * 反复出现的"中间的线没接"。
 */
function parseSelfCheck(value: unknown): AgentSelfCheck | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { status?: unknown; detail?: unknown }
  if (candidate.status !== 'passed' && candidate.status !== 'unverifiable'
    && candidate.status !== 'failed' && candidate.status !== 'absent') return undefined
  return {
    status: candidate.status,
    ...(typeof candidate.detail === 'string' && candidate.detail !== '' ? { detail: candidate.detail } : {}),
  }
}

/**
 * 宽松解析材料列表：**读不出来就按空数组**。
 *
 * ⚠️ 与 {@link parseInputRefs} / {@link parseDependsOnStrict} 的"损坏即分类"不同——这是**历史
 * 行为**（调用方按"可能为空"用），文件头那句"损坏不降级为空值"只对那两个**有分类结论**的函数
 * 成立。真正的强校验在 `parseInputRefs`（它逐层核验到每条材料的形状与状态取值）。
 */
export function parseArtifacts(raw: unknown): readonly AgentArtifact[] {
  if (raw === '' || raw === null || raw === undefined) return []
  try {
    // 入参放宽为 `unknown`：JSONB 列读回的是数组（见 `parseInputRefs` 上的说明）。
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is AgentArtifact => {
      if (typeof item !== 'object' || item === null) return false
      const candidate = item as Partial<AgentArtifact>
      return typeof candidate.title === 'string' && typeof candidate.path === 'string' && typeof candidate.kind === 'string'
    })
  } catch {
    return []
  }
}

/**
 * 解析落库的前置目标标识。
 *
 * 与材料引用同理：一条脏记录不该让整个任务详情读不出来，解析失败按「没有前置」处理。
 */
export function parseDependsOn(raw: unknown): readonly string[] {
  if (raw === '' || raw === null || raw === undefined) return []
  try {
    // 入参放宽为 `unknown`：JSONB 列读回的是数组（见 `parseInputRefs` 上的说明）。
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/**
 * 严格解析落库的前置目标标识，并给出分类结论（依赖重判方案 §3 条目 4：损坏即拒）。
 *
 * 与 {@link parseDependsOn} 的「脏数据静默降级为无前置」不同：解析失败、不是数组、或混入
 * 非字符串项一律归为 `damaged`。`damaged` 时 `items` 为空数组，编排层读到该分类必须拒派
 * （拒派语义由编排层消费，存储层只暴露分类）；原值保持原样留存，不做修补。
 */
export function parseDependsOnStrict(raw: unknown): { readonly kind: ButlerDependsOnKind; readonly items: readonly string[] } {
  if (raw === '' || raw === null || raw === undefined) return { kind: 'valid', items: [] }
  try {
    // 入参放宽为 `unknown`：JSONB 列读回的是数组（见 `parseInputRefs` 上的说明）。
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(parsed)) return { kind: 'damaged', items: [] }
    if (!parsed.every((item): item is string => typeof item === 'string')) return { kind: 'damaged', items: [] }
    return { kind: 'valid', items: parsed }
  } catch {
    return { kind: 'damaged', items: [] }
  }
}

/**
 * 解析附件的解析结果（`butler_attachments.parsed`）。
 *
 * **读不出来就给 `undefined`**（宽松），与 {@link parseArtifacts} 同一档：这一列是辅助信息——
 * 有它页面能显示"共 12 段"，派单简报能少一次重解析；没有它，附件本身照样能下载、能转交，
 * 只是要重新解析一遍。为一条读不出的 JSON 让整个附件列表报错，代价明显更大。
 *
 * 逐项核验而不是整体 `as`：`units` 是要逐字进提示词的东西，混进非字符串项会在下游变成
 * `[object Object]`。
 */
export function parseAttachmentParsed(raw: unknown): ButlerAttachmentParsed | undefined {
  if (raw === '' || raw === null || raw === undefined) return undefined
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const candidate = parsed as Partial<ButlerAttachmentParsed>
    if (typeof candidate.unit !== 'string') return undefined
    if (typeof candidate.totalUnits !== 'number' || !Number.isSafeInteger(candidate.totalUnits)) return undefined
    if (typeof candidate.characters !== 'number' || !Number.isSafeInteger(candidate.characters)) return undefined
    if (!Array.isArray(candidate.units)) return undefined
    const units: ButlerAttachmentUnit[] = []
    for (const item of candidate.units) {
      if (typeof item !== 'object' || item === null) return undefined
      const unit = item as Partial<ButlerAttachmentUnit>
      if (typeof unit.number !== 'number' || !Number.isSafeInteger(unit.number) || typeof unit.text !== 'string') return undefined
      units.push({ number: unit.number, text: unit.text })
    }
    return {
      kind: typeof candidate.kind === 'string' ? candidate.kind : '',
      unit: candidate.unit,
      totalUnits: candidate.totalUnits,
      characters: candidate.characters,
      partial: candidate.partial === true,
      units,
    }
  } catch {
    return undefined
  }
}
