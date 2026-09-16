import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hash, tarCommand } from '../src/state.mjs';
import { buildBuiltinPlugins, composeCandidate, discoverArchives, validateRuntimeIndex } from '../src/site-archives.mjs';
import { releaseSite, describeTooling } from '../src/site-release.mjs';
import { fileHash, readSitePointer, readSiteRecord, verifySavedTooling } from '../src/site-record.mjs';
import { writePublicInputRecord } from '../src/public-build-view.mjs';

const image = `registry.test/runtime@sha256:${'a'.repeat(64)}`, hostCommit = 'b'.repeat(40);

test('发布日志能分辨这轮跑的是源码还是工具快照', t => {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'tooling-origin-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const toolRoot = resolve(root, 'operation/tooling');
  const installed = resolve(toolRoot, 'node_modules/@dsh-plugin-manager/plugin-manager/dist/site-release.mjs');
  mkdirSync(dirname(installed), { recursive: true });
  writeFileSync(installed, 'export {};');
  const snapshot = describeTooling(pathToFileURL(installed).href, { toolRoot, managerHash: 'a'.repeat(64) });
  assert.match(snapshot, /执行工具：工具快照/);
  assert.match(snapshot, /工具归档摘要：a{16}…/);
  const source = describeTooling(pathToFileURL(resolve(root, 'packages/plugin-manager/src/site-release.mjs')).href, { toolRoot, managerHash: 'b'.repeat(64) });
  assert.match(source, /执行工具：当前源码检出/);
  // 老记录没有 toolRoot 时只说来源，不编造目录与摘要。
  const legacy = describeTooling(pathToFileURL(installed).href, { schemaVersion: 2 });
  assert.match(legacy, /执行工具：当前源码检出/);
  assert.doesNotMatch(legacy, /工具目录|工具归档摘要/);
});
const entry = ['node', '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs', 'container-start', '--root', '/opt/plugin-project'];

test('内置构建与 incoming 同 id 时在准备输入阶段就报出两个来源', t => {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'duplicate-id-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const operation = resolve(root, '.local/artifacts/op');
  mkdirSync(operation, { recursive: true });
  const builtin = { plugins: [{ id: 'auth', package: 'dsh-auth' }] };
  const incoming = [{ path: resolve(root, 'incoming/public-apps/manifest.json'), plugins: [{ id: 'auth', package: 'dsh-auth' }] }];
  // 这一步在「准备部署输入」里，先于停旧：报错要让操作者看到是两个来源撞了 id，而不是等到组合清单。
  assert.throws(() => composeCandidate({ operation }, builtin, incoming), error => {
    assert.match(error.message, /插件 id 与内置构建重复：auth/);
    assert.match(error.message, /incoming[\\/]public-apps/);
    assert.match(error.message, /请从 incoming 移除该发布目录/);
    return true;
  });
});

