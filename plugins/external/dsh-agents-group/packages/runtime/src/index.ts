/**
 * 牛马生态的 Agent 运行时。
 *
 * 机制在这里实现一次：会话生命周期、事件投影、协作入口、提示词与工具装配都由本包代管，
 * 业务子包只提供一份 `AgentDefinition` 声明（人设、工具、输出钩子、结果投影）。
 *
 * 本包**永远内联进群组产物、不单独构建**——理由见包根 `README.md`。
 *
 * 导出形式是刻意的：有运行时值的模块用 `export *`；**纯类型模块显式列出**，因为打包器在
 * 生成声明时会把纯类型转发丢掉，子包构建就会报 `AgentParticipant is not exported`
 * （这是既有实现踩过的坑，写在 `common/src/index.ts` 的注释里）。
 */

export * from './errors.ts'
export * from './resources.ts'
export * from './projection.ts'
export * from './conversation.ts'
export * from './participant.ts'
export * from './selfcheck.ts'
export * from './handoff.ts'
export * from './runtime.ts'

export { PARTICIPANT_PROTOCOL } from './contract.ts'
export type {
  AgentParticipant,
  ParticipantArtifact,
  ParticipantExternalPending,
  ParticipantProgress,
  ParticipantRequest,
  ParticipantResult,
  ParticipantStatus,
} from './contract.ts'

export type {
  AgentDefinition,
  AgentToolContext,
  JudgeInput,
  JudgeResult,
  ProjectedResult,
  ReasoningProjectionContext,
  ResultContext,
  TurnHistory,
  TurnMessage,
} from './definition.ts'

export type {
  AgentDatabasePort,
  AgentStoragePort,
  AppendTurnResultInput,
  ConversationOwner,
  ConversationPageShape,
  ConversationPort,
  ConversationProviderShape,
  ConversationQueryShape,
  ConversationRecordShape,
  ManagedConversationShape,
  OwnerKey,
  PreviewMessageShape,
  RemovalResultShape,
  TurnResultRecord,
  TurnStorePort,
} from './storage/ports.ts'

// —— 存储实现（P2）：本地同步围栏面 + PG 异步面 + 门面 + 会话契约适配器 ——
export {
  AgentDatabaseFacade,
  LocalFenceStore,
  PostgresAgentDatabase,
  RUNTIME_SCHEMA_VERSION,
  StorageError,
  createAgentDatabase,
  mapStorageError,
  storageCodeOf,
  uniqueViolation,
} from './storage/index.ts'
export type { BusyProbe, CreateAgentDatabaseInput, ManagedProviderFactory, StorageHealth } from './storage/index.ts'
export type { StorageErrorCode } from './storage/errors.ts'
export { createConversationProvider } from './storage/adapter.ts'
export type { AdapterPreviewMessage, ConversationAdapterInput } from './storage/adapter.ts'
