/** Standard plugin settings work for arbitrary plugin names, without framework edits. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, chownSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { resolveDeployment } from '../src/config.mjs';
import { atomicJSON } from '../src/state.mjs';
import { resolvePluginSettings, applyPluginSettings } from '../src/plugin-settings.mjs';
import { renderCompose } from '../src/compose.mjs';
import { applyCompose } from '../src/apply-compose.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-settings-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  atomicJSON(join(root, 'deployment.json'), { publicOrigin: 'https://plugins.example', containerImage: `registry.example/host@sha256:${'a'.repeat(64)}`, containerUid: process.getuid?.() || 1000, containerGid: process.getgid?.() || 1000 });
  const deployment = resolveDeployment({ root, config: 'deployment.json' }, {});
  const release = { path: join(root, 'release/manifest.json'), plugins: [
    { id: 'identity', healthPath: '/identity/ready', configuration: { entryId: 'identity-provider', auth: 'provider' } },
    { id: 'weather', healthPath: '/weather/ready', configuration: { entryId: 'weather-service', auth: 'consumer' } },
  ] };
  const settings = (id, value) => atomicJSON(join(deployment.home, 'plugins', id, 'plugin.json'), { schemaVersion: 1, ...value });
  return { root, deployment, release, settings };
}

test('one plugin setting changes only its authentication and immutable generated patch', t => {
  const f = fixture(t);
  const first = resolvePluginSettings(f.deployment, f.release);
  assert.equal(first.entries[1].config.accessMode, 'authenticated');
  applyPluginSettings(f.deployment, first);
  const before = f.deployment.config.patches.at(-1), bytes = readFileSync(before, 'utf8');
  f.deployment.config.patches = [];
  f.settings('weather', { accessMode: 'standalone', config: { pageSize: 20 } });
  const next = resolvePluginSettings(f.deployment, f.release);
  assert.deepEqual(next.entries[0], first.entries[0]);
  assert.deepEqual(next.entries[1], { id: 'weather-service', config: { pageSize: 20, accessMode: 'standalone' } });
  applyPluginSettings(f.deployment, next);
  assert.notEqual(f.deployment.config.patches.at(-1), before);
  assert.equal(readFileSync(before, 'utf8'), bytes);
});

test('disabled authentication never downgrades protected consumers', t => {
  const f = fixture(t);
  f.settings('identity', { enabled: false });
  assert.throws(() => resolvePluginSettings(f.deployment, f.release), /认证提供者/);
  f.settings('weather', { accessMode: 'standalone' });
  assert.deepEqual(resolvePluginSettings(f.deployment, f.release).release.plugins.map(p => p.id), ['weather']);
});

test('omitted health paths and runtime fields keep authenticated defaults', t => {
  const f = fixture(t);
  for (const plugin of f.release.plugins) delete plugin.healthPath;
  f.settings('weather', {});
  const result = resolvePluginSettings(f.deployment, f.release);
  assert.equal(result.release.plugins.length, 2);
  assert.equal(result.entries[1].config.accessMode, 'authenticated');
  assert.equal(result.entries[1].config.publicOrigin, 'https://plugins.example');
});

test('invalid or ambiguous settings fail before deployment', t => {
  const f = fixture(t);
  for (const bad of [{ schemaVersion: 2 }, { enabled: 'false' }, { accessMode: 'typo' }, { auth: false }, { config: { accessMode: 'standalone' } }, { config: [] }]) {
    f.settings('weather', bad);
    assert.throws(() => resolvePluginSettings(f.deployment, f.release));
  }
  f.settings('weather', {});
  f.deployment.config.publicOrigin = 'https://plugins.example/path';
  assert.throws(() => resolvePluginSettings(f.deployment, f.release), /origin/);
});

test('Compose mounts per-plugin settings and preserves disabled candidates for later re-enabling', t => {
  const f = fixture(t);
  f.settings('weather', { enabled: false });
  const generated = renderCompose(f.deployment, f.release, join(f.root, 'compose'));
  const config = JSON.parse(readFileSync(generated.configPath));
  assert.deepEqual(config.plugins, ['identity', 'weather']);
  assert.equal(config.instances.weather.settingsFile, '/run/dsh-plugin-settings/weather.json');
  const compose = JSON.parse(readFileSync(generated.path));
  assert.ok(compose.services.dsh.healthcheck.test.includes('health'));
  assert.ok(!JSON.stringify(compose.services.dsh.healthcheck).includes('/weather/ready'));
});

test('apply generates one complete Compose document and preserves existing settings', t => {
  const f = fixture(t), calls = [];
  f.settings('weather', { accessMode: 'standalone' });
  const file = join(f.deployment.home, 'plugins/weather/plugin.json'), before = readFileSync(file, 'utf8');
  if (process.getuid?.() === 0) for (const path of [f.deployment.dataRoot, f.deployment.home, join(f.deployment.home, 'plugins'), dirname(file), file]) chownSync(path, f.deployment.config.containerUid, f.deployment.config.containerGid);
  const result = applyCompose(f.deployment, f.release, args => calls.push(args.slice(2)), { endpoint: 'unix:///var/run/docker.sock', id: 'settings-test', desktop: false, architecture: 'amd64' });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.ok(existsSync(join(f.deployment.home, 'plugins/identity/plugin.json')));
  assert.deepEqual(calls.map(args => args.slice(5)), [['stop', 'dsh'], ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '180', 'dsh']]);
  const compose = JSON.parse(readFileSync(result.path));
  assert.equal(compose.services.dsh.image, f.deployment.config.containerImage);
  assert.equal(compose.services.dsh.environment.DSH_BIND_HOST, '127.0.0.1');
});
