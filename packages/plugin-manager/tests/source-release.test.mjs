import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { release, validateBase } from '../../../deploy/scripts/build.mjs';
import { loadSite } from '../../../deploy/scripts/site.mjs';
import { renderFrameworkConfig } from '../src/framework-config.mjs';

const hostCommit = 'a'.repeat(40), revision = 'b'.repeat(40);
const base = `registry.test/dsh@sha256:${'1'.repeat(64)}`, target = `registry.test/dsh@sha256:${'2'.repeat(64)}`;
const baseId = `sha256:${'3'.repeat(64)}`, builtId = `sha256:${'4'.repeat(64)}`;
const info = { Id: baseId, Os: 'linux', Config: { Labels: { 'org.opencontainers.image.revision': hostCommit } } };
const digest = value => createHash('sha256').update(value).digest('hex');
const defaults = JSON.parse(readFileSync(new URL('../../../deploy/config/site.defaults.json', import.meta.url)));

function fixture(t, { fresh = false, fail } = {}) {
  // Windows runners can expose TEMP through an 8.3 alias; production paths are canonical.
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'source-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { path = resolve(root, path); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); };
  const artifacts = resolve(root, '.local/artifacts');
  const config = resolve(root, '.local/deployment.json');
  const runtimeData = resolve(root, 'runtime-data');
  put('runtime-data/marker.txt', 'retained runtime');
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
    put('.local/artifacts/previous.json', { services: { dsh: { image: base, environment: { DSH_PORT: '7902', DSH_HOME: '/data/dsh-home', DSH_PROFILE: 'web' }, volumes: [{ type: 'bind', source: runtimeData, target: '/data' }] } } });
  }
  const original = existsSync(config) ? readFileSync(config, 'utf8') : null, calls = [];
  const images = new Map([[base, info], [baseId, info]]);
  const builtInfo = { ...info, Id: builtId, RepoDigests: [target] };
  const execute = (bin, args) => {
    calls.push([bin, ...args]);
    if (fail?.(bin, args)) throw new Error('simulated failure');
    if (bin === 'docker' && args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
    if (bin === 'docker' && args[0] === '--host') {
      if (args[2] === 'info') return JSON.stringify({ OSType: 'linux', ID: 'fixture-engine', Architecture: 'x86_64', OperatingSystem: process.platform === 'linux' ? 'Linux' : 'Docker Desktop' });
      return 'Docker Compose fixture';
    }
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
      put('.local/artifacts/new-compose.json', { services: { dsh: { image: candidate.containerImage, environment: { DSH_PORT: String(candidate.port), DSH_HOME: '/data/dsh-home', DSH_PROFILE: 'web' }, volumes: [{ type: 'bind', source: runtimeData, target: '/data' }] } } });
      put('.local/artifacts/active-compose.json', { project: candidate.composeProject, path: resolve(artifacts, 'new-compose.json') });
    }
    if (bin === 'docker' && args[0] === 'tag') images.set(args[2], images.get(args[1]) ?? builtInfo);
    if (bin === 'docker' && args[0] === 'compose' && args.includes('ps') && args.includes('-a')) return 'c'.repeat(64);
    if (bin === 'docker' && args[0] === 'inspect') {
      const active = JSON.parse(readFileSync(resolve(artifacts, 'active-compose.json')));
      const service = JSON.parse(readFileSync(active.path)).services.dsh;
      return JSON.stringify([{ Id: 'c'.repeat(64), State: { Running: false, Restarting: false }, Config: { Image: service.image, Labels: { 'com.docker.compose.service': 'dsh' }, Env: ['DSH_HOME=/data/dsh-home', 'DSH_PROFILE=web'] }, Mounts: [{ Type: 'bind', Source: runtimeData, Destination: '/data', RW: true }] }]);
    }
    if (bin === 'docker' && args[0] === 'image') return JSON.stringify([images.get(args[2]) ?? builtInfo]);
    if (bin === 'docker' && args.includes('--volumes-from')) return readFileSync(resolve(runtimeData, args.at(-1).slice('/data/'.length)), 'utf8');
    if (bin === 'docker' && args[0] === 'run') return '0.2.3';
    return '';
  };
  const buildHost = () => { calls.push(['build-host']); return { imageId: builtId, resultFile: resolve(artifacts, 'host-image.json') }; };
  const result = () => { const pointer = JSON.parse(readFileSync(resolve(root, '.local/source-release.json'))); return JSON.parse(readFileSync(resolve(pointer.operation, 'result.json'))); };
  return { root, config, original, calls, execute, buildHost, result, put };
}

