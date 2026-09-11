import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as helpers from '../web/src/mission-request.js';
import { createSceneEventFeed } from '../web/src/scene-events.js';
import { getCompassState } from '../web/src/compass-state.js';

// 执行真实 useMission 源码；hooks、网络和定时器为内存替身，浏览器另做验收。
const source = readFileSync(new URL('../web/src/use-mission.js', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
const appSource = readFileSync(new URL('../web/src/App.jsx', import.meta.url), 'utf8');
// 同时执行 App 的实际模型读取 effect；截在场景与 JSX 之前，DOM/渲染不由此夹具证明。
const modelAppSource = appSource.match(/^const CREW_FOR_ACTOR.*$/m)[0] + '\n'
  + appSource.slice(appSource.indexOf('export function App() {'), appSource.indexOf('  function selectMission(')).replace('export function', 'function')
  + '\nreturn { mission, modelCatalog, modelValue, modelRecoveryHint: typeof modelRecoveryHint === "undefined" ? undefined : modelRecoveryHint, retryModels: () => setModelReload(value => value + 1), chooseModel: value => setModelDraft({ id: mission.id, value }) }; }\nApp;';
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture({ withModels = false, missionId = 'm1' } = {}) {
  const cells = [], requests = [], timers = [];
  let index = 0, queued = false, api, hook, component, modelState, effects = [];
  const same = (a, b) => a && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const rerender = () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; render(); }); } };
  const runtime = {
    ...helpers, URL, AbortSignal, AbortController, crypto: webcrypto, getCompassState,
    window: { matchMedia: () => ({ matches: false }) },
    location: { href: 'http://fixture/pirate/' + (missionId ? '?mission=' + missionId : '') }, document: { baseURI: 'http://fixture/pirate/' }, history: { replaceState() {} },
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, value => { cells[i].value = typeof value === 'function' ? value(cells[i].value) : value; rerender(); }]; },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i]; },
    useMemo(fn) { return fn(); },
    useCallback(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn, deps }; return cells[i].value; },
    useEffect(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const previous = cells[i]; cells[i] = { deps }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = fn(); }); } },
    fetch(url, options) { return new Promise(resolve => requests.push({ url: String(url), options, resolve })); },
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; }, clearTimeout(timer) { if (timer) timer.cancelled = true; },
  };
  const missionModule = runInNewContext(source + '\n({ useMission, isRunning });', runtime);
  hook = missionModule.useMission;
  if (withModels) component = runInNewContext(modelAppSource, { ...runtime, ...missionModule });
  function render() { index = 0; modelState = component?.(); api = component ? modelState.mission : hook(); const next = effects; effects = []; next.forEach(fn => fn()); }
  const pending = path => requests.find(item => !item.done && !item.options.signal?.aborted && new URL(item.url).pathname.endsWith('/' + path));
  function reply(path, data, status = 200, raw = false) {
    const item = pending(path); assert.ok(item, 'pending ' + path); item.done = true;
    item.resolve({ ok: status < 400, status, json: async () => raw ? JSON.parse(data) : data }); return item;
  }
  function tick() { const timer = timers.find(item => !item.cancelled && !item.ran); if (!timer) return false; timer.ran = true; timer.fn(); return timer.delay; }
  render();
  return { get api() { return api; }, get modelState() { return modelState; }, requests, reply, pending, tick };
}
const event = seq => ({ seq, type: 'message', role: 'user', text: '历史' + seq });
const data = (events, state = 'running') => ({ mission: { id: 'm1', state }, events, crewSessions: [] });
const crew = { crew: [{ id: 'closedoff', available: true }], maxMessageChars: 8000 };
async function loaded(state = 'running') {
  const f = fixture(); f.reply('crew', crew); f.reply('missions', { missions: [{ id: 'm1', title: '已读历史' }] }); f.reply('mission', data([event(1), event(2)], state)); await settle(); return f;
}

