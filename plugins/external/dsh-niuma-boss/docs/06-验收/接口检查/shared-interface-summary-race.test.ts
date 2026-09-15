// F4 follow-up: a supplement accepted during the asynchronous summary must gate its terminal commit.
import {expect, it, vi} from 'vitest';
import {ButlerConsole} from '../../../plugins/dsh-butler-console/src/butler.ts';
import {TaskStore} from '../../../plugins/dsh-butler-console/src/store.ts';

it('does not commit an old summary when a supplement arrives during summarization', async () => {
  const actor = {namespace: 'user', userId: 'alice', sessionId: 'login'} as const;
  const conversationId = 'butler-web-01234567-89ab-4cde-8fab-0123456789ab';
  const store = new TaskStore(':memory:');
  const service = new ButlerConsole({} as never, {} as never, {assert() {}} as never, store, '');
  try {
    store.openOrReserveConversation(conversationId, actor);
    store.createTask({id: 'summary-race', conversationId, actor, goal: 'yesterday', note: '',
      subtasks: [{id: 's1', goal: 'yesterday', agentId: 'blog', reason: 'writing'}]});
    store.setSubtaskState('summary-race', 's1', 'dispatched');
    store.setSubtaskState('summary-race', 's1', 'succeeded', {result: 'yesterday result'});
    // Replace only model generation. The task transition, input transaction and closeTask are real.
    const summary = vi.spyOn(service as any, 'summarize').mockImplementation(async function* () {
      expect(store.task(actor, 'summary-race')!.state).toBe('summarizing');
      await Promise.resolve();
      store.addInput(actor, 'summary-race', 'change scope to last week', 'supplement', 1);
      yield {type: 'chat', role: 'butler', text: 'old summary', time: Date.now()};
    });
    for await (const event of (service as any).closeTask({taskId: 'summary-race', conversation: {id: conversationId},
      goal: 'yesterday', subtasks: store.task(actor, 'summary-race')!.subtasks,
      reports: ['yesterday result'], signal: new AbortController().signal, stopped: false})) void event;
    expect(summary).toHaveBeenCalledOnce();
    const task = store.task(actor, 'summary-race')!;
    expect({terminal: ['completed', 'partial', 'external_pending'].includes(task.state),
      accepted: task.acceptedVersion, processed: task.processedVersion})
      .toEqual({terminal: false, accepted: 2, processed: 1});
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});
