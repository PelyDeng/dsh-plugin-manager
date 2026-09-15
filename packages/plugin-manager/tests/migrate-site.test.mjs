/** migrate-site 只做一次性元数据转换：预览只读，apply 在互斥下按 6.2/6.3 顺序转换。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { main, migrateSiteApply, migrateSitePreview, ownerTargetMatches } from '../src/migrate-site.mjs';
import { acquireLock, readState } from '../src/installation.mjs';
import { readBinding } from '../src/site-binding.mjs';
import { hostname } from 'node:os';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const STOPPED_PID = 2147483647;

/** 已停止的管理者：真实退出进程的 PID 会被复用，按 deployment.test.mjs 的既有约定模拟。 */
function stoppedManager(t) {
  const kill = process.kill;
  t.mock.method(process, 'kill', function (pid, signal) {
    if (pid === STOPPED_PID && signal === 0) throw Object.assign(new Error('fixture manager is stopped'), { code: 'ESRCH' });
    return kill.call(this, pid, signal);
  });
}

function fixture(t, { legacyState = true, pending = false, explicitPlugins = false, conf = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-migrate-site-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  stoppedManager(t);
  const put = (path, value) => { path = resolve(root, path); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); return path; };
  const config = conf
    ? put('.local/env.conf', `# 旧站点配置\nDSH_PLUGIN_SOURCE=source\nDSH_HOME=${JSON.stringify(resolve(root, '.local/data/dsh-home'))}\n${explicitPlugins ? 'DSH_PLUGINS=["auth"]\n' : ''}`)
    : put('.local/site.json', JSON.stringify({ ...(explicitPlugins ? { plugins: ['auth'] } : {}), ...(conf ? {} : {}) }));
  const profile = resolve(root, '.local/data/dsh-home/profiles/web');
  if (legacyState) put(join(profile, '.deepseek-plugin-state.json'), { schemaVersion: 2, candidates: ['auth', 'example'], plugins: [{ id: 'auth', package: 'dsh-auth' }, { id: 'example', package: 'dsh-example' }] });
  if (pending) put(join(profile, '.deepseek-plugin-pending.json'), { schemaVersion: 2, operationId: '11111111-1111-4111-8111-111111111111', desired: {}, touched: [{ id: 'auth', package: 'dsh-auth' }, { id: 'other', package: 'unmanaged-touched' }] });
  put(join(profile, 'package.json'), { dependencies: { 'dsh-auth': 'file:../../plugin-packages/auth.tgz', 'someone-else': '1.0.0' }, dsh: { profile: { bundles: ['dsh-auth'] } } });
  put('.local/data/dsh-home/plugin-packages/auth.tgz', 'legacy archive');
  const stoppedFile = put('stopped.json', { schemaVersion: 1, home: resolve(root, '.local/data/dsh-home'), profile: 'web', manager: 'process', instanceId: 'legacy', pid: STOPPED_PID, stopped: true, stoppedAt: new Date().toISOString() });
  return { root, put, profile, stoppedFile: 'stopped.json', config };
}

/**
 * 旧运行容器声明的归档挂载：容器内 /opt/plugin-packages 对应**旧发布目录**（不是新缓存根）。
 * 迁移必须按 destination→source 把容器地址换算回那里，再复制进本次缓存。
 */
function withContainerMount(f, { spec, mount = '.local/artifacts/source-release-old', archive = 'legacy/foo.tgz', content = 'legacy archive' }) {
  const source = resolve(f.root, mount);
  const manifest = read(join(f.profile, 'package.json'));
  manifest.dependencies = { 'dsh-auth': spec };
  writeFileSync(join(f.profile, 'package.json'), JSON.stringify(manifest));
  const compose = f.put('.local/artifacts/compose.json', { services: { dsh: { image: 'runtime@sha256:' + 'a'.repeat(64), volumes: [{ type: 'bind', source, target: '/opt/plugin-packages', read_only: true }] } } });
  f.put('.local/artifacts/active-compose.json', { schemaVersion: 1, project: 'dsh-plugins', path: compose, runtime: {} });
  if (content !== null) f.put(join(source, archive), content);
  return { source, archive, cache: resolve(f.root, '.local/artifacts/plugin-packages') };
}

