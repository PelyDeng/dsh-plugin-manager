import assert from 'node:assert/strict';
import test from 'node:test';
import { getCompassState } from '../web/src/compass-state.js';

const mission = state => ({ id: 'mission-a', state });
const event = (seq, stage, role = 'jack') => ({ seq, stage, role, type: 'status' });

test('公开拆解、派单、工作、整合阶段逐步靠近目标，不依赖耗时', () => {
  const events = [event(1, 'thinking'), event(2, 'commanding', 'closedoff'), event(3, 'working', 'closedoff'), event(4, 'aggregating')];
  const angles = events.map((_, index) => getCompassState(mission('running'), events.slice(0, index + 1)).angle);
  assert.deepEqual(angles, [-135, -95, -55, -20]);
  assert.equal(getCompassState({ ...mission('running'), updatedAt: 1 }, events).angle, -20);
  assert.equal(getCompassState({ ...mission('running'), updatedAt: 9999999 }, events).angle, -20);
});

test('只有后端 completed 对齐 X，所有其他终态有独立说明', () => {
  const events = [event(1, 'aggregating'), event(2, 'returning', 'closedoff'), event(3, 'returning', 'blog')];
  const labels = new Set();
  for (const state of ['running', 'waiting', 'partial', 'failed', 'cancelled', 'interrupted', 'stopping', 'unrecognized']) {
    const compass = getCompassState(mission(state), events);
    assert.notEqual(compass.angle, 0, state);
    labels.add(compass.label);
  }
  assert.equal(labels.size, 8);
  assert.equal(getCompassState(mission('completed'), events).angle, 0);
  assert.equal(getCompassState(mission('running'), events).phase, 'working');
});

test('新一轮返回但事件尚未刷新时忽略旧轮，随后由新 thinking 建立轮次', () => {
  const old = [event(1, 'thinking'), event(8, 'aggregating')];
  assert.equal(getCompassState(mission('running'), old, { afterSeq: 8 }).phase, 'starting');
  const fresh = [...old, event(9, 'thinking'), event(10, 'commanding', 'blog')];
  assert.deepEqual(getCompassState(mission('running'), fresh, { afterSeq: 8 }), getCompassState(mission('running'), fresh));
  assert.equal(getCompassState(mission('running'), fresh).round, 9);
});

test('恢复直接取当前阶段，分页读取不展示旧轮进度，重复和无序输入稳定', () => {
  const events = [event(1, 'thinking'), event(8, 'aggregating'), event(9, 'thinking'), event(10, 'working', 'blog')];
  const result = getCompassState(mission('running'), events);
  assert.equal(result.phase, 'working');
  assert.equal(result.round, 9);
  assert.deepEqual(getCompassState(mission('running'), [...events].reverse()), result);
  assert.equal(getCompassState(mission('completed'), events, { loading: true }).phase, 'loading');
  assert.equal(getCompassState(null, []).phase, 'idle');
  assert.equal(getCompassState(mission('running'), []).phase, 'starting');
});

test('补充仅接收不前移，开始处理时回到理解；未公开阶段与普通消息不能推动指针', () => {
  const old = [event(1, 'thinking'), event(8, 'aggregating')];
  const received = [...old, { seq: 9, type: 'message', role: 'user', text: '补充要求' }, { seq: 10, type: 'status', role: 'jack', text: '已接收补充' }];
  assert.equal(getCompassState(mission('running'), received).phase, 'aggregating');
  assert.equal(getCompassState(mission('running'), [...received, event(11, 'thinking')]).phase, 'thinking');
  assert.equal(getCompassState(mission('running'), [{ ...event(1, 'aggregating'), type: 'message' }, event(2, 'aggregating', 'blog')]).phase, 'starting');
});