test('两次poll之间列表临时404：旧timer先处理清理，游标0分页恢复且不补演', async () => {
  const f = await loaded();
  void f.api.refreshList(); f.reply('missions', '', 404, true); await settle();
  assert.equal(f.api.events.length, 0); assert.equal(f.api.crew.length, 0);
  assert.equal(f.tick(), 1000); assert.equal(f.pending('mission'), undefined, '旧timer不能携旧cursor直接读取');
  assert.equal(f.tick(), 3000); assert.equal(new URL(f.pending('mission').url).searchParams.get('after'), '0');
  f.reply('mission', data(Array.from({ length: 200 }, (_, i) => event(i + 1)), 'interrupted')); await settle();
  assert.equal(f.api.events.length, 200); assert.equal(f.api.restore, true); assert.equal(f.api.loading, true);
  const feed = createSceneEventFeed(); feed.push(f.api.mission, f.api.events, { restore: f.api.restore, loading: f.api.loading }); assert.equal(feed.drain().events.length, 0);
  f.reply('crew', crew); f.reply('missions', { missions: [{ id: 'm1' }] }); await settle();
  assert.equal(f.tick(), 0); assert.equal(new URL(f.pending('mission').url).searchParams.get('after'), '200');
  f.reply('mission', data([event(201)], 'interrupted')); await settle();
  assert.equal(f.api.events.length, 201); assert.equal(f.api.events[0].seq, 1); assert.equal(f.api.restore, true); assert.equal(f.api.loading, false); assert.equal(f.api.crew.length, 1);
  feed.push(f.api.mission, f.api.events, { restore: f.api.restore }); assert.equal(feed.drain().events.length, 0);
  assert.ok(f.requests.every(item => item.options.method === 'GET'));
});

test('两次poll之间列表401/403/JSON404：受保护内容清空，预排timer不得再发GET', async () => {
  for (const [status, body] of [[401, ''], [403, '{"error":"访问撤销"}'], [404, '{"error":"协作不存在"}']]) {
    const f = await loaded(); void f.api.refreshList(); f.reply('missions', body, status, true); await settle();
    const count = f.requests.length; f.tick(); await settle();
    assert.equal(f.requests.length, count); assert.equal(f.api.events.length, 0); assert.equal(f.api.crew.length, 0); assert.equal(f.api.mission, null);
  }
});

test('任务读取临时404最多重试三次，耗尽后提示刷新且不自动写入', async () => {
  const f = await loaded(); f.tick();
  for (let attempt = 0; attempt < 4; attempt++) {
    f.reply('mission', '', 404, true); await settle();
    if (attempt < 3) { assert.equal(f.tick(), 3000); assert.equal(new URL(f.pending('mission').url).searchParams.get('after'), '0'); }
  }
  assert.equal(f.tick(), false); assert.match(f.api.error, /刷新页面/); assert.equal(f.api.events.length, 0);
  assert.ok(f.requests.every(item => item.options.method === 'GET'));
});

test('提交得到临时路由404不自动重发，用户原文重试保留原requestId', async () => {
  const f = await loaded();
  const first = f.api.send('补充原文', 'jack'); const original = JSON.parse(f.pending('message').options.body);
  f.reply('message', '', 404, true); await first; await settle();
  assert.equal(f.api.events.length, 0); assert.equal(f.requests.filter(item => item.options.method === 'POST').length, 1);
  const retry = f.api.send('补充原文', 'jack'); const repeated = JSON.parse(f.pending('message').options.body);
  assert.equal(repeated.requestId, original.requestId); assert.equal(repeated.missionId, original.missionId);
  f.reply('message', { mission: { id: 'm1', state: 'running' } }, 202); await retry;
});

test('新协作空404明确提示先刷新模型，目录GET保留原模型意图和完整重试请求', async () => {
  const f = fixture({ withModels: true, missionId: '' });
  const catalog = { groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: 'model-a', name: 'A' }] }], failures: [] };
  f.reply('crew', crew); f.reply('missions', { missions: [] }); f.reply('models', catalog); await settle();
  const model = { provider: 'fixture', model: 'model-a' }, intent = JSON.stringify(['fixture', 'model-a']);
  f.modelState.chooseModel(intent); await settle();
  const first = f.api.send('保留原文', 'jack', model, f.modelState.modelValue);
  const originalBytes = f.pending('message').options.body;
  f.reply('message', '', 404, true); await first; await settle();
  assert.equal(f.api.id, ''); assert.equal(f.api.retryNeedsModelCatalog, true);
  assert.match(f.modelState.modelRecoveryHint, /先刷新船长模型目录，再按原内容重试/);
  assert.equal(f.pending('models'), undefined); assert.equal(f.pending('mission'), undefined);
  const before = f.requests.length;
  f.modelState.retryModels(); await settle();
  assert.equal(f.requests.length, before + 1); assert.equal(f.pending('models').options.method ?? 'GET', 'GET');
  assert.equal(f.requests.filter(item => item.options.method === 'POST').length, 1);
  f.reply('models', catalog); await settle();
  assert.equal(f.api.accessDenied, true, '目录成功不放开原访问清理边界');
  assert.equal(f.modelState.modelRecoveryHint, '', '有实际目录后隐藏刷新指引');
  assert.equal(f.modelState.modelValue, intent, '不要求重新选择模型');
  const retry = f.api.send('保留原文', 'jack', model, f.modelState.modelValue);
  assert.equal(f.pending('message').options.body, originalBytes, '正文、模型和requestId字节完全不变');
  f.reply('message', { mission: { id: 'm-new', state: 'running' } }, 202); await retry; await settle();
  assert.equal(f.api.retryNeedsModelCatalog, false);
});