test('preview is read-only and lists the conversion plan and unmanaged installs', t => {
  const f = fixture(t, { pending: true });
  const before = readFileSync(join(f.profile, '.deepseek-plugin-state.json'), 'utf8');
  const preview = migrateSitePreview(f.root, { config: f.config });
  assert.equal(preview.state.schemaVersion, 2);
  assert.deepEqual(preview.managed, [{ id: 'auth', package: 'dsh-auth' }, { id: 'example', package: 'dsh-example' }, { id: 'other', package: 'unmanaged-touched' }]);
  assert.deepEqual(preview.nonManaged, [{ package: 'someone-else', spec: '1.0.0' }]);
  assert.deepEqual(preview.fileRefs.map(item => item.package), ['dsh-auth']);
  assert.equal(preview.binding, null);
  assert.deepEqual(preview.candidates, ['auth', 'example']);
  assert.equal(readFileSync(join(f.profile, '.deepseek-plugin-state.json'), 'utf8'), before);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
});

test('preview neither copies archives nor creates the cache for mounted references', t => {
  const f = fixture(t);
  const mounted = withContainerMount(f, { spec: 'file:/opt/plugin-packages/legacy/foo.tgz' });
  const preview = migrateSitePreview(f.root, { config: f.config });
  const entry = preview.fileRefs.find(item => item.package === 'dsh-auth');
  assert.equal(entry.kind, 'mounted');
  assert.equal(entry.cached, 'plugin-packages/legacy/foo.tgz');
  // 容器地址本身在主机上不存在；预览只规划，不复制。
  assert.equal(existsSync(join(mounted.source, mounted.archive)), true);
  assert.equal(existsSync(join(mounted.cache, mounted.archive)), false);
  assert.equal(existsSync(join(f.root, '.local/site-binding.json')), false);
});

test('apply writes the binding, marks, schema 3 managed set and backs up legacy records', t => {
  const f = fixture(t, { pending: true });
  const result = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.equal(result.status, 'migrated');
  assert.equal(result.binding.siteId.startsWith('site-'), true);
  assert.deepEqual(result.moved, ['.deepseek-plugin-pending.json']);
  assert.deepEqual(readState(join(f.profile, '.deepseek-plugin-state.json')).managed.map(e => e.id), ['auth', 'example', 'other']);
  assert.equal(existsSync(join(f.profile, '.deepseek-plugin-pending.json')), false);
  assert.equal(existsSync(resolve(f.root, '.local/data', '.dsh-site-id')), true);
  assert.equal(readBinding(f.root).composeProject, 'dsh-plugins');
  assert.deepEqual(read(join(f.root, '.local/site.json')).plugins, ['auth', 'example']);
  // 旧记录先备份再移走，且备份里留有旧状态与方案摘要。
  assert.equal(existsSync(join(result.backup, '.deepseek-plugin-pending.json')), true);
  assert.equal(existsSync(join(result.backup, 'profile-state.json')), true);
  assert.equal(read(join(result.backup, 'plan.json')).managed.length, 3);
});

test('apply is idempotent for the same site and does not widen ownership', t => {
  const f = fixture(t);
  const first = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  const again = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.equal(again.binding.siteId, first.binding.siteId);
  assert.deepEqual(readState(join(f.profile, '.deepseek-plugin-state.json')).managed, first.managed);
});

test('apply keeps an explicit selection untouched and rejects invalid stop evidence', t => {
  const f = fixture(t, { explicitPlugins: true });
  assert.throws(() => migrateSiteApply(f.root, {}), /stopped-file/);
  assert.throws(() => migrateSiteApply(f.root, { stoppedFile: 'missing-evidence.json' }), /ENOENT/);
  // 证据字段齐全但管理者仍在运行：实查拒绝，不接受只填 stopped=true。
  const alive = JSON.parse(readFileSync(join(f.root, f.stoppedFile), 'utf8'));
  alive.pid = process.pid;
  writeFileSync(join(f.root, f.stoppedFile), JSON.stringify(alive));
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /进程状态与证据不符/);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
  alive.pid = STOPPED_PID;
  writeFileSync(join(f.root, f.stoppedFile), JSON.stringify(alive));
  migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.deepEqual(read(join(f.root, '.local/site.json')).plugins, ['auth']);
});

