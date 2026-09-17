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

import type { AgentArtifact, AgentSelfCheck } from '@dsh-plugin-manager/plugin-kit'
import { SUBTASK_STATES, type SubtaskState } from '../task-model.ts'
import type { ButlerDependsOnKind, ButlerInputRef, ButlerInputRefsKind, ButlerMemberReturn } from './types.ts'

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
  if (raw === '' || raw === null || raw === undefined) return { kind: neverDispatched ? 'unfixed' : 'unknown' }
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
    return {
      protocol: 1,
      text: candidate.text,
      ...(pending === undefined ? {} : { externalPending: pending }),
      ...(selfCheck === undefined ? {} : { selfCheck }),
    }
  } catch {
    return undefined
  }
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
