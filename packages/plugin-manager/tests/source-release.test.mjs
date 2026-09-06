import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { release, validateBase } from '../../../deploy/scripts/build.mjs';
import { loadSite } from '../../../deploy/scripts/site.mjs';

const hostCommit = 'a'.repeat(40), revision = 'b'.repeat(40);
const base = `registry.test/dsh@sha256:${'1'.repeat(64)}`, target = `registry.test/dsh@sha256:${'2'.repeat(64)}`;
const baseId = `sha256:${'3'.repeat(64)}`, builtId = `sha256:${'4'.repeat(64)}`;
const info = { Id: baseId, Os: 'linux', Config: { Labels: { 'org.opencontainers.image.revision': hostCommit } } };
const digest = value => createHash('sha256').update(value).digest('hex');
const defaults = JSON.parse(readFileSync(new URL('../../../deploy/config/site.defaults.json', import.meta.url)));

function fixture(t, { fresh = false, fail } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'source-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { path = resolve(root, path); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const artifacts = resolve(root, '.local/artifacts');
  const config = resolve(root, '.local/deployment.json');
  put('deploy/config/site.defaults.json', defaults);
  put('package.json', { packageManager: 'pnpm@11.19.0' });
  put('packages/plugin-manager/package.json', { version: '0.2.3' });
  put('integrations/docker/manager-update.Dockerfile', 'FROM test');
  put('deepseek-harness/.git', 'fixture git worktree');
  if (!fresh) {
    put('.local/deployment.json', { containerImage: base, manifest: '.local/artifacts/old/manifest.json', plugins: ['example'], publicOrigin: 'https://example.test', composeProject: 'site' });
    put('.local/artifacts/old/example.tgz', 'old archive');
    put('.local/artifacts/old/manifest.json', { plugins: [{ archive: 'example.tgz', sha256: digest('old archive') }] });
    put('.local/artifacts/active-compose.json', { project: 'site', path: resolve(artifacts, 'previous.json') });
    put('.local/artifacts/previous.json', { services: { dsh: { image: base, environment: { DSH_PORT: '7902' }, volumes: [{ type: 'bind', source: '/srv/example-data', target: '/data' }] } } });
  }
  const original = existsSync(config) ? readFileSync(config, 'utf8') : null, calls = [];
  const images = new Map([[base, info], [baseId, info]]);
  const builtInfo = { ...info, Id: builtId, RepoDigests: [target] };
  const execute = (bin, args) => {
    calls.push([bin, ...args]);
    if (fail?.(bin, args)) throw new Error('simulated failure');
    if (bin === 'git') return args[0] === '-C' ? args[2] === 'rev-parse' ? hostCommit : '' : args[0] === 'ls-tree' ? `160000 commit ${hostCommit}\tdeepseek-harness` : args[0] === 'rev-parse' ? revision : '';
    if (bin === 'pnpm' && args[0] === '--version') return '11.19.0';
    if (bin === 'pnpm' && args.includes('pack')) put(args.at(-1), 'archive');
    if (bin === process.execPath && args[0] === 'scripts/package-plugins.mjs') {
      const archive = `example-${digest('new archive')}.tgz`;
      put(resolve(args.at(-1), archive), 'new archive');
      put(resolve(args.at(-1), 'manifest.json'), { plugins: [{ id: 'example', version: '0.2.1', archive, sha256: digest('new archive') }] });
    }
    if (bin === process.execPath && args[1] === 'apply-compose') {
      const candidate = JSON.parse(readFileSync(args[args.indexOf('--config') + 1]));
      put('.local/artifacts/new-compose.json', { services: { dsh: { image: candidate.containerImage, environment: { DSH_PORT: String(candidate.port) }, volumes: [{ type: 'bind', source: '/srv/example-data', target: '/data' }] } } });
      put('.local/artifacts/active-compose.json', { project: candidate.composeProject, path: resolve(artifacts, 'new-compose.json') });
    }
    if (bin === 'docker' && args[0] === 'tag') images.set(args[2], images.get(args[1]) ?? builtInfo);
    if (bin === 'docker' && args[0] === 'image') return JSON.stringify([images.get(args[2]) ?? builtInfo]);
    if (bin === 'docker' && args[0] === 'run') return '0.2.3';
    if (bin === 'tar' && args[0] === '-czf') put(args[1], 'backup');
    return '';
  };
  const buildHost = () => { calls.push(['build-host']); return { imageId: builtId, resultFile: resolve(artifacts, 'host-image.json') }; };
  const result = () => { const pointer = JSON.parse(readFileSync(resolve(root, '.local/source-release.json'))); return JSON.parse(readFileSync(resolve(pointer.operation, 'result.json'))); };
  return { root, config, original, calls, execute, buildHost, result, put };
}

test('a complete source checkout initializes defaults without fetching official source or using previous artifacts', t => {
  const f = fixture(t, { fresh: true });
  assert.equal(release({ root: f.root }, f.execute, f.buildHost).status, 'ready');
  assert.ok(f.calls.some(call => call[0] === 'build-host'));
  assert.equal(f.calls.some(call => call[0] === 'git' && call.some(value => ['submodule', 'clone', 'fetch', 'pull'].includes(value))), false);
  assert.equal(f.calls.some(call => call.includes('push') || call.includes('stop') || call.includes('-czf')), false);
  assert.equal(JSON.parse(readFileSync(f.config)).containerImage, builtId);
  const site = JSON.parse(readFileSync(resolve(f.root, '.local/site.json')));
  assert.deepEqual(site.plugins, ['auth', 'example']);
  assert.equal('containerImage' in site, false);
});

