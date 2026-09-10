import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hash, tarCommand } from '../src/state.mjs';
import { discoverArchives, validateRuntimeIndex } from '../src/site-archives.mjs';
import { releaseSite } from '../src/site-release.mjs';
import { fileHash, readSitePointer, readSiteRecord, verifySavedTooling } from '../src/site-record.mjs';

const image = `registry.test/runtime@sha256:${'a'.repeat(64)}`, hostCommit = 'b'.repeat(40);
const entry = ['node', '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs', 'container-start', '--root', '/opt/plugin-project'];
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'site archives 中文 ')));
  t.after(() => { assert.equal(dirname(root), realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const put = (path, value) => { path = resolve(root, path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); return path; };
  for (const name of ['cli', 'site-release']) put(`tools/node_modules/@dsh-plugin-manager/plugin-manager/dist/${name}.mjs`, 'export {};');
  let version, runtimeImage;
  const setFramework = (value, reference = image) => {
    version = value; runtimeImage = reference;
    put('tools/plugin-manager.tgz', `isolated-tool-fixture-${version}`);
    put('tools/node_modules/@dsh-plugin-manager/plugin-manager/package.json', { version });
    put('framework-runtime.json', { schemaVersion: 1, frameworkVersion: version, manager: { version, sha256: fileHash(resolve(root, 'tools/plugin-manager.tgz')) }, runtimes: [{ platform: 'linux/amd64', image: runtimeImage, hostCommit }] });
  };
  setFramework('0.15.2');
  const pack = (directory = 'alpha-release', content = 'one') => {
    const stage = resolve(root, 'stage/package'), output = resolve(root, 'incoming', directory);
    put('stage/package/package.json', { name: 'fixture-alpha', version: '0.1.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } }, deepseekPlugin: { schemaVersion: 3, id: 'alpha', configuration: { entryId: 'alpha' } } });
    put('stage/package/index.js', `export const value = '${content}';`); put('stage/package/cordis.patch.yml', '{}\n');
    mkdirSync(output, { recursive: true });
    const archive = resolve(output, 'alpha.tgz'), tar = spawnSync(tarCommand, ['-czf', '-', 'package'], { cwd: dirname(stage), windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr?.toString());
    writeFileSync(archive, tar.stdout);
    put(resolve(output, 'manifest.json'), { schemaVersion: 1, plugins: [{ id: 'alpha', package: 'fixture-alpha', version: '0.1.0', directory: 'plugins/alpha', archive: 'alpha.tgz', sha256: fileHash(archive), verifyFiles: ['package.json', 'index.js', 'cordis.patch.yml'], configuration: { entryId: 'alpha' } }] });
  };
  pack();
  const calls = []; let fail = 'check-compose';
  const execute = (bin, args) => {
    calls.push([bin, ...args]);
    if (args[1] === fail) throw new Error(`fixture ${fail} failure`);
    if (bin === 'docker' && args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
    if (bin === 'docker' && args[0] === '--host') return args[2] === 'info' ? JSON.stringify({ OSType: 'linux', ID: 'site-engine', Architecture: 'x86_64', OperatingSystem: process.platform === 'linux' ? 'Linux' : 'Docker Desktop' }) : 'Docker Compose fixture';
    if (bin === 'docker' && args[0] === 'image') return JSON.stringify([{ Id: runtimeImage.split('@')[1], Os: 'linux', Architecture: 'amd64', Config: { Entrypoint: entry, Labels: { 'org.opencontainers.image.revision': hostCommit, 'com.dsh-plugin-manager.manager.sha256': fileHash(resolve(root, 'tools/plugin-manager.tgz')) } } }]);
    if (bin === 'docker' && args[0] === 'run') return version;
    return '';
  };
  const record = () => { const pointer = readSitePointer(root); return readSiteRecord(root, pointer.operation); };
  return { root, put, pack, calls, execute, record, setFramework, setFail: value => { fail = value; } };
}

for (const priorKind of ['current', 'schema3 archives', 'schema3 source', 'mismatched image', 'mismatched candidate', 'mismatched operation', 'mismatched manifest', 'schema2']) test(`framework summary identifies a ${priorKind} deployment before preflight`, t => {
  const f = fixture(t), messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  f.setFail(null);
  const successful = releaseSite({ root: f.root }, f.execute), candidate = JSON.parse(readFileSync(successful.candidatePath));
  if (priorKind === 'current') assert.equal(candidate.frameworkVersion, '0.15.2');
  else {
    // Recreate a real pre-field deployment using the completed lifecycle's frozen candidate.
    delete candidate.frameworkVersion;
    f.put(successful.candidatePath, candidate); f.put('.local/deployment.json', candidate);
    successful.candidateHash = fileHash(successful.candidatePath);
    if (priorKind === 'schema3 source') { successful.inputKind = 'source'; delete successful.frameworkVersion; }
    if (priorKind === 'mismatched image') successful.image = `registry.test/runtime@sha256:${'d'.repeat(64)}`;
    if (priorKind === 'mismatched candidate') successful.candidateHash = 'e'.repeat(64);
    if (priorKind === 'mismatched operation') successful.siteOperation = '12345678-1234-1234-1234-123456789012';
    if (priorKind === 'mismatched manifest') successful.manifest = resolve(f.root, 'unrelated/manifest.json');
    if (priorKind === 'schema2') successful.schemaVersion = 2;
    f.put(resolve(successful.operation, 'result.json'), successful);
  }
  const compose = f.put('.local/artifacts/prior-compose.json', { services: { dsh: { image, environment: { DSH_PORT: candidate.port } } } });
  f.put('.local/artifacts/active-compose.json', { project: candidate.composeProject, path: compose });
  f.setFramework('0.15.3', `registry.test/runtime@sha256:${'c'.repeat(64)}`);
  f.setFail('check-compose'); messages.length = 0;
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture check-compose/);
  const known = ['current', 'schema3 archives', 'schema3 source'].includes(priorKind);
  assert.ok(messages.some(message => message.startsWith(`框架 ${known ? '0.15.2' : '首次/旧记录'} → 0.15.3；`)), messages.join('\n'));
  assert.equal(f.calls.some(call => call[0] === 'docker' && call.includes('stop')), false);
});

for (const legacy of [false, true]) test(`framework recovery summary retains the ${legacy ? 'legacy schema3' : 'current'} runtime after the failed candidate was applied`, t => {
  const f = fixture(t), messages = [], targetImage = `registry.test/runtime@sha256:${'c'.repeat(64)}`;
  t.mock.method(console, 'log', message => messages.push(message));
  f.setFail(null);
  const successful = releaseSite({ root: f.root }, f.execute), candidate = JSON.parse(readFileSync(successful.candidatePath));
  if (legacy) {
    delete candidate.frameworkVersion;
    f.put(successful.candidatePath, candidate); f.put('.local/deployment.json', candidate);
    successful.candidateHash = fileHash(successful.candidatePath);
    f.put(resolve(successful.operation, 'result.json'), successful);
  }
  const data = resolve(f.root, '.local/data'), containerId = 'f'.repeat(64);
  mkdirSync(data, { recursive: true });
  const compose = f.put('.local/artifacts/prior-compose.json', { services: { dsh: { image,
    environment: { DSH_PORT: candidate.port, DSH_HOME: '/data/dsh-home', DSH_PROFILE: 'web' }, volumes: [{ type: 'bind', source: data, target: '/data' }] } } });
  f.put('.local/artifacts/active-compose.json', { project: candidate.composeProject, path: compose });
  const execute = (bin, args) => {
    if (bin === 'docker' && args[0] === 'compose' && args.includes('ps') && args.includes('-a')) return containerId;
    if (bin === 'docker' && args[0] === 'inspect') return JSON.stringify([{ Id: containerId, State: { Running: false, Restarting: false },
      Config: { Image: image, Labels: { 'com.docker.compose.service': 'dsh' }, Env: ['DSH_HOME=/data/dsh-home', 'DSH_PROFILE=web'] },
      Mounts: [{ Type: 'bind', Source: data, Destination: '/data', RW: true }] }]);
    if (bin === 'docker' && args.includes('--volumes-from')) return readFileSync(resolve(data, args.at(-1).slice('/data/'.length)), 'utf8');
    return f.execute(bin, args);
  };
  f.setFramework('0.15.3', targetImage); f.setFail('apply-compose');
  assert.throws(() => releaseSite({ root: f.root }, execute), /fixture apply-compose/);
  assert.equal(JSON.parse(readFileSync(resolve(f.root, '.local/deployment.json'))).containerImage, targetImage);
  messages.length = 0; f.setFail(null);
  assert.equal(releaseSite({ root: f.root, recover: true, dataCompatible: true }, execute).status, 'ready');
  assert.ok(messages.includes(`框架 0.15.2 → 0.15.3；宿主镜像 ${image} → ${targetImage}`), messages.join('\n'));
});

test('archive discovery requires complete, unique, ordinary release directories', t => {
  const f = fixture(t);
  assert.deepEqual(discoverArchives(f.root).flatMap(r => r.plugins.map(p => p.id)), ['alpha']);
  f.pack('old-alpha');
  assert.throws(() => discoverArchives(f.root), /重复插件.*alpha-release.*old-alpha/);
  const duplicate = resolve(f.root, 'incoming/old-alpha'); assert.equal(dirname(duplicate), resolve(f.root, 'incoming')); rmSync(duplicate, { recursive: true });
  f.put('incoming/loose.tgz', 'loose'); assert.throws(() => discoverArchives(f.root), /完整发布目录/);
  rmSync(resolve(f.root, 'incoming/loose.tgz'));
  f.put('incoming/alpha-release/alpha.tgz', 'tampered'); assert.throws(() => discoverArchives(f.root), /摘要/);
});

test('prepared archive operations freeze tools and inputs before data writes and resume without incoming', t => {
  const f = fixture(t);
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture check-compose/);
  const record = f.record(); assert.equal(record.schemaVersion, 3); assert.equal(record.status, 'deployment-failed');
  assert.equal(existsSync(resolve(f.root, '.local/data')), false);
  assert.equal(f.calls.some(call => ['npm', 'pnpm', 'git'].includes(call[0])), false);
  const settings = resolve(f.root, '.local/config/plugins/alpha/plugin.json');
  assert.equal(existsSync(settings), true);
  const candidate = JSON.parse(readFileSync(record.candidatePath));
  assert.equal(typeof record.siteOperation, 'string');
  assert.equal(candidate.siteOperation, record.siteOperation);
  assert.ok(candidate.instances.alpha.settingsFile.startsWith(record.operation));
  const incoming = resolve(f.root, 'incoming'); assert.equal(dirname(incoming), f.root); rmSync(incoming, { recursive: true });
  f.setFail(null);
  assert.equal(releaseSite({ root: f.root, resume: true }, f.execute).status, 'ready');
  assert.equal(f.record().operation, record.operation);
});

test('configuration recovery uses the same saved package and rejects enablement or tool changes', t => {
  const f = fixture(t);
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture check-compose/);
  const original = f.record(), settings = resolve(f.root, '.local/config/plugins/alpha/plugin.json');
  f.put(settings, { schemaVersion: 1, enabled: false, config: {} });
  assert.throws(() => releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute), /enabled\/accessMode/);
  f.put(settings, { schemaVersion: 1, enabled: true, config: { corrected: true } });
  assert.throws(() => releaseSite({ root: f.root, resume: true }, f.execute), /原受管输入已变化/);
  f.setFail(null);
  const recovered = releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute);
  assert.equal(recovered.supersedes, original.operation); assert.notEqual(recovered.operation, original.operation);
  assert.deepEqual(recovered.selectedPlugins, original.selectedPlugins);
  const candidate = JSON.parse(readFileSync(recovered.candidatePath));
  assert.equal(candidate.siteOperation, recovered.siteOperation);
  assert.equal(candidate.siteRecovery.id, recovered.siteOperation);
  assert.notEqual(recovered.siteOperation, original.siteOperation);
  assert.equal(candidate.siteRecovery.pendingId, null);
  assert.deepEqual(JSON.parse(readFileSync(candidate.instances.alpha.settingsFile)).config, { corrected: true });
  f.put(resolve(recovered.toolRoot, 'node_modules/extra.mjs'), 'changed');
  assert.throws(() => verifySavedTooling(recovered), /execution tree changed/);
});

for (const kind of ['pending', 'state']) for (const field of ['configurations', 'environment', 'patches']) test(`recover rejects unrelated same-package ${kind} with different ${field}`, t => {
  const f = fixture(t);
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture check-compose/);
  const original = f.record();
  const desired = { schemaVersion: 2, plugins: original.selectedPlugins, siteOperation: '12345678-1234-1234-1234-123456789012',
    [field]: field === 'patches' ? ['/other.yml'] : { unrelated: true } };
  const value = kind === 'state' ? desired : { schemaVersion: 2, operationId: '22345678-1234-1234-1234-123456789012', desired };
  f.put(resolve(original.sitePaths.home, 'profiles', original.sitePaths.profile, `.deepseek-plugin-${kind}.json`), value);
  const callsBefore = f.calls.length;
  f.setFail(null);
  assert.throws(() => releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute), /失败候选|受管成功状态/);
  assert.equal(f.record().operation, original.operation);
  assert.equal(f.calls.slice(callsBefore).some(call => call[2] === 'apply-compose'), false);
});

