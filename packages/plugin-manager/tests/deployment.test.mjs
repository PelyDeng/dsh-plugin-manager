/** Isolated profile behavior tests; real DSH startup is verified separately. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveDeployment, parseArguments, loadRelease, runtimeEnvironment, computeChanges, synchronize, atomicJSON, finalize, acquireLock, renderCompose, checkDataSelection, verifyReady, adoptLegacy, tarCommand, supervise, prepareOfflineDependencies } from '../src/deployment.mjs';
import { installedMatches, readState } from '../src/installation.mjs';
import { verificationSubjects } from '../src/verification.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-deployment-test-')));
  t.after(() => {
    assert.equal(dirname(root), realpathSync.native(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const deployment = resolveDeployment({ root, home: 'data/home', 'host-mode': 'owned' }, {});
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

test('adding publisher evidence preserves pending resume and unchanged installs without reinstallation', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  const pendingPath = join(f.deployment.profileRoot, '.deepseek-plugin-pending.json');
  const before = read(pendingPath).desiredHash;
  const plugin = f.release.plugins[0];
  const annotated = { ...f.release, verification: { schemaVersion: 1, builds: [], runs: [{
    pluginId: plugin.id, archiveSha256: plugin.sha256, subjects: verificationSubjects(f.release.plugins),
    scenarioId: 'fixture-profile', suiteId: 'fixture', suiteRevision: 'a'.repeat(64), finishedAt: '2026-09-07T00:00:00Z',
    outcome: 'passed', scope: 'real-host', source: 'runner', host: { kind: 'unknown' },
    platform: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node }, reportSha256: 'b'.repeat(64),
  }] } };
  f.deployment.options.resume = true;
  const calls = f.calls.length;
  const resumed = await synchronize(f.deployment, annotated, { execute: f.execute, cli: f.cli });
  assert.equal(read(pendingPath).desiredHash, before);
  assert.equal(resumed.verification[0].records[0].status, 'partial-match');
  assert.equal(f.calls.length, calls);
  await finalize(f.deployment, annotated, { running: true });
  delete f.deployment.options.resume;
  const unchanged = await synchronize(f.deployment, annotated, { execute: f.execute, cli: f.cli });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.verification[0].records[0].scope, 'real-host');
  assert.equal(f.calls.length, calls);
  assert.equal(Object.hasOwn(readState(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')), 'verification'), false);
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
  const changes = computeChanges({ plugins: [plugin] }, [next], read(join(f.deployment.profileRoot, 'package.json')), p => installedMatches(f.deployment.profileRoot, p));
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
  assert.deepEqual(new Set(calls.map(args => args[0])), new Set(['add', 'install', 'remove']));
  for (const args of calls) {
    assert.ok(args.includes(args[0] === 'remove' ? '--config.offline=true' : '--offline'));
    if (args[0] === 'remove') assert.ok(!args.includes('--offline'));
    assert.equal(args[args.indexOf('--store-dir') + 1], join(f.root, 'data/writable store'));
    assert.equal(args[args.indexOf('--cache-dir') + 1], join(f.root, 'data/writable cache'));
  }
});

test('saved candidates survive disabling every plugin and allow re-enabling from source', async t => {
  const f = fixture(t);
  f.deployment.candidates = f.release.plugins.map(plugin => plugin.id);
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, f.release, { running: true });
  const disabled = { ...f.release, plugins: [] };
  await synchronize(f.deployment, disabled, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, disabled, { running: true });
  const state = readState(join(f.deployment.profileRoot, '.deepseek-plugin-state.json'));
  assert.deepEqual(state.plugins, []);
  assert.deepEqual(state.candidates, ['alpha', 'beta']);
  const enabled = { ...f.release, plugins: f.release.plugins.filter(plugin => state.candidates.includes(plugin.id)) };
  await synchronize(f.deployment, enabled, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, enabled, { running: true });
  assert.deepEqual(readState(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')).plugins.map(plugin => plugin.id), ['alpha', 'beta']);
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
  manifest.plugins[0].directory = 'plugins/alpha'; manifest.plugins[0].runtimeConfig = { variable: 'NODE_OPTIONS' }; atomicJSON(f.release.path, manifest);
  assert.throws(() => loadRelease(f.release.path), /runtimeConfig/);
  assert.throws(() => runtimeEnvironment(f.deployment, [{ id: 'x', runtimeConfig: { variable: 'PATH' } }]), /变量/);
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
  assert.throws(() => computeChanges(null, [plugin], { dependencies: { 'fixture-alpha': '1.0.0' } }, () => true), /非受管/);
});

test('sync retains unchanged packages, removes only deselected packages, and supports empty selection', async t => {
  const f = fixture(t); const options = { execute: f.execute, cli: f.cli };
  await synchronize(f.deployment, f.release, options);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')), false);
  await finalize(f.deployment, f.release, { running: true });
  const firstCount = f.calls.length;
  const result = await synchronize(f.deployment, f.release, options);
  assert.equal(result.changed, false); assert.equal(f.calls.length, firstCount);
  const selected = { ...f.release, plugins: [f.release.plugins[0]] };
  await synchronize(f.deployment, selected, options); await finalize(f.deployment, selected, { running: true });
  assert.ok(f.calls.slice(firstCount).filter(call => call.home === f.deployment.home).every(call => call.args[0] === 'remove' && call.args.at(-1) === 'fixture-beta'));
  const empty = { ...f.release, plugins: [] };
  await synchronize(f.deployment, empty, options); await finalize(f.deployment, empty, { running: true });
  assert.deepEqual(read(join(f.deployment.profileRoot, 'package.json')).dependencies, {});
});

test('failed second installation remains recoverable and never claims unrelated packages', async t => {
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
  const pendingPath = join(f.deployment.profileRoot, '.deepseek-plugin-pending.json');
  assert.equal(read(pendingPath).status, 'failed');
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')), false);
  await assert.rejects(synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli }), /未完成部署/);
  f.deployment.options.resume = true;
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, f.release, { running: true });
  assert.equal(existsSync(pendingPath), false);
  assert.deepEqual(read(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')).plugins.map(p => p.id), ['alpha', 'beta']);
});

test('an orphaned owned Bundle preserves ownership until its dependency is restored', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, f.release, { running: true });
  const path = join(f.deployment.profileRoot, 'package.json');
  const metadata = read(path); delete metadata.dependencies['fixture-alpha']; atomicJSON(path, metadata);
  const empty = { ...f.release, plugins: [] };
  await assert.rejects(synchronize(f.deployment, empty, { execute: f.execute, cli: f.cli }), /Bundle.*依赖已缺失/);
  assert.equal(read(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')).plugins.length, 2);
  f.deployment.options.rebuild = true;
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, f.release, { running: true });
  await synchronize(f.deployment, empty, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, empty, { running: true });
  assert.deepEqual(read(path).dsh.profile.bundles, []);
});

test('external synchronization requires stop evidence and applied configuration requires start evidence', async t => {
  const f = fixture(t); f.deployment.hostMode = 'external';
  delete f.deployment.options['stopped-file'];
  await assert.rejects(synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli }), /停服证据/);
  assert.equal(existsSync(join(f.deployment.profileRoot, 'package.json')), false);
  f.deployment.options['stopped-file'] = join(f.root, 'stopped.json');
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  await assert.rejects(finalize(f.deployment, f.release), /启动证据/);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')), false);
});

test('external synchronization rejects stopped evidence for a live process', async t => {
  const f = fixture(t); f.deployment.hostMode = 'external';
  const evidence = f.deployment.options['stopped-file'];
  atomicJSON(evidence, { ...read(evidence), pid: process.pid });
  await assert.rejects(synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli }), /进程状态与证据不符/);
  assert.equal(existsSync(join(f.deployment.profileRoot, 'package.json')), false);
});

test('recovery selects a corrected release while retaining the old journal and partial ownership', async t => {
  const f = fixture(t);
  const broken = (cli, d, args, home) => {
    f.execute(cli, d, args, home);
    if (home === undefined) throw new Error('interrupted-after-install');
  };
  await assert.rejects(synchronize(f.deployment, f.release, { execute: broken, cli: f.cli }), /interrupted/);
  const pendingPath = join(f.deployment.profileRoot, '.deepseek-plugin-pending.json');
  const original = read(pendingPath);
  const selected = { ...f.release, plugins: [f.release.plugins[0]] };
  f.deployment.options.recover = true;
  await assert.rejects(synchronize(f.deployment, selected, { execute: f.execute, cli: f.cli }), /data-compatible/);
  f.deployment.options['data-compatible'] = true;
  await assert.rejects(synchronize(f.deployment, selected, { cli: f.cli, execute: () => { throw new Error('preflight-failure'); } }), /preflight-failure/);
  assert.deepEqual(read(pendingPath), original);
  await synchronize(f.deployment, selected, { execute: f.execute, cli: f.cli });
  const replacement = read(pendingPath);
  assert.equal(replacement.supersedes, original.operationId);
  assert.notEqual(replacement.operationId, original.operationId);
  assert.deepEqual(read(join(f.deployment.dataRoot, '.deployment-private', original.operationId, 'pending-before-recovery.json')), original);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')), false);
  await finalize(f.deployment, selected, { running: true });
  assert.equal(read(join(f.deployment.profileRoot, 'package.json')).dependencies['fixture-beta'], undefined);
  assert.deepEqual(read(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')).plugins.map(p => p.id), ['alpha']);
});

test('unchanged installations still require external stop evidence before owned startup', async t => {
  const f = fixture(t);
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, f.release, { running: true });
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  delete f.deployment.options['stopped-file'];
  const cliFile = join(f.root, 'never-start.mjs'); writeFileSync(cliFile, 'throw new Error("must not spawn");');
  f.deployment.options['dsh-cli-js'] = cliFile;
  await assert.rejects(supervise(f.deployment, f.release), /停服证据/);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-owner.json')), false);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-lock')), false);
});

test('configuration revision restarts without reinstall', async t => {
  const f = fixture(t); await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  await finalize(f.deployment, f.release, { running: true });
  f.calls.length = 0; f.deployment.instances.alpha = { configRevision: 1 };
  await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  assert.equal(f.calls.length, 0);
  await finalize(f.deployment, f.release, { running: true });
  assert.equal(read(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')).configurations.alpha.configRevision, 1);
});

test('configuration changes after sync cannot finalize a stale applied record', async t => {
  const f = fixture(t); await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
  f.deployment.instances.alpha = { configRevision: 3 };
  await assert.rejects(finalize(f.deployment, f.release, { running: true }), /验证配置与待启动/);
  assert.equal(existsSync(join(f.deployment.profileRoot, '.deepseek-plugin-state.json')), false);
});

test('every plugin probe is checked and a later failure cannot be hidden by the first success', async t => {
  const f = fixture(t); await synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli });
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

test('explicit adoption manages only named actual installations and still requires sync', async t => {
  const f = fixture(t);
  for (const p of f.release.plugins) f.execute(f.cli, f.deployment, ['add', `file:${p.archivePath}`]);
  await assert.rejects(adoptLegacy(f.deployment, f.release, ['all']), /精确列出/);
  const result = await adoptLegacy(f.deployment, f.release, ['alpha']);
  assert.equal(result.status, 'adopted-requires-sync');
  const state = read(join(f.deployment.profileRoot, '.deepseek-plugin-state.json'));
  assert.deepEqual(state.plugins.map(p => p.id), ['alpha']);
  assert.equal(state.plugins[0].sha256, '0'.repeat(64));
  assert.deepEqual(state.configurations, {});
});

test('profile locks reject concurrent synchronization without clobbering the owner', t => {
  const f = fixture(t); const unlock = acquireLock(f.deployment.profileRoot);
  assert.throws(() => acquireLock(f.deployment.profileRoot), /正在同步/);
  unlock(); const again = acquireLock(f.deployment.profileRoot); again();
});

test('legacy discovery-derived state is not automatically adopted', async t => {
  const f = fixture(t);
  atomicJSON(join(f.deployment.profileRoot, '.deepseek-plugin-managed.json'), { schemaVersion: 1, packages: ['fixture-alpha', 'unmanaged'] });
  await assert.rejects(synchronize(f.deployment, f.release, { execute: f.execute, cli: f.cli }), /旧受管/);
  assert.equal(f.calls.length, 0);
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
