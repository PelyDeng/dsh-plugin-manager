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
import { composeRelease, composeReleases } from '../src/compose-release.mjs';
import { loadRelease, loadReleaseInputs, selectRelease } from '../src/release.mjs';
import { resolveDeployment, runtimeEnvironment } from '../src/config.mjs';
import { applyCompose } from '../src/apply-compose.mjs';
import { renderCompose } from '../src/compose.mjs';
import { synchronize, finalize, adoptLegacy } from '../src/installation.mjs';
import { supervise } from '../src/supervisor.mjs';
import { verificationSubjects, writeVerificationReport } from '../src/verification.mjs';

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
    deepseekPlugin: { schemaVersion: 3, id: 'fixture', development: { rootVariable: 'FIXTURE_SOURCE', patch: 'dev.yml' } },
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

test('CLI help separates author, deployer, and maintainer entries', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 30000 });
  ok(result);
  for (const heading of ['插件作者：', '部署者：', '维护者：']) assert.match(result.stdout, new RegExp(heading));
  assert.match(result.stdout, /pack\s+生成完整发布目录/u);
  assert.match(result.stdout, /release-site\s+部署包 build 使用的站点发布入口/u);
  assert.match(result.stdout, /container-start\s+完整运行镜像容器入口/u);
});

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

test('repository packaging reports build and verified pack separately, skipping the check by default', t => {
  // 三个插件：并发 1 时顺序确定，正好用来验证「失败后不再派发」——中间那个失败，最后一个不该出现。
  const FIXTURE_PLUGINS = ['alpha', 'beta', 'gamma'];
  const { base, root, manifest } = fixture(t);
  const workspace = join(base, 'workspace');
  mkdirSync(join(workspace, 'plugins'), { recursive: true });
  json(join(workspace, 'package.json'), { private: true, packageManager: 'pnpm@11.19.0' });
  writeFileSync(join(workspace, 'pnpm-workspace.yaml'), "packages:\n  - 'plugins/*'\n");
  writeFileSync(join(workspace, 'pnpm-lock.yaml'), lock + '  plugins/alpha: {}\n  plugins/beta: {}\n  plugins/gamma: {}\n');
  for (const id of FIXTURE_PLUGINS) {
    const pluginRoot = join(workspace, 'plugins', id);
    mkdirSync(pluginRoot);
    for (const file of readdirSync(root)) copyFileSync(join(root, file), join(pluginRoot, file));
    json(join(pluginRoot, 'package.json'), { ...manifest, name: id, deepseekPlugin: { schemaVersion: 3, id } });
    writeFileSync(join(pluginRoot, 'cordis.patch.yml'), `- insert:\n    - id: ${id}\n      name: ${id}\n`);
  }
  const script = fileURLToPath(new URL('../../../scripts/package-plugins.mjs', import.meta.url));
  // 每轮都是一次完整打包（安装 + 构建 + 打包）：测试文件之间并行跑，机器忙时 60s 会被打满，
  // 超时会被误判成打包失败，所以留出两倍余量。
  const pack = (output, ...flags) => spawnSync(process.execPath, [script, '--root', workspace, '--plugins', 'all', '--output', output, ...flags], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, DSH_BUILD_PROGRESS: '1' },
  });
  const events = result => result.stdout.split(/\r?\n/).filter(line => line.startsWith('DSH_BUILD_PROGRESS ')).map(line => {
    const event = JSON.parse(line.slice('DSH_BUILD_PROGRESS '.length));
    if (['done', 'failed'].includes(event.type)) {
      assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0, 'completed steps include their measured duration');
    } else assert.equal(event.elapsedMs, undefined);
    const { elapsedMs, ...identity } = event;
    return identity;
  });
  /**
   * 把事件流折成「每个阶段各自开始、各自结束」。
   *
   * 插件是并行的，所以阶段之间的先后不再固定；能固定的是：每个阶段有自己的 `id`，
   * `start` 与 `done` 必须配对，同一个插件内部仍按构建 → 检查 → 打包的顺序。
   */
  const fold = list => {
    const open = new Map(), finished = [];
    let peak = 0;
    for (const event of list) {
      assert.equal(typeof event.id, 'string', 'each stage carries an id so overlapping stages stay distinct');
      if (event.type === 'start') {
        assert.equal(open.has(event.id), false, 'a stage starts once');
        open.set(event.id, event.label);
      } else {
        assert.equal(open.get(event.id), event.label, 'a stage finishes under its own id');
        open.delete(event.id);
        finished.push(`${event.type === 'done' ? 'done' : 'failed'} ${event.label}`);
      }
      peak = Math.max(peak, open.size);
    }
    return { open: [...open.values()], finished, peak, index: label => finished.findIndex(entry => entry.endsWith(` ${label}`)) };
  };
  const tasks = id => readFileSync(join(workspace, 'plugins', id, 'tasks'), 'utf8');

  // pack 只构建打包：进度里没有「检查插件」，fixture 的 check.mjs 也没被执行。
  const result = pack('.local/success'); ok(result);
  const skipped = fold(events(result));
  assert.deepEqual(skipped.open, []);
  assert.deepEqual([...skipped.finished].sort(), ['done 安装插件依赖', ...FIXTURE_PLUGINS.flatMap(id => [`done 构建插件 ${id}`, `done 打包插件 ${id}`])].sort());
  assert.ok(skipped.peak > 1, '多个插件的构建确实同时进行，而不是排队');
  for (const id of FIXTURE_PLUGINS) assert.ok(skipped.index(`构建插件 ${id}`) < skipped.index(`打包插件 ${id}`), `${id} 先构建后打包`);
  assert.equal(read(join(workspace, '.local/success/manifest.json')).plugins.length, FIXTURE_PLUGINS.length);
  for (const id of FIXTURE_PLUGINS) assert.equal(tasks(id), 'build\n');

  // 已移除的检查开关被明确拒绝：不静默忽略，也不会悄悄执行检查、产出目录。
  const removed = pack('.local/removed', '--verify-plugin-check');
  assert.notEqual(removed.status, 0);
  assert.match(removed.stdout + removed.stderr, /已移除/);
  assert.equal(existsSync(join(workspace, '.local/removed')), false);

  // 构建失败时不得产出成功清单：已经派发的插件跑完，还没派发的插件一步都不启动。
  // 用并发 1 让顺序确定：alpha 正常跑完，beta 的构建失败，gamma 不该出现任何阶段。
  writeFileSync(join(workspace, 'plugins/beta/build.mjs'), 'process.exitCode = 8;\n');
  const failure = pack('.local/failure', '--concurrency', '1');
  assert.notEqual(failure.status, 0);
  const failed = events(failure);
  const failureIndex = failed.findIndex(event => event.type === 'failed' && event.label === '构建插件 beta');
  assert.ok(failureIndex >= 0, '失败的那一步被如实报告');
  assert.equal(failed.some(event => event.label?.endsWith('插件 gamma')), false, '失败后不再派发新的插件');
  assert.equal(failed.some(event => event.label === '打包插件 beta'), false);
  assert.equal(existsSync(join(workspace, '.local/failure/manifest.json')), false);
});