test('the CLI passes stopping evidence through to apply', t => {
  const f = fixture(t);
  main(['--root', f.root, '--config', '.local/site.json', '--apply', '--stopped-file', 'stopped.json']);
  assert.equal(read(join(f.root, '.local/site.json')).plugins.length, 2);
  assert.equal(readState(join(f.profile, '.deepseek-plugin-state.json')).schemaVersion, 3);
});

test('a legacy .conf entry is migrated and loses the removed source-mode field', t => {
  const f = fixture(t, { conf: true });
  const preview = migrateSitePreview(f.root, { config: '.local/env.conf' });
  assert.equal(preview.legacyMode, 'source');
  const result = migrateSiteApply(f.root, { config: '.local/env.conf', stoppedFile: f.stoppedFile });
  assert.deepEqual(result.selection, ['auth', 'example']);
  const text = readFileSync(resolve(f.root, '.local/env.conf'), 'utf8');
  assert.equal(text.includes('DSH_PLUGIN_SOURCE'), false);
  assert.equal(text.includes('DSH_PLUGINS=["auth","example"]'), true);
});

test('unreachable file references reject the migration before any writes', t => {
  const f = fixture(t);
  const manifest = read(join(f.profile, 'package.json'));
  manifest.dependencies['broken-archive'] = 'file:../../missing/broken.tgz';
  writeFileSync(join(f.profile, 'package.json'), JSON.stringify(manifest));
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /不可达/);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
  assert.equal(read(join(f.profile, '.deepseek-plugin-state.json')).schemaVersion, 2);
});

test('mounted references are preserved by mapping the container address back to the host mount', t => {
  const f = fixture(t);
  const mounted = withContainerMount(f, { spec: 'file:/opt/plugin-packages/legacy/foo.tgz' });
  const result = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.equal(result.fileRefs, 1);
  // 完整相对路径 legacy/foo.tgz 保留在新缓存根下，源归档仍在原处。
  assert.equal(readFileSync(join(mounted.cache, mounted.archive), 'utf8'), 'legacy archive');
  assert.equal(readFileSync(join(mounted.source, mounted.archive), 'utf8'), 'legacy archive');
  assert.equal(readState(join(f.profile, '.deepseek-plugin-state.json')).schemaVersion, 3);
});

test('a cache target with different content rejects the migration', t => {
  const f = fixture(t);
  const mounted = withContainerMount(f, { spec: 'file:/opt/plugin-packages/legacy/foo.tgz' });
  f.put(join(mounted.cache, mounted.archive), 'different bytes');
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /内容不同/);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
});

test('an unrestorable legacy selection demands an explicit DSH_PLUGINS instead of guessing', t => {
  const f = fixture(t, { legacyState: false });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /无法还原旧有效候选集合/);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
  const config = read(join(f.root, '.local/site.json'));
  config.plugins = [];
  writeFileSync(join(f.root, '.local/site.json'), JSON.stringify(config));
  const result = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.deepEqual(result.managed, []);
  assert.deepEqual(read(join(f.root, '.local/site.json')).plugins, []);
});

test('missing legacy state without explicit selection is rejected before any write', t => {
  const f = fixture(t, { legacyState: false, explicitPlugins: true });
  const result = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.deepEqual(result.managed, []);
  assert.equal(result.selection, null);
});

test('rebind updates bound paths only after checking the new target marks', t => {
  const f = fixture(t);
  migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  // 物理搬迁：整棵持久树（含站点标记）复制到独立的新位置。
  const dataRoot = resolve(f.root, 'data/new-data');
  cpSync(resolve(f.root, '.local/data'), dataRoot, { recursive: true });
  const home = join(dataRoot, 'dsh-home');
  const config = read(join(f.root, '.local/site.json')); config.dataRoot = dataRoot; config.home = home;
  writeFileSync(join(f.root, '.local/site.json'), JSON.stringify(config));
  writeFileSync(join(f.root, 'stopped.json'), JSON.stringify({ schemaVersion: 1, home, profile: 'web', manager: 'process', instanceId: 'legacy', pid: STOPPED_PID, stopped: true, stoppedAt: new Date().toISOString() }));
  const rebind = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile, rebind: true });
  assert.equal(rebind.binding.home, home);
  assert.equal(rebind.binding.dataRoot, dataRoot);
  assert.equal(readFileSync(join(dataRoot, '.dsh-site-id'), 'utf8').trim(), rebind.siteId);
});

