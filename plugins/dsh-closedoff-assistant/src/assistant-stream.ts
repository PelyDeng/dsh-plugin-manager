/** Present official live frames and durable Session V3 streams. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as llm from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface AssistantDelta {
  time: number
  step: number
  chunk: StreamChunk
}

/** Subscribe through Cordis so plugin disposal also removes the live listener. */
export function onAssistantDelta(ctx: Context, receive: (sessionId: string, delta: AssistantDelta) => void): void {
  const attempts = new WeakMap<Agent, { attemptId: string; revision: number; step: number }>()
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') {
      attempts.set(agent, { attemptId: frame.attemptId, revision: frame.revision, step: frame.step })
      return
    }
    const attempt = attempts.get(agent)
    if (attempt?.attemptId !== frame.attemptId || attempt.revision >= frame.revision) return
    attempt.revision = frame.revision
    if (frame.type === 'end') attempts.delete(agent)
    else receive(String(agent.session.id), { time: frame.time, step: attempt.step, chunk: frame.chunk })
  })
}

/** Read timed deltas without inventing durable events or changing their sequence numbers. */
export function historyAssistantDeltas(event: SessionEvent): readonly AssistantDelta[] {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return []
  const data = event.data
  if (data.stream === undefined) return []
  return llm.expandAssistantStream(data.stream).map(value => ({ ...value, step: data.step }))
}