test('新协作401/403/JSON404不误提示刷新目录可恢复原提交，切换清理旧空404指引', async () => {
  for (const [status, body, raw] of [[401, '', true], [403, { error: '访问撤销' }, false], [404, { error: '不存在' }, false]]) {
    const f = fixture({ withModels: true, missionId: '' });
    f.reply('crew', crew); f.reply('missions', { missions: [] }); f.reply('models', { groups: [], failures: [] }); await settle();
    const first = f.api.send('原文', 'jack'); f.reply('message', body, status, raw); await first; await settle();
    assert.equal(f.api.retryNeedsModelCatalog, false);
    assert.equal(f.modelState.modelRecoveryHint, ''); assert.equal(f.pending('models'), undefined);
    assert.equal(f.requests.filter(item => item.options.method === 'POST').length, 1);
  }
  const f = fixture({ withModels: true, missionId: '' });
  f.reply('crew', crew); f.reply('missions', { missions: [] }); f.reply('models', { groups: [], failures: [] }); await settle();
  const first = f.api.send('旧内容', 'jack'); f.reply('message', '', 404, true); await first; await settle();
  assert.equal(f.api.retryNeedsModelCatalog, true);
  f.api.select('m2'); await settle();
  assert.equal(f.api.retryNeedsModelCatalog, false); assert.equal(f.modelState.modelRecoveryHint, '');
});

test('列表拒权后的旧mission和crew成功回包不得恢复受保护内容', async () => {
  const f = fixture(); f.reply('missions', '{"error":"访问撤销"}', 403, true); await settle();
  f.reply('crew', crew); f.reply('mission', data([event(1), event(2)])); await settle();
  assert.equal(f.api.events.length, 0); assert.equal(f.api.crew.length, 0); assert.equal(f.api.mission, null); assert.equal(f.tick(), false);
});

test('App模型401/403/JSON404立即清理已读内容且不因epoch更新自动循环读取', async () => {
  for (const status of [401, 403, 404]) {
    const f = fixture({ withModels: true });
    f.reply('crew', crew); f.reply('missions', { missions: [{ id: 'm1' }] }); f.reply('mission', data([event(1)], 'completed')); await settle();
    assert.equal(f.api.events.length, 1); assert.equal(f.api.crew.length, 1);
    f.reply('models', { error: '访问撤销' }, status); await settle();
    assert.equal(f.api.events.length, 0); assert.equal(f.api.crew.length, 0); assert.equal(f.api.missions.length, 0); assert.equal(f.api.mission, null);
    assert.equal(f.api.accessEpoch, 1); assert.equal(f.api.accessDenied, true);
    assert.equal(f.modelState.modelCatalog.loading, false); assert.equal(f.pending('models'), undefined);
    const count = f.requests.length; f.tick(); await settle(); assert.equal(f.requests.length, count);
    f.modelState.retryModels(); await settle();
    assert.equal(f.requests.length, count + 1, '显式重试只增加一次模型目录GET');
    f.reply('models', { error: '仍无权限' }, status); await settle();
    assert.equal(f.pending('models'), undefined); assert.equal(f.requests.length, count + 1);
    assert.ok(f.requests.every(item => item.options.method !== 'POST'));
  }
});

test('旧选中任务或旧访问版本的独立拒权不能清理当前任务，普通503不算拒权', async () => {
  const f = await loaded('completed');
  const scope = { id: f.api.id, selectionEpoch: f.api.selectionEpoch, accessEpoch: f.api.accessEpoch };
  f.api.select('m2'); await settle(); f.api.select('m1'); await settle();
  f.reply('mission', data([event(3)], 'completed')); await settle();
  assert.equal(f.api.rejectAccess(Object.assign(new Error('旧拒权'), { status: 403 }), scope), false);
  assert.equal(f.api.events.length, 1);
  const current = { id: f.api.id, selectionEpoch: f.api.selectionEpoch, accessEpoch: f.api.accessEpoch };
  assert.equal(f.api.rejectAccess(Object.assign(new Error('暂时失败'), { status: 503 }), current), false);
  assert.equal(f.api.rejectAccess(Object.assign(new Error('当前拒权'), { status: 403 }), current), true); await settle();
  assert.equal(f.api.events.length, 0);
  assert.equal(f.api.rejectAccess(Object.assign(new Error('迟到拒权'), { status: 403 }), current), false);
  assert.equal(f.api.accessEpoch, 1);
});