test('rebind refuses a target directory that is not marked for this site', t => {
  const f = fixture(t);
  migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  const dataRoot = resolve(f.root, 'data/new-data');
  cpSync(resolve(f.root, '.local/data'), dataRoot, { recursive: true });
  rmSync(join(dataRoot, '.dsh-site-id'));
  const home = join(dataRoot, 'dsh-home');
  const config = read(join(f.root, '.local/site.json')); config.dataRoot = dataRoot; config.home = home;
  writeFileSync(join(f.root, '.local/site.json'), JSON.stringify(config));
  writeFileSync(join(f.root, 'stopped.json'), JSON.stringify({ schemaVersion: 1, home, profile: 'web', manager: 'process', instanceId: 'legacy', pid: STOPPED_PID, stopped: true, stoppedAt: new Date().toISOString() }));
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile, rebind: true }), /目标目录缺少本站点标记/);
  assert.equal(readBinding(f.root).dataRoot, resolve(f.root, '.local/data'));
});

test('rebind refuses a target whose nested workspace is missing', t => {
  const f = fixture(t);
  migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  const dataRoot = resolve(f.root, 'data/new-data');
  cpSync(resolve(f.root, '.local/data'), dataRoot, { recursive: true });
  // 复制时漏掉 dataRoot 内部的 workspace：不能靠 rebind 补成一个空目录（标记根去重会掩盖它）。
  rmSync(join(dataRoot, 'workspace'), { recursive: true, force: true });
  const home = join(dataRoot, 'dsh-home');
  const config = read(join(f.root, '.local/site.json')); config.dataRoot = dataRoot; config.home = home;
  writeFileSync(join(f.root, '.local/site.json'), JSON.stringify(config));
  writeFileSync(join(f.root, 'stopped.json'), JSON.stringify({ schemaVersion: 1, home, profile: 'web', manager: 'process', instanceId: 'legacy', pid: STOPPED_PID, stopped: true, stoppedAt: new Date().toISOString() }));
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile, rebind: true }), /目标目录不存在/);
  assert.equal(existsSync(join(dataRoot, 'workspace')), false);
  assert.equal(readBinding(f.root).dataRoot, resolve(f.root, '.local/data'));
});

test('a persistent directory that disappeared blocks the migration', t => {
  const f = fixture(t);
  migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  rmSync(resolve(f.root, '.local/data/dsh-home'), { recursive: true, force: true });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /没有可迁移的现场|持久目录缺失/);
});

test('an interrupted conversion keeps the confirmed selection when it is re-run', t => {
  const f = fixture(t, { conf: true });
  const first = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.deepEqual(first.selection, ['auth', 'example']);
  // 重建「schema 3 已写、配置替换失败」的中断现场：配置回到转换前的内容，并且抹掉计划的完成标记
  // （完成标记是最后一步写的，真实中断时它一定不存在）。
  const configPath = resolve(f.root, '.local/env.conf');
  writeFileSync(configPath, `# 旧站点配置\nDSH_PLUGIN_SOURCE=source\nDSH_HOME=${JSON.stringify(resolve(f.root, '.local/data/dsh-home'))}\n`);
  const planPath = resolve(first.backup, 'plan.json');
  const plan = read(planPath); delete plan.completedAt;
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  // 缺一个本次转换本来就该创建的标记，验证重入同时能补标记与恢复选集。
  rmSync(resolve(f.root, '.local/artifacts', '.dsh-site-id'));
  const again = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  const text = readFileSync(configPath, 'utf8');
  // 旧候选集合只能从同次转换的迁移计划恢复：既不能猜，也不能悄悄变成「全部候选」。
  assert.deepEqual(again.selection, ['auth', 'example']);
  assert.equal(text.includes('DSH_PLUGIN_SOURCE'), false);
  assert.equal(text.includes('DSH_PLUGINS=["auth","example"]'), true);
  assert.equal(existsSync(resolve(f.root, '.local/artifacts', '.dsh-site-id')), true);
  // 每次 apply 都写自己的备份目录：完成标记写在这一次的计划里。
  assert.equal(read(resolve(again.backup, 'plan.json')).completedAt !== undefined, true);
});

