import assert from 'node:assert/strict';
import test from 'node:test';
import { createMutationGate, isAccessRejection, prepareMissionSubmission, readApiResponse, unobservedSubmissionRound } from '../web/src/mission-request.js';
import { createSceneEventFeed } from '../web/src/scene-events.js';
import * as requests from '../web/src/mission-request.js';

test('丢失POST响应后GET已读到失败和主题，原请求重试只确认，不抬高边界或重播', () => {
  const failed = { id: 'same', state: 'failed' };
  const history = [{ seq: 1, role: 'jack', type: 'status', stage: 'thinking' },
    { seq: 2, role: 'jack', type: 'topic', text: '旧主题' }];
  const pending = prepareMissionSubmission(null, 'same-request', failed, history);
  const feed = createSceneEventFeed();
  feed.push(failed, history, { restore: true }); feed.drain();
  const observed = [...history, { seq: 3, role: 'jack', type: 'status', stage: 'thinking' },
    { seq: 4, role: 'jack', type: 'topic', text: '新主题' }];
  feed.push(failed, observed);
  assert.equal(feed.drain().topic, '新主题');
  const retry = prepareMissionSubmission(pending, 'same-request', failed, observed);
  assert.equal(retry, pending);
  assert.equal(retry.roundStart.afterSeq, 2, '重试不能把边界移到已完成的新轮末尾');
  const roundStart = unobservedSubmissionRound(retry, failed.id, observed);
  assert.equal(roundStart, null, '新thinking已建立轮次，成功回包不再初始化');
  for (let poll = 0; poll < 3; poll++) {
    feed.push(failed, observed, { roundStart });
    const snapshot = feed.drain();
    assert.equal(snapshot.topic, '新主题');
    assert.equal(snapshot.initialize, false);
    assert.deepEqual(snapshot.events, []);
  }
});

test('丢响应后尚未读到新thinking，重试沿原请求边界开始且只初始化一次', () => {
  const failed = { id: 'same', state: 'failed' }, running = { ...failed, state: 'running' };
  const history = [{ seq: 10, role: 'jack', type: 'topic', text: '旧主题' }];
  const pending = prepareMissionSubmission(null, 'request', failed, history);
  const received = [...history, { seq: 11, role: 'user', type: 'message', text: '新指令' }];
  const retry = prepareMissionSubmission(pending, 'request', failed, received);
  const roundStart = unobservedSubmissionRound(retry, failed.id, received);
  assert.deepEqual(roundStart, { id: 'same', afterSeq: 10 });
  const feed = createSceneEventFeed();
  feed.push(failed, history, { restore: true }); feed.drain();
  feed.push(running, received, { roundStart });
  assert.equal(feed.drain().initialize, true);
  feed.push(running, received, { roundStart });
  const waiting = feed.drain();
  assert.equal(waiting.initialize, false); assert.equal(waiting.topic, '');
  feed.push(running, [...received, { seq: 12, role: 'jack', type: 'status', stage: 'thinking' },
    { seq: 13, role: 'jack', type: 'topic', text: '新主题' }], { roundStart });
  const started = feed.drain();
  assert.equal(started.initialize, false); assert.equal(started.topic, '新主题');
});

test('运行中补充不建立新边界，内容变化或请求清空后才生成新请求号', () => {
  const events = [{ seq: 20 }], mission = { id: 'same', state: 'failed' };
  for (const current of [null, { ...mission, state: 'running' }, { ...mission, state: 'stopping' }]) {
    assert.equal(prepareMissionSubmission(null, 'supplement', current, events).roundStart, null);
  }
  const first = prepareMissionSubmission(null, 'first', mission, events);
  const changed = prepareMissionSubmission(first, 'changed', mission, [{ seq: 30 }]);
  assert.notEqual(changed.requestId, first.requestId);
  assert.equal(changed.roundStart.afterSeq, 30);
  const cleared = prepareMissionSubmission(null, 'first', mission, events);
  assert.notEqual(cleared.requestId, first.requestId, '切换或权限清空后不复用旧请求');
  assert.equal(unobservedSubmissionRound(first, 'another-mission', events), null);
});

