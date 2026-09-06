/** Host preparation uses immutable inputs and never publishes without explicit selection. */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildHostImage, isMissingImage, loadImageConfig, recipeHash, repositoryDigest } from '../../../integrations/docker/host-image.mjs';
import { migrateConfig } from '../../../integrations/docker/migrate-config.mjs';
import { tarCommand } from '../src/deployment.mjs';

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'dsh host image ')); directories.push(root);
  mkdirSync(resolve(root, 'deploy'));
  for (const path of ['integrations/docker', 'packages/plugin-kit', 'packages/plugin-manager']) {
    mkdirSync(resolve(root, path), { recursive: true }); writeFileSync(resolve(root, path, 'input.txt'), 'fixture\n');
  }
  writeFileSync(resolve(root, 'integrations/docker/toolchain.Dockerfile'), 'FROM fixture\n');
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.19.0' }));
  writeFileSync(resolve(root, 'pnpm-lock.yaml'), 'fixture lock');
  writeFileSync(resolve(root, 'pnpm-workspace.yaml'), 'packages: []');
  return root;
}
function config(root, extra = '') {
  const path = resolve(root, 'image.conf');
  writeFileSync(path, `HARBOR_ENABLED=true\nREGISTRY_HOST=harbor.example\nBASE_PROJECT=library\nAPP_PROJECT=dsh\n${extra}`, { mode: 0o600 });
  return path;
}
const digest = character => `sha256:${character.repeat(64)}`;

