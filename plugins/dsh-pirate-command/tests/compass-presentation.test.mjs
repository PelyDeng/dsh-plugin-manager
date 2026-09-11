import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPASS_FAILURE_MS, updateCompassPresentation } from '../web/src/compass-presentation.js';
const input = (missionState, extra = {}) => ({ missionId: 'a', round: 10, missionState, ...extra });

test('实时整轮失败只乱转一次，轮询不延长截止点，到时静态断针', () => {
  const running = updateCompassPresentation(null, input('running'), 0);
  const failed = updateCompassPresentation(running, input('failed'), 100);
  assert.equal(failed.mode, 'spinning'); assert.equal(failed.spinUntil, 100 + COMPASS_FAILURE_MS);
  assert.ok(COMPASS_FAILURE_MS > 0 && COMPASS_FAILURE_MS <= 900);
  assert.equal(updateCompassPresentation(failed, input('failed'), 500), failed);
  const ended = updateCompassPresentation(failed, input('failed'), failed.spinUntil);
  assert.equal(ended.mode, 'broken'); assert.equal(ended.spinUntil, 0);
  assert.equal(updateCompassPresentation(ended, input('failed'), 9000), ended);
});

test('历史或加载中的失败直接静态，恢复后的轮询不重播', () => {
  for (const boundary of [{ restore: true }, { loading: true }, { reducedMotion: true }]) {
    const history = updateCompassPresentation(null, input('failed', boundary), 0);
    assert.equal(history.mode, 'broken');
    const polled = updateCompassPresentation(history, input('failed'), 1000);
    assert.equal(polled.mode, 'broken'); assert.equal(polled.spinUntil, 0);
  }
  const restoredRunning = updateCompassPresentation(null, input('running', { restore: true }), 0);
  assert.equal(updateCompassPresentation(restoredRunning, input('failed'), 500).mode, 'spinning', '恢复后新发生的真实失败仍反馈');
});

test('减少动态与历史恢复立即结束乱转，解除后不补演', () => {
  for (const boundary of [{ reducedMotion: true }, { restore: true }, { loading: true }]) {
    const spinning = updateCompassPresentation(null, input('failed'), 0);
    const stopped = updateCompassPresentation(spinning, input('failed', boundary), 100);
    assert.equal(stopped.mode, 'broken'); assert.equal(stopped.spinUntil, 0);
    assert.equal(updateCompassPresentation(stopped, input('failed'), 200).mode, 'broken');
  }
});

test('等待、部分完成和停止不折针，切换任务与新轮清除旧失败', () => {
  const failed = updateCompassPresentation(null, input('failed'), 0);
  for (const state of ['running', 'waiting', 'partial', 'stopping', 'cancelled', 'interrupted', 'completed', undefined]) {
    const result = updateCompassPresentation(failed, input(state), 100);
    assert.equal(result.mode, 'intact', String(state)); assert.equal(result.spinUntil, 0);
  }
  const switched = updateCompassPresentation(failed, input('running', { missionId: 'b' }), 100);
  assert.notEqual(switched.key, failed.key); assert.equal(switched.mode, 'intact');
  const newRound = updateCompassPresentation(failed, input('running', { round: 20 }), 100);
  assert.notEqual(newRound.key, failed.key); assert.equal(newRound.mode, 'intact');
  const newFailure = updateCompassPresentation(newRound, input('failed', { round: 20 }), 200);
  assert.equal(newFailure.spinUntil, 200 + COMPASS_FAILURE_MS);
});