test('同一协作的旧 GET 在发送或停止成功后不能覆盖新状态', async () => {
  for (const nextState of ['running', 'stopping']) {
    const gate = createMutationGate();
    let visible = { id: 'same-mission', state: 'completed' }, release;
    const oldRead = gate.snapshot();
    const delayedGet = new Promise(resolve => { release = resolve; }).then(result => {
      if (gate.accepts(oldRead)) visible = result;
    });
    const finish = gate.begin();
    const readDuringMutation = gate.snapshot();
    assert.equal(gate.accepts(readDuringMutation), false);
    visible = { id: 'same-mission', state: nextState };
    finish();
    release({ id: 'same-mission', state: 'completed' });
    await delayedGet;
    assert.equal(visible.state, nextState);
    assert.equal(gate.accepts(readDuringMutation), false);
    assert.equal(gate.accepts(gate.snapshot()), true);
  }
});

test('操作失败后仍让旧读取失效，完成回调重复调用不会取消另一项保护', () => {
  const gate = createMutationGate();
  const old = gate.snapshot(), first = gate.begin();
  first();
  const second = gate.begin();
  first();
  assert.equal(gate.accepts(gate.snapshot()), false);
  second();
  assert.equal(gate.accepts(old), false);
  assert.equal(gate.accepts(gate.snapshot()), true);
});

test('空体及纯文本认证拒绝保留状态并进入受保护数据清理条件', async () => {
  for (const [status, body] of [[401, ''], [403, 'Forbidden'], [404, 'Not Found']]) {
    await assert.rejects(readApiResponse(new Response(body, { status })), error => {
      assert.equal(error.status, status);
      assert.equal(isAccessRejection(error), true);
      assert.equal(error instanceof SyntaxError, false);
      assert.ok(error.message.length > 0);
      return true;
    });
  }
});

test('保留正常JSON错误；成功响应不可读时保持结果不明确以复用提交请求号', async () => {
  await assert.rejects(readApiResponse(new Response(JSON.stringify({ error: '协作仍在停止中' }), { status: 409 })), { status: 409, message: '协作仍在停止中' });
  await assert.rejects(readApiResponse(new Response('', { status: 202 })), error => {
    assert.equal(error.status, undefined);
    assert.equal(isAccessRejection(error), false);
    return true;
  });
  assert.deepEqual(await readApiResponse(new Response('{"mission":{"state":"running"}}', { status: 202 })), { mission: { state: 'running' } });
});

test('启动窗口的非JSON404仍清除受保护数据，但只有前三次任务读取允许恢复', async () => {
  for (const body of ['', 'Not Found', '<html>Not Found</html>']) {
    await assert.rejects(readApiResponse(new Response(body, { status: 404 })), error => {
      assert.equal(error.status, 404);
      assert.equal(isAccessRejection(error), true, '临时路由错误也不能保留受保护内容');
      assert.equal(error.routeUnavailable, true);
      assert.match(error.message, /刷新页面/);
      for (let attempts = 0; attempts < 3; attempts++) assert.equal(requests.canRetryMissionRead(error, attempts), true);
      assert.equal(requests.canRetryMissionRead(error, 3), false);
      return true;
    });
  }
});

test('真实JSON业务404及所有401和403不进入路由恢复', async () => {
  for (const [status, body] of [[404, '{"error":"协作不存在或无权访问"}'], [404, 'null'], [401, ''], [403, 'Forbidden'], [403, '{"error":"访问已撤销"}']]) {
    await assert.rejects(readApiResponse(new Response(body, { status })), error => {
      assert.equal(isAccessRejection(error), true);
      assert.notEqual(error.routeUnavailable, true);
      assert.equal(requests.canRetryMissionRead(error, 0), false);
      return true;
    });
  }
});

test('首次payload独立保存，用户明确改变发送意图才新建请求和轮次边界', () => {
  const mission = { id: 'same', state: 'completed' }, payload = { missionId: 'same', target: 'jack', message: '原文', modelSelection: null };
  const original = prepareMissionSubmission(null, 'original-intent', mission, [{ seq: 4 }], payload);
  payload.message = '外部对象修改';
  const retry = prepareMissionSubmission(original, 'original-intent', { ...mission, state: 'running' }, [{ seq: 20 }], { message: '原文' });
  assert.equal(retry, original); assert.equal(retry.payload.message, '原文'); assert.equal(retry.payload.modelSelection, null); assert.equal(retry.roundStart.afterSeq, 4);
  for (const signature of ['changed-message', 'changed-target', 'changed-model', 'changed-mission']) {
    const changed = prepareMissionSubmission(original, signature, mission, [{ seq: 20 }], { message: signature });
    assert.notEqual(changed.requestId, original.requestId); assert.equal(changed.payload.message, signature); assert.equal(changed.roundStart.afterSeq, 20);
  }
});
