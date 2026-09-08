/** Container settings must be usable by the declared process identity before restart. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveDeployment } from '../src/config.mjs';
import { applyCompose as apply, checkCompose } from '../src/apply-compose.mjs';
import { LOCK, OWNER, PENDING, atomicJSON } from '../src/state.mjs';
const runtime = { endpoint: 'unix:///var/run/docker.sock', id: 'test-engine', desktop: false, architecture: 'amd64' };
const applyCompose = (deployment, release, execute) => apply(deployment, release, (args, options) => execute(args.slice(2), options), runtime);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compose-access-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  if (process.platform !== 'win32') chmodSync(root, 0o755);
  atomicJSON(join(root, 'deployment.json'), { containerImage: `registry.example/host@sha256:${'a'.repeat(64)}`, containerUid: process.getuid?.() || 1000, containerGid: process.getgid?.() || 1000 });
  const deployment = resolveDeployment({ root, config: 'deployment.json' }, {});
  const release = { path: join(root, 'release/manifest.json'), plugins: [{ id: 'weather', healthPath: '/weather/ready', configuration: { entryId: 'weather' } }] };
  mkdirSync(dirname(release.path), { recursive: true });
  return { root, deployment, release, settingsFile: join(deployment.home, 'plugins/weather/plugin.json') };
}

test('fresh deployment initializes directories and settings for the container user', t => {
  const f = fixture(t), calls = [];
  const result = applyCompose(f.deployment, f.release, args => calls.push(args));
  const compose = JSON.parse(readFileSync(result.path, 'utf8'));
  const { containerUid: uid, containerGid: gid } = f.deployment.config;
  assert.equal(compose.services.dsh.user, `${uid}:${gid}`);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(f.settingsFile, 'utf8')), { schemaVersion: 1, enabled: true });
  if (process.platform !== 'linux') return;
  for (const path of [f.deployment.dataRoot, f.deployment.home, f.deployment.workspace, f.settingsFile, result.configPath]) {
    assert.equal(statSync(path).uid, uid, path);
    assert.equal(statSync(path).gid, gid, path);
  }
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', 'import { readFileSync, writeFileSync } from "node:fs"; JSON.parse(readFileSync(process.argv[1], "utf8")); JSON.parse(readFileSync(process.argv[2], "utf8")); writeFileSync(process.argv[3], "writable");', f.settingsFile, result.configPath, join(f.deployment.home, 'container-write-probe')], {
    cwd: f.root, encoding: 'utf8', ...(process.getuid() === 0 ? { uid, gid } : {}),
  });
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
});

test('local image startup uses the configured health port and forwards recovery to the container', t => {
  const f = fixture(t);
  f.deployment.config.containerImage = `sha256:${'b'.repeat(64)}`;
  f.deployment.config.port = 17913;
  f.deployment.options.resume = true;
  f.deployment.options.rebuild = true;
  const result = applyCompose(f.deployment, f.release, () => {});
  const service = JSON.parse(readFileSync(result.path, 'utf8')).services.dsh;
  assert.equal(service.image, f.deployment.config.containerImage);
  assert.equal(service.pull_policy, 'never');
  assert.deepEqual(service.command, ['--rebuild', '--resume']);
  assert.equal(service.environment.DSH_PORT, '17913');
  assert.equal(JSON.parse(readFileSync(result.configPath, 'utf8')).port, 17913);
});

test('a stopped matching container permits preserving and clearing only its stale process records', t => {
  const f = fixture(t);
  applyCompose(f.deployment, f.release, () => {});
  const records = {
    [LOCK]: { host: 'old-container', pid: 7 },
    [OWNER]: { host: 'old-container', home: '/data/dsh-home', profile: 'web', pid: 7, token: 'kept-private' },
    [PENDING]: { operationId: 'retain-this-operation' },
  };
  for (const [name, value] of Object.entries(records)) atomicJSON(join(f.deployment.profileRoot, name), value);
  const result = applyCompose(f.deployment, f.release, args => {
    if (args.includes('ps')) return 'old-id';
    if (args[0] === 'inspect') return JSON.stringify([{ State: { Running: false, Restarting: false }, Config: { Hostname: 'old-container', Env: ['DSH_HOME=/data/dsh-home', 'DSH_PROFILE=web'] }, Mounts: [{ Type: 'bind', Source: f.deployment.dataRoot, Destination: '/data' }] }]);
    return '';
  });
  for (const name of [LOCK, OWNER]) {
    assert.equal(existsSync(join(f.deployment.profileRoot, name)), false);
    assert.deepEqual(JSON.parse(readFileSync(join(dirname(result.path), 'stopped-records', name))), records[name]);
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.deployment.profileRoot, PENDING))), records[PENDING]);
});

for (const problem of ['running', 'hostname', 'mount', 'legacy', 'no-container', 'inspect-error']) test(`recovery retains process records when container proof fails: ${problem}`, t => {
  const f = fixture(t);
  applyCompose(f.deployment, f.release, () => {});
  const owner = { ...(problem === 'legacy' ? {} : { host: 'old-container' }), home: '/data/dsh-home', profile: 'web' };
  atomicJSON(join(f.deployment.profileRoot, OWNER), owner);
  let started = false;
  assert.throws(() => applyCompose(f.deployment, f.release, args => {
    if (args.includes('up')) started = true;
    if (args.includes('ps')) return problem === 'no-container' ? '' : 'old-id';
    if (args[0] === 'inspect') {
      if (problem === 'inspect-error') throw new Error('inspect failed');
      return JSON.stringify([{ State: { Running: problem === 'running', Restarting: false }, Config: { Hostname: problem === 'hostname' ? 'other' : 'old-container', Env: ['DSH_HOME=/data/dsh-home', 'DSH_PROFILE=web'] }, Mounts: [{ Type: 'bind', Source: problem === 'mount' ? join(f.root, 'other') : f.deployment.dataRoot, Destination: '/data' }] }]);
    }
    return '';
  }), /旧容器|残留运行记录|inspect failed/);
  assert.equal(started, false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.deployment.profileRoot, OWNER))), owner);
});

test('unreadable existing settings reject deployment before stopping Docker and keep ownership', { skip: process.platform !== 'linux' ? 'Linux filesystem permissions required' : false }, t => {
  const f = fixture(t), calls = [];
  // The administrator can read this file; the configured container identity cannot.
  f.deployment.config.containerUid = (process.getuid() || 1000) + 1;
  f.deployment.config.containerGid = (process.getgid() || 1000) + 1;
  for (const path of [f.deployment.dataRoot, f.deployment.home, f.deployment.workspace]) { mkdirSync(path, { recursive: true }); chmodSync(path, 0o777); }
  atomicJSON(f.settingsFile, { schemaVersion: 1, enabled: true });
  chmodSync(f.settingsFile, 0o600);
  const before = statSync(f.settingsFile), content = readFileSync(f.settingsFile, 'utf8');
  assert.throws(() => applyCompose(f.deployment, f.release, args => calls.push(args)), error => /无法访问/.test(error.message) && error.message.includes(f.settingsFile));
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(f.settingsFile, 'utf8'), content);
  assert.equal(statSync(f.settingsFile).uid, before.uid);
  assert.equal(statSync(f.settingsFile).gid, before.gid);
  assert.equal(statSync(f.settingsFile).mode, before.mode);
});

test('Desktop preflight uses bridge and rejects inaccessible mounts before any stop', t => {
  const f = fixture(t), desktop = { ...runtime, desktop: true }, calls = [];
  const generated = checkCompose(f.deployment, f.release, args => { calls.push(args); }, desktop);
  const service = JSON.parse(readFileSync(generated.path, 'utf8')).services.dsh;
  assert.equal(service.network_mode, undefined);
  assert.equal(service.environment.DSH_BIND_HOST, '0.0.0.0');
  assert.deepEqual(service.ports, [{ target: 7902, published: '7902', host_ip: '127.0.0.1', protocol: 'tcp' }]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--user'));
  assert.ok(calls[0].includes('--mount'));
  const failures = [];
  assert.throws(() => apply(f.deployment, f.release, args => { failures.push(args); if (args.includes('run')) throw new Error('mount inaccessible'); }, desktop), /mount inaccessible/);
  assert.ok(failures.every(args => !args.includes('stop') && !args.includes('up')));
});

test('an unexpected Docker engine rejects before writing candidate settings', t => {
  const f = fixture(t);
  f.deployment.config.dockerRuntime = { ...runtime, id: 'previous-engine' };
  assert.throws(() => checkCompose(f.deployment, f.release, () => {}, runtime), /Docker 引擎/);
  assert.equal(existsSync(f.settingsFile), false);
});
