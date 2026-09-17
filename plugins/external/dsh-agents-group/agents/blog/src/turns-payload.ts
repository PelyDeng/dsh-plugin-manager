/**
 * blog 在 `dsh_turns.payload` / `dsh_turn_results.payload` 里放什么。
 *
 * 索引库切 PG 之后，blog 的三张索引表映射到运行时的**框架级**表（`dsh_turns` /
 * `dsh_turn_results`），而那些表的列是**机制列**（id / agent_id / owner_* / request_id /
 * input_hash / status / created_at / turn_id / operation_id / seq）。blog 自己的业务字段没有列
 * ——它们进 **`payload`（JSONB）**。设计把它当"业务载荷位"是**设计意图**，不是妥协。
 *
 * ## ⚠️ 本文件存在的第一个理由：**状态取值域冲突**
 *
 * `dsh_turns.status` 在运行时里的取值是 **`claimed` / `finished`**（`TurnStorePort.claim` 的契约，
 * 已被真 PG 契约测试固化）。而 blog 需要 **`queued` / `running` / `stopping` / `interrupted` /
 * `succeeded` / `failed`**（它自己的回合业务状态，`chat-store.ts` 与 `chat.ts` 都在读写）。
 *
 * ⇒ **业务状态只能放 `payload.status`**。写进 `dsh_turns.status` 会与运行时的幂等状态机**互相覆盖**
 * （`claim` 写 `claimed`、`finish` 写 `finished`，blog 的业务状态会被抹掉；反过来也会把运行时的
 * 幂等状态改坏）。读取时**一律从 payload 取**业务状态。
 *
 * ## 第二个理由：JSONB 读回的是**对象**，不是字符串
 *
 * 旧实现里这些字段是 TEXT（`JSON.parse(raw)`）。新库是 JSONB ⇒ pg 驱动返回**对象/数组**。
 * 解码函数因此**同时接受**字符串与已解析值（与 P7 给 `parse.ts` 做的那次放宽同一理由：
 * `JSON.parse({})` 会抛 ⇒ 静默退化成空值）。**不要**在写入侧再 `JSON.stringify` 一次去迁就旧假设。
 *
 * ## schema（逐字段）
 *
 * | 字段 | 类型 | 谁写 | 说明 |
 * | --- | --- | --- | --- |
 * | `status` | {@link BlogTurnStatus} | `start`（`queued`）/ `updateRequest` / `finish` | **业务**状态，见上 |
 * | `input` | 对象 | `start` | 这一轮的问题与附件（`digest` 算 `input_hash` 用的就是它 + conversationId） |
 * | `operationId` | string | `start` | 业务操作标识（未给时生成） |
 * | `draftId` | string \| null | `updateRequest` | 这一轮落到哪份草稿 |
 * | `sources` | 数组 | `updateRequest` | 检索来源快照 |
 * | `attachments` | 数组 | `start` / `updateRequest` | 这一轮携带的资料引用 |
 * | `userSeq` | number \| null | `start` | 用户消息序号（重试定位用） |
 * | `message` | string \| null | `updateRequest` | 给用户看的说明（失败/中断原因） |
 * | `updatedAt` | number | `updateRequest` | 最后一次业务更新时刻（旧实现写的是 `updatedAt`） |
 * | 其余键 | unknown | 业务 | **保留**：`updateRequest` 的 patch 形状是开放的，未知字段要原样带回去 |
 *
 * 结果侧（`dsh_turn_results.payload`）：`kind`（`candidate` 等）/ `draftId` / `revision` /
 * `title` / `proposal` / `createdAt`——即旧 `chat_results.data` 的整份内容（`seq` 由库生成，**不写**）。
 */

/** blog 自己的回合**业务**状态（与 `dsh_turns.status` 的 `claimed`/`finished` 是**两个域**）。 */
export type BlogTurnStatus = 'queued' | 'running' | 'stopping' | 'interrupted' | 'succeeded' | 'failed'

/** 一条回合请求的业务载荷（旧 `chat_requests.data` 里除机制列以外的部分）。 */
export interface BlogTurnPayload {
  readonly status: BlogTurnStatus
  readonly input: Record<string, unknown>
  readonly operationId: string
  readonly draftId: string | null
  readonly sources: readonly unknown[]
  readonly attachments: readonly BlogAttachmentRefLike[]
  readonly userSeq: number | null
  readonly message?: string | null
  readonly updatedAt?: number
  /** `updateRequest` 的 patch 形状是开放的 ⇒ 未知字段原样保留。 */
  readonly [key: string]: unknown
}