function engine(root, { pullError = '', pushError = false, wrongLabel = false } = {}) {
  const calls = [];
  const images = new Map();
  let runtimeLabels;
  const source = { path: root, commit: 'a'.repeat(40), repositoryCommit: 'b'.repeat(40), version: '0.1.2-alpha.5', packageManager: 'pnpm@11.7.0' };
  const info = image => {
    if (images.has(image)) return images.get(image);
    const kind = image.includes('toolchain') ? 'toolchain' : image.includes('dsh-base') || image.startsWith('docker.io/library/node:') ? 'base' : 'runtime';
    const repository = image.split('@')[0].replace(/:[^/:]+$/u, '');
    if (kind === 'runtime' && !runtimeLabels) {
      const saved = readdirSync(resolve(root, '.local/artifacts')).map(id => JSON.parse(readFileSync(resolve(root, '.local/artifacts', id, 'host-image.json')))).find(value => value.image === image);
      runtimeLabels = { 'org.opencontainers.image.revision': source.commit, 'org.opencontainers.image.version': source.version, 'com.deepseek-plugin.dsh.runtime-recipe': saved.recipe };
    }
    const item = { Id: digest(kind === 'base' ? '1' : kind === 'toolchain' ? '2' : '3'), Os: 'linux', Architecture: 'amd64', RepoDigests: [`${repository}@${digest('4')}`], Config: { Labels: kind === 'runtime' ? runtimeLabels : {} } };
    images.set(image, item); images.set(item.Id, item); return item;
  };
  const execute = (bin, args, options) => {
    calls.push({ bin, args, input: options?.input });
    if (bin === 'git') return { status: 0, stdout: '' };
    if (bin === tarCommand) {
      const destination = args[args.indexOf('-C') + 1];
      if (destination.endsWith('harness-source')) writeFileSync(resolve(destination, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.7.0' }));
      else {
        for (const path of ['integrations/docker', 'packages/plugin-kit', 'packages/plugin-manager']) cpSync(resolve(root, path), resolve(destination, path), { recursive: true });
        for (const file of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml']) cpSync(resolve(root, file), resolve(destination, file));
      }
      return { status: 0, stdout: '' };
    }
    assert.equal(bin, 'docker');
    args = args.slice(2);
    if (args[0] === 'pull') {
      if (pullError && args.at(-1).startsWith('harbor.example/')) return { status: 1, stderr: pullError };
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'build') {
      const values = Object.fromEntries(args.flatMap((arg, index) => arg === '--build-arg' ? [args[index + 1].split(/=(.*)/su).slice(0, 2)] : []));
      if (values.DSH_COMMIT_SHA) runtimeLabels = { 'org.opencontainers.image.revision': wrongLabel ? 'wrong' : source.commit, 'org.opencontainers.image.version': source.version, 'com.deepseek-plugin.dsh.runtime-recipe': values.DSH_RECIPE_HASH };
      return { status: 0, stdout: '' };
    }
    if (args[0] === 'image') return { status: 0, stdout: JSON.stringify([info(args.at(-1))]) };
    if (args[0] === 'run') return { status: 0, stdout: source.version };
    if (args[0] === 'tag') { images.set(args[2], { ...info(args[1]), RepoDigests: [`${args[2].replace(/:[^/:]+$/u, '')}@${digest('4')}`] }); return { status: 0, stdout: '' }; }
    if (args[0] === 'push') return { status: pushError ? 1 : 0, stderr: pushError ? 'push failed' : '' };
    if (args[0] === 'login') return { status: 0, stdout: '' };
    assert.fail(`Unexpected docker command: ${args[0]}`);
  };
  return { calls, execute, inspectSource: () => source, images };
}

test('default configuration does not read a legacy credential file; literal values never execute', () => {
  const root = fixture();
  writeFileSync(resolve(root, 'deploy/registry.conf'), 'this must not be read');
  assert.equal(loadImageConfig(root).HARBOR_ENABLED, 'false');
  assert.equal(loadImageConfig(root).IMAGE_NAME, 'dsh-host');
  const path = config(root, 'REGISTRY_USERNAME=test\nREGISTRY_PASSWORD=$(touch stolen)\n');
  assert.equal(loadImageConfig(root, path).REGISTRY_PASSWORD, '$(touch stolen)');
  writeFileSync(path, 'DSH_PORT=7902\n');
  assert.throws(() => loadImageConfig(root, path), /Unknown.*line 1/u);
  writeFileSync(path, 'IMAGE_NAME=other/image:tag\n');
  assert.throws(() => loadImageConfig(root, path), /IMAGE_NAME/u);
});

test('only explicit absence permits fallback, including mixed error responses', () => {
  for (const value of ['manifest unknown', 'name unknown', 'manifest for x not found', 'unknown: artifact project/image:tag not found']) assert.equal(isMissingImage(value), true);
  for (const value of ['unauthorized', 'manifest unknown: unauthorized', 'x509: certificate error', 'no matching manifest for linux/amd64', '503 Service Unavailable', 'credential helper not found', 'host not found']) assert.equal(isMissingImage(value), false);
});

test('recipe changes with manager content and platform but not business plugin content or line endings', () => {
  const root = fixture(); const first = recipeHash(root, { platform: 'linux/amd64' });
  mkdirSync(resolve(root, 'plugins/example'), { recursive: true }); writeFileSync(resolve(root, 'plugins/example/package.json'), '{}');
  assert.equal(recipeHash(root, { platform: 'linux/amd64' }), first);
  writeFileSync(resolve(root, 'packages/plugin-manager/input.txt'), 'fixture\r\n'); assert.equal(recipeHash(root, { platform: 'linux/amd64' }), first);
  assert.notEqual(recipeHash(root, { platform: 'linux/arm64' }), first);
  writeFileSync(resolve(root, 'packages/plugin-manager/input.txt'), 'changed\n'); assert.notEqual(recipeHash(root, { platform: 'linux/amd64' }), first);
});

test('digest selection ignores unrelated registry digests and normalizes Docker Hub names', () => {
  assert.equal(repositoryDigest('docker.io/library/node:24', { RepoDigests: [`other.example/node@${digest('1')}`, `node@${digest('2')}`] }), `node@${digest('2')}`);
  assert.throws(() => repositoryDigest('harbor.example/dsh/image:x', { RepoDigests: [`other.example/dsh/image@${digest('1')}`] }), /matching/u);
});

test('ordinary host preparation builds without registry config, login, or push', () => {
  const root = fixture(); const mock = engine(root);
  const result = buildHostImage({ root, workingTree: true, operationId: 'local' }, mock);
  assert.equal(result.status, 'built'); assert.equal(result.published, false);
  assert.equal(result.image, `dsh-local/dsh-host:0.1.2-alpha.5-${'a'.repeat(40)}-${result.recipe.slice(0, 20)}`);
  assert.equal(mock.calls.filter(call => call.bin === 'docker' && call.args[2] === 'build').length, 2);
  assert.ok(!mock.calls.some(call => call.args.includes('login') || call.args.includes('push')));
  assert.ok(!mock.calls.some(call => call.args.some(arg => arg.includes('harbor.example'))));
  assert.equal(JSON.parse(readFileSync(result.resultFile)).imageId, digest('3'));
  assert.throws(() => buildHostImage({ root, workingTree: true, publish: true }, mock), /requires an explicitly enabled/u);
  assert.throws(() => buildHostImage({ root, workingTree: true, artifacts: '..hidden' }, mock), /must stay under/u);
});

test('registry authentication failure stops before upstream or build, with a retained failed operation', () => {
  const root = fixture(); const mock = engine(root, { pullError: 'unauthorized: manifest unknown' });
  assert.throws(() => buildHostImage({ root, config: config(root), workingTree: true, operationId: 'auth-failure' }, mock), /fallback is prohibited/u);
  assert.equal(mock.calls.filter(call => call.bin === 'docker' && call.args[2] === 'pull').length, 1);
  assert.ok(!mock.calls.some(call => call.args.includes('build') || call.args.includes('push')));
  assert.equal(JSON.parse(readFileSync(resolve(root, '.local/artifacts/auth-failure/host-image.json'))).status, 'failed');
});

test('explicit cache miss may build but does not upload without --publish; invalid labels fail', () => {
  const root = fixture(); const mock = engine(root, { pullError: 'manifest unknown' });
  const result = buildHostImage({ root, config: config(root), workingTree: true }, mock);
  assert.equal(result.status, 'built'); assert.ok(!mock.calls.some(call => call.args.includes('push')));
  assert.throws(() => buildHostImage({ root, workingTree: true }, engine(root, { wrongLabel: true })), /label does not match/u);
});

test('anonymous cache hits do not build, login, publish, or pull upstream', () => {
  const root = fixture(); const mock = engine(root);
  const result = buildHostImage({ root, config: config(root, 'ALLOW_UPSTREAM=false\nIMAGE_NAME=shared-agents\n'), workingTree: true }, mock);
  assert.equal(result.status, 'built');
  assert.equal(result.image, `harbor.example/dsh/shared-agents:0.1.2-alpha.5-${'a'.repeat(40)}-${result.recipe.slice(0, 20)}`);
  assert.ok(!mock.calls.some(call => call.args.includes('build') || call.args.includes('push') || call.args.includes('login')));
  assert.ok(mock.calls.filter(call => call.args.includes('pull')).every(call => call.args.at(-1).startsWith('harbor.example/')));
});

test('publish failure retains immutable images and resume only publishes, with credentials on stdin', () => {
  const root = fixture(); const path = config(root, 'REGISTRY_USERNAME=writer\nREGISTRY_PASSWORD=fixture-secret\n');
  const mock = engine(root, { pullError: 'manifest unknown', pushError: true });
  assert.throws(() => buildHostImage({ root, config: path, publish: true, operationId: 'publishing' }, mock), /push failed/u);
  const resultFile = resolve(root, '.local/artifacts/publishing/host-image.json');
  assert.equal(JSON.parse(readFileSync(resultFile)).status, 'publish-failed');
  assert.ok(!readFileSync(resultFile, 'utf8').includes('fixture-secret'));
  assert.equal(mock.calls.find(call => call.args.includes('login')).input, 'fixture-secret');
  assert.ok(!mock.calls.some(call => call.args.includes('fixture-secret')));
  const resumed = engine(root); for (const [key, value] of mock.images) resumed.images.set(key, value);
  const result = buildHostImage({ root, config: path, publish: true, resume: resultFile }, resumed);
  assert.equal(result.status, 'published'); assert.ok(!resumed.calls.some(call => ['git', tarCommand].includes(call.bin) || call.args.includes('build')));
  assert.equal(resumed.calls.filter(call => call.args.includes('push')).length, 3);
  config(root, 'REGISTRY_USERNAME=writer\nREGISTRY_PASSWORD=fixture-secret\nIMAGE_NAME=other-agents\n');
  const changed = engine(root);
  assert.throws(() => buildHostImage({ root, config: path, publish: true, resume: resultFile }, changed), /destination or platform changed/u);
  assert.ok(!changed.calls.some(call => call.args.includes('push')));
});

test('explicit legacy migration retains sources and separates runtime fields without printing credentials', () => {
  const root = fixture();
  const source = resolve(root, 'deploy/registry.conf');
  writeFileSync(source, 'REGISTRY_HOST=harbor.example\nIMAGE_NAME=legacy-agents\nREGISTRY_USERNAME=writer\nREGISTRY_PASSWORD="pass with spaces"\nDSH_PORT=7902\n');
  const result = migrateConfig(root);
  assert.equal(result.retained, 1); assert.ok(existsSync(source));
  assert.deepEqual(result.ignoredFields, ['DSH_PORT']);
  const migrated = loadImageConfig(root, result.destination);
  assert.equal(migrated.HARBOR_ENABLED, 'true'); assert.equal(migrated.REGISTRY_PASSWORD, 'pass with spaces');
  assert.equal(migrated.IMAGE_NAME, 'legacy-agents');
  assert.ok(!JSON.stringify(result).includes('pass with spaces'));
  assert.equal(migrateConfig(root).migrated, false);
  writeFileSync(source, 'REGISTRY_HOST=changed.example\n');
  assert.throws(() => migrateConfig(root), /conflicts/u); assert.ok(existsSync(source));
});