test('explicit sources select a standalone package without a lockfile, and reject invalid declarations before scripts', t => {
  const { root, manifest } = fixture(t);
  assert.equal(sourcePlugins(root, undefined, '.')[0].id, 'fixture');
  assert.equal(sourcePlugins(root, undefined, '.')[0].defaultEnabled, undefined);
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
  await assert.rejects(() => packagePlugins(root, undefined, output, '.'), /pnpm-lock\.yaml。请在作者项目根执行 pnpm install --ignore-workspace/u);
  assert.equal(existsSync(output), false);
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  // pack 不做插件检查，也不做合规校验，所以标记里只有构建。
  const packedRun = run(root, 'pack', '--root', root, '--package', '.', '--output', '.local/release');
  ok(packedRun);
  assert.match(packedRun.stdout, /交付插件：fixture/u);
  assert.match(packedRun.stdout, /下一步：需要自检时先跑 verify-package/u);
  assert.equal(readFileSync(join(root, 'tasks'), 'utf8'), 'build\n');
  assert.equal(readFileSync(join(base, 'pnpm-lock.yaml'), 'utf8'), 'parent-lock-must-not-be-used\n');
  assert.equal(existsSync(join(base, 'node_modules')), false);
  const releasePath = join(output, 'manifest.json');
  const packed = read(releasePath);
  assert.equal(packed.schemaVersion, 2);
  assert.equal(packed.plugins.length, 1);
  assert.equal(packed.verification.builds[0].archiveSha256, packed.plugins[0].sha256);
  assert.equal(packed.verification.builds[0].nodeVersion, process.versions.node);
  assert.deepEqual(packed.verification.runs, []);
  assert.equal(Object.hasOwn(packed.plugins[0], 'directory'), false);
  assert.equal(Object.hasOwn(packed.plugins[0], 'defaultEnabled'), false);
  assert.deepEqual(packed.plugins[0].development, manifest.deepseekPlugin.development);
  ok(run(root, 'verify-package', '--root', root, '--package', '.', '--archive', join('.local/release', packed.plugins[0].archive)));
  // verify-package 只读校验，不会执行插件的 check 脚本。
  assert.equal(readFileSync(join(root, 'tasks'), 'utf8'), 'build\n');
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
  for (const action of ['deploy', 'start', 'sync', 'apply-compose']) {
    const result = run(root, action, '--root', base, '--home', 'data/home', '--artifacts', 'artifacts', '--manifest', releasePath, '--mode', 'development');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /仅支持 release/);
    assert.doesNotMatch(result.stderr, /兼容提示：未提供 --manifest/u);
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

test('legacy source deployment warns before the manifest fallback fails', t => {
  const { root } = fixture(t);
  const plugin = join(root, 'plugins', 'incomplete');
  mkdirSync(plugin, { recursive: true });
  json(join(plugin, 'package.json'), { name: 'incomplete', version: '0.0.0' });
  const result = run(root, 'deploy', '--root', root, '--home', 'data/home', '--artifacts', 'artifacts', '--plugins', 'incomplete');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /兼容提示：未提供 --manifest/u);
  assert.equal(existsSync(join(root, 'artifacts')), false);
});

test('failed builds and unsafe output selections never produce a success manifest', async t => {
  const { root, manifest } = fixture(t);
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  await assert.rejects(() => packagePlugins(root, undefined, root, '.'), /发布目录/);
  manifest.scripts.build = 'node -e "process.exit(1)"'; json(join(root, 'package.json'), manifest);
  const output = join(root, '.local/failed');
  await assert.rejects(() => packagePlugins(root, undefined, output, '.'), /失败/);
  assert.equal(existsSync(join(output, 'manifest.json')), false);
  assert.deepEqual(readdirSync(output), []);
  // 检查脚本失败不再影响 pack：它只由独立的 check 命令执行，那里会如实报错。
  manifest.scripts.build = 'node build.mjs';
  manifest.scripts.check = 'node -e "process.exit(7)"'; json(join(root, 'package.json'), manifest);
  const packed = await packagePlugins(root, undefined, join(root, '.local/passing'), '.');
  assert.equal(packed.plugins.length, 1);
  assert.notEqual(run(root, 'check', '--root', root, '--package', '.').status, 0);
});

test('compose releases from archives, reject conflicts before output, retain source independence', async t => {
  const { base, root, manifest } = fixture(t);
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  const first = join(base, 'first'); await packagePlugins(root, undefined, first, '.');
  manifest.name = 'second-fixture'; manifest.deepseekPlugin.id = 'second';
  manifest.deepseekPlugin.development.rootVariable = 'SECOND_SOURCE';
  json(join(root, 'package.json'), manifest);
  const second = join(base, 'second'); await packagePlugins(root, undefined, second, '.');
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
  const primary = release.plugins[0];
  const report = join(base, 'verification.json');
  writeVerificationReport(report, [{ pluginId: primary.id, archiveSha256: primary.sha256, subjects: verificationSubjects(release.plugins),
    scenarioId: 'external-pair', suiteId: 'external-fixture', suiteRevision: 'a'.repeat(64), finishedAt: '2026-09-07T00:00:00Z',
    outcome: 'passed', scope: 'archive-consumption', source: 'runner', host: { kind: 'unknown' },
    platform: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node } }]);
  const annotatedOutput = join(base, 'annotated');
  const annotatedResult = run(base, 'compose-release', '--root', base, '--output', annotatedOutput, '--manifest', join(output, 'manifest.json'), '--verification-report', report);
  assert.equal(annotatedResult.status, 0, annotatedResult.stderr);
  const annotated = loadRelease(join(annotatedOutput, 'manifest.json'));
  assert.equal(annotated.verification.runs[0].subjects.length, 2);
  assert.deepEqual(readFileSync(annotated.plugins[0].archivePath), readFileSync(primary.archivePath));
  assert.equal(selectRelease(annotated, primary.id).verification.runs[0].subjects.length, 2);
  const invalidReport = read(report); invalidReport.runs[0].archiveSha256 = '0'.repeat(64); json(report, invalidReport);
  const rejected = join(base, 'rejected-evidence');
  assert.throws(() => composeRelease([path1, path2], rejected, undefined, [report]), /subject|归属/);
  assert.equal(existsSync(rejected), false);
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

test('the cache manifest is readable by the deployment path that consumes it in the container', async t => {
  const { base, root } = fixture(t);
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  const output = join(base, 'release'); await packagePlugins(root, undefined, output, '.');
  const released = loadReleaseInputs(join(output, 'manifest.json'));
  const cacheRoot = join(base, 'cache');
  const composed = composeReleases([released], join(base, 'composed'), undefined, [], { cacheRoot });
  assert.equal(typeof composed.cacheManifest, 'string');
  // 容器内 PLUGIN_MANIFEST_FILE 指向这份缓存清单：部署读路径必须能直接解析，并拿到完整安装契约。
  const consumed = loadReleaseInputs(join(cacheRoot, composed.cacheManifest));
  assert.deepEqual(consumed.plugins.map(plugin => plugin.id), released.plugins.map(plugin => plugin.id));
  for (const plugin of consumed.plugins) {
    assert.ok(plugin.verifyFiles.length > 0, `${plugin.id} 的 verifyFiles 不能丢`);
    assert.equal(existsSync(plugin.archivePath), true, `${plugin.id} 的归档相对缓存根可达`);
    assert.equal(typeof plugin.package, 'string');
    assert.equal(typeof plugin.version, 'string');
  }
});