for (const kind of ['pending', 'state']) test(`recover accepts ${kind} owned by the failed site candidate`, t => {
  const f = fixture(t);
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture check-compose/);
  const original = f.record();
  const desired = { schemaVersion: 2, plugins: original.selectedPlugins, siteOperation: original.siteOperation };
  const value = kind === 'state' ? desired : { schemaVersion: 2, operationId: '22345678-1234-1234-1234-123456789012', desired };
  f.put(resolve(original.sitePaths.home, 'profiles', original.sitePaths.profile, `.deepseek-plugin-${kind}.json`), value);
  f.setFail(null);
  assert.equal(releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute).status, 'ready');
});

test('recover before the first pending accepts only the recorded prior successful state', t => {
  const f = fixture(t);
  f.setFail(null);
  const successful = releaseSite({ root: f.root }, f.execute), candidate = JSON.parse(readFileSync(successful.candidatePath));
  const state = { schemaVersion: 2, plugins: successful.selectedPlugins, siteOperation: successful.siteOperation };
  const statePath = resolve(successful.sitePaths.home, 'profiles', successful.sitePaths.profile, '.deepseek-plugin-state.json');
  f.put(statePath, state);
  const composePath = f.put('.local/artifacts/prior-compose.json', { services: { dsh: { image, environment: { DSH_PORT: candidate.port } } } });
  f.put('.local/artifacts/active-compose.json', { project: candidate.composeProject, path: composePath });
  f.pack('alpha-release', 'updated'); f.setFail('check-compose');
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture check-compose/);
  const failed = f.record();
  assert.equal(failed.previousStateHash, hash(JSON.stringify(state)));
  assert.notDeepEqual(failed.selectedPlugins, state.plugins);
  f.put(statePath, { ...state, configurations: { drifted: true } });
  assert.throws(() => releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute), /受管成功状态/);
  f.put(statePath, state);
  assert.throws(() => releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute), /fixture check-compose/);
  assert.equal(f.record().supersedes, failed.operation);
});

