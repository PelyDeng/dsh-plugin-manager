import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { release, validateBase } from '../../../deploy/scripts/build.mjs';

const hostCommit = 'a'.repeat(40), revision = 'b'.repeat(40);
const base = `registry.test/dsh@sha256:${'1'.repeat(64)}`;
const target = `registry.test/dsh@sha256:${'2'.repeat(64)}`;
const info = { Os: 'linux', Config: { Labels: { 'org.opencontainers.image.revision': hostCommit } }, RepoDigests: [target] };

function fixture(t, fail) {
  const root = mkdtempSync(resolve(tmpdir(), 'source-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { path = resolve(root, path); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const artifacts = resolve(root, '.local/artifacts');
  const config = resolve(root, '.local/deployment.json');
  put('package.json', { packageManager: 'pnpm@11.19.0' });
  put('packages/plugin-manager/package.json', { version: '0.2.1' });
  put('integrations/docker/manager-update.Dockerfile', 'FROM test');
  put('.local/deployment.json', { containerImage: base, manifest: '.local/artifacts/old/manifest.json', plugins: ['example'], publicOrigin: 'https://example.test', composeProject: 'site' });
  put('.local/artifacts/old/example.tgz', 'old archive');
  put('.local/artifacts/old/manifest.json', { plugins: [{ archive: 'example.tgz', sha256: createHash('sha256').update('old archive').digest('hex') }] });
  put('.local/artifacts/active-compose.json', { project: 'site', path: resolve(artifacts, 'previous.json') });
  put('.local/artifacts/previous.json', { services: { dsh: { image: base, volumes: [{ type: 'bind', source: '/srv/example-data', target: '/data' }] } } });
  const original = readFileSync(config, 'utf8'), calls = [];
  const execute = (bin, args) => {
    calls.push([bin, ...args]);
    if (fail?.(bin, args)) throw new Error('simulated failure');
    if (bin === 'git') return args[0] === 'status' ? '' : args[0] === 'ls-tree' ? `160000 commit ${hostCommit}\tdeepseek-harness` : revision;
    if (bin === 'pnpm' && args[0] === '--version') return '11.19.0';
    if (bin === 'pnpm' && args.includes('pack')) put(args.at(-1), 'archive');
    if (bin === process.execPath && args[0] === 'scripts/package-plugins.mjs') put(resolve(args.at(-1), 'manifest.json'), { plugins: [{ id: 'example', version: '0.2.1' }] });
    if (bin === process.execPath && args[1] === 'paths') return JSON.stringify({ artifacts });
    if (bin === 'docker' && args[0] === 'image') return JSON.stringify([info]);
    if (bin === 'docker' && args[0] === 'run') return '0.2.1';
    if (bin === 'tar') put(args[1], 'backup');
    return '';
  };
  const result = () => JSON.parse(readFileSync(resolve(artifacts, readdirSync(artifacts).find(name => name.startsWith('source-release-')), 'result.json'), 'utf8'));
  return { root, config, original, calls, execute, result };
}

test('source release builds all site plugins before stopping and keeps site settings', t => {
  const f = fixture(t);
  assert.equal(release({ root: f.root }, f.execute).status, 'ready');
  const stop = f.calls.findIndex(call => call.includes('stop'));
  const pack = f.calls.findIndex(call => call.includes('scripts/package-plugins.mjs'));
  const push = f.calls.findIndex(call => call[0] === 'docker' && call[1] === 'push');
  const backup = f.calls.findIndex(call => call[0] === 'tar');
  const apply = f.calls.findIndex(call => call.includes('apply-compose'));
  assert.ok(pack < push && push < stop && stop < backup && backup < apply);
  const updated = JSON.parse(readFileSync(f.config));
  assert.equal(updated.publicOrigin, 'https://example.test');
  assert.equal(updated.containerImage, target);
  assert.deepEqual(updated.plugins, ['example']);
  assert.equal(readFileSync(resolve(f.root, updated.manifest, '../example.tgz'), 'utf8'), 'old archive');
  assert.equal(f.result().revision, revision);
});

test('build failure leaves the service and site configuration unchanged', t => {
  const f = fixture(t, (bin, args) => bin === 'pnpm' && args.includes('check'));
  assert.throws(() => release({ root: f.root }, f.execute), /simulated failure/);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('backup failure restarts the unchanged old service before any installation', t => {
  const f = fixture(t, bin => bin === 'tar');
  assert.throws(() => release({ root: f.root }, f.execute), /simulated failure/);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.equal(f.calls.some(call => call.includes('apply-compose')), false);
  assert.ok(f.calls.at(-1).includes('up'));
});

test('deployment failure retains recovery evidence and does not blindly restore old data', t => {
  const f = fixture(t, (bin, args) => bin === process.execPath && args.includes('apply-compose'));
  assert.throws(() => release({ root: f.root }, f.execute), /simulated failure/);
  assert.equal(f.result().status, 'deployment-failed');
  assert.equal(f.calls.some(call => call[0] === 'docker' && call.includes('up')), false);
  assert.equal(JSON.parse(readFileSync(f.config)).containerImage, target);
});

test('a different host pin or mutable base is rejected', () => {
  assert.throws(() => validateBase(base, info, 'c'.repeat(40)), /gitlink/);
  assert.throws(() => validateBase('registry.test/dsh:latest', info, hostCommit), /immutable/);
});

test('a tampered previous archive fails before stopping the service', t => {
  const f = fixture(t);
  writeFileSync(resolve(f.root, '.local/artifacts/old/example.tgz'), 'changed');
  assert.throws(() => release({ root: f.root }, f.execute), /Previous archive content/);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});
