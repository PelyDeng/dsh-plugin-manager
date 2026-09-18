/**
 * 未就绪时的协作入口占位。
 *
 * ## 为什么它是共享实现，而不是每个子包各写一份
 *
 * 三个子包（closedoff / blog / huiyu）都写了同一段代码：一个把 `assertAccess` 与 `run` 一律
 * 拒绝的参与者。三份实现里**身份三项各抄了一遍**（`id` / `displayName` / `description`），
 * 而这三项必须与正式定义逐字相同——一旦漂移，协调方与用户在成员列表、会话侧栏、任务卡片上
 * 看到的就是**同一个成员的两种身份**，而且很难查（两边都不报错）。
 *
 * 所以这里让身份**从定义里取**：`unavailableParticipant({ definition, reason })`。子包把
 * 自己那份 `AgentDefinition` 递进来，抄写这件事就不存在了。
 *
 * ## 语义：不伪造能力，也不假装成员不存在
 *
 * `assertAccess` 与 `run` 都以 **503 + 稳定原因**拒绝：协作侧拿到的是"这个成员现在不能用、
 * 因为缺什么"，而不是"这个成员不存在"，也不是一句空结果。原因由调用方给（它才知道缺的是
 * 存储、私有配置还是别的）。
 */

import { AccessError } from '@dsh-plugin-manager/plugin-kit'
import { PARTICIPANT_PROTOCOL, type AgentParticipant } from './contract.ts'
import type { AgentDefinition } from './definition.ts'

/** 身份三项：与正式定义同源，不做第二份声明。 */
type ParticipantIdentity = Pick<AgentDefinition, 'id' | 'displayName' | 'description'>

/**
 * 造一个"未就绪"的协作入口。
 *
 * @param input.definition 本 Agent 的定义（只取身份三项）
 * @param input.reason 未就绪的原因，会出现在 503 的正文里（写清缺什么，用户能自己修）
 * @returns 可直接交给群组登记的参与者
 */
export function unavailableParticipant(input: {
  readonly definition: ParticipantIdentity
  readonly reason: string
}): AgentParticipant {
  const refuse = (): never => {
    throw new AccessError(503, `${input.definition.displayName}未就绪：${input.reason}`)
  }
  return {
    protocol: PARTICIPANT_PROTOCOL,
    id: input.definition.id,
    displayName: input.definition.displayName,
    description: input.definition.description,
    assertAccess: refuse,
    run: async () => refuse(),
  }
}
