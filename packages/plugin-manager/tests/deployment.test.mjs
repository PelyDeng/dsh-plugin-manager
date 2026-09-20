/** Isolated profile behavior tests; real DSH startup is verified separately. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { resolveDeployment, parseArguments, loadRelease, runtimeEnvironment, computeChanges, synchronize, atomicJSON, finalize, acquireLock, renderCompose, checkDataSelection, verifyReady, adoptLegacy, tarCommand, supervise, prepareOfflineDependencies, main } from '../src/deployment.mjs';
import { installedMatches, readState } from '../src/installation.mjs';
import { verificationSubjects } from '../src/verification.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const statePath = deployment => join(deployment.profileRoot, '.deepseek-plugin-state.json');

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-deployment-test-')));
  t.after(() => {
    assert.equal(dirname(root), realpathSync.native(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  // schema 3 需要站点身份：本次部署配置提供 siteId（容器内由 candidate 提供，宿主由绑定提供）。
  const siteConfig = join(root, 'site.json'); writeFileSync(siteConfig, `${JSON.stringify({ siteId: 'site-fixture' }, null, 2)}\n`);
  const deployment = resolveDeployment({ root, config: siteConfig, home: 'data/home', 'host-mode': 'owned' }, {});
  const stoppedFile = join(root, 'stopped.json');
  // Simulate a stopped manager: a real exited child's PID can be reused by tar/Node.
  const stoppedPid = 2147483647;
  const kill = process.kill;
  t.mock.method(process, 'kill', function(pid, signal) {
    if (pid === stoppedPid && signal === 0) throw Object.assign(new Error('fixture manager is stopped'), { code: 'ESRCH' });
    return kill.call(this, pid, signal);
  });
  atomicJSON(stoppedFile, { schemaVersion: 1, home: deployment.home, profile: 'web', manager: 'process', instanceId: 'isolated', pid: stoppedPid, stopped: true, stoppedAt: new Date().toISOString() });
  deployment.options['stopped-file'] = stoppedFile;
  const directory = join(root, 'release'); mkdirSync(directory);
  const plugins = [];
  for (const id of ['alpha', 'beta']) {
    const stage = join(root, `stage-${id}`, 'package'); mkdirSync(stage, { recursive: true });
    const metadata = { name: `fixture-${id}`, version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, deepseekPlugin: { schemaVersion: 3, id } };
    writeFileSync(join(stage, 'package.json'), JSON.stringify(metadata));
    writeFileSync(join(stage, 'index.js'), `export const name = '${id}';\n`);
    writeFileSync(join(stage, 'cordis.patch.yml'), '{}\n');
    const archive = `${id}.tgz`;
    const result = spawnSync(tarCommand, ['-czf', join(directory, archive), '-C', dirname(stage), 'package']);
    assert.equal(result.status, 0, result.stderr?.toString());
    plugins.push({ id, package: metadata.name, version: metadata.version, directory: `plugins/${id}`, archive,
      sha256: createHash('sha256').update(readFileSync(join(directory, archive))).digest('hex'), verifyFiles: ['package.json', 'index.js', 'cordis.patch.yml'] });
  }
  const path = join(directory, 'manifest.json'); atomicJSON(path, { schemaVersion: 1, plugins });
  const release = loadRelease(path);
  const calls = [];
  const execute = (_cli, d, args, home = d.home) => {
    calls.push({ args, home });
    const targets = args.filter(arg => arg.startsWith('file:'));
    if (args[0] === 'add' && targets.length > 1) {
      for (const target of targets) execute(_cli, d, ['add', target], home);
      return;
    }
    const profile = join(home, 'profiles', d.profile); mkdirSync(profile, { recursive: true });
    const manifestPath = join(profile, 'package.json');
    const manifest = existsSync(manifestPath) ? read(manifestPath) : { dependencies: {}, dsh: { profile: { bundles: [] } } };
    if (args[0] === 'install') {
      for (const spec of Object.values(manifest.dependencies)) execute(_cli, d, ['add', spec], home);
      return;
    }
    const value = args.at(-1);
    if (args[0] === 'remove') {
      delete manifest.dependencies[value];
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== value);
      rmSync(join(profile, 'node_modules', value), { recursive: true, force: true });
    } else {
      const archive = value.slice('file:'.length);
      const packageJson = JSON.parse(spawnSync(tarCommand, ['-xOf', archive, 'package/package.json']).stdout);
      const destination = join(profile, 'node_modules', packageJson.name); mkdirSync(destination, { recursive: true });
      const extracted = spawnSync(tarCommand, ['-xzf', archive, '--strip-components=1', '-C', destination]);
      assert.equal(extracted.status, 0, extracted.stderr?.toString());
      manifest.dependencies[packageJson.name] = value;
      if (!manifest.dsh.profile.bundles.includes(packageJson.name)) manifest.dsh.profile.bundles.push(packageJson.name);
    }
    atomicJSON(manifestPath, manifest);
  };
  return { root, deployment, release, execute, calls, cli: { command: 'fixture' } };
}

const options = f => ({ execute: f.execute, cli: f.cli });

test('unchanged sync reuses verified installs and publisher evidence never becomes a gate', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  await finalize(f.deployment, f.release, { running: true });
  const plugin = f.release.plugins[0];
  const annotated = { ...f.release, verification: { schemaVersion: 1, builds: [], runs: [{
    pluginId: plugin.id, archiveSha256: plugin.sha256, subjects: verificationSubjects(f.release.plugins),
    scenarioId: 'fixture-profile', suiteId: 'fixture', suiteRevision: 'a'.repeat(64), finishedAt: '2026-09-07T00:00:00Z',
    outcome: 'passed', scope: 'real-host', source: 'runner', host: { kind: 'unknown' },
    platform: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node }, reportSha256: 'b'.repeat(64),
  }] } };
  const calls = f.calls.length;
  const unchanged = await synchronize(f.deployment, annotated, options(f));
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.verification[0].records[0].scope, 'real-host');
  assert.equal(f.calls.length, calls);
  assert.equal(Object.hasOwn(readState(statePath(f.deployment)), 'verification'), false);
});

test('an unchanged package is re-added when its archive reference changes', t => {
  const f = fixture(t);
  const plugin = f.release.plugins[0];
  f.execute(f.cli, f.deployment, ['add', `file:${plugin.archivePath}`]);
  assert.equal(installedMatches(f.deployment.profileRoot, plugin), true);
  const archivePath = join(f.root, `${plugin.id}-${plugin.sha256}.tgz`);
  writeFileSync(archivePath, readFileSync(plugin.archivePath));
  const next = { ...plugin, archivePath };
  assert.equal(installedMatches(f.deployment.profileRoot, next), false);
  const changes = computeChanges([{ id: 'alpha', package: 'fixture-alpha' }], [next], read(join(f.deployment.profileRoot, 'package.json')), p => installedMatches(f.deployment.profileRoot, p));
  assert.deepEqual(changes.add, [next]);
});

test('paths use repo root, honor explicit home, and exclude persistent paths from operation output', t => {
  const f = fixture(t);
  atomicJSON(join(f.root, 'deployment.json'), { dataRoot: 'data/config', home: 'data/config-home', profile: 'custom' });
  const d = resolveDeployment({ root: f.root, config: 'deployment.json', home: 'data/cli-home' }, { DSH_DATA_DIR: 'data/env' });
  assert.equal(d.dataRoot, join(f.root, 'data/env'));
  assert.equal(d.home, join(f.root, 'data/cli-home'));
  assert.equal(d.profile, 'custom');
  assert.throws(() => resolveDeployment({ root: f.root, home: 'plugins/alpha' }, {}), /持久路径/);
  assert.throws(() => resolveDeployment({ root: f.root, artifacts: '.local/data' }, {}), /重叠/);
  assert.throws(() => parseArguments(['sync', '--unknown']), /未知参数/);
});

test('已移除的部署旗标明确报错并指向替代入口，不混进未知参数', () => {
  for (const flag of ['--resume', '--recover', '--data-compatible', '--rebuild', '--rebuild-plugins', '--container']) {
    assert.throws(() => parseArguments(['start', flag]), /已移除/u, flag);
  }
  assert.throws(() => parseArguments(['start', '--recover']), /普通 build/u);
  assert.throws(() => parseArguments(['start', '--container']), /container-start/u);
  assert.throws(() => parseArguments(['start', '--unknown']), /未知参数/u);
});

test('没有残留 profile 锁时 unlock 不创建 profile 目录', async t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-unlock-')));
  t.after(() => { assert.equal(dirname(root), realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const home = join(root, 'data/home');
  // 解锁是「什么都不该做」的动作：缺锁要报成缺锁，而不是裸 ENOENT；也不能顺手补建空目录掩盖现场。
  await main(['unlock', '--root', root, '--home', home, '--data-root', join(root, 'data'), '--artifacts', join(root, '.local/artifacts')]);
  assert.equal(existsSync(home), false, '没有锁时不得创建 profile 目录');
});

test('old data candidates require explicit selection before creating an empty home', t => {
  const f = fixture(t); const fakeUser = join(f.root, 'user'); mkdirSync(join(fakeUser, '.dsh'), { recursive: true });
  const d = resolveDeployment({ root: f.root }, {});
  assert.throws(() => checkDataSelection(d, fakeUser), /旧目录/);
  assert.equal(existsSync(d.home), false);
  assert.doesNotThrow(() => checkDataSelection(f.deployment, fakeUser));
});

test('offline cache configuration uses CLI, environment and file precedence', t => {
  const f = fixture(t);
  atomicJSON(join(f.root, 'deployment.json'), { cacheDir: 'data/config-cache', offlineCache: 'data/config-source' });
  const fromConfig = resolveDeployment({ root: f.root, config: 'deployment.json' }, {});
  assert.equal(fromConfig.cache, 'data/config-cache'); assert.equal(fromConfig.offlineCache, 'data/config-source');
  const fromEnv = resolveDeployment({ root: f.root, config: 'deployment.json' }, { DSH_CACHE_DIR: 'data/env-cache', DSH_OFFLINE_CACHE_DIR: 'data/env-source' });
  assert.equal(fromEnv.cache, 'data/env-cache'); assert.equal(fromEnv.offlineCache, 'data/env-source');
  const args = parseArguments(['sync', '--root', f.root, '--cache-dir', 'data/cli-cache', '--offline-cache', 'data/cli-source']);
  const fromCli = resolveDeployment(args, { DSH_CACHE_DIR: 'data/env-cache', DSH_OFFLINE_CACHE_DIR: 'data/env-source' });
  assert.equal(fromCli.cache, 'data/cli-cache'); assert.equal(fromCli.offlineCache, 'data/cli-source');
});

test('official add, install and remove receive the same offline store and metadata cache paths', async t => {
  const f = fixture(t); f.deployment.offline = true;
  f.deployment.store = 'data/writable store'; f.deployment.cache = 'data/writable cache';
  const calls = [];
  const execute = (cli, d, args, home) => { calls.push(args); f.execute(cli, d, args, home); };
  await synchronize(f.deployment, f.release, { execute, cli: f.cli });
  await finalize(f.deployment, f.release, { running: true });
  await synchronize(f.deployment, { ...f.release, plugins: [] }, { execute, cli: f.cli });
  // 没有待保留的非受管依赖时不跑隔离安装：官方 CLI 只按目标 add/remove 收敛。
  assert.deepEqual(new Set(calls.map(args => args[0])), new Set(['add', 'remove']));
  for (const args of calls) {
    assert.ok(args.includes(args[0] === 'remove' ? '--config.offline=true' : '--offline'));
    if (args[0] === 'remove') assert.ok(!args.includes('--offline'));
    assert.equal(args[args.indexOf('--store-dir') + 1], join(f.root, 'data/writable store'));
    assert.equal(args[args.indexOf('--cache-dir') + 1], join(f.root, 'data/writable cache'));
  }
});

test('deselecting every plugin empties the managed set and re-selection installs again', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  await finalize(f.deployment, f.release, { running: true });
  const disabled = { ...f.release, plugins: [] };
  await synchronize(f.deployment, disabled, options(f));
  await finalize(f.deployment, disabled, { running: true });
  assert.deepEqual(readState(statePath(f.deployment)).managed, []);
  assert.deepEqual(read(join(f.deployment.profileRoot, 'package.json')).dependencies, {});
  await synchronize(f.deployment, f.release, options(f));
  await finalize(f.deployment, f.release, { running: true });
  assert.deepEqual(readState(statePath(f.deployment)).managed.map(entry => entry.id), ['alpha', 'beta']);
});

test('offline inputs are copied independently and warmed metadata refreshes an existing writable cache', t => {
  const f = fixture(t);
  const store = join(f.root, 'store-source'); const cache = join(f.root, 'cache-source');
  mkdirSync(store); mkdirSync(cache);
  mkdirSync(join(store, 'v11/projects'), { recursive: true });
  writeFileSync(join(store, 'v11/projects/warming-host'), 'source installation');
  writeFileSync(join(store, 'content'), 'immutable package'); writeFileSync(join(cache, 'package.jsonl'), 'warmed metadata');
  writeFileSync(join(cache, 'lockfile-verified.jsonl'), 'warming-host verification\n');
  Object.assign(f.deployment, { offlineStore: store, offlineCache: cache, store: 'data/store', cache: 'data/cache' });
  prepareOfflineDependencies(f.deployment);
  assert.equal(readFileSync(join(f.root, 'data/store/content'), 'utf8'), 'immutable package');
  assert.equal(readFileSync(join(f.root, 'data/cache/package.jsonl'), 'utf8'), 'warmed metadata');
  assert.equal(readFileSync(join(f.root, 'data/cache/lockfile-verified.jsonl'), 'utf8'), 'warming-host verification\n');
  writeFileSync(join(f.root, 'data/cache/lockfile-verified.jsonl'), 'locally verified lockfile\n');
  assert.equal(existsSync(join(f.root, 'data/store/v11/projects')), false);
  mkdirSync(join(f.root, 'data/store/v11/projects'), { recursive: true });
  writeFileSync(join(f.root, 'data/store/v11/projects/local-host'), 'local installation');
  writeFileSync(join(f.root, 'data/cache/package.jsonl'), 'stale metadata');
  prepareOfflineDependencies(f.deployment);
  assert.equal(readFileSync(join(f.root, 'data/cache/package.jsonl'), 'utf8'), 'warmed metadata');
  assert.equal(readFileSync(join(cache, 'package.jsonl'), 'utf8'), 'warmed metadata');
  assert.equal(readFileSync(join(f.root, 'data/cache/lockfile-verified.jsonl'), 'utf8'), 'locally verified lockfile\n');
  assert.equal(readFileSync(join(cache, 'lockfile-verified.jsonl'), 'utf8'), 'warming-host verification\n');
  assert.equal(readFileSync(join(f.root, 'data/store/v11/projects/local-host'), 'utf8'), 'local installation');
  assert.equal(existsSync(join(f.root, 'data/store/v11/projects/warming-host')), false);
  f.deployment.cache = store;
  assert.throws(() => prepareOfflineDependencies(f.deployment), /不能重叠/);
  f.deployment.cache = undefined;
  assert.throws(() => prepareOfflineDependencies(f.deployment), /cache-dir/);
});

test('manifest tampering and unsafe runtime variables are rejected before installation', t => {
  const f = fixture(t); const manifest = read(f.release.path);
  manifest.plugins[0].directory = '../outside'; atomicJSON(f.release.path, manifest);
  assert.throws(() => loadRelease(f.release.path), /源码目录/);
  manifest.plugins[0].directory = 'plugins/alpha';
  for (const name of ['PATH', 'USERPROFILE', 'NODE_OPTIONS', 'DSH_HOME', 'BASH_ENV', 'PLUGIN_MANIFEST_FILE', 'lowercase', 'INVALID-NAME']) {
    for (const field of ['runtimeConfig', 'development']) {
      const spec = field === 'runtimeConfig' ? { variable: name } : { rootVariable: name, patch: 'dev.yml' };
      manifest.plugins[0][field] = spec; atomicJSON(f.release.path, manifest);
      assert.throws(() => loadRelease(f.release.path), new RegExp(field), `${field}: ${name}`);
      assert.throws(() => runtimeEnvironment(f.deployment, [{ id: 'x', [field]: spec }]), /变量/, `${field}: ${name}`);
      delete manifest.plugins[0][field];
    }
  }
});

test('optional runtime files do not inherit stale process values and config revision is explicit', t => {
  const f = fixture(t);
  const plugins = [{ id: 'alpha', runtimeConfig: { variable: 'ALPHA_CONFIG', required: false } }];
  const env = runtimeEnvironment(f.deployment, plugins);
  assert.equal(env.variables.ALPHA_CONFIG, undefined);
  assert.throws(() => runtimeEnvironment(f.deployment, [{ id: 'alpha', runtimeConfig: { variable: 'ALPHA_CONFIG', required: true } }]), /alpha: 缺少运行配置/);
  f.deployment.instances.alpha = { configRevision: -1 };
  assert.throws(() => runtimeEnvironment(f.deployment, plugins), /configRevision/);
});

test('existing non-managed dependency conflicts even if the package is discovered', () => {
  const plugin = { id: 'alpha', package: 'fixture-alpha', sha256: 'a'.repeat(64) };
  assert.throws(() => computeChanges([], [plugin], { dependencies: { 'fixture-alpha': '1.0.0' } }, () => true), /非受管/);
});

test('sync retains unchanged packages, removes only deselected packages, and supports empty selection', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  assert.equal(readState(statePath(f.deployment)).managed.length, 2);
  await finalize(f.deployment, f.release, { running: true });
  const firstCount = f.calls.length;
  const result = await synchronize(f.deployment, f.release, options(f));
  assert.equal(result.changed, false); assert.equal(f.calls.length, firstCount);
  const selected = { ...f.release, plugins: [f.release.plugins[0]] };
  await synchronize(f.deployment, selected, options(f)); await finalize(f.deployment, selected, { running: true });
  assert.ok(f.calls.slice(firstCount).filter(call => call.home === f.deployment.home).every(call => call.args[0] === 'remove' && call.args.at(-1) === 'fixture-beta'));
  const empty = { ...f.release, plugins: [] };
  await synchronize(f.deployment, empty, options(f)); await finalize(f.deployment, empty, { running: true });
  assert.deepEqual(read(join(f.deployment.profileRoot, 'package.json')).dependencies, {});
});

test('a partially applied add converges on the next ordinary run without any journal', async t => {
  const f = fixture(t); let failed = false;
  const broken = (cli, d, args, home) => {
    if (home === undefined && args.at(-1).endsWith('beta.tgz') && !failed) {
      const first = args.find(arg => arg.startsWith('file:') && arg.endsWith('alpha.tgz'));
      if (first) f.execute(cli, d, ['add', first]);
      failed = true; throw new Error('second-package-failure');
    }
    f.execute(cli, d, args, home);
  };
  await assert.rejects(synchronize(f.deployment, f.release, { execute: broken, cli: f.cli }), /second-package-failure/);
  // 授权先于 CLI 写入：两个包都已是受管对象，失败现场没有任何 journal。
  assert.deepEqual(readState(statePath(f.deployment)).managed.map(entry => entry.id), ['alpha', 'beta']);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-pending.json')), false);
  // 普通重跑直接收敛：不要求 resume/pending，也不要求同一包版本。
  await synchronize(f.deployment, f.release, options(f));
  await finalize(f.deployment, f.release, { running: true });
  assert.deepEqual(readState(statePath(f.deployment)).managed.map(entry => entry.id), ['alpha', 'beta']);
  assert.deepEqual(Object.keys(read(join(f.deployment.profileRoot, 'package.json')).dependencies), ['fixture-alpha', 'fixture-beta']);
  // 换修复包（不同字节、同版本）同样由普通重跑承接。
  const plugin = f.release.plugins[1];
  const fixed = join(f.root, 'fixed-beta.tgz');
  writeFileSync(fixed, readFileSync(plugin.archivePath));
  const fixedRelease = { ...f.release, plugins: f.release.plugins.map(p => p.id === 'beta' ? { ...p, archivePath: fixed } : p) };
  await synchronize(f.deployment, fixedRelease, options(f));
  assert.deepEqual(read(join(f.deployment.profileRoot, 'package.json')).dependencies['fixture-beta'], `file:${fixed}`);
});

test('an orphaned managed Bundle is cleaned only for exactly managed packages', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  await finalize(f.deployment, f.release, { running: true });
  const path = join(f.deployment.profileRoot, 'package.json');
  const metadata = read(path);
  // 模拟官方 CLI 撤选只删掉了依赖、却遗留了 Bundle。
  delete metadata.dependencies['fixture-alpha'];
  atomicJSON(path, metadata);
  const empty = { ...f.release, plugins: [] };
  await synchronize(f.deployment, empty, options(f));
  const after = read(path);
  assert.deepEqual(after.dsh.profile.bundles, [], '受管包遗留的 Bundle 被精确剔除，不残留');
  assert.deepEqual(readState(statePath(f.deployment)).managed, []);
});

test('external synchronization requires stop evidence and applied configuration requires start evidence', async t => {
  const f = fixture(t); f.deployment.hostMode = 'external';
  delete f.deployment.options['stopped-file'];
  await assert.rejects(synchronize(f.deployment, f.release, options(f)), /停服证据/);
  assert.equal(existsSync(join(f.deployment.profileRoot, 'package.json')), false);
  f.deployment.options['stopped-file'] = join(f.root, 'stopped.json');
  await synchronize(f.deployment, f.release, options(f));
  await assert.rejects(finalize(f.deployment, f.release), /启动证据/);
  // 受管授权与安装验证由 synchronize 维护：外部同步后状态已存在，启动证据只影响验证步骤。
  assert.deepEqual(readState(statePath(f.deployment)).managed.map(entry => entry.id), ['alpha', 'beta']);
});

test('external synchronization rejects stopped evidence for a live process', async t => {
  const f = fixture(t); f.deployment.hostMode = 'external';
  const evidence = f.deployment.options['stopped-file'];
  atomicJSON(evidence, { ...read(evidence), pid: process.pid });
  await assert.rejects(synchronize(f.deployment, f.release, options(f)), /进程状态与证据不符/);
  assert.equal(existsSync(join(f.deployment.profileRoot, 'package.json')), false);
});

test('unchanged installations still require external stop evidence before owned startup', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  await finalize(f.deployment, f.release, { running: true });
  await synchronize(f.deployment, f.release, options(f));
  delete f.deployment.options['stopped-file'];
  const cliFile = join(f.root, 'never-start.mjs'); writeFileSync(cliFile, 'throw new Error("must not spawn");');
  f.deployment.options['dsh-cli-js'] = cliFile;
  await assert.rejects(supervise(f.deployment, f.release), /停服证据/);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-owner.json')), false);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-lock')), false);
});

test('owned startup allows a cold host to take more than ten seconds', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cliFile = join(f.root, 'cold-host.mjs');
  writeFileSync(cliFile, `import { createServer } from 'node:http';
    setTimeout(() => createServer((_req, res) => res.end('ready')).listen(${port}, '127.0.0.1'), 11000);
    setTimeout(() => process.exit(0), 15000);`);
  f.deployment.options['dsh-cli-js'] = cliFile;
  f.deployment.options.port = port;
  await supervise(f.deployment, f.release);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-pending.json')), false);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-owner.json')), false);
});

test('a managed plugin the host only warns about still fails owned startup', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cliFile = join(f.root, 'warning-host.mjs');
  // 官方宿主从 0.1.6 起只对全局必需条目拒绝启动，其余条目只警告并继续服务：端口能访问不再
  // 等于托管插件起来了，所以这里必须由管理器按官方诊断判定。两条诊断分别按入口 id 和包名命中。
  writeFileSync(cliFile, `import { createServer } from 'node:http';
    process.stderr.write('dsh: warning: 2 entries did not activate\\nalpha (fixture-alpha): failed to import\\nexample (fixture-beta): pending (waiting for service: webServer)\\n');
    createServer((_req, res) => res.end('ready')).listen(${port}, '127.0.0.1');`);
  f.deployment.options['dsh-cli-js'] = cliFile;
  f.deployment.options.port = port;
  await assert.rejects(supervise(f.deployment, f.release), error => {
    assert.match(error.message, /^托管插件未激活：/);
    assert.match(error.message, /alpha \(fixture-alpha\) failed to import/);
    assert.match(error.message, /example \(fixture-beta\) pending \(waiting for service: webServer\)/);
    return true;
  });
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-owner.json')), false);
});

test('a warning about an entry the manager does not own leaves startup successful', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cliFile = join(f.root, 'foreign-warning-host.mjs');
  writeFileSync(cliFile, `import { createServer } from 'node:http';
    process.stderr.write('dsh: warning: 1 entry did not activate\\nsomeone-else (/opt/other/index.mjs): pending (waiting for service: neverProvided)\\n');
    createServer((_req, res) => res.end('ready')).listen(${port}, '127.0.0.1');
    setTimeout(() => process.exit(0), 1500);`);
  f.deployment.options['dsh-cli-js'] = cliFile;
  f.deployment.options.port = port;
  await supervise(f.deployment, f.release);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-owner.json')), false);
});

test('a required startup failure is reported with the authoritative diagnostics', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cliFile = join(f.root, 'required-failure-host.mjs');
  // 逐字取自真实 0.1.6 宿主：必需条目失败的抬头前面还有调用方的前缀（boot 包装 + Node 未捕获异常），
  // 所以解析必须按行内匹配，否则这段诊断永远读不到。探测端口占用一个已释放的空闲端口，
  // 不用默认 7902——开发机上常有真实 DSH 在监听，fetch 会意外成功。
  writeFileSync(cliFile, `process.stderr.write('Error: dsh: plugin tree failed to load: required startup failure: 1 entry did not activate\\nsdk-jsonrpc-server (dsh-plugin-that-does-not-exist): failed to import\\n    at boot (/opt/dsh-runtime/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2579:9)\\n');
    setTimeout(() => process.exit(1), 500);`);
  f.deployment.options['dsh-cli-js'] = cliFile;
  f.deployment.options.port = port;
  await assert.rejects(supervise(f.deployment, f.release), /未激活的必需条目：[\s\S]*sdk-jsonrpc-server \(dsh-plugin-that-does-not-exist\): failed to import/);
});

test('a grouped required failure as of 0.1.6-alpha.2 still reports managed entries', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cliFile = join(f.root, 'required-failure-alpha2-host.mjs');
  // 逐字对应 0.1.6-alpha.2 宿主的分组诊断：抬头由 StartupError 直接抛出、不再加 boot 前缀；
  // 明细按 Failed plugins 分组缩进（2 空格条目、4 空格 Package 与原因），可选条目也并入这份
  // 诊断。托管插件混在分组里时必须比对出来，官方必需失败块也要一并转报。
  writeFileSync(cliFile, `process.stderr.write('dsh: startup failed: 2 required plugins did not activate\\n\\nFailed plugins (2):\\n  sdk-jsonrpc-server (required)\\n    Package: dsh-plugin-that-does-not-exist\\n    Error: Cannot find module \\'dsh-plugin-that-does-not-exist\\'\\n  alpha\\n    Package: fixture-alpha\\n    failed to import\\n');
    setTimeout(() => process.exit(1), 500);`);
  f.deployment.options['dsh-cli-js'] = cliFile;
  f.deployment.options.port = port;
  await assert.rejects(supervise(f.deployment, f.release), error => {
    assert.match(error.message, /托管插件未激活：alpha \(fixture-alpha\) failed to import/);
    assert.match(error.message, /未激活的必需条目：[\s\S]*Failed plugins \(2\):[\s\S]*sdk-jsonrpc-server \(required\)/);
    return true;
  });
});

test('a decoy line inside a failure reason cannot hide a later managed plugin', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const cliFile = join(f.root, 'decoy-host.mjs');
  // 逐字取自真实 0.1.6 宿主：官方原因字段用 error.stack，插件抛出的消息里带一行以列 0 开头、
  // 形状与明细行相同的诱饵。按抬头条数收行会在这里把真正的托管条目挤掉，从而漏判成成功。
  writeFileSync(cliFile, `import { createServer } from 'node:http';
    process.stderr.write('dsh: warning: 2 entries did not activate\\nevil-first (file:///probe/evil.mjs): Error: boom\\ndecoy (decoy-package): decoy reason\\ntail\\n    at new apply (file:///probe/evil.mjs:2:9)\\nmanaged-second (fixture-beta): failed to import\\n');
    createServer((_req, res) => res.end('ready')).listen(${port}, '127.0.0.1');`);
  f.deployment.options['dsh-cli-js'] = cliFile;
  f.deployment.options.port = port;
  await assert.rejects(supervise(f.deployment, f.release), /托管插件未激活：[\s\S]*managed-second \(fixture-beta\) failed to import/);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-owner.json')), false);
});

test('configuration revision does not reinstall and never enters the managed set', async t => {
  const f = fixture(t); await synchronize(f.deployment, f.release, options(f));
  await finalize(f.deployment, f.release, { running: true });
  f.calls.length = 0; f.deployment.instances.alpha = { configRevision: 1 };
  const result = await synchronize(f.deployment, f.release, options(f));
  assert.equal(result.changed, false);
  assert.equal(f.calls.length, 0);
  assert.equal(Object.hasOwn(readState(statePath(f.deployment)), 'configurations'), false);
});

test('a changed environment reinstalls from the ordinary path without any rebuild flag', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  await finalize(f.deployment, f.release, { running: true });
  const path = statePath(f.deployment);
  const recorded = readState(path);
  recorded.environment = { ...recorded.environment, mode: 'development' };
  atomicJSON(path, recorded);
  f.calls.length = 0;
  const result = await synchronize(f.deployment, f.release, options(f));
  assert.equal(result.changed, true, '环境记录变化使安装重用失效并触发重装');
  assert.ok(f.calls.some(call => call.args[0] === 'add'));
});

test('every plugin probe is checked and a later failure cannot be hidden by the first success', async t => {
  const f = fixture(t); await synchronize(f.deployment, f.release, options(f));
  f.deployment.baseUrl = 'http://127.0.0.1:12345';
  const calls = [];
  const release = { ...f.release, plugins: f.release.plugins.map(p => ({ ...p, healthPath: `/${p.id}/ready` })) };
  await assert.rejects(verifyReady(f.deployment, release, async url => {
    calls.push(url.pathname);
    return { ok: url.pathname.includes('alpha'), status: url.pathname.includes('alpha') ? 200 : 503 };
  }), /beta.*503/);
  assert.deepEqual(calls, ['/alpha/ready', '/beta/ready']);
});

test('preflight rejects changes to retained non-managed dependencies before touching the live profile', async t => {
  const f = fixture(t);
  f.execute(f.cli, f.deployment, ['add', `file:${f.release.plugins[1].archivePath}`]);
  const selected = { ...f.release, plugins: [f.release.plugins[0]] };
  const original = readFileSync(join(f.deployment.profileRoot, 'node_modules/fixture-beta/index.js'), 'utf8');
  const destructive = (cli, d, args, home) => {
    f.execute(cli, d, args, home);
    if (home && args[0] === 'install') writeFileSync(join(home, 'profiles/web/node_modules/fixture-beta/index.js'), 'changed');
  };
  await assert.rejects(synchronize(f.deployment, selected, { execute: destructive, cli: f.cli }), /要保留的依赖/);
  assert.equal(readFileSync(join(f.deployment.profileRoot, 'node_modules/fixture-beta/index.js'), 'utf8'), original);
  assert.equal(existsSync(join(f.deployment.profileRoot, 'node_modules/fixture-alpha')), false);
});

test('explicit adoption adds only named actual installations and stays idempotent', async t => {
  const f = fixture(t);
  for (const p of f.release.plugins) f.execute(f.cli, f.deployment, ['add', `file:${p.archivePath}`]);
  await assert.rejects(adoptLegacy(f.deployment, f.release, ['all']), /精确列出/);
  const result = await adoptLegacy(f.deployment, f.release, ['alpha']);
  assert.equal(result.status, 'adopted-requires-sync');
  assert.deepEqual(readState(statePath(f.deployment)).managed, [{ id: 'alpha', package: 'fixture-alpha' }]);
  // 相同映射幂等，未点名的包不被接管。
  const again = await adoptLegacy(f.deployment, f.release, ['alpha']);
  assert.equal(again.status, 'adopted-unchanged');
  assert.deepEqual(readState(statePath(f.deployment)).managed, [{ id: 'alpha', package: 'fixture-alpha' }]);
  // 增量接管保留原授权。
  await adoptLegacy(f.deployment, f.release, ['beta']);
  assert.deepEqual(readState(statePath(f.deployment)).managed.map(entry => entry.id), ['alpha', 'beta']);
  // 接管不宣称环境已应用：没有 environment 记录，下一次同步完成目标环境安装验证。
  const synced = await synchronize(f.deployment, f.release, options(f));
  assert.equal(synced.changed, true);
  assert.ok(Object.hasOwn(readState(statePath(f.deployment)), 'environment'));
});

test('profile locks reject concurrent synchronization without clobbering the owner', t => {
  const f = fixture(t); const unlock = acquireLock(f.deployment.profileRoot);
  assert.throws(() => acquireLock(f.deployment.profileRoot), /正在同步/);
  unlock(); const again = acquireLock(f.deployment.profileRoot); again();
});

test('legacy discovery-derived state is not automatically adopted', async t => {
  const f = fixture(t);
  atomicJSON(join(f.deployment.profileRoot, '.deepseek-plugin-managed.json'), { schemaVersion: 1, packages: ['fixture-alpha', 'unmanaged'] });
  await assert.rejects(synchronize(f.deployment, f.release, options(f)), /旧受管/);
  assert.equal(f.calls.length, 0);
});

test('a shared home owner record blocks fresh container synchronization', async t => {
  const f = fixture(t);
  atomicJSON(join(f.deployment.profileRoot, '.deepseek-plugin-owner.json'), { token: 'occupied' });
  await assert.rejects(synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli, freshContainer: true }), /运行记录/);
});

test('Compose maps external home and runtime files independently of the data root', t => {
  const f = fixture(t); const outside = mkdtempSync(join(tmpdir(), 'dsh-external-home-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  f.deployment.home = outside;
  f.deployment.authUrlFile = join(outside, 'authentication.txt');
  writeFileSync(f.deployment.authUrlFile, '', { mode: 0o644 });
  const patch = join(f.root, 'user.patch.yml'); writeFileSync(patch, '{}\n');
  f.deployment.config.patches = [patch];
  const store = join(f.root, 'offline-store'); mkdirSync(store); f.deployment.offlineStore = store;
  const cache = join(f.root, 'offline-cache'); mkdirSync(cache); f.deployment.offlineCache = cache;
  const generated = renderCompose(f.deployment, f.release, join(f.root, 'compose'));
  const service = read(generated.path).services.dsh;
  assert.equal(service.environment.DSH_HOME, '/dsh-home');
  assert.ok(service.volumes.some(volume => volume.source === outside && volume.target === '/dsh-home'));
  assert.ok(service.volumes.some(volume => volume.source === dirname(f.release.path) && volume.read_only));
  assert.ok(service.volumes.some(volume => volume.source === patch && volume.target === '/run/dsh-patches/0.yml' && volume.read_only));
  assert.ok(service.volumes.some(volume => volume.source === store && volume.target === '/opt/plugin-offline-store' && volume.read_only));
  assert.ok(service.volumes.some(volume => volume.source === cache && volume.target === '/opt/plugin-offline-cache' && volume.read_only));
  const config = read(generated.configPath);
  assert.equal(config.authUrlFile, '/run/dsh-auth-url.txt');
  assert.equal(config.authUrlDirectWrite, true);
  assert.equal(config.offlineStore, '/opt/plugin-offline-store');
  assert.equal(config.offlineCache, '/opt/plugin-offline-cache');
  assert.equal(config.cacheDir, '/data/plugin-cache');
  if (process.platform !== 'win32') assert.equal(statSync(f.deployment.authUrlFile).mode & 0o777, 0o600);
  for (const plugins of [[f.release.plugins[0]], []]) {
    const subset = renderCompose(f.deployment, { ...f.release, plugins }, join(f.root, `compose-${plugins.length}`));
    assert.deepEqual(read(subset.configPath).plugins, plugins.map(plugin => plugin.id));
  }
});

test('site identity travels through Compose rendering without entering the managed set', async t => {
  const f = fixture(t);
  const id = '12345678-1234-1234-1234-123456789012';
  f.deployment.config.siteOperation = id;
  const rendered = renderCompose(f.deployment, f.release, join(f.root, 'compose-site'));
  // siteOperation 已随旧 site-recovery 路径一起移除：渲染产物不得再携带该字段。
  assert.equal(Object.hasOwn(read(rendered.configPath), 'siteOperation'), false);
  // 容器内没有宿主绑定，站点身份只能来自本次部署配置：缺了它就写不了 schema 3 授权（设计 2.6）。
  assert.equal(read(rendered.configPath).siteId, 'site-fixture');
  await synchronize(f.deployment, f.release, options(f));
  assert.equal(Object.hasOwn(readState(statePath(f.deployment)), 'siteOperation'), false);
});

test('managed state from another site or profile is refused instead of adopted', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  const path = statePath(f.deployment), managed = readState(path).managed;
  // 另一个站点留下的授权集合：既不能当成「无需改变」，也不能用当前身份重写。
  atomicJSON(path, { schemaVersion: 3, siteId: 'site-other', profile: 'web', managed });
  await assert.rejects(synchronize(f.deployment, f.release, options(f)), /与本次部署 site-fixture（profile web）不一致/);
  assert.equal(readState(path).siteId, 'site-other');
  // 同一站点、另一个 profile 同样拒绝。
  atomicJSON(path, { schemaVersion: 3, siteId: 'site-fixture', profile: 'other', managed });
  await assert.rejects(synchronize(f.deployment, f.release, options(f)), /与本次部署 site-fixture（profile web）不一致/);
  // 显式接管走同一条身份判定：别人的授权不能被增量并入。
  atomicJSON(path, { schemaVersion: 3, siteId: 'site-other', profile: 'web', managed: [] });
  await assert.rejects(adoptLegacy(f.deployment, f.release, ['alpha']), /与本次部署 site-fixture（profile web）不一致/);
  assert.deepEqual(readState(path).managed, []);
  // 缺身份的 schema 3 状态无法证明属于哪个站点（设计 2.6）：字段校验必须自己拦住，不能靠后面的比对。
  // 这里用原始 JSON 读盘：readState 会做同一份校验，拿不到「拒绝后现场有没有被改写」这个事实。
  atomicJSON(path, { schemaVersion: 3, profile: 'web', managed });
  await assert.rejects(synchronize(f.deployment, f.release, options(f)), /受管授权集合缺少 siteId/);
  assert.equal(read(path).siteId, undefined);
  atomicJSON(path, { schemaVersion: 3, siteId: 'site-fixture', managed });
  await assert.rejects(synchronize(f.deployment, f.release, options(f)), /受管授权集合缺少 profile/);
  assert.equal(read(path).profile, undefined);
});

test('缺少站点身份时拒绝写入受管授权集合', async t => {
  const f = fixture(t);
  // 部署配置与站点绑定都没有 siteId：写授权集合等于把一个站点的授权悄悄带到另一个站点。
  const anonymousConfig = join(f.root, 'anonymous.json'); writeFileSync(anonymousConfig, '{}\n');
  const anonymous = resolveDeployment({ root: f.root, config: anonymousConfig, home: 'data/home', 'host-mode': 'owned' }, {});
  anonymous.options['stopped-file'] = f.deployment.options['stopped-file'];
  await assert.rejects(synchronize(anonymous, f.release, options(f)), /缺少站点身份 siteId/);
  assert.equal(existsSync(statePath(anonymous)), false, '拒绝时不得留下受管授权集合');
});

test('owned startup keeps the caller profile lock until ready and releases it there', { timeout: 30000 }, async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, options(f));
  const reservation = createServer();
  await new Promise(resolvePromise => reservation.listen(0, '127.0.0.1', resolvePromise));
  const port = reservation.address().port;
  await new Promise(resolvePromise => reservation.close(resolvePromise));
  const cliFile = join(f.root, 'lock-hold.mjs');
  // 宿主先就绪、再存活一段时间：只有这样才能观察到「就绪时释放、宿主仍在运行」这个状态本身，
  // 而不是等 supervise 返回（那时宿主已退出，释放时机无从区分）。
  writeFileSync(cliFile, `import { createServer } from 'node:http';
    setTimeout(() => createServer((_req, res) => res.end('ready')).listen(${port}, '127.0.0.1'), 1500);
    setTimeout(() => process.exit(0), 12000);`);
  f.deployment.options['dsh-cli-js'] = cliFile;
  f.deployment.options.port = port;
  const lockPath = join(f.deployment.profileRoot, '.deepseek-plugin-lock');
  const ownerPath = join(f.deployment.profileRoot, '.deepseek-plugin-owner.json');
  const unlock = acquireLock(f.deployment.profileRoot);
  const starting = supervise(f.deployment, f.release, { locked: true, unlock });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  // 安装到启动验收之间锁必须连续：另一个安装拿不到同一把锁，也不会重复取锁。
  assert.equal(existsSync(lockPath), true);
  assert.throws(() => acquireLock(f.deployment.profileRoot), /正在同步或上次进程中断/);
  const deadline = Date.now() + 20000;
  while (existsSync(lockPath) && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  // 就绪即释放安装锁：此刻宿主进程仍在运行（OWNER 还在），锁已经可以被别人取得。
  assert.equal(existsSync(lockPath), false, '就绪后必须释放安装锁');
  assert.equal(existsSync(ownerPath), true, '宿主仍在运行时 OWNER 必须保留');
  assert.doesNotThrow(() => acquireLock(f.deployment.profileRoot));
  // 兜底释放幂等：调用方再释放一次不会把别人的锁删掉。
  unlock();
  await starting;
  assert.equal(existsSync(ownerPath), false);
});

test('a host binding refuses synchronization into another home even without existing state', async t => {
  const f = fixture(t);
  const other = join(f.root, 'other-home');
  // 绑定指向既有 home；本次同步却解析到另一个空 home——那里没有 STATE，身份比对不会触发。
  atomicJSON(join(f.root, '.local/site-binding.json'), { schemaVersion: 1, siteId: 'site-fixture', root: resolve(f.root), dataRoot: f.deployment.dataRoot,
    home: f.deployment.home, workspace: f.deployment.workspace, authUrlFile: f.deployment.authUrlFile, artifacts: f.deployment.artifacts, profile: f.deployment.profile, composeProject: 'dsh-plugins' });
  const target = { ...f.deployment, home: other, profileRoot: join(other, 'profiles', 'web') };
  await assert.rejects(synchronize(target, f.release, options(f)), /站点绑定 home 与本次解析不一致/);
  assert.equal(existsSync(join(target.profileRoot, '.deepseek-plugin-state.json')), false);
});