test('a complete source checkout initializes defaults without fetching official source or using previous artifacts', t => {
  const f = fixture(t, { fresh: true });
  assert.equal(release({ root: f.root }, f.execute, f.buildHost).status, 'ready');
  for (const call of f.calls.filter(call => call[0] === 'pnpm' && call[1] === '--filter' && ['build', 'check', 'test'].includes(call[3]))) {
    const name = call[2].split('/').at(-1);
    const manifest = JSON.parse(readFileSync(new URL(`../../${name}/package.json`, import.meta.url)));
    assert.ok(manifest.scripts[call[3]], `${call[2]} does not declare ${call[3]}`);
  }
  assert.ok(f.calls.some(call => call[0] === 'build-host'));
  assert.equal(f.calls.some(call => call[0] === 'git' && call.some(value => ['submodule', 'clone', 'fetch', 'pull'].includes(value))), false);
  assert.equal(f.calls.some(call => call.includes('push') || call.includes('stop') || call.includes('-czf')), false);
  assert.equal(JSON.parse(readFileSync(f.config)).containerImage, builtId);
  const { site } = loadSite(f.root);
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

test('legacy update preserves data and site values and applies immediately after proving the stop', t => {
  const f = fixture(t);
  assert.equal(release({ root: f.root }, f.execute, f.buildHost).status, 'ready');
  const stop = f.calls.findIndex(call => call.includes('stop'));
  const push = f.calls.findIndex(call => call[0] === 'docker' && call[1] === 'push');
  const apply = f.calls.findIndex(call => call.includes('apply-compose'));
  const proof = f.calls.findIndex(call => call[0] === 'docker' && call[1] === 'inspect');
  assert.ok(push < stop && stop < proof && proof < apply);
  assert.equal(f.calls.some(call => call.includes('-czf') || call.includes('-tzf')), false);
  assert.equal(existsSync(resolve(f.result().operation, 'backup')), false);
  assert.equal(readFileSync(resolve(f.root, 'runtime-data/marker.txt'), 'utf8'), 'retained runtime');
  const updated = JSON.parse(readFileSync(f.config));
  assert.equal(updated.publicOrigin, 'https://example.test');
  assert.equal(updated.containerImage, target);
  assert.equal(readFileSync(resolve(f.root, updated.manifest, '../example.tgz'), 'utf8'), 'old archive');
});

test('repeated execution keeps the site file and uses the established deployment', t => {
  const f = fixture(t, { fresh: true });
  release({ root: f.root }, f.execute, f.buildHost);
  const site = readFileSync(resolve(f.root, '.local/env.conf'), 'utf8');
  release({ root: f.root }, f.execute, f.buildHost);
  assert.equal(f.calls.filter(call => call[0] === 'build-host').length, 1);
  assert.equal(readFileSync(resolve(f.root, '.local/env.conf'), 'utf8'), site);
  assert.equal(f.result().stopComplete, true);
});

test('a partial site override uses the same effective paths on repeated deployments', t => {
  const f = fixture(t, { fresh: true });
  f.put('.local/site.json', { dataRoot: '.local/data/custom' });
  release({ root: f.root }, f.execute, f.buildHost);
  release({ root: f.root }, f.execute, f.buildHost);
  assert.equal(f.result().status, 'ready');
  assert.equal(JSON.parse(readFileSync(f.config)).home, resolve(f.root, defaults.home));
  assert.ok(f.calls.filter(call => call.includes('apply-compose')).every(call => call.includes('--rebuild')));
});

test('changing the established data location is rejected before stopping the service', t => {
  const f = fixture(t, { fresh: true });
  release({ root: f.root }, f.execute, f.buildHost);
  f.put('.local/env.conf', renderFrameworkConfig({ config: { ...defaults, home: '.local/data/another-home' } }));
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /explicit migration/);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('build failure leaves service and deployment inputs unchanged', t => {
  const f = fixture(t, { fail: (bin, args) => bin === 'pnpm' && args.includes('build') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('generated Docker identity is not imported as a site preference', t => {
  const f = fixture(t);
  const previous = JSON.parse(readFileSync(f.config));
  f.put('.local/deployment.json', { ...previous, dockerRuntime: { endpoint: 'unix:///var/run/docker.sock', id: 'prior-engine' } });
  const loaded = loadSite(f.root);
  assert.equal(loaded.site.composeProject, previous.composeProject);
  assert.equal(Object.hasOwn(loaded.site, 'dockerRuntime'), false);
  assert.equal(JSON.parse(readFileSync(f.config)).dockerRuntime.id, 'prior-engine');
});

test('container access failure is detected before stopping the old service', t => {
  const f = fixture(t, { fail: (bin, args) => args.includes('check-compose') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
  assert.equal(f.calls.some(call => call.includes('apply-compose')), false);
});

test('first access preflight may create settings and fail without preventing resume', t => {
  let deny = true, f;
  f = fixture(t, { fresh: true, fail: (bin, args) => {
    if (deny && args.includes('check-compose')) {
      f.put('.local/data/dsh-home/plugins/example/plugin.json', { schemaVersion: 1, enabled: true });
      return true;
    }
    return false;
  } });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  assert.equal(f.result().status, 'deployment-failed');
  assert.equal(f.calls.some(call => call.includes('stop')), false);
  deny = false;
  const result = release({ root: f.root, resume: true }, f.execute, f.buildHost);
  assert.equal(result.status, 'ready');
  assert.equal(f.calls.filter(call => call[0] === 'build-host').length, 1);
  assert.equal(JSON.parse(readFileSync(resolve(f.root, '.local/data/dsh-home/plugins/example/plugin.json'))).enabled, true);
});

test('legacy unfinished releases use current preflight but keep their original install CLI', t => {
  let failApply = true;
  const f = fixture(t, { fresh: true, fail: (bin, args) => failApply && args.includes('apply-compose') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  const saved = f.result(); delete saved.runtime;
  f.put(resolve(saved.operation, 'result.json'), saved);
  failApply = false;
  const callsBefore = f.calls.length;
  release({ root: f.root, resume: true }, f.execute, f.buildHost);
  const calls = f.calls.slice(callsBefore);
  assert.equal(calls.find(call => call.includes('check-compose'))[1], resolve(f.root, 'deploy/scripts/deployment.mjs'));
  assert.equal(calls.find(call => call.includes('apply-compose'))[1], resolve(saved.operation, 'tooling/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs'));
});

test('resume refuses a different Docker engine without stopping or applying', t => {
  const f = fixture(t, { fresh: true, fail: (bin, args) => args.includes('apply-compose') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  const before = f.calls.length;
  const otherEngine = (bin, args, options) => bin === 'docker' && args.includes('info')
    ? JSON.stringify({ OSType: 'linux', ID: 'different-engine', Architecture: 'x86_64', OperatingSystem: 'Linux' })
    : f.execute(bin, args, options);
  assert.throws(() => release({ root: f.root, resume: true }, otherEngine, f.buildHost), /Docker/);
  assert.equal(f.calls.slice(before).some(call => call.includes('stop') || call.includes('apply-compose')), false);
});

test('a new site saves the engine architecture while existing preferences remain unchanged', t => {
  const f = fixture(t, { fresh: true });
  const first = loadSite(f.root, undefined, { imagePlatform: 'linux/arm64' });
  assert.equal(first.source.image.DSH_IMAGE_PLATFORM, 'linux/arm64');
  const bytes = readFileSync(first.sitePath);
  assert.equal(loadSite(f.root, undefined, { imagePlatform: 'linux/amd64' }).source.image.DSH_IMAGE_PLATFORM, 'linux/arm64');
  assert.deepEqual(readFileSync(first.sitePath), bytes);
});

test('stop verification failure restarts the unchanged old service and is checked again on resume', t => {
  let denied = true;
  const f = fixture(t, { fail: (bin, args) => denied && bin === 'docker' && args[0] === 'inspect' });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.equal(f.calls.some(call => call.includes('apply-compose')), false);
  assert.ok(f.calls.at(-1).includes('up'));
  assert.equal(f.result().stopComplete, false);
  denied = false;
  release({ root: f.root, resume: true }, f.execute, f.buildHost);
  assert.equal(f.calls.filter(call => call.includes('stop')).length, 2);
  assert.equal(f.result().status, 'ready');
});

test('resume accepts older stop records without requiring their archive files or rechecking a replaced container', t => {
  for (const completed of [false, true]) {
    let failApply = true;
    const f = fixture(t, { fail: (bin, args) => failApply && args.includes('apply-compose') });
    assert.throws(() => release({ root: f.root }, f.execute, f.buildHost), /simulated failure/);
    const saved = f.result();
    delete saved.stopComplete;
    Object.assign(saved, { status: completed ? 'applying' : 'backing-up', backupComplete: completed, backupArchive: '/missing/legacy.tar.gz' });
    f.put(resolve(saved.operation, 'result.json'), saved);
    f.put('.local/source-release.json', { operation: saved.operation, status: saved.status });
    f.put(resolve(saved.operation, 'backup/existing-file'), 'preserve existing files');
    failApply = false;
    const before = f.calls.length;
    assert.equal(release({ root: f.root, resume: true }, f.execute, f.buildHost).status, 'ready');
    const calls = f.calls.slice(before);
    assert.equal(calls.some(call => call.includes('stop')), !completed);
    assert.equal(calls.some(call => call.includes('-czf') || call.includes('-tzf')), false);
    assert.equal(readFileSync(resolve(saved.operation, 'backup/existing-file'), 'utf8'), 'preserve existing files');
  }
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

test('unified source keeps exact private input backup while generated records contain no secret values', t => {
  const f = fixture(t, { fresh: true });
  const text = renderFrameworkConfig({ credentials: { DEEPSEEK_API_KEY: 'sk-source-private-sentinel' }, privateInput: true });
  f.put('.local/env.conf', text);
  const result = release({ root: f.root }, f.execute, f.buildHost);
  assert.equal(readFileSync(resolve(result.operation, 'framework-input.conf'), 'utf8'), text);
  assert.equal(JSON.stringify(result).includes('private-sentinel'), false);
  assert.equal(readFileSync(f.config, 'utf8').includes('private-sentinel'), false);
  assert.equal(JSON.stringify(f.calls).includes('private-sentinel'), false);
  assert.equal(JSON.parse(readFileSync(f.config)).frameworkCredentials.sha256.length, 64);
});

test('unsupported legacy business fields reject migration before creating a unified file', t => {
  const f = fixture(t, { fresh: true });
  const previous = { instances: { example: { apiKey: 'private-sentinel' } } };
  f.put('.local/site.json', previous);
  assert.throws(() => loadSite(f.root), error => /DSH_INSTANCES/.test(error.message) && !error.message.includes('private-sentinel'));
  assert.equal(existsSync(resolve(f.root, '.local/env.conf')), false);
  assert.deepEqual(JSON.parse(readFileSync(resolve(f.root, '.local/site.json'))), previous);
});

test('legacy image preferences import once and retain the original source', t => {
  const f = fixture(t, { fresh: true });
  f.put('.local/site.json', { hostImageConfig: '.local/image.conf', home: '.local/data/custom home' });
  const previous = 'HARBOR_ENABLED=true\nREGISTRY_HOST=registry.example\nREGISTRY_USERNAME=fixture\nREGISTRY_PASSWORD=registry-private-sentinel\n';
  f.put('.local/image.conf', previous);
  const loaded = loadSite(f.root);
  assert.equal(loaded.source.image.REGISTRY_PASSWORD, 'registry-private-sentinel');
  assert.equal(loaded.site.home, resolve(f.root, '.local/data/custom home'));
  assert.equal(readFileSync(resolve(f.root, '.local/image.conf'), 'utf8'), previous);
  assert.equal(JSON.stringify(loaded.site).includes('private-sentinel'), false);
  f.put('.local/image.conf', 'REGISTRY_HOST=changed.example\n');
  assert.equal(loadSite(f.root).source.image.REGISTRY_HOST, 'registry.example');
});

test('new unified source derives unset home and workspace from dataRoot, while explicit JSON keeps its defaults', t => {
  const f = fixture(t, { fresh: true });
  f.put('.local/env.conf', 'DSH_DATA_DIR=data/custom\n');
  const { site } = loadSite(f.root);
  assert.equal(site.home, resolve(f.root, 'data/custom/dsh-home'));
  assert.equal(site.workspace, resolve(f.root, 'data/custom/workspace'));
  f.put('.local/legacy.json', { dataRoot: 'data/custom' });
  assert.equal(loadSite(f.root, '.local/legacy.json').site.home, defaults.home);
});
