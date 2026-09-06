/** Presentation bridge for legacy chunks and DSH 0.1.3 live/embedded streams. */
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

// The published development SDK predates these runtime exports. Keep this
// version bridge local; compact records are decoded by the installed DSH.
type Frame = { attemptId: string; revision: number } & (
  | { type: 'start'; step: number }
  | { type: 'chunk'; time: number; chunk: StreamChunk }
  | { type: 'end' }
)

/** Subscribe through Cordis so plugin disposal also removes the live listener. */
export function onAssistantDelta(ctx: Context, receive: (sessionId: string, delta: AssistantDelta) => void): void {
  const attempts = new WeakMap<Agent, { attemptId: string; revision: number; step: number }>()
  const on = ctx.on.bind(ctx) as (name: 'agent/assistant-stream', listener: (payload: { agent: Agent; frame: Frame }) => void) => unknown
  on('agent/assistant-stream', ({ agent, frame }) => {
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
  if (event.type === 'assistant/chunk') return [{ time: event.time, ...event.data }]
  const settlement = event as { type: string; data: { step: number; stream?: unknown } }
  if (settlement.type !== 'assistant/message' && settlement.type !== 'assistant/attempt') return []
  const data = settlement.data
  if (data.stream === undefined) return []
  const expand = (llm as unknown as {
    expandAssistantStream?: (stream: unknown) => readonly { time: number; chunk: StreamChunk }[]
  }).expandAssistantStream
  if (expand === undefined) throw new Error('DSH runtime cannot expand the embedded assistant stream')
  return expand(data.stream).map(value => ({ ...value, step: data.step }))
}