test('recover accepts first installation failing before pending creation', t => {
  const f = fixture(t); f.setFail('apply-compose');
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture apply-compose/);
  assert.equal(f.record().installStarted, true);
  assert.equal(f.record().previousStateHash, null);
  f.setFail(null);
  assert.equal(releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute).status, 'ready');
});

test('repeated recovery before pending consumption keeps only the already-authorized transaction', t => {
  const f = fixture(t);
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture check-compose/);
  const original = f.record(), pendingPath = resolve(original.sitePaths.home, 'profiles', original.sitePaths.profile, '.deepseek-plugin-pending.json');
  const pending = { schemaVersion: 2, operationId: '22345678-1234-1234-1234-123456789012', desired: { schemaVersion: 2, plugins: original.selectedPlugins, siteOperation: original.siteOperation } };
  f.put(pendingPath, pending);
  assert.throws(() => releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute), /fixture check-compose/);
  const failedRecovery = f.record();
  assert.equal(Object.hasOwn(failedRecovery, 'previousStateHash'), false);
  rmSync(pendingPath);
  assert.throws(() => releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute), /受管成功状态/);
  f.put(pendingPath, { ...pending, desired: { ...pending.desired, configurations: { drifted: true } } });
  assert.throws(() => releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute), /原 pending/);
  f.put(pendingPath, pending); f.setFail(null);
  const recovered = releaseSite({ root: f.root, recover: true, dataCompatible: true }, f.execute);
  assert.equal(recovered.supersedes, failedRecovery.operation);
  assert.equal(recovered.status, 'ready');
});