test('内置构建先把依赖装进公开构建视图，再用视图里的入口脚本构建', t => {
  const repository = fileURLToPath(new URL('../../..', import.meta.url));
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'public-view-build-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const operation = resolve(root, '.local/artifacts/op');
  mkdirSync(operation, { recursive: true });
  const pinned = JSON.parse(readFileSync(resolve(repository, 'package.json'), 'utf8')).packageManager.slice(5);
  const calls = [];
  // 视图内没有 node_modules 时入口脚本连加载都过不去：安装必须先于运行入口脚本，且装在视图里。
  const execute = (bin, args) => { calls.push({ bin, args }); return bin === 'pnpm' && args[0] === '--version' ? pinned : ''; };
  const run = (bin, args, options = {}) => {
    calls.push({ bin, args, options });
    if (bin === process.execPath) {
      const output = args[args.indexOf('--output') + 1];
      mkdirSync(output, { recursive: true });
      writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ schemaVersion: 2, plugins: [] }));
    }
    return { status: 0 };
  };
  const builtin = buildBuiltinPlugins({ root: repository, operation, env: { PATH: process.env.PATH }, execute, run });
  assert.deepEqual(builtin.plugins, []);
  const view = resolve(operation, 'build-view');
  assert.ok(existsSync(resolve(view, 'scripts/package-plugins.mjs')), '入口脚本必须来自视图');
  assert.ok(existsSync(resolve(view, 'packages/plugin-manager/src/plugins.mjs')), '视图必须带管理器源码');
  const install = calls.findIndex(call => call.bin === 'pnpm' && call.args[1] === '--frozen-lockfile');
  const entry = calls.findIndex(call => call.bin === process.execPath);
  assert.ok(install >= 0 && entry >= 0 && install < entry, '安装视图依赖必须早于运行入口脚本');
  assert.equal(calls[install].args[0], 'install');
  assert.equal(calls[install].options.cwd, view);
  // `source/` 只是材料目录：入口脚本与工作区都取视图，站点材料里不装依赖。
  assert.deepEqual(calls[entry].args.slice(0, 4), [resolve(view, 'scripts/package-plugins.mjs'), '--plugins', 'all', '--output']);
  assert.equal(calls[entry].args[calls[entry].args.indexOf('--workspace-root') + 1], view);
  assert.equal(calls.some(call => call.options?.cwd === repository && call.bin === 'pnpm'), false);
});

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
  // 统一部署路径：发行包自带公开源码（source/）与公开构建输入（tools/builtin-build/），
  // 站点侧在只含这些材料的视图里构建全部内置插件。
  const builtinManifest = { name: 'fixture-builtin', version: '0.1.0', type: 'module', main: 'index.js', files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: 'cordis.patch.yml' } }, deepseekPlugin: { schemaVersion: 3, id: 'builtin-one' } };
  put('source/package.json', { version, packageManager: 'pnpm@11.19.0' });
  put('source/packages/plugin-manager/package.json', { version });
  put('source/pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n");
  put('source/pnpm-lock.yaml', ["lockfileVersion: '9.0'", 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', 'importers:', '  .:', '    dependencies: {}', '  packages/plugin-manager:', '    dependencies: {}', '  plugins/builtin/one:', '    dependencies: {}', ''].join('\n'));
  put('source/plugins/builtin/one/package.json', builtinManifest);
  put('source/plugins/builtin/one/index.js', 'export const one = true;\n');
  put('source/plugins/builtin/one/cordis.patch.yml', '{}\n');
  // 交付输入必须按字节写入：put 会把 Buffer 之类的非字符串值 JSON 化（归档/元数据一律用 writeFileSync）。
  mkdirSync(resolve(root, 'tools/builtin-build'), { recursive: true });
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) writeFileSync(resolve(root, `tools/builtin-build/${name}`), readFileSync(resolve(root, `source/${name}`)));
  // 发行包必须自带交付记录：站点侧用的是独立交付目录，没有记录就直接拒绝构造构建视图。
  writePublicInputRecord(resolve(root, 'tools/builtin-build'), { version, sourceKind: 'release', sourceCommit: null, sourceModified: null });
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
  const installCwds = [];
  const buildRoots = [];
  const execute = (bin, args, options = {}) => {
    calls.push([bin, ...args]);
    if (args[1] === fail) throw new Error(`fixture ${fail} failure`);
    if (bin === 'pnpm' && args[0] === '--version') return '11.19.0';
    if (bin === 'pnpm' && args.includes('install')) { installCwds.push(options.cwd); return ''; }
    if (bin === process.execPath && String(args[0]).replaceAll('\\', '/').endsWith('scripts/package-plugins.mjs')) {
      // 内置构建的产物必须落在站点操作目录里，并与视图分开。
      const output = args[args.indexOf('--output') + 1];
      buildRoots.push(args[args.indexOf('--workspace-root') + 1]);
      const stage = resolve(root, 'stage-builtin/package');
      put(resolve(stage, 'package.json'), builtinManifest);
      put(resolve(stage, 'index.js'), 'export const one = true;\n');
      put(resolve(stage, 'cordis.patch.yml'), '{}\n');
      const archive = resolve(root, 'stage-builtin/one.tgz');
      const tar = spawnSync(tarCommand, ['-czf', '-', 'package'], { cwd: resolve(root, 'stage-builtin'), windowsHide: true });
      assert.equal(tar.status, 0, tar.stderr?.toString());
      writeFileSync(archive, tar.stdout);
      // put 会把非字符串 JSON 化；归档必须按字节写入。
      mkdirSync(output, { recursive: true });
      writeFileSync(resolve(output, 'one.tgz'), readFileSync(archive));
      put(resolve(output, 'manifest.json'), { schemaVersion: 2, plugins: [
        { id: 'builtin-one', package: 'fixture-builtin', version: '0.1.0', archive: 'one.tgz', sha256: fileHash(archive), verifyFiles: ['package.json', 'index.js', 'cordis.patch.yml'] },
      ] });
      return '';
    }
    if (bin === 'docker' && args[0] === 'context') return JSON.stringify('unix:///var/run/docker.sock');
    if (bin === 'docker' && args[0] === '--host') return args[2] === 'info' ? JSON.stringify({ OSType: 'linux', ID: 'site-engine', Architecture: 'x86_64', OperatingSystem: process.platform === 'linux' ? 'Linux' : 'Docker Desktop' }) : 'Docker Compose fixture';
    if (bin === 'docker' && args[0] === 'image') return JSON.stringify([{ Id: runtimeImage.split('@')[1], Os: 'linux', Architecture: 'amd64', Config: { Entrypoint: entry, Labels: { 'org.opencontainers.image.revision': hostCommit, 'com.dsh-plugin-manager.manager.sha256': fileHash(resolve(root, 'tools/plugin-manager.tgz')) } } }]);
    if (bin === 'docker' && args[0] === 'run') return version;
    return '';
  };
  const record = () => { const pointer = readSitePointer(root); return readSiteRecord(root, pointer.operation); };
  return { root, put, pack, calls, installCwds, buildRoots, execute, record, setFramework, setFail: value => { fail = value; } };
}

test('a release renders and applies the container configuration in one pass before stopping', t => {
  const f = fixture(t);
  f.setFail(null);
  assert.equal(releaseSite({ root: f.root }, f.execute).status, 'ready');
  // check-compose/render-compose 公共动作已移除：apply-compose 内部先渲染核验再停旧起新，
  // 不再留下没人读的 preflight 目录。
  const compose = f.calls.map(call => call[2]).filter(action => action === 'apply-compose');
  assert.deepEqual(compose, ['apply-compose']);
});

test('a release reports current facts without inferring from old records', t => {
  const f = fixture(t), messages = [];
  t.mock.method(console, 'log', message => messages.push(message));
  f.setFail(null);
  assert.equal(releaseSite({ root: f.root }, f.execute).status, 'ready');
  assert.ok(messages.some(message => message.includes('发布已完成')), messages.join('\n'));
  // 摘要只报本次事实，不读取旧记录推断升级路径。
  assert.ok(!messages.some(message => message.includes('框架 ')), messages.join('\n'));
});

test('archive discovery requires complete, unique, ordinary release directories', t => {
  const f = fixture(t);
  assert.deepEqual(discoverArchives(f.root).flatMap(r => r.plugins.map(p => p.id)), ['alpha']);
  f.pack('old-alpha');
  assert.throws(() => discoverArchives(f.root), /重复插件.*alpha-release.*old-alpha/);
  const duplicate = resolve(f.root, 'incoming/old-alpha'); assert.equal(dirname(duplicate), resolve(f.root, 'incoming')); rmSync(duplicate, { recursive: true });
  f.put('incoming/loose.tgz', 'loose'); assert.throws(() => discoverArchives(f.root), /完整发布目录/);
  rmSync(resolve(f.root, 'incoming/loose.tgz'));
  f.put('incoming/alpha-release/alpha.tgz', 'tampered'); assert.throws(() => discoverArchives(f.root), /无法读取插件归档/);
});

test('prepared archive operations freeze tools and inputs before data writes', t => {
  const f = fixture(t); f.setFail('apply-compose');
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture apply-compose/);
  const record = f.record(); assert.equal(record.schemaVersion, 3); assert.equal(record.status, 'deployment-failed');
  // 绑定初始化会创建持久目录与站点标记；业务写入（profile/安装层）尚未发生。
  assert.equal(existsSync(resolve(f.root, '.local/data', '.dsh-site-id')), true);
  assert.equal(existsSync(resolve(f.root, '.local/data/dsh-home/profiles/web')), false);
  // 统一准备不再调用 git，也不在站点根安装依赖：构建依赖只装进公开构建视图。
  assert.equal(f.calls.some(call => call[0] === 'git'), false);
  assert.equal(existsSync(resolve(f.root, 'node_modules')), false);
  // 视图安装只由打包入口在同一个视图里做（不再由站点准备重复安装一次）：
  // 这里核对构建拿到的 workspace 根就是视图，站点根与任何非视图位置都不在列。
  assert.ok(f.buildRoots.length > 0 && f.buildRoots.every(cwd => resolve(cwd).startsWith(resolve(f.root, '.local/artifacts'))), f.buildRoots.join(','));
  assert.ok(f.buildRoots.every(cwd => resolve(cwd) !== resolve(f.root)), f.buildRoots.join(','));
  assert.ok(f.installCwds.every(cwd => resolve(cwd).startsWith(resolve(f.root, '.local/artifacts'))), f.installCwds.join(','));
  const settings = resolve(f.root, '.local/config/plugins/alpha/plugin.json');
  assert.equal(existsSync(settings), true);
  const candidate = JSON.parse(readFileSync(record.candidatePath));
  assert.equal(typeof record.siteId, 'string');
  assert.equal(candidate.siteId, record.siteId);
  assert.ok(candidate.instances.alpha.settingsFile.startsWith(record.operation));
  // 绑定已初始化且目录标记就位；失败候选保留，下次普通 build 重新收敛。
  assert.equal(existsSync(resolve(f.root, '.local/site-binding.json')), true);
});

