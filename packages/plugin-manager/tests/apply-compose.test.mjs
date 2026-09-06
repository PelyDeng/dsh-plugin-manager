/** Container settings must be usable by the declared process identity before restart. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { resolveDeployment } from '../src/config.mjs';
import { applyCompose } from '../src/apply-compose.mjs';
import { atomicJSON } from '../src/state.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compose-access-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  if (process.platform !== 'win32') chmodSync(root, 0o755);
  atomicJSON(join(root, 'deployment.json'), { containerImage: `registry.example/host@sha256:${'a'.repeat(64)}`, containerUid: process.getuid?.() || 1000, containerGid: process.getgid?.() || 1000 });
  const deployment = resolveDeployment({ root, config: 'deployment.json' }, {});
  const release = { path: join(root, 'release/manifest.json'), plugins: [{ id: 'weather', healthPath: '/weather/ready', configuration: { entryId: 'weather' } }] };
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
