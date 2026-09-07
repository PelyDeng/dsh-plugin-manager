/** Independent author packages share the workspace pipeline without inheriting its layout. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readPlugin, sourcePlugins } from '../src/plugins.mjs';
import { packagePlugins } from '../src/package-plugins.mjs';
import { composeRelease } from '../src/compose-release.mjs';
import { loadRelease, selectRelease } from '../src/release.mjs';
import { resolveDeployment, runtimeEnvironment } from '../src/config.mjs';
import { applyCompose } from '../src/apply-compose.mjs';
import { renderCompose } from '../src/compose.mjs';
import { synchronize, finalize, adoptLegacy } from '../src/installation.mjs';
import { supervise } from '../src/supervisor.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const lock = "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n";
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-external-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, '独立 author');
  mkdirSync(root);
  const manifest = {
    name: 'external-fixture', version: '1.0.0', type: 'module', packageManager: 'pnpm@11.19.0',
    main: './dist/index.mjs', exports: './dist/index.mjs', files: ['dist', 'cordis.patch.yml', 'dev.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    deepseekPlugin: { schemaVersion: 3, id: 'fixture', defaultEnabled: false, development: { rootVariable: 'FIXTURE_SOURCE', patch: 'dev.yml' } },
    scripts: { build: 'node build.mjs', check: 'node check.mjs' },
  };
  json(join(root, 'package.json'), manifest);
  writeFileSync(join(root, 'README.md'), 'Independent fixture.\n');
  writeFileSync(join(root, 'cordis.patch.yml'), "- insert:\n    - id: fixture\n      name: external-fixture\n");
  writeFileSync(join(root, 'dev.yml'), '[]\n');
  writeFileSync(join(root, 'build.mjs'), "import {appendFileSync,mkdirSync,writeFileSync} from 'node:fs'; mkdirSync('dist',{recursive:true}); writeFileSync('dist/index.mjs','export function apply() {}\\n'); appendFileSync('tasks','build\\n');\n");
  writeFileSync(join(root, 'check.mjs'), "import {appendFileSync} from 'node:fs'; import {apply} from './dist/index.mjs'; if(typeof apply !== 'function') throw Error('missing export'); appendFileSync('tasks','check\\n');\n");
  return { base, root, manifest };
}
function run(root, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dirname(root), encoding: 'utf8', timeout: 30000 });
}
function ok(result) { assert.equal(result.status, 0, result.stdout + result.stderr); }

test('runPnpm forwards captured pack diagnostics on failure and keeps successful pack output quiet', t => {
  const { base, root, manifest } = fixture(t);
  manifest.scripts.prepack = 'node prepack.mjs';
  json(join(root, 'package.json'), manifest);
  const runner = join(base, 'pack.mjs');
  const tasks = new URL('../src/run-plugin-task.mjs', import.meta.url).href;
  writeFileSync(runner, `import { runPnpm } from ${JSON.stringify(tasks)};\ntry { runPnpm(['--ignore-workspace', 'pack', '--json', '--out', process.argv[2]], ${JSON.stringify(root)}, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }); } catch (error) { console.error(error.message); process.exitCode = 1; }\n`);
  const pack = name => spawnSync(process.execPath, [runner, join(base, name)], { encoding: 'utf8', timeout: 30000 });
  const messages = 'console.log("pack-stdout-detail"); console.error("pack-stderr-detail");';
  writeFileSync(join(root, 'prepack.mjs'), messages + 'process.exitCode = 6;\n');
  const failure = pack('failure.tgz');
  assert.notEqual(failure.status, 0);
  assert.match(failure.stdout + failure.stderr, /pack-stdout-detail/);
  assert.match(failure.stdout + failure.stderr, /pack-stderr-detail/);
  assert.match(failure.stderr, /pnpm .*失败/);
  writeFileSync(join(root, 'prepack.mjs'), messages + '\n');
  const success = pack('success.tgz');
  ok(success);
  assert.doesNotMatch(success.stdout + success.stderr, /pack-stdout-detail|pack-stderr-detail/);
  assert.ok(existsSync(join(base, 'success.tgz')));
});

test('repository packaging reports build, check and verified pack separately for each discovered plugin', t => {
  const { base, root, manifest } = fixture(t);
  const workspace = join(base, 'workspace');
  mkdirSync(join(workspace, 'plugins'), { recursive: true });
  json(join(workspace, 'package.json'), { private: true, packageManager: 'pnpm@11.19.0' });
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'plugins/*'\n");
  writeFileSync(join(workspace, 'pnpm-lock.yaml'), lock + '  plugins/alpha: {}\n  plugins/beta: {}\n');
  for (const id of ['alpha', 'beta']) {
    const pluginRoot = join(workspace, 'plugins', id);
    mkdirSync(pluginRoot);
    for (const file of readdirSync(root)) copyFileSync(join(root, file), join(pluginRoot, file));
    json(join(pluginRoot, 'package.json'), { ...manifest, name: id, deepseekPlugin: { schemaVersion: 3, id, defaultEnabled: true } });
    writeFileSync(join(pluginRoot, 'cordis.patch.yml'), `- insert:\n    - id: ${id}\n      name: ${id}\n`);
  }
  const script = fileURLToPath(new URL('../../../scripts/package-plugins.mjs', import.meta.url));
  const pack = output => spawnSync(process.execPath, [script, '--root', workspace, '--plugins', 'all', '--output', output], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, DSH_BUILD_PROGRESS: '1' },
  });
  const events = result => result.stdout.split(/\r?\n/).filter(line => line.startsWith('DSH_BUILD_PROGRESS ')).map(line => JSON.parse(line.slice('DSH_BUILD_PROGRESS '.length)));
  const result = pack('.local/success'); ok(result);
  const labels = ['安装插件依赖', ...['alpha', 'beta'].flatMap(id => ['构建', '检查', '打包'].map(task => `${task}插件 ${id}`))];
  assert.deepEqual(events(result), labels.flatMap(label => [{ type: 'start', label }, { type: 'done', label }]));
  assert.equal(read(join(workspace, '.local/success/manifest.json')).plugins.length, 2);
  for (const id of ['alpha', 'beta']) assert.equal(readFileSync(join(workspace, 'plugins', id, 'tasks'), 'utf8'), 'build\ncheck\n');
  writeFileSync(join(workspace, 'plugins/beta/check.mjs'), 'process.exitCode = 8;\n');
  const failure = pack('.local/failure');
  assert.notEqual(failure.status, 0);
  assert.deepEqual(events(failure).at(-1), { type: 'failed', label: '检查插件 beta' });
  assert.equal(events(failure).some(event => event.label === '打包插件 beta'), false);
  assert.equal(existsSync(join(workspace, '.local/failure/manifest.json')), false);
});

test('explicit sources select disabled packages without a lockfile, and reject invalid declarations before scripts', t => {
  const { root, manifest } = fixture(t);
  assert.equal(sourcePlugins(root, undefined, '.')[0].defaultEnabled, false);
  ok(run(root, 'list', '--root', root, '--package', '.'));
  assert.equal(existsSync(join(root, 'tasks')), false);
  assert.throws(() => sourcePlugins(root, 'all', '.'), /不能与/);
  assert.throws(() => sourcePlugins(root, undefined, 'nested'), /仅支持/);
  assert.throws(() => sourcePlugins(undefined, undefined, '.'), /root/);
  for (const change of [
    value => { delete value.deepseekPlugin; },
    value => { value.deepseekPlugin.runtimeConfig = { variable: 'FIXTURE_SOURCE', required: false }; },
    value => { value.deepseekPlugin.configuration = { auth: 'consumer' }; },
  ]) {
    const value = structuredClone(manifest); change(value); json(join(root, 'package.json'), value);
    assert.throws(() => readPlugin(root));
    assert.notEqual(run(root, 'check', '--root', root, '--package', '.').status, 0);
    assert.equal(existsSync(join(root, 'tasks')), false);
  }
});

test('a single package builds once and packs a source-free release without touching its parent workspace', async t => {
  const { base, root, manifest } = fixture(t);
  json(join(base, 'package.json'), { private: true, packageManager: 'pnpm@11.19.0', scripts: { postinstall: 'node -e "throw Error(\"parent installed\")"' } });
  writeFileSync(join(base, 'pnpm-workspace.yaml'), "packages:\n  - '*'\n");
  writeFileSync(join(base, 'pnpm-lock.yaml'), 'parent-lock-must-not-be-used\n');
  const output = join(root, '.local/release');
  assert.throws(() => packagePlugins(root, undefined, output, '.'), /pnpm-lock/);
  assert.equal(existsSync(output), false);
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  ok(run(root, 'pack', '--root', root, '--package', '.', '--output', '.local/release'));
  assert.equal(readFileSync(join(root, 'tasks'), 'utf8'), 'build\ncheck\n');
  assert.equal(readFileSync(join(base, 'pnpm-lock.yaml'), 'utf8'), 'parent-lock-must-not-be-used\n');
  assert.equal(existsSync(join(base, 'node_modules')), false);
  const releasePath = join(output, 'manifest.json');
  const packed = read(releasePath);
  assert.equal(packed.schemaVersion, 2);
  assert.equal(packed.plugins.length, 1);
  assert.equal(Object.hasOwn(packed.plugins[0], 'directory'), false);
  assert.equal(packed.plugins[0].defaultEnabled, false);
  assert.deepEqual(packed.plugins[0].development, manifest.deepseekPlugin.development);
  ok(run(root, 'verify-package', '--root', root, '--package', '.', '--archive', join('.local/release', packed.plugins[0].archive)));
  assert.equal(readFileSync(join(root, 'tasks'), 'utf8'), 'build\ncheck\n');
  assert.notEqual(run(root, 'verify-package', root, join(output, packed.plugins[0].archive), base, '--package', '.').status, 0);

  for (const extra of [{ directory: '.' }, { source: root }, { development: { rootVariable: 'TAMPERED_ROOT', patch: 'dev.yml' } }]) {
    json(releasePath, { ...packed, plugins: [{ ...packed.plugins[0], ...extra }] });
    assert.throws(() => loadRelease(releasePath));
  }
  json(releasePath, packed);
  const release = loadRelease(releasePath);
  assert.equal(selectRelease(release, 'fixture').schemaVersion, 2);
  const deployment = resolveDeployment({ root: base, home: 'data/home', artifacts: 'artifacts', mode: 'development' }, {});
  assert.throws(() => renderCompose(deployment, release, join(base, 'compose')), /仅支持 release/);
  assert.throws(() => applyCompose(deployment, release, () => assert.fail('must not invoke Docker')), /仅支持 release/);
  for (const action of [synchronize, supervise, finalize, adoptLegacy]) await assert.rejects(action(deployment, release), /仅支持 release/);
  for (const action of ['deploy', 'start', 'sync', 'render-compose', 'apply-compose']) {
    const result = run(root, action, '--root', base, '--home', 'data/home', '--artifacts', 'artifacts', '--manifest', releasePath, '--mode', 'development');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /仅支持 release/);
  }
  assert.equal(existsSync(deployment.dataRoot), false);
  assert.equal(existsSync(deployment.artifacts), false);
  assert.equal(existsSync(join(base, 'compose')), false);

  const delivered = join(base, 'delivered');
  renameSync(output, delivered);
  renameSync(root, join(base, 'source-unavailable'));
  const relocated = loadRelease(join(delivered, 'manifest.json'));
  const env = runtimeEnvironment({ ...deployment, mode: 'release' }, relocated.plugins).variables;
  assert.ok(Object.hasOwn(env, 'FIXTURE_SOURCE'));
  assert.equal(env.FIXTURE_SOURCE, undefined);
  const bytes = readFileSync(relocated.plugins[0].archivePath);
  writeFileSync(relocated.plugins[0].archivePath, Buffer.concat([bytes, Buffer.from('tampered')]));
  assert.throws(() => loadRelease(join(delivered, 'manifest.json')), /摘要/);
});

test('failed builds and unsafe output selections never produce a success manifest', t => {
  const { root, manifest } = fixture(t);
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  assert.throws(() => packagePlugins(root, undefined, root, '.'), /发布目录/);
  manifest.scripts.check = 'node -e "process.exit(1)"'; json(join(root, 'package.json'), manifest);
  const output = join(root, '.local/failed');
  assert.throws(() => packagePlugins(root, undefined, output, '.'), /失败/);
  assert.equal(existsSync(join(output, 'manifest.json')), false);
  assert.deepEqual(readdirSync(output), []);
});

test('compose releases from archives, reject conflicts before output, retain source independence', t => {
  const { base, root, manifest } = fixture(t);
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  const first = join(base, 'first'); packagePlugins(root, undefined, first, '.');
  manifest.name = 'second-fixture'; manifest.deepseekPlugin.id = 'second';
  manifest.deepseekPlugin.development.rootVariable = 'SECOND_SOURCE';
  json(join(root, 'package.json'), manifest);
  const second = join(base, 'second'); packagePlugins(root, undefined, second, '.');
  const path1 = join(first, 'manifest.json'), path2 = join(second, 'manifest.json');
  for (const path of [path1, path2]) {
    const value = read(path);
    renameSync(join(dirname(path), value.plugins[0].archive), join(dirname(path), 'package.tgz'));
    value.plugins[0].archive = 'package.tgz'; json(path, value);
  }
  const v1 = read(path1); v1.schemaVersion = 1; v1.plugins[0].directory = 'plugins/fixture'; json(path1, v1);
  const output = join(base, 'composed');
  const result = run(base, 'compose-release', '--root', base, '--output', output, '--manifest', path1, '--manifest', path2);
  assert.equal(result.status, 0, result.stderr);
  const release = loadRelease(join(output, 'manifest.json'));
  assert.equal(release.schemaVersion, 2); assert.equal(release.plugins.length, 2);
  assert.ok(release.plugins.every(plugin => !Object.hasOwn(plugin, 'directory')));
  const conflict = join(base, 'conflict');
  assert.throws(() => composeRelease([path1, path1], conflict), /重复/);
  assert.equal(existsSync(conflict), false);
  assert.throws(() => composeRelease([path1], output), /为空/);
  const upgrade = join(base, 'upgrade');
  composeRelease([path1], upgrade, path2);
  assert.equal(loadRelease(join(upgrade, 'manifest.json')).plugins.length, 1);
  assert.deepEqual(readFileSync(join(upgrade, 'package.tgz')), readFileSync(join(second, 'package.tgz')));
  const previous = read(path2);
  previous.plugins[0].archive = `${v1.plugins[0].id}-${v1.plugins[0].sha256}.tgz`;
  renameSync(join(second, 'package.tgz'), join(second, previous.plugins[0].archive)); json(path2, previous);
  assert.throws(() => composeRelease([path1], conflict, path2), /内容冲突/);
  assert.equal(existsSync(conflict), false);
  const originalArchive = join(second, previous.plugins[0].archive);
  const inputPath = join(second, 'previous-input.json');
  const outsideBefore = readFileSync(originalArchive);
  json(inputPath, { ...previous, plugins: [{ ...previous.plugins[0], archive: `../second/${previous.plugins[0].archive}` }] });
  assert.throws(() => composeRelease([path1], conflict, inputPath), /越界/);
  assert.deepEqual(readFileSync(originalArchive), outsideBefore);
  assert.equal(existsSync(conflict), false);
  const variables = read(path2); variables.plugins[0].development.rootVariable = 'FIXTURE_SOURCE';
  // A tampered input must fail its existing archive check, not be accepted by assembly.
  json(path2, variables); assert.throws(() => composeRelease([path2], conflict), /不一致/);
  for (const archive of ['manifest.json', 'manifest.json.tmp']) {
    cpSync(originalArchive, join(second, archive));
    json(inputPath, { ...previous, plugins: [{ ...previous.plugins[0], archive }] });
    assert.throws(() => composeRelease([path1], conflict, inputPath), /保留路径/);
    assert.equal(existsSync(conflict), false);
  }
  const nested = `${v1.plugins[0].id}-${v1.plugins[0].sha256}.tgz/old.tgz`;
  mkdirSync(join(second, 'nested-source', dirname(nested)), { recursive: true });
  cpSync(originalArchive, join(second, 'nested-source', nested));
  const nestedInput = join(second, 'nested-source/old.json');
  json(nestedInput, { ...previous, plugins: [{ ...previous.plugins[0], archive: nested }] });
  assert.throws(() => composeRelease([path1], conflict, nestedInput), /文件与目录冲突/);
  assert.equal(existsSync(conflict), false);
  renameSync(first, join(base, 'first-moved')); renameSync(second, join(base, 'second-moved'));
  assert.equal(loadRelease(join(output, 'manifest.json')).plugins.length, 2);
});