test('saved operations and executable paths cannot escape through directory junctions', t => {
  const f = fixture(t); f.setFail('apply-compose');
  assert.throws(() => releaseSite({ root: f.root }, f.execute), /fixture apply-compose/);
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

test('the archive cache root follows the resolved artifacts root instead of a fixed path', t => {
  const f = fixture(t);
  // 自定义 artifacts 根：迁移保全 file: 引用时按绑定的 artifacts 换算，发布必须落到同一个位置，
  // 否则换容器后挂载的是另一个目录，历史引用会失效（设计 4.2、5.1、6.2）。
  f.put('.local/site.json', { containerUid: process.getuid?.() ?? 1000, containerGid: process.getgid?.() ?? 1000, artifacts: 'deploy-artifacts' });
  f.setFail(null);
  const record = releaseSite({ root: f.root }, f.execute);
  assert.equal(record.status, 'ready');
  const candidate = JSON.parse(readFileSync(record.candidatePath));
  assert.equal(candidate.pluginCacheRoot, resolve(f.root, 'deploy-artifacts/plugin-packages'));
  assert.equal(existsSync(resolve(candidate.pluginCacheRoot, candidate.pluginCacheManifest)), true);
  assert.equal(record.sitePaths.artifacts, resolve(f.root, 'deploy-artifacts'));
});