test('missing source fails without downloading, while a different supplied commit is accepted', t => {
  const f = fixture(t, { fresh: true });
  rmSync(resolve(f.root, 'deepseek-harness/.git'));
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /checkout is incomplete/);
  f.put('deepseek-harness/.git', 'fixture git worktree');
  const wrongPin = (bin, args, options) => bin === 'git' && args[0] === '-C' && args[2] === 'rev-parse' ? 'c'.repeat(40) : f.execute(bin, args, options);
  assert.equal(release({ root: f.root }, wrongPin, f.buildHost).status, 'ready');
  assert.equal(f.calls.some(call => call.includes('submodule') || call.includes('stop')), false);
});

test('missing pnpm is prepared locally at the pinned version without changing the caller PATH', t => {
  let unavailable = true;
  const f = fixture(t, { fresh: true, fail: (bin, args) => {
    if (unavailable && bin === 'pnpm' && args[0] === '--version') { unavailable = false; return true; }
    return false;
  } });
  const originalPath = process.env.PATH;
  release({ root: f.root }, f.execute, f.buildHost);
  assert.ok(f.calls.some(call => call[0] === 'npm' && call.includes(resolve(f.root, '.local/tooling/pnpm')) && call.includes('pnpm@11.19.0')));
  assert.equal(process.env.PATH, originalPath);
});

test('legacy update preserves site values, copies old references and backs up before applying', t => {
  const f = fixture(t);
  assert.equal(release({ root: f.root }, f.execute, f.buildHost).status, 'ready');
  const stop = f.calls.findIndex(call => call.includes('stop'));
  const push = f.calls.findIndex(call => call[0] === 'docker' && call[1] === 'push');
  const backup = f.calls.findIndex(call => call.includes('-czf'));
  const apply = f.calls.findIndex(call => call.includes('apply-compose'));
  assert.ok(push < stop && stop < backup && backup < apply);
  const updated = JSON.parse(readFileSync(f.config));
  assert.equal(updated.publicOrigin, 'https://example.test');
  assert.equal(updated.containerImage, target);
  assert.equal(readFileSync(resolve(f.root, updated.manifest, '../example.tgz'), 'utf8'), 'old archive');
});

test('repeated execution keeps the site file and uses the established deployment', t => {
  const f = fixture(t, { fresh: true });
  release({ root: f.root }, f.execute, f.buildHost);
  const site = readFileSync(resolve(f.root, '.local/site.json'), 'utf8');
  release({ root: f.root }, f.execute, f.buildHost);
  assert.equal(f.calls.filter(call => call[0] === 'build-host').length, 1);
  assert.equal(readFileSync(resolve(f.root, '.local/site.json'), 'utf8'), site);
  assert.ok(f.result().backupComplete);
});

test('a partial site override uses the same effective paths on repeated deployments', t => {
  const f = fixture(t, { fresh: true });
  f.put('.local/site.json', { dataRoot: '.local/data/custom' });
  release({ root: f.root }, f.execute, f.buildHost);
  release({ root: f.root }, f.execute, f.buildHost);
  assert.equal(f.result().status, 'ready');
  assert.equal(JSON.parse(readFileSync(f.config)).home, defaults.home);
  assert.ok(f.calls.filter(call => call.includes('apply-compose')).every(call => call.includes('--rebuild')));
});

test('changing the established data location is rejected before stopping the service', t => {
  const f = fixture(t, { fresh: true });
  release({ root: f.root }, f.execute, f.buildHost);
  f.put('.local/site.json', { ...defaults, home: '.local/data/another-home' });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /explicit migration/);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('build failure leaves service and deployment inputs unchanged', t => {
  const f = fixture(t, { fail: (bin, args) => bin === 'pnpm' && args.includes('check') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('backup failure restarts the unchanged old service', t => {
  const f = fixture(t, { fail: (bin, args) => bin === 'tar' && args[0] === '-czf' });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.equal(f.calls.some(call => call.includes('apply-compose')), false);
  assert.ok(f.calls.at(-1).includes('up'));
});

test('failed first startup resumes the original artifacts without rebuilding or deleting data', t => {
  let failApply = true;
  const f = fixture(t, { fresh: true, fail: (bin, args) => failApply && args.includes('apply-compose') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  const operation = f.result().operation;
  f.put('.local/data/dsh-home/user-data', 'keep me');
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /--resume/);
  failApply = false;
  release({ root: f.root, resume: true }, f.execute, f.buildHost);
  assert.equal(f.result().operation, operation);
  assert.equal(f.calls.filter(call => call[0] === 'build-host').length, 1);
  assert.ok(f.calls.at(-1).includes('--resume'));
  assert.equal(readFileSync(resolve(f.root, '.local/data/dsh-home/user-data'), 'utf8'), 'keep me');
});

test('existing data or a missing explicit site file cannot be treated as a blank installation', t => {
  const f = fixture(t, { fresh: true }); f.put('.local/data/dsh-home/user-data', 'keep me');
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /Existing data/);
  assert.throws(() => loadSite(f.root, '.local/typo.json'), /does not exist/);
  assert.equal(f.calls.some(call => call.includes('install')), false);
});

test('tampered previous archives are rejected before stopping', t => {
  const f = fixture(t); f.put('.local/artifacts/old/example.tgz', 'changed');
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /Previous archive content/);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('immutable supplied images are accepted without a predetermined host version', () => {
  assert.equal(validateBase(base, { ...info, Config: {} }), baseId);
  assert.throws(() => validateBase('registry.test/dsh:latest', info), /immutable/);
});