test('saved operations and executable paths cannot escape through directory junctions', t => {
  const f = fixture(t);
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture check-compose/);
  const record = f.record(), outside = resolve(f.root, 'elsewhere');
  cpSync(record.toolRoot, outside, { recursive: true, filter: () => true });
  assert.throws(() => verifySavedTooling({ ...record, toolRoot: outside }), /escapes/);
  const link = resolve(f.root, '.local/artifacts/redirect');
  try { symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('link creation unavailable'); throw error; }
  f.put('.local/source-release.json', { operation: link, status: 'prepared' });
  assert.throws(() => readSitePointer(f.root), /escapes|real directory/);
});

test('runtime metadata rejects version mismatch and duplicate platforms', () => {
  const index = { schemaVersion: 1, frameworkVersion: '0.15.2', manager: { version: '0.15.2', sha256: 'c'.repeat(64) }, runtimes: [{ platform: 'linux/amd64', image, hostCommit }] };
  assert.equal(validateRuntimeIndex(index), index);
  assert.throws(() => validateRuntimeIndex({ ...index, manager: { ...index.manager, version: '0.1.0' } }), /发行信息/);
  assert.throws(() => validateRuntimeIndex({ ...index, runtimes: [...index.runtimes, ...index.runtimes] }), /平台重复/);
});