test('a completed conversion is not treated as a re-entry that repairs later damage', t => {
  const f = fixture(t);
  migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  // 转换已经完成；此后现场被改动（授权集合变了）不再算「同一次转换」，不能自动补标记或恢复选集。
  const statePath = resolve(f.profile, '.deepseek-plugin-state.json');
  const state = read(statePath); state.managed = state.managed.slice(0, 1);
  writeFileSync(statePath, JSON.stringify(state));
  rmSync(resolve(f.root, '.local/artifacts', '.dsh-site-id'));
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /缺少站点标记/);
  assert.equal(existsSync(resolve(f.root, '.local/artifacts', '.dsh-site-id')), false);
});

test('a conversion interrupted before creating a planned directory completes it on re-run', t => {
  const f = fixture(t);
  const workspace = resolve(f.root, '.local/data/workspace');
  assert.equal(existsSync(workspace), false);
  const first = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.equal(existsSync(workspace), true);
  // 计划记录的是「本次才创建」的目录：重入可以补建它，但不能补建计划里当时已存在的目录。
  const planPath = resolve(first.backup, 'plan.json');
  const recorded = read(planPath).createdDirectories;
  assert.equal(recorded.includes(workspace), true);
  assert.equal(recorded.includes(resolve(f.root, '.local/data')), false);
  // 中断现场：目录还没建起来，但计划和绑定已经写好（完成标记是最后一步写的，此时一定不存在）。
  rmSync(workspace, { recursive: true, force: true });
  const plan = read(planPath); delete plan.completedAt;
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const again = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.equal(again.binding.siteId, first.binding.siteId);
  assert.equal(existsSync(workspace), true);
  assert.equal(readFileSync(resolve(workspace, '..', '.dsh-site-id'), 'utf8').trim(), again.siteId);
  // 原本存在的目录被移走时仍然拒绝，不会补成空目录。
  rmSync(resolve(f.root, '.local/data'), { recursive: true, force: true });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /没有可迁移的现场|持久目录缺失/);
});

test('another site mark is still refused while completing an interrupted conversion', t => {
  const f = fixture(t);
  migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  writeFileSync(resolve(f.root, '.local/artifacts', '.dsh-site-id'), 'site-other\n');
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /其他站点/);
});

test('a live profile lock refuses the migration instead of being moved away', t => {
  const f = fixture(t);
  const held = acquireLock(f.profile);
  try {
    assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /仍由本机进程|正在同步/);
  } finally { held(); }
  // 活动锁不得被搬走，迁移也不得写任何管理元数据。
  assert.equal(existsSync(join(f.profile, '.deepseek-plugin-lock')), false);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
  assert.equal(read(join(f.profile, '.deepseek-plugin-state.json')).schemaVersion, 2);
});

test('a locally dead residual lock is retired into the backup before taking the shared lock', t => {
  const f = fixture(t);
  // 本机进程留下的锁：PID 已退出，可以在本机直接核实。
  f.put(join(f.profile, '.deepseek-plugin-lock'), { pid: 2147483647, host: hostname(), createdAt: new Date().toISOString(), token: '11111111-1111-4111-8111-111111111111' });
  const result = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.equal(result.retiredLock, true);
  assert.equal(existsSync(join(f.profile, '.deepseek-plugin-lock')), false);
  assert.equal(read(join(result.backup, '.deepseek-plugin-lock')).pid, 2147483647);
  assert.equal(readState(join(f.profile, '.deepseek-plugin-state.json')).schemaVersion, 3);
});

