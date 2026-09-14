/** 层数只报数：计数正确、缺失信息不抛错、不做阈值判断。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLayerReport, layerReport } from '../../../deploy/scripts/layer-count.mjs';
test('按 RootFS.Layers 长度报数并算出本次新增层数', () => {
  const info = { RootFS: { Layers: ['sha256:a', 'sha256:b', 'sha256:c'] }, History: [{}, {}] };
  assert.deepEqual(layerReport(info, { driver: 'overlay2', engine: '27.1.1', base: 2 }), { layers: 3, added: 1, history: 2, driver: 'overlay2', engine: '27.1.1' });
});

test('缺少 RootFS.Layers 时返回 null，而不是猜一个数字', () => {
  assert.deepEqual(layerReport({}, { driver: 'overlay2' }), { layers: null, added: null, history: null, driver: 'overlay2', engine: null });
  assert.equal(layerReport(undefined).layers, null);
});

test('报数文本包含基底、镜像、新增与驱动引擎，缺项自动省略', () => {
  const text = formatLayerReport({ base: { layers: 489 }, image: { layers: 492, added: 3 }, driver: 'overlay2', engine: '27.1.1' });
  assert.match(text, /基底 489 层/);
  assert.match(text, /本次镜像 492 层（本次新增 3）/);
  assert.match(text, /驱动 overlay2/);
  assert.match(text, /引擎 27\.1\.1/);
  assert.equal(formatLayerReport({ base: { layers: null }, image: { layers: null, added: null } }), '');
});

test('层数模块不做阈值判断：超大数据仍然原样返回', () => {
  const report = layerReport({ RootFS: { Layers: Array.from({ length: 489 }, (_, index) => `sha256:${index}`) } }, { base: 486 });
  assert.equal(report.layers, 489);
  assert.equal(report.added, 3);
});
