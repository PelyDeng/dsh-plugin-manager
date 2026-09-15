// Independent acceptance probes: real request acceptance and SQLite; no host/model execution.
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ButlerConsole} from '../../../plugins/dsh-butler-console/src/butler.ts';
import {TaskStore} from '../../../plugins/dsh-butler-console/src/store.ts';

const actor = {namespace: 'user', userId: 'alice', sessionId: 'alice-login'} as const;
const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab';
const stores: TaskStore[] = [];
afterEach(() => {vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close();});

function fixture() {
  const store = new TaskStore(':memory:'); stores.push(store);
  store.openOrReserveConversation(conversationId, actor);
  store.createTask({id: 'task-acceptance', conversationId, actor, goal: 'original', note: '',
    subtasks: [{id: 's1', goal: 'old scope', agentId: 'blog', reason: 'writing'}]});
  const service = new ButlerConsole({} as never, {idempotencyTtlMs: 600000, maxConversationEvents: 200} as never,
    {assert() {}} as never, store, '');
  const conversation = {id: conversationId, active: false, lastUsedAt: Date.now(), handle: {agent: {}}};
  const open = vi.spyOn(service, 'open').mockImplementation(async () => conversation as never);
  // Keep the probe at the acceptance seam; no model, external executor, or background mutation.
  const pump = vi.spyOn(service as any, 'pump').mockResolvedValue(undefined);
  return {store, service, open, pump, conversation};
}

describe('shared task acceptance invariants', () => {
  it('two concurrent clients with the same expected version accept only one supplement', async () => {
    const f = fixture();
    const results = await Promise.allSettled(['first', 'second'].map(text => f.service.submitSupplement({
      taskId: 'task-acceptance', actor, text, expectVersion: 1, requestId: text,
    })));
    expect({accepted: results.filter(r => r.status === 'fulfilled').length,
      version: f.store.task(actor, 'task-acceptance')!.acceptedVersion})
      .toEqual({accepted: 1, version: 2});
  });

  it('concurrent duplicate requestId schedules one execution and accepts one input', async () => {
    const f = fixture();
    const request = {taskId: 'task-acceptance', actor, text: 'same change', requestId: 'same-id'};
    const results = await Promise.all([f.service.submitSupplement(request), f.service.submitSupplement(request)]);
    expect({runs: new Set(results.map(r => r.runId)).size, executions: f.pump.mock.calls.length,
      acceptedVersion: f.store.task(actor, 'task-acceptance')!.acceptedVersion})
      .toEqual({runs: 1, executions: 1, acceptedVersion: 2});
  });

  it('a task completed while opening its session cannot accept a late supplement', async () => {
    const f = fixture();
    f.open.mockImplementation(async () => {
      f.store.setTaskState('task-acceptance', 'completed', {summary: 'already finished'});
      return f.conversation as never;
    });
    const results = await Promise.allSettled([f.service.submitSupplement({taskId: 'task-acceptance', actor, text: 'late'})]);
    expect({accepted: results.filter(r => r.status === 'fulfilled').length,
      version: f.store.task(actor, 'task-acceptance')!.acceptedVersion})
      .toEqual({accepted: 0, version: 1});
  });

  it('normal task completion cannot overtake an already accepted unprocessed supplement', async () => {
    const f = fixture();
    f.store.setSubtaskState('task-acceptance', 's1', 'dispatched');
    f.store.setSubtaskState('task-acceptance', 's1', 'succeeded', {result: 'old scope result'});
    f.store.addInput(actor, 'task-acceptance', 'changed scope', 'supplement');
    const events = [];
    for await (const event of (f.service as any).closeTask({taskId: 'task-acceptance', goal: 'original',
      subtasks: [{id: 's1', state: 'succeeded'}], reports: ['old scope result'],
      signal: new AbortController().signal, stopped: false})) events.push(event);
    const task = f.store.task(actor, 'task-acceptance')!;
    expect({state: task.state, acceptedVersion: task.acceptedVersion, processedVersion: task.processedVersion})
      .toEqual({state: 'running', acceptedVersion: 2, processedVersion: 1});
  });

  it('a still-claimed idempotency record survives unrelated submissions after the replay TTL', () => {
    const f = fixture();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000000);
    f.store.claimRequest(actor, 'chat', 'long-running', 'digest-a', 'run-a', conversationId, 600000);
    now.mockReturnValue(1600001);
    f.store.claimRequest(actor, 'chat', 'another-request', 'digest-b', 'run-b', conversationId, 600000);
    expect(f.store.request(actor, 'chat', 'long-running')?.state).toBe('claimed');
  });
});