test('a lock of unprovable provenance is never retired on another process evidence alone', t => {
  const f = fixture(t);
  // 容器命名空间的锁（主机名不是本机），而停写证据声明的是 process：无法证明持有者已退出。
  f.put(join(f.profile, '.deepseek-plugin-lock'), { pid: 999999, host: 'container-host', createdAt: new Date().toISOString(), token: '11111111-1111-4111-8111-111111111111' });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /无法核实持有者是否退出/);
  // 原记录原样留在原位，迁移没有写任何管理元数据。
  assert.equal(read(join(f.profile, '.deepseek-plugin-lock')).host, 'container-host');
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
  assert.equal(read(join(f.profile, '.deepseek-plugin-state.json')).schemaVersion, 2);
});

test('a foreign running record is not retired without container provenance', t => {
  const f = fixture(t);
  f.put(join(f.profile, '.deepseek-plugin-owner.json'), { home: resolve(f.root, '.local/data/dsh-home'), profile: 'web', host: 'container-host', pid: 999999, port: 1, token: '22222222-2222-4222-8222-222222222222', createdAt: new Date().toISOString() });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /运行记录来自其他主机/);
  assert.equal(existsSync(join(f.profile, '.deepseek-plugin-owner.json')), true);
});

test('a local lock without a usable PID is refused instead of treated as exited', t => {
  const f = fixture(t);
  // 本机主机名但没有可用 PID：无法证明持有者已退出，不能当成旧记录退役。
  f.put(join(f.profile, '.deepseek-plugin-lock'), { host: hostname(), createdAt: new Date().toISOString(), token: '11111111-1111-4111-8111-111111111111' });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /记录不完整或已损坏/);
  assert.equal(read(join(f.profile, '.deepseek-plugin-lock')).pid, undefined);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
  // 损坏的锁记录同样拒绝；完整记录仍然可以退役。
  rmSync(join(f.profile, '.deepseek-plugin-lock'));
  f.put(join(f.profile, '.deepseek-plugin-lock'), '{ 这不是 JSON');
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /profile 锁记录无法解析/);
  rmSync(join(f.profile, '.deepseek-plugin-lock'));
  f.put(join(f.profile, '.deepseek-plugin-lock'), { host: hostname(), pid: 2147483647, createdAt: new Date().toISOString(), token: '33333333-3333-4333-8333-333333333333' });
  const result = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.equal(result.retiredLock, true);
});

test('an OWNER written the way supervisor writes it is retired, not rejected as corrupt', t => {
  const f = fixture(t);
  // 与 supervisor.mjs 的写入字段完全一致：home/profile/host/pid/port/token，没有 createdAt。
  f.put(join(f.profile, '.deepseek-plugin-owner.json'), { home: resolve(f.root, '.local/data/dsh-home'), profile: 'web',
    host: hostname(), pid: 2147483647, port: 41234, token: '44444444-4444-4444-8444-444444444444' });
  const result = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  assert.deepEqual(result.moved, ['.deepseek-plugin-owner.json']);
  assert.equal(existsSync(join(f.profile, '.deepseek-plugin-owner.json')), false);
  assert.equal(read(join(result.backup, '.deepseek-plugin-owner.json')).port, 41234);
  // 字段不全的 OWNER 仍然拒绝（例如缺 token 或 port）。
  const g = fixture(t);
  g.put(join(g.profile, '.deepseek-plugin-owner.json'), { home: resolve(g.root, '.local/data/dsh-home'), profile: 'web', host: hostname(), pid: 2147483647 });
  assert.throws(() => migrateSiteApply(g.root, { config: g.config, stoppedFile: g.stoppedFile }), /运行记录不完整或已损坏/);
});

test('a foreign OWNER is refused for provenance, not for its format', t => {
  const f = fixture(t);
  f.put(join(f.profile, '.deepseek-plugin-owner.json'), { home: resolve(f.root, '.local/data/dsh-home'), profile: 'web',
    host: 'container-host', pid: 999999, port: 41234, token: '55555555-5555-4555-8555-555555555555' });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /运行记录来自其他主机/);
});

