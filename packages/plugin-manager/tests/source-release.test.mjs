import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readPlugin } from '../src/plugins.mjs';
import { loadRelease, loadReleaseInputs } from '../src/release.mjs';
import { release, validateBase } from '../../../deploy/scripts/build.mjs';
import { loadSite } from '../../../deploy/scripts/site.mjs';
import { renderFrameworkConfig } from '../src/framework-config.mjs';
import { writePublicInputRecord } from '../src/public-build-view.mjs';

const hostCommit = 'a'.repeat(40), revision = 'b'.repeat(40);
const base = `registry.test/dsh@sha256:${'1'.repeat(64)}`, target = `registry.test/dsh@sha256:${'2'.repeat(64)}`;
const baseId = `sha256:${'3'.repeat(64)}`, builtId = `sha256:${'4'.repeat(64)}`;
const info = { Id: baseId, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': hostCommit } } };
const digest = value => createHash('sha256').update(value).digest('hex');
const defaults = JSON.parse(readFileSync(new URL('../../../deploy/config/site.defaults.json', import.meta.url)));
/**
 * 已有站点（旧 JSON）没有声明容器用户时，站点流程按默认 1000 判定挂载可访问性；CI 与 macOS 运行器的
 * uid 不是 1000，而夹具目录属于测试进程。真实部署里运维会把 `DSH_CONTAINER_UID/GID` 对齐到本机属主，
 * 夹具照此声明（`apply-compose.test.mjs` 同做法）。
 */
const containerUser = { containerUid: process.getuid?.() ?? 1000, containerGid: process.getgid?.() ?? 1000 };

function fixture(t, { fresh = false, fail } = {}) {
  // Windows runners can expose TEMP through an 8.3 alias; production paths are canonical.
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'source-release-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { path = resolve(root, path); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 }); };
  const artifacts = resolve(root, '.local/artifacts');
  const config = resolve(root, '.local/deployment.json');
  put('deploy/config/site.defaults.json', defaults);
  put('package.json', { version: '0.2.3', packageManager: 'pnpm@11.19.0' });
  put('packages/plugin-manager/package.json', { version: '0.2.3' });
  put('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n  - 'plugins/external/*'\n");
  put('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/plugin-manager: {}\n");
  put('integrations/docker/manager-update.Dockerfile', 'FROM test');
  put('deepseek-harness/.git', 'fixture git worktree');
  const archivePlugin = (output, id, version, archive) => {
    const stage = resolve(root, '.local/staging', `${id}-${version}`, 'package');
    put(resolve(stage, 'package.json'), { name: id, version, type: 'module', main: 'dist/index.mjs', files: ['dist', 'cordis.patch.yml'],
      scripts: { build: 'node build.mjs', check: 'node check.mjs' }, dsh: { bundle: { patch: 'cordis.patch.yml' } }, deepseekPlugin: { schemaVersion: 3, id } });
    put(resolve(stage, 'cordis.patch.yml'), `- insert:\n  - id: ${id}\n    name: ${id}\n`);
    put(resolve(stage, 'README.md'), id);
    put(resolve(stage, 'dist/index.mjs'), 'export function apply() {}\n');
    mkdirSync(output, { recursive: true });
    const path = resolve(output, archive);
    const tar = spawnSync('tar', ['-czf', path, '-C', resolve(stage, '..'), 'package'], { encoding: 'utf8', windowsHide: true });
    assert.equal(tar.status, 0, tar.stderr);
    const { directory, ...plugin } = readPlugin(stage);
    return { ...plugin, archive, sha256: digest(readFileSync(path)) };
  };
  let oldArchive;
  if (!fresh) {
    put('.local/deployment.json', { ...containerUser, containerImage: base, manifest: '.local/artifacts/old/manifest.json', plugins: ['example'], publicOrigin: 'https://example.test', composeProject: 'site' });
    const old = archivePlugin(resolve(artifacts, 'old'), 'example', '0.2.0', 'example.tgz');
    oldArchive = readFileSync(resolve(artifacts, 'old/example.tgz'));
    put('.local/artifacts/old/manifest.json', { schemaVersion: 2, plugins: [old] });
    put('.local/artifacts/active-compose.json', { project: 'site', path: resolve(artifacts, 'previous.json') });
    put('.local/artifacts/previous.json', { services: { dsh: { image: base, environment: { DSH_PORT: '7902', DSH_HOME: '/data/dsh-home', DSH_PROFILE: 'web' }, volumes: [{ type: 'bind', source: resolve(root, '.local/data'), target: '/data' }] } } });
    // 模拟 migrate-site 已完成：稳定绑定与目录标记就位，旧数据与活动部署保留。
    put('.local/site-binding.json', { schemaVersion: 1, siteId: 'site-legacy', root, dataRoot: resolve(root, '.local/data'), home: resolve(root, '.local/data/dsh-home'), workspace: resolve(root, '.local/data/workspace'), authUrlFile: resolve(root, '.local/data/dsh-web-auth-url.txt'), artifacts: resolve(root, '.local/artifacts'), profile: 'web', composeProject: 'site' });
    // 绑定声明的持久目录必须在场：缺失会被当成数据丢失而拒绝发布。
    mkdirSync(resolve(root, '.local/data/dsh-home'), { recursive: true });
    mkdirSync(resolve(root, '.local/data/workspace'), { recursive: true });
    put('.local/data/.dsh-site-id', 'site-legacy');
    put('.local/artifacts/.dsh-site-id', 'site-legacy');
    // 站点数据就在绑定声明的数据根内：旧站点数据在普通更新后必须原样保留。
    put('.local/data/marker.txt', 'retained runtime');
  }
  const original = existsSync(config) ? readFileSync(config, 'utf8') : null, calls = [];
  const images = new Map([[base, info], [baseId, info]]);
  const builtInfo = { ...info, Id: builtId, RepoDigests: [target], Config: { Labels: { ...info.Config.Labels, 'com.dsh-plugin-manager.manager.sha256': digest('saved manager fixture archive') } } };
  // 实时查询的状态：旧站点有一个运行中的 dsh 容器，本次部署按项目查询后停止它；新站点没有容器。
  const containerId = 'c'.repeat(64);
  let containerExists = !fresh, containerRunning = !fresh;
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
    if (bin === process.execPath && String(args[0]).replaceAll('\\', '/').endsWith('scripts/package-plugins.mjs')) {
      // 内置构建固定全量：fixture 的内置集合是 auth+example，与运行选集（DSH_PLUGINS）无关。
      const requested = args[args.indexOf('--plugins') + 1];
      const selected = requested === 'all' ? ['auth', 'example'] : requested.split(',').filter(id => id !== 'none');
      const output = args[args.indexOf('--output') + 1];
      const plugins = selected.map(id => archivePlugin(output, id, '0.2.1', `${id}-0.2.1.tgz`));
      put(resolve(output, 'manifest.json'), { schemaVersion: 2, plugins });
    }
    if (bin === process.execPath && args[1] === 'apply-compose') {
      const candidate = JSON.parse(readFileSync(args[args.indexOf('--config') + 1]));
      put('.local/artifacts/new-compose.json', { services: { dsh: { image: candidate.containerImage, environment: { DSH_PORT: String(candidate.port), DSH_HOME: '/data/dsh-home', DSH_PROFILE: 'web', PLUGIN_MANIFEST_FILE: '/opt/plugin-packages/manifest.json' }, volumes: [{ type: 'bind', source: resolve(root, '.local/data'), target: '/data' }, { type: 'bind', source: resolve(root, candidate.manifest, '..'), target: '/opt/plugin-packages', read_only: true }] } } });
      put('.local/artifacts/active-compose.json', { project: candidate.composeProject, path: resolve(artifacts, 'new-compose.json') });
    }
    if (bin === 'docker' && args[0] === 'tag') images.set(args[2], images.get(args[1]) ?? builtInfo);
    if (bin === 'docker' && args[0] === 'ps') {
      if (args.includes('-a')) return containerExists ? containerId : '';
      return containerRunning ? containerId : '';
    }
    if (bin === 'docker' && args[0] === 'stop') { containerRunning = false; return ''; }
    if (bin === 'docker' && args[0] === 'inspect') {
      const active = JSON.parse(readFileSync(resolve(artifacts, 'active-compose.json')));
      const service = JSON.parse(readFileSync(active.path)).services.dsh;
      return JSON.stringify([{ Id: containerId, State: { Running: containerRunning, Restarting: false }, Config: { Image: service.image, Labels: { 'com.docker.compose.service': 'dsh' }, Env: ['DSH_HOME=/data/dsh-home', 'DSH_PROFILE=web'] }, Mounts: [{ Type: 'bind', Source: resolve(root, '.local/data'), Destination: '/data', RW: true }] }]);
    }
    if (bin === 'docker' && args[0] === 'image') return JSON.stringify([images.get(args[2]) ?? builtInfo]);
    if (bin === 'docker' && args.includes('--volumes-from')) return readFileSync(resolve(root, '.local/data', args.at(-1).slice('/data/'.length)), 'utf8');
    if (bin === 'docker' && args[0] === 'run') return '0.2.3';
    return '';
  };
  const buildHost = () => { calls.push(['build-host']); return { imageId: builtId, resultFile: resolve(artifacts, 'host-image.json') }; };
  const tooling = ({ output, execute: run }) => {
    // Build/install behavior has separate real-archive tests; this fixture owns the saved tree.
    run('pnpm', ['--filter', '@dsh-plugin-manager/plugin-manager', 'build']);
    const archive = resolve(output, 'plugin-manager.tgz');
    put(archive, 'saved manager fixture archive');
    const cli = resolve(output, 'node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs');
    put(cli, '// saved fixture CLI\n');
    put(resolve(cli, '../site-release.mjs'), '// saved fixture worker\n');
    return { archive, sha256: digest(readFileSync(archive)), cli, toolRoot: output };
  };
  const result = () => { const pointer = JSON.parse(readFileSync(resolve(root, '.local/source-release.json'))); return JSON.parse(readFileSync(resolve(pointer.operation, 'result.json'))); };
  return { root, config, original, calls, execute, buildHost, tooling, result, put, oldArchive };
}

test('the source entry merges incoming external archives into the same candidate set', t => {
  const f = fixture(t);
  // 外部产物只以完整发布目录出现在 incoming：与内置构建结果合并成唯一候选集合。
  const stage = resolve(f.root, 'incoming/stage/package');
  mkdirSync(stage, { recursive: true });
  f.put(resolve(stage, 'package.json'), { name: 'fixture-external', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: 'cordis.patch.yml' } }, deepseekPlugin: { schemaVersion: 3, id: 'external-one' } });
  f.put(resolve(stage, 'index.js'), 'export const external = true;\n');
  f.put(resolve(stage, 'cordis.patch.yml'), '{}\n');
  const archive = resolve(f.root, 'incoming/stage/external.tgz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', dirname(stage), 'package'], { encoding: 'utf8', windowsHide: true });
  assert.equal(tar.status, 0, tar.stderr);
  f.put(resolve(f.root, 'incoming/stage/manifest.json'), { schemaVersion: 2, plugins: [
    { id: 'external-one', package: 'fixture-external', version: '1.0.0', archive: 'external.tgz', sha256: digest(readFileSync(archive)), verifyFiles: ['package.json', 'index.js', 'cordis.patch.yml'] },
  ] });
  const record = release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.equal(record.status, 'ready');
  const candidate = loadReleaseInputs(record.manifest);
  const ids = candidate.plugins.map(plugin => plugin.id).sort();
  assert.deepEqual(ids, ['auth', 'example', 'external-one']);
  assert.deepEqual(record.externalPlugins, ['external-one']);
  assert.deepEqual(record.pluginBuilds.map(item => item.id).sort(), ['auth', 'example']);
});

test('a selected plugin missing from the merged candidate fails before the old service is stopped', t => {
  const f = fixture(t, { fresh: true });
  f.put('.local/site.json', { plugins: ['example', 'ghost'] });
  const calls = [];
  assert.throws(() => release({ root: f.root }, (bin, args) => { calls.push([bin, ...args]); return f.execute(bin, args); }, f.buildHost, f.tooling), /ghost 缺少产物/);
  assert.equal(calls.some(call => call.includes('stop')), false);
});

test('the source entry builds its view from the delivered public build inputs', t => {
  const f = fixture(t, { fresh: true });
  const delivered = resolve(f.root, 'tools/builtin-build');
  const lock = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n  packages/plugin-manager:\n    dependencies: {}\n";
  f.put('tools/builtin-build/package.json', { version: '0.2.3', packageManager: 'pnpm@11.19.0' });
  f.put('tools/builtin-build/pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n");
  f.put('tools/builtin-build/pnpm-lock.yaml', lock);
  // 交付记录随材料一起交付：只有独立交付目录就必须能证明交付完整性（站点侧同一判据）。
  writePublicInputRecord(delivered, { version: '0.2.3' });
  // 现场根文件与交付材料不同：源码入口只能按交付的字节构造视图。
  f.put('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  plugins/external/marker: {}\n");
  const record = release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.equal(record.status, 'ready');
  const view = resolve(record.operation, 'build-view');
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    assert.deepEqual(readFileSync(resolve(view, name)), readFileSync(resolve(delivered, name)), `${name} 必须逐字节来自交付输入`);
  }
  assert.equal(existsSync(resolve(view, 'plugins/external')), false, '视图不得包含 external 源码');
  assert.equal(existsSync(resolve(view, 'pnpm-workspace.yaml')) && readFileSync(resolve(view, 'pnpm-lock.yaml'), 'utf8').includes('plugins/external/'), false);
});

test('the source entry refuses a private checkout without delivered public build inputs', t => {
  const f = fixture(t, { fresh: true });
  f.put('plugins/external/one/package.json', { name: 'private-one', version: '0.1.0' });
  const calls = [];
  assert.throws(() => release({ root: f.root }, (bin, args) => { calls.push([bin, ...args]); return f.execute(bin, args); }, f.buildHost, f.tooling), /不能按现场元数据构造构建视图/);
  // 拒绝发生在准备阶段：没有停服、没有候选启动，记录停在 build-failed。
  assert.equal(calls.some(call => call[0] === 'docker' && (call[1] === 'stop' || call.includes('apply-compose'))), false);
  assert.equal(f.result().status, 'build-failed');
});

test('a complete source checkout initializes defaults without fetching official source or using previous artifacts', t => {
  const f = fixture(t, { fresh: true });
  assert.equal(release({ root: f.root }, f.execute, f.buildHost, f.tooling).status, 'ready');
  for (const call of f.calls.filter(call => call[0] === 'pnpm' && call[1] === '--filter' && ['build', 'check', 'test'].includes(call[3]))) {
    const name = call[2].split('/').at(-1);
    const manifest = JSON.parse(readFileSync(new URL(`../../${name}/package.json`, import.meta.url)));
    assert.ok(manifest.scripts[call[3]], `${call[2]} does not declare ${call[3]}`);
  }
  assert.ok(f.calls.some(call => call[0] === 'build-host'));
  assert.ok(f.calls.some(call => call[0] === 'docker' && call[1] === 'build' && call.includes(`MANAGER_SHA256=${digest('saved manager fixture archive')}`)));
  assert.equal(f.calls.some(call => call[0] === 'git' && call.some(value => ['submodule', 'clone', 'fetch', 'pull'].includes(value))), false);
  assert.equal(f.calls.some(call => call.includes('push') || call.includes('stop') || call.includes('-czf')), false);
  assert.equal(JSON.parse(readFileSync(f.config)).containerImage, builtId);
  const { site } = loadSite(f.root);
  // 运行选集不随来源改变（设计 2.8）：未指定选集时站点配置不落值，部署按全部候选收敛。
  assert.equal(site.plugins, undefined);
  assert.equal('containerImage' in site, false);
});

test('a mismatched runtime manager archive is rejected before stopping the service', t => {
  const f = fixture(t);
  const execute = (bin, args, options) => {
    const result = f.execute(bin, args, options);
    if (bin === 'docker' && args[0] === 'image' && args[2].startsWith('dsh-local/source:')) {
      const [image] = JSON.parse(result);
      image.Config.Labels['com.dsh-plugin-manager.manager.sha256'] = '0'.repeat(64);
      return JSON.stringify([image]);
    }
    return result;
  };
  assert.throws(() => release({ root: f.root }, execute, f.buildHost, f.tooling), /archive differs from saved tooling/);
  assert.equal(f.calls.some(call => call.includes('stop') || call.includes('apply-compose')), false);
});

test('missing source fails without downloading, while a different supplied commit is accepted', t => {
  const f = fixture(t, { fresh: true });
  rmSync(resolve(f.root, 'deepseek-harness/.git'));
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost, f.tooling), /checkout is incomplete/);
  f.put('deepseek-harness/.git', 'fixture git worktree');
  const wrongPin = (bin, args, options) => bin === 'git' && args[0] === '-C' && args[2] === 'rev-parse' ? 'c'.repeat(40) : f.execute(bin, args, options);
  assert.equal(release({ root: f.root }, wrongPin, f.buildHost, f.tooling).status, 'ready');
  assert.equal(f.calls.some(call => call.includes('submodule') || call.includes('stop')), false);
});

test('missing pnpm is prepared locally at the pinned version without changing the caller PATH', t => {
  let unavailable = true;
  const f = fixture(t, { fresh: true, fail: (bin, args) => {
    if (unavailable && bin === 'pnpm' && args[0] === '--version') { unavailable = false; return true; }
    return false;
  } });
  const originalPath = process.env.PATH;
  release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.ok(f.calls.some(call => call[0] === 'npm' && call.includes(resolve(f.root, '.local/tooling/pnpm')) && call.includes('pnpm@11.19.0')));
  assert.equal(process.env.PATH, originalPath);
});

test('legacy update preserves data and site values and applies immediately after proving the stop', t => {
  const f = fixture(t);
  assert.equal(release({ root: f.root }, f.execute, f.buildHost, f.tooling).status, 'ready');
  const stop = f.calls.findIndex(call => call.includes('stop'));
  const push = f.calls.findIndex(call => call[0] === 'docker' && call[1] === 'push');
  const apply = f.calls.findIndex(call => call.includes('apply-compose'));
  const proof = f.calls.findIndex(call => call[0] === 'docker' && call[1] === 'inspect');
  assert.ok(push < stop && stop < proof && proof < apply);
  assert.equal(existsSync(resolve(f.result().operation, 'backup')), false);
  assert.equal(readFileSync(resolve(f.root, '.local/data/marker.txt'), 'utf8'), 'retained runtime');
  const updated = JSON.parse(readFileSync(f.config));
  assert.equal(updated.publicOrigin, 'https://example.test');
  assert.equal(updated.containerImage, target);
});

test('repeated execution keeps the site file and the established binding', t => {
  const f = fixture(t, { fresh: true });
  release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  const site = readFileSync(resolve(f.root, '.local/env.conf'), 'utf8');
  const binding = JSON.parse(readFileSync(resolve(f.root, '.local/site-binding.json')));
  release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.equal(readFileSync(resolve(f.root, '.local/env.conf'), 'utf8'), site);
  assert.deepEqual(JSON.parse(readFileSync(resolve(f.root, '.local/site-binding.json'))), binding);
  assert.equal(f.result().status, 'ready');
});

test('a partial site override uses the same effective paths on repeated deployments', t => {
  const f = fixture(t, { fresh: true });
  f.put('.local/site.json', { ...containerUser, dataRoot: '.local/data/custom' });
  release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.equal(f.result().status, 'ready');
  assert.equal(JSON.parse(readFileSync(f.config)).home, resolve(f.root, defaults.home));
});

test('changing the established data location is rejected before stopping the service', t => {
  const f = fixture(t, { fresh: true });
  release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  f.put('.local/env.conf', renderFrameworkConfig({ config: { ...defaults, home: '.local/data/another-home' } }));
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost, f.tooling), /站点绑定/);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('build failure leaves service and deployment inputs unchanged', t => {
  const f = fixture(t, { fail: (bin, args) => bin === 'pnpm' && args.includes('build') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost, f.tooling), /simulated failure/);
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
  const f = fixture(t);
  let deny = true;
  const execute = (bin, args, options) => {
    if (deny && bin === 'docker' && args.includes('--mount')) throw new Error('simulated mount failure');
    if (bin === 'docker' && args[2] === 'info') return JSON.stringify({ OSType: 'linux', ID: 'fixture-engine', Architecture: 'x86_64', OperatingSystem: 'Docker Desktop' });
    return f.execute(bin, args, options);
  };
  assert.throws(() => release({ root: f.root }, execute, f.buildHost, f.tooling), /simulated mount failure/);
  assert.equal(f.calls.some(call => call.includes('stop')), false);
});

test('first access failure is repaired by the next ordinary build', t => {
  let deny = true, f;
  f = fixture(t, { fresh: true, fail: (bin, args) => {
    if (deny && args.includes('apply-compose')) {
      f.put('.local/data/dsh-home/plugins/example/plugin.json', { schemaVersion: 1, enabled: true });
      return true;
    }
    return false;
  } });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost, f.tooling), /simulated failure/);
  assert.equal(f.result().status, 'deployment-failed');
  assert.equal(f.calls.some(call => call.includes('stop')), false);
  deny = false;
  const result = release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.equal(result.status, 'ready');
  assert.equal(JSON.parse(readFileSync(resolve(f.root, '.local/data/dsh-home/plugins/example/plugin.json'))).enabled, true);
});

test('a changed Docker engine no longer blocks an ordinary build', t => {
  let deny = true;
  const f = fixture(t, { fresh: true, fail: (bin, args) => deny && args.includes('apply-compose') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost, f.tooling), /simulated failure/);
  const otherEngine = (bin, args, options) => bin === 'docker' && args.includes('info')
    ? JSON.stringify({ OSType: 'linux', ID: 'different-engine', Architecture: 'x86_64', OperatingSystem: 'Linux' })
    : f.execute(bin, args, options);
  deny = false;
  assert.equal(release({ root: f.root }, otherEngine, f.buildHost, f.tooling).status, 'ready');
});

test('a new site saves the engine architecture while existing preferences remain unchanged', t => {
  const f = fixture(t, { fresh: true });
  const first = loadSite(f.root, undefined, { imagePlatform: 'linux/arm64' });
  assert.equal(first.source.image.DSH_IMAGE_PLATFORM, 'linux/arm64');
  const bytes = readFileSync(first.sitePath);
  assert.equal(loadSite(f.root, undefined, { imagePlatform: 'linux/amd64' }).source.image.DSH_IMAGE_PLATFORM, 'linux/arm64');
  assert.deepEqual(readFileSync(first.sitePath), bytes);
});

test('stop verification failure leaves the site intact for the next ordinary build', t => {
  let denied = true;
  // 停止目标来自实时查询：查询失败必须在写运行配置与停旧之前中止。
  const f = fixture(t, { fail: (bin, args) => denied && bin === 'docker' && args[0] === 'ps' });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost, f.tooling), /simulated failure/);
  assert.equal(readFileSync(f.config, 'utf8'), f.original);
  assert.equal(f.calls.some(call => call.includes('apply-compose')), false);
  denied = false;
  release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.equal(f.result().status, 'ready');
});

test('failed first startup converges on the next ordinary build without touching data', t => {
  let failApply = true;
  const f = fixture(t, { fresh: true, fail: (bin, args) => failApply && args.includes('apply-compose') });
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost, f.tooling), /simulated failure/);
  f.put('.local/data/dsh-home/user-data', 'keep me');
  failApply = false;
  release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.equal(f.result().status, 'ready');
  assert.equal(readFileSync(resolve(f.root, '.local/data/dsh-home/user-data'), 'utf8'), 'keep me');
});

test('existing data or a missing explicit site file cannot be treated as a blank installation', t => {
  const f = fixture(t, { fresh: true }); f.put('.local/data/dsh-home/user-data', 'keep me');
  assert.throws(() => release({ root: f.root }, f.execute, f.buildHost, f.tooling), /存在数据但没有站点绑定/);
  assert.throws(() => loadSite(f.root, '.local/typo.json'), /does not exist/);
  assert.equal(f.calls.some(call => call.includes('install')), false);
});

test('damaged archives from previous releases do not block a new build', t => {
  const f = fixture(t); f.put('.local/artifacts/old/example.tgz', 'changed');
  // 旧指针与旧归档不再是新发布的输入：内置构建固定全量，正常发布不受影响。
  assert.equal(release({ root: f.root }, f.execute, f.buildHost, f.tooling).status, 'ready');
});

test('immutable supplied images are accepted without a predetermined host version', () => {
  assert.equal(validateBase(base, { ...info, Config: {} }), baseId);
  assert.throws(() => validateBase('registry.test/dsh:latest', info), /immutable/);
});

test('unified source keeps exact private input backup while generated records contain no secret values', t => {
  const f = fixture(t, { fresh: true });
  // 手写的统一配置要像真实运维那样声明容器用户：默认 1000 在非 1000 的运行器上会被访问核对判成不可访问。
  const text = renderFrameworkConfig({ config: { containerUid: process.getuid?.() ?? 1000, containerGid: process.getgid?.() ?? 1000 }, credentials: { DEEPSEEK_API_KEY: 'sk-source-private-sentinel' }, privateInput: true });
  f.put('.local/env.conf', text);
  const result = release({ root: f.root }, f.execute, f.buildHost, f.tooling);
  assert.equal(readFileSync(result.inputs.find(input => input.kind === 'site').path, 'utf8'), text);
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