test('App模型普通503保留已读任务，迟到的旧模型拒权不影响新选择', async () => {
  const f = fixture({ withModels: true });
  f.reply('crew', crew); f.reply('missions', { missions: [] }); f.reply('mission', data([event(1)], 'completed')); await settle();
  f.reply('models', { error: '目录暂不可用' }, 503); await settle();
  assert.equal(f.api.events.length, 1); assert.equal(f.api.accessEpoch, 0); assert.equal(f.api.accessDenied, false);
  f.modelState.retryModels(); await settle(); const old = f.pending('models');
  f.api.select('m2'); await settle();
  f.reply('mission', { ...data([event(2)], 'completed'), mission: { id: 'm2', state: 'completed' } }); await settle();
  old.resolve({ ok: false, status: 403, json: async () => ({ error: '旧任务已撤权' }) }); await settle();
  assert.equal(f.api.id, 'm2'); assert.equal(f.api.events.length, 1); assert.equal(f.api.accessEpoch, 0);
});

test('App模型临时路由404只沿用任务GET恢复，模型自身不自动重试且恢复不写入', async () => {
  const f = fixture({ withModels: true });
  f.reply('crew', crew); f.reply('missions', { missions: [] }); f.reply('mission', data([event(1)], 'completed')); await settle();
  f.reply('models', '', 404, true); await settle();
  assert.equal(f.api.events.length, 0); assert.equal(f.pending('models'), undefined);
  assert.equal(f.tick(), 4000); assert.equal(f.pending('mission'), undefined);
  assert.equal(f.tick(), 3000); assert.equal(new URL(f.pending('mission').url).searchParams.get('after'), '0');
  f.reply('mission', data([event(1), event(2)], 'interrupted')); await settle();
  assert.equal(f.api.restore, true); assert.equal(f.api.accessDenied, false); assert.ok(f.pending('models'));
  f.reply('models', { groups: [], failures: [] }); f.reply('crew', crew); f.reply('missions', { missions: [] }); await settle();
  assert.equal(f.api.events.length, 2); assert.equal(f.modelState.modelCatalog.error, '');
  assert.ok(f.requests.every(item => item.options.method !== 'POST'));
});

test('已有任务选模型后丢ACK，GET已running的原意图重试冻结完整首次payload', async () => {
  for (const model of [{ provider: 'deepseek-official', model: 'model-a' }, null]) {
  const f = await loaded('completed'); const intent = model === null ? 'auth-default' : 'selected-model-a';
  const sending = f.api.send('继续原文', 'jack', model, intent);
  const originalBytes = f.pending('message').options.body;
  const original = JSON.parse(f.pending('message').options.body);
  f.reply('message', '', 202, true); await sending; await settle();
  f.tick(); f.reply('mission', data([event(3)], 'running')); await settle();
  const retry = f.api.send('继续原文', 'jack', undefined, intent);
  const repeated = JSON.parse(f.pending('message').options.body);
  assert.equal(f.pending('message').options.body, originalBytes, '服务器收到的payload字节保持一致，包括Auth默认null');
  assert.deepEqual(repeated, original, 'running门槛省略模型参数不能改变已经提交的payload或请求号');
  f.reply('message', { mission: { id: 'm1', state: 'running' } }, 202);
  assert.equal((await retry).modelSelectionSent, true, 'App按原payload清理模型草稿');
  }
});

test('用户主动修改正文、目标或模型意图时发送新payload，Auth默认null与继承不混用', async () => {
  for (const change of [{ message: '修改正文' }, { target: 'blog' }, { model: { provider: 'fixture', model: 'another' }, intent: 'another' }, { model: undefined, intent: '' }]) {
    const f = await loaded('completed');
    const first = f.api.send('原文', 'jack', null, 'auth-default'); const original = JSON.parse(f.pending('message').options.body);
    f.reply('message', '', 202, true); await first; await settle();
    const model = Object.hasOwn(change, 'model') ? change.model : null;
    const sending = f.api.send(change.message ?? '原文', change.target ?? 'jack', model, change.intent ?? 'auth-default');
    const changed = JSON.parse(f.pending('message').options.body);
    assert.notEqual(changed.requestId, original.requestId); assert.equal(changed.message, change.message ?? '原文'); assert.equal(changed.target, change.target ?? 'jack');
    assert.equal(Object.hasOwn(changed, 'modelSelection'), model !== undefined); if (model !== undefined) assert.deepEqual(changed.modelSelection, model);
    f.reply('message', { mission: { id: 'm1', state: 'running' } }, 202); await sending;
  }
});