test('an OWNER with a complete record but another target is refused', t => {
  const f = fixture(t);
  // 字段完整、本机进程已退出，但 home 指向别的目录：不能因为「本机 PID 已退出」就退役别人的记录。
  f.put(join(f.profile, '.deepseek-plugin-owner.json'), { home: resolve(f.root, 'elsewhere/dsh-home'), profile: 'web',
    host: hostname(), pid: 2147483647, port: 41234, token: '66666666-6666-4666-8666-666666666666' });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /目标 home（.*）与本次迁移（.*）不一致/);
  assert.equal(existsSync(join(f.profile, '.deepseek-plugin-owner.json')), true);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
  // profile 不符同样拒绝（即使 home 正确）。
  rmSync(join(f.profile, '.deepseek-plugin-owner.json'));
  f.put(join(f.profile, '.deepseek-plugin-owner.json'), { home: resolve(f.root, '.local/data/dsh-home'), profile: 'other',
    host: hostname(), pid: 2147483647, port: 41234, token: '77777777-7777-4777-8777-777777777777' });
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /目标 profile（other）与本次迁移（web）不一致/);
});

test('owner target matching accepts the host home, a mount-mapped home and the container home', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-owner-target-')));
  t.after(() => { assert.equal(dirname(root), realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const deployment = { root, dataRoot: resolve(root, '.local/data'), home: resolve(root, '.local/data/dsh-home'), workspace: resolve(root, '.local/data/workspace') };
  const record = { home: deployment.home, profile: 'web', host: 'container-host', pid: 1, port: 1, token: 'x' };
  assert.equal(ownerTargetMatches(record, deployment), true);
  // 容器内写法：dataRoot 挂到 /data，home 保持相对路径。
  assert.equal(ownerTargetMatches({ ...record, home: '/data/dsh-home' }, deployment), true);
  // 自定义挂载：home 单独挂到 /dsh-home，按旧挂载映射换算回宿主路径。
  assert.equal(ownerTargetMatches({ ...record, home: '/dsh-own-home' }, deployment, [{ source: deployment.home, target: '/dsh-own-home' }]), true);
  // 子路径是另一个数据目录，不是同一个 home：不认。
  assert.equal(ownerTargetMatches({ ...record, home: '/dsh-own-home/nested' }, deployment, [{ source: deployment.home, target: '/dsh-own-home' }]), false);
  // 映射指到别的宿主目录、或写法根本不匹配 → 不符。
  assert.equal(ownerTargetMatches({ ...record, home: '/dsh-own-home' }, deployment, [{ source: resolve(root, 'other'), target: '/dsh-own-home' }]), false);
  assert.equal(ownerTargetMatches({ ...record, home: resolve(root, 'elsewhere') }, deployment), false);
  assert.equal(ownerTargetMatches({ ...record, home: '/data/other-home' }, deployment), false);
});

test('a corrupt old activity record only removes a mapping clue, and an explicit archive root restores it', t => {
  const f = fixture(t);
  const mounted = withContainerMount(f, { spec: 'file:/opt/plugin-packages/legacy/foo.tgz' });
  // 旧记录损坏不是迁移的前置条件（设计 6.2）：无法换算的引用要指名报错，而不是解析异常。
  f.put('.local/artifacts/active-compose.json', '{ 这已经不是 JSON');
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /引用不可达/);
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), false);
  // 操作者明确声明旧归档位置后可以完成迁移，完整相对路径保留。
  const result = migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile, archiveRoot: mounted.source });
  assert.equal(result.fileRefs, 1);
  assert.equal(readFileSync(join(mounted.cache, mounted.archive), 'utf8'), 'legacy archive');
  assert.equal(JSON.parse(readFileSync(resolve(result.backup, 'plan.json'), 'utf8')).archiveRoot, mounted.source);
});

test('a site config carrying another siteId is refused by the shared identity check', t => {
  const f = fixture(t);
  migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile });
  const config = read(join(f.root, '.local/site.json'));
  config.siteId = 'site-other';
  writeFileSync(join(f.root, '.local/site.json'), JSON.stringify(config));
  assert.throws(() => migrateSiteApply(f.root, { config: f.config, stoppedFile: f.stoppedFile }), /与站点绑定不一致/);
});
