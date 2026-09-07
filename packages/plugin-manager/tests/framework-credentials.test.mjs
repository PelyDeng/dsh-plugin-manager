import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDeployment, runtimeEnvironment } from '../src/config.mjs';
import { prepareFrameworkCredentials, frameworkCredentialEnvironment } from '../src/framework-credentials.mjs';
import { renderCompose } from '../src/compose.mjs';
import { PENDING } from '../src/state.mjs';

function fixture(t, text = 'DEEPSEEK_API_KEY=sk-private-sentinel\nREGISTRY_PASSWORD=registry-private-sentinel\n') {
  const root = mkdtempSync(join(tmpdir(), 'dsh credentials 中文 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'env.conf');
  writeFileSync(config, text, { mode: 0o600 });
  return { root, config, deployment: resolveDeployment({ root, config }, {}) };
}

test('model secrets are projected without leaking into deployment objects or Compose environment', t => {
  const { root, deployment } = fixture(t);
  const release = { schemaVersion: 1, plugins: [], path: join(root, 'release/manifest.json') };
  const rendered = renderCompose(deployment, release, join(root, 'compose'));
  const encoded = JSON.stringify(deployment) + readFileSync(rendered.path, 'utf8') + readFileSync(rendered.configPath, 'utf8');
  assert.ok(!encoded.includes('private-sentinel'));
  const compose = JSON.parse(readFileSync(rendered.path));
  const mount = compose.services.dsh.volumes.find(value => value.target === '/run/dsh-framework-credentials.json');
  assert.equal(mount.read_only, true);
  assert.deepEqual(frameworkCredentialEnvironment(deployment), { DEEPSEEK_API_KEY: 'sk-private-sentinel' });
  assert.ok(!readFileSync(mount.source, 'utf8').includes('registry-private-sentinel'));
  assert.equal(runtimeEnvironment(deployment, []).configurations.$framework.sha256, deployment.config.frameworkCredentials.sha256);
});

test('empty file credentials add no override and do not erase inherited environment values', t => {
  const { deployment } = fixture(t, 'DEEPSEEK_API_KEY=\nZHIPU_API_KEY=\n');
  prepareFrameworkCredentials(deployment);
  const inherited = { DEEPSEEK_API_KEY: 'sk-existing-environment' };
  assert.deepEqual({ ...inherited, ...frameworkCredentialEnvironment(deployment) }, inherited);
  assert.equal(deployment.config.frameworkCredentials, undefined);
});

test('source changes and projection tampering reject instead of silently regenerating credentials', t => {
  const { config, deployment } = fixture(t);
  prepareFrameworkCredentials(deployment);
  writeFileSync(deployment.config.frameworkCredentials.file, '{}\n');
  assert.throws(() => prepareFrameworkCredentials(deployment), /摘要不符/);
  writeFileSync(config, 'DEEPSEEK_API_KEY=sk-changed\n');
  assert.throws(() => prepareFrameworkCredentials(deployment), /读取后发生变化/);
});

test('resume binds the original projection and rejects changed keys or missing original bytes', t => {
  const { root, config, deployment } = fixture(t);
  prepareFrameworkCredentials(deployment);
  const original = deployment.config.frameworkCredentials;
  mkdirSync(deployment.profileRoot, { recursive: true });
  writeFileSync(join(deployment.profileRoot, PENDING), JSON.stringify({ desired: { configurations: { $framework: original } } }));
  writeFileSync(config, 'DEEPSEEK_API_KEY=sk-other\n');
  assert.throws(() => prepareFrameworkCredentials(resolveDeployment({ root, config, resume: true }, {})), /恢复需要原框架/);
  writeFileSync(config, 'DEEPSEEK_API_KEY=sk-private-sentinel\n');
  const resumed = resolveDeployment({ root, config, resume: true }, {});
  prepareFrameworkCredentials(resumed);
  assert.deepEqual(resumed.config.frameworkCredentials, original);
  rmSync(original.file);
  assert.throws(() => prepareFrameworkCredentials(resumed), /ENOENT/);
  assert.equal(existsSync(original.file), false);
});

test('POSIX public-readable private input is rejected', { skip: process.platform === 'win32' }, t => {
  const { root, config } = fixture(t);
  chmodSync(config, 0o644);
  assert.throws(() => resolveDeployment({ root, config }, {}), /0600/);
});

test('Compose resume maps the container pending reference to the existing host projection only', t => {
  const { root, config, deployment } = fixture(t);
  const release = { schemaVersion: 1, plugins: [], path: join(root, 'release/manifest.json') };
  const rendered = renderCompose(deployment, release, join(root, 'compose'));
  const original = JSON.parse(readFileSync(rendered.configPath)).frameworkCredentials;
  const hostFile = deployment.config.frameworkCredentials.file;
  mkdirSync(deployment.profileRoot, { recursive: true });
  writeFileSync(join(deployment.profileRoot, PENDING), JSON.stringify({ desired: { configurations: { $framework: original } } }));
  const resumed = resolveDeployment({ root, config, resume: true }, {});
  const recovered = renderCompose(resumed, release, join(root, 'recovered'));
  assert.deepEqual(JSON.parse(readFileSync(recovered.configPath)).frameworkCredentials, original);
  assert.equal(resumed.config.frameworkCredentials.file, hostFile);
  rmSync(hostFile);
  assert.throws(() => renderCompose(resumed, release, join(root, 'missing')), /ENOENT/);
  assert.equal(existsSync(hostFile), false);
});