/** 结构上与 `chat-store.ts` 的 `ChatAttachmentRef` 同形；这里不复用是为了让本文件零依赖。 */
export interface BlogAttachmentRefLike {
  readonly requestId: string
  readonly id: string
}

/** 一条回合结果的业务载荷（旧 `chat_results.data` 的整份内容）。 */
export interface BlogTurnResultPayload {
  readonly kind: string
  readonly draftId: string
  readonly revision: unknown
  readonly title: string
  readonly proposal?: unknown
  readonly createdAt: number
  readonly [key: string]: unknown
}

/** 合法业务状态；用于解码时的收窄（**不猜**：不在表里的值原样保留在 `rawStatus` 里，见下）。 */
const STATUSES: readonly BlogTurnStatus[] = ['queued', 'running', 'stopping', 'interrupted', 'succeeded', 'failed']

/**
 * 把任意读回值解成对象。
 *
 * 三种输入都要接受：**已解析的对象/数组**（新库 JSONB 的读回形态）、**JSON 文本**（旧库 TEXT 的
 * 形态、以及我们自己写进去的字符串）、以及空值（`''`/`null`/`undefined` ⇒ 空对象）。
 * 非法 JSON / 不是对象的值 ⇒ 返回 `undefined`（"读不出来"），**不降级成空对象**——那会让
 * "没落过值"与"值坏了"混为一谈。
 */
export function decodeJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === '' || raw === null || raw === undefined) return undefined
  if (typeof raw === 'object') {
    // 数组也是 object，但它不是我们要的形状 ⇒ 交给调用方按 undefined 处理。
    return Array.isArray(raw) ? undefined : (raw as Record<string, unknown>)
  }
  if (typeof raw !== 'string') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch { return undefined }
}

/**
 * 解一条回合请求的业务载荷。
 *
 * **必填字段缺失时的取向**：`status` 不在取值域里（缺省、拼错、`dsh_turns.status` 的
 * `claimed`/`finished` 被误写进来）⇒ 收窄成 `'queued'` 并**把原值留在 `rawStatus` 里**。
 * 这是刻意的：回合层的"读不出来"会让调用方连这一轮的存在都看不见，比"状态不准"更糟；
 * 而保留 `rawStatus` 让排查者能看出上游写错了什么（不是静默吞掉）。
 */
export function decodeTurnPayload(raw: unknown): BlogTurnPayload | undefined {
  const value = decodeJsonObject(raw)
  if (value === undefined) return undefined
  const candidate = value.status
  const status: BlogTurnStatus = STATUSES.includes(candidate as BlogTurnStatus) ? candidate as BlogTurnStatus : 'queued'
  return {
    ...value,
    status,
    ...(status === candidate ? {} : { rawStatus: candidate }),
    input: isObject(value.input) ? value.input : {},
    operationId: typeof value.operationId === 'string' ? value.operationId : '',
    draftId: typeof value.draftId === 'string' ? value.draftId : null,
    sources: Array.isArray(value.sources) ? value.sources : [],
    attachments: Array.isArray(value.attachments) ? value.attachments as readonly BlogAttachmentRefLike[] : [],
    userSeq: typeof value.userSeq === 'number' ? value.userSeq : null,
  }
}

/** 编码一条回合请求的业务载荷（写进 `dsh_turns.payload`）。保持**全量**：未知字段原样带上。 */
export function encodeTurnPayload(payload: BlogTurnPayload): Record<string, unknown> {
  const { status, input, operationId, draftId, sources, attachments, userSeq, ...rest } = payload
  return { ...rest, status, input, operationId, draftId, sources, attachments, userSeq }
}

/** 解一条回合结果的业务载荷。`kind` 缺失时返回 `undefined`（结果没有种类就等于读不出来）。 */
export function decodeTurnResultPayload(raw: unknown): BlogTurnResultPayload | undefined {
  const value = decodeJsonObject(raw)
  if (value === undefined) return undefined
  if (typeof value.kind !== 'string' || value.kind === '') return undefined
  return {
    ...value,
    kind: value.kind,
    draftId: typeof value.draftId === 'string' ? value.draftId : '',
    revision: value.revision ?? null,
    title: typeof value.title === 'string' ? value.title : '',
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
  }
}

/** 编码一条回合结果的业务载荷。 */
export function encodeTurnResultPayload(payload: BlogTurnResultPayload): Record<string, unknown> {
  const { kind, draftId, revision, title, proposal, createdAt, ...rest } = payload
  return { ...rest, kind, draftId, revision, title, ...(proposal === undefined ? {} : { proposal }), createdAt }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
