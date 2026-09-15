/** 公开构建视图必须只含公开输入，并带一份可安装的匹配锁文件。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPublicBuildView, lockImporters, parseWorkspacePackages, publicInputFiles, PUBLIC_INPUT_RECORD, workspaceGlobs, writePublicInputRecord } from '../src/public-build-view.mjs';
import { packagePlugins } from '../src/package-plugins.mjs';

const repository = fileURLToPath(new URL('../../..', import.meta.url));

function build(t) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-build-view-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const output = join(base, 'view');
  return { base, output, result: createPublicBuildView({ root: repository, output }) };
}

/** 写一份与当前交付物一致的交付记录（发行打包与私有集成交付用的是同一实现）。 */
const writeRecord = (directory, version) => writePublicInputRecord(directory, { version });

test('视图收录公开材料，不含 external 与运行产物', t => {
  const f = build(t);
  for (const entry of ['packages', 'plugins/builtin', 'scripts', 'deploy', 'doc', 'package.json', 'pnpm-lock.yaml']) {
    assert.ok(existsSync(join(f.output, entry)), `缺少 ${entry}`);
  }
  // 公开边界按目录与文件清单确定，不按扩展名裁剪：无扩展名的交付材料与 example 源码索引读取的
  // 根级文件都必须在视图里（设计 2.8、7.4）。
  for (const entry of ['LICENSE', 'NOTICE', 'env.conf', 'test-report.sh', 'packages/plugin-manager/LICENSE', 'plugins/builtin/dsh-auth/LICENSE']) {
    assert.ok(existsSync(join(f.output, entry)), `缺少 ${entry}`);
  }
  assert.ok(!existsSync(join(f.output, 'plugins/external')), '视图不得包含 external 源码');
  assert.ok(!existsSync(join(f.output, 'node_modules')), '视图不得包含已安装依赖');
  assert.ok(!existsSync(join(f.output, 'plugins/builtin/dsh-example/dist')), '视图不得包含构建产物');
  assert.ok(!existsSync(join(f.output, '.local')), '视图不得包含运行数据');
});

test('视图的 workspace 定义与锁逐字节来自那一份公开输入', t => {
  const f = build(t);
  // 视图根文件必须逐字节等于本次使用的公开输入：有交付目录（tools/builtin-build）时用它，
  // 公共检出退回根文件。私有集成库没有交付材料时根本构造不出来，由下一条用例覆盖。
  const delivered = join(repository, 'tools', 'builtin-build');
  const expected = existsSync(join(delivered, 'package.json')) ? delivered : resolve(repository);
  assert.equal(f.result.inputs, expected);
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    assert.deepEqual(readFileSync(join(f.output, name)), readFileSync(join(expected, name)), name);
  }
  const workspace = readFileSync(join(f.output, 'pnpm-workspace.yaml'), 'utf8');
  assert.ok(workspaceGlobs(workspace).includes('plugins/builtin/*'), 'workspace 必须指向内置源码');
});

test('视图锁覆盖视图内全部项目，且不含 external importer', t => {
  const f = build(t);
  const lock = readFileSync(join(f.output, 'pnpm-lock.yaml'), 'utf8');
  const importers = lockImporters(lock);
  for (const key of ['.', 'packages/plugin-kit', 'packages/plugin-manager', 'plugins/builtin/dsh-auth', 'plugins/builtin/dsh-example']) {
    assert.ok(importers.has(key), `锁缺少 importer：${key}`);
  }
  assert.ok(![...importers].some(key => key.startsWith('plugins/external/')), '锁不得含 external importer');
  assert.ok(![...importers].some(key => key.startsWith('plugins/dsh-')), '锁不得含旧扁平 importer');
  // 视图里实际存在的项目必须都在锁里，否则 --frozen-lockfile 会在安装阶段才失败。
  for (const importer of f.result.importers) assert.ok(importers.has(importer), `锁缺少视图项目：${importer}`);
});

test('锁与 workspace 解析按段落取值，不被相邻段落干扰', () => {
  const lock = ['lockfileVersion: 9.0', 'importers:', '  .:', '    dependencies:', '      a: 1.0.0', '  plugins/external/x:', '    dependencies:', '      b: 1.0.0', 'packages:', '  a@1.0.0:', '    resolution: {integrity: sha512-x}'].join('\n');
  assert.deepEqual([...lockImporters(lock)], ['.', 'plugins/external/x']);
  const workspace = ['packages:', "  - 'packages/*'", "  - 'plugins/builtin/*'", 'nodeLinker: hoisted', 'minimumReleaseAgeExclude:', "  - '@deepseek-ai/dsh-session@0.1.5-alpha.2'"].join('\n');
  assert.deepEqual(workspaceGlobs(workspace), ['packages/*', 'plugins/builtin/*']);
  // 注释、引号内含 # 与 CRLF 都要正确处理；看不懂的结构进 unknown，由调用方拒绝。
  const commented = ['# 顶部注释', 'packages:', "  - 'packages/*' # 公开包", '  - plugins/builtin/*', "  - 'weird#name'", '  - ../../outside/*  # 越界', '  not-a-list-item', 'packages: ["inline"]'].join('\r\n');
  const parsed = parseWorkspacePackages(commented);
  assert.deepEqual(parsed.globs, ['packages/*', 'plugins/builtin/*', 'weird#name', '../../outside/*']);
  assert.deepEqual(parsed.unknown, ['  not-a-list-item', 'packages: ["inline"]']);
});

test('重复构造同一视图得到相同的 importer 集合', t => {
  const f = build(t);
  const again = createPublicBuildView({ root: repository, output: f.output });
  assert.deepEqual(again.importers, f.result.importers);
  writeFileSync(join(f.output, 'probe'), 'ok');
  assert.ok(readdirSync(f.output).includes('packages'));
});

test('安装与构建可以只发生在视图内：源码树没有依赖也不影响打包', async t => {
  const f = build(t);
  // 另造一棵「源码树」：只有插件源码与锁文件，没有 node_modules、也没有 packages/*。
  const source = join(f.base, 'source');
  cpSync(join(repository, 'plugins/builtin'), join(source, 'plugins/builtin'), { recursive: true });
  cpSync(join(repository, 'pnpm-lock.yaml'), join(source, 'pnpm-lock.yaml'));
  const archive = join(f.base, 'release');
  await packagePlugins(source, 'auth', archive, undefined, undefined, { concurrency: 1, workspaceRoot: f.output });
  assert.ok(readdirSync(archive).some(name => /^auth-.*\.tgz$/u.test(name)), '应在视图内产出 auth 归档');
  assert.ok(existsSync(join(f.output, 'node_modules')), '依赖必须装在视图内');
  assert.ok(!existsSync(join(source, 'node_modules')), '源码树不得被安装依赖');
});

test('交付的公开构建输入优先：元数据逐字节使用，不按现场生成或裁剪', t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-build-inputs-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  // 发行包树：公开材料 + tools/builtin-build 元数据；根锁故意带上 external importer 以示区别。
  const root = join(base, 'release');
  cpSync(join(repository, 'packages'), join(root, 'packages'), { recursive: true });
  cpSync(join(repository, 'plugins/builtin'), join(root, 'plugins/builtin'), { recursive: true });
  const manifest = readFileSync(join(repository, 'package.json'));
  writeFileSync(join(root, 'package.json'), manifest);
  const version = JSON.parse(manifest).version;
  writeFileSync(join(root, 'packages/plugin-manager/package.json'), `${JSON.stringify({ version }, null, 2)}\n`);
  const shippedLock = ["lockfileVersion: '9.0'", 'settings:', '  autoInstallPeers: true', 'importers:', '  .:', '    dependencies: {}', '  packages/plugin-kit:', '    dependencies: {}', '  packages/plugin-manager:', '    dependencies: {}', '  plugins/builtin/dsh-auth:', '    dependencies: {}', '  plugins/builtin/dsh-example:', '    dependencies: {}', ''].join('\n');
  const builtinBuild = join(root, 'tools/builtin-build');
  mkdirSync(builtinBuild, { recursive: true });
  writeFileSync(join(builtinBuild, 'package.json'), manifest);
  writeFileSync(join(builtinBuild, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n");
  writeFileSync(join(builtinBuild, 'pnpm-lock.yaml'), shippedLock);
  writeRecord(builtinBuild, version);
  // 根锁故意带上 external importer 与更少的项目：视图只能按交付输入构造，不看现场。
  writeFileSync(join(root, 'pnpm-lock.yaml'), `${shippedLock}  plugins/external/x: {}\n`);
  const output = join(base, 'view');
  const result = createPublicBuildView({ root, output });
  assert.equal(result.inputs, builtinBuild);
  for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    assert.deepEqual(readFileSync(join(output, name)), readFileSync(join(builtinBuild, name)), `${name} 必须逐字节来自交付输入`);
  }
  // 随包输入不完整时直接失败，不退回现场生成。
  rmSync(join(builtinBuild, 'pnpm-lock.yaml'));
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view2') }), /公开构建输入不完整/);
});

test('含 plugins/external 的私有树缺少交付材料时拒绝，不再现场裁剪', t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-build-private-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'private');
  mkdirSync(join(root, 'plugins/external/one'), { recursive: true });
  mkdirSync(join(root, 'plugins/builtin/two'), { recursive: true });
  writeFileSync(join(root, 'plugins/builtin/two/package.json'), `${JSON.stringify({ name: 'fixture-two', version: '0.1.0' }, null, 2)}\n`);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ private: true, version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  // 现场有完整私有 workspace，也不能拿来构造视图：必须先交付公开构建元数据。
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n  - 'plugins/external/*'\n  - 'plugins/external/*/agents/*'\n");
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /含 plugins\/external，不能按现场元数据构造构建视图/);
  assert.equal(existsSync(join(base, 'view')), false, '拒绝时不得留下半个视图');
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view'), inputs: join(root, 'missing') }), /公开构建输入不存在/);
  // 交付了元数据就走交付路径：含私有嵌套包的 workspace 定义会被一致性核对拦住。
  const delivered = join(root, 'tools/builtin-build');
  mkdirSync(delivered, { recursive: true });
  writeFileSync(join(delivered, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  mkdirSync(join(root, 'packages/plugin-manager'), { recursive: true });
  writeFileSync(join(root, 'packages/plugin-manager/package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), readFileSync(join(root, 'pnpm-workspace.yaml')));
  writeFileSync(join(delivered, 'pnpm-lock.yaml'), readFileSync(join(root, 'pnpm-lock.yaml')));
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /含非公开范围：plugins\/external\/\*\/agents\/\*/);
  // 带注释的私有路径不能借注释躲过校验（正则不认行尾注释就会静默跳过整行）。
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n  - '../../../../plugins/external/*' # private source\n");
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /含非公开范围：\.\.\/\.\.\/\.\.\/\.\.\/plugins\/external\/\*/);
  // 行内数组属于无法识别的结构：明确拒绝，不当作「没有项目」。
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "packages: ['packages/*', 'plugins/builtin/*']\n");
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /含无法识别的配置行/);
  // 合法范围加行尾注释要能解析出来：继续走到锁检查（说明这一行没有被跳过）。交付记录必须与当前
  // 交付物一致，否则会先被摘要校验拦住——那一条由下一个用例专门覆盖。
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*' # 公开范围\n");
  writeFileSync(join(delivered, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/plugin-manager: {}\n");
  writeRecord(delivered, '0.17.0');
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /锁缺少视图项目：plugins\/builtin\/two/);
  // 版本不一致（材料来自另一份框架版本）同样拒绝。
  writeFileSync(join(delivered, 'package.json'), `${JSON.stringify({ version: '0.16.0' }, null, 2)}\n`);
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /不是同一份框架版本/);
});

test('公开范围判定不能被 BOM、引号键或显式键旁路', t => {
  // 解析层：带 BOM 的合法定义必须照常读出；读不出 `packages` 段的写法给出空集合，由调用方拒绝。
  assert.deepEqual(workspaceGlobs("\uFEFFpackages:\r\n  - 'packages/*'\r\n  - 'plugins/builtin/*'\r\n"), ['packages/*', 'plugins/builtin/*']);
  for (const key of ["'packages':", '"packages":', '? packages']) {
    assert.deepEqual(workspaceGlobs(`${key}\n  - 'packages/*'\n  - 'plugins/builtin/*'\n`), [], key);
  }
  // 端到端：一个 BOM 字节不能让非公开范围蒙混过关，空集合也不能让白名单判定恒真。
  const base = mkdtempSync(join(tmpdir(), 'dsh-build-workspace-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'private');
  mkdirSync(join(root, 'plugins/builtin/two'), { recursive: true });
  mkdirSync(join(root, 'packages/plugin-manager'), { recursive: true });
  writeFileSync(join(root, 'packages/plugin-manager/package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  const delivered = join(root, 'tools/builtin-build');
  mkdirSync(delivered, { recursive: true });
  writeFileSync(join(delivered, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(delivered, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/plugin-manager: {}\n  plugins/builtin/two: {}\n");
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "\uFEFFpackages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n  - 'examples/*'\n");
  writeRecord(delivered, '0.17.0');
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /含非公开范围：examples\/\*/);
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "'packages':\n  - 'packages/*'\n  - 'plugins/builtin/*'\n");
  writeRecord(delivered, '0.17.0');
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /缺少 packages\/\*/);
});

test('交付输入含私有 workspace 的锁时必须拒绝', t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-build-private-lock-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'private');
  mkdirSync(join(root, 'plugins/builtin/two'), { recursive: true });
  mkdirSync(join(root, 'packages/plugin-manager'), { recursive: true });
  writeFileSync(join(root, 'packages/plugin-manager/package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  const delivered = join(root, 'tools/builtin-build');
  mkdirSync(delivered, { recursive: true });
  writeFileSync(join(delivered, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n");
  writeFileSync(join(delivered, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/plugin-manager: {}\n  plugins/builtin/two: {}\n  plugins/external/one: {}\n");
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /锁包含私有 workspace 项目：plugins\/external\/one/);
});

test('私有集成检出的交付物被改过时，站点视图拒绝生成', t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-build-delivered-record-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'private');
  mkdirSync(join(root, 'plugins/external/one'), { recursive: true });
  mkdirSync(join(root, 'plugins/builtin/two'), { recursive: true });
  writeFileSync(join(root, 'plugins/builtin/two/package.json'), `${JSON.stringify({ name: 'fixture-two', version: '0.1.0' }, null, 2)}\n`);
  mkdirSync(join(root, 'packages/plugin-manager'), { recursive: true });
  writeFileSync(join(root, 'packages/plugin-manager/package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  const delivered = join(root, 'tools/builtin-build');
  mkdirSync(delivered, { recursive: true });
  const lock = "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n  packages/plugin-manager:\n    dependencies: {}\n  plugins/builtin/two:\n    dependencies: {}\n";
  writeFileSync(join(delivered, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n");
  writeFileSync(join(delivered, 'pnpm-lock.yaml'), lock);
  // 交付记录（交付脚本写的同一格式）：三个文件的 LF 摘要。
  writeRecord(delivered, '0.17.0');
  // 记录一致 → 视图正常生成。
  const view = join(base, 'view');
  assert.doesNotThrow(() => createPublicBuildView({ root, output: view }));
  assert.deepEqual(readFileSync(join(view, 'pnpm-workspace.yaml')), readFileSync(join(delivered, 'pnpm-workspace.yaml')));
  // 只改交付物、保留旧记录：站点侧必须拒绝，而不是照旧生成视图（门禁之外的这条路径也要闭环）。
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*' # 手工改过\n");
  assert.throws(() => createPublicBuildView({ root, output: view }), /交付的公开构建输入与记录不一致：pnpm-workspace\.yaml/);
  // 删掉 plugins/external 不能成为跳过校验的路径：交付目录里带记录就一律核对。
  rmSync(join(root, 'plugins/external'), { recursive: true, force: true });
  assert.throws(() => createPublicBuildView({ root, output: view }), /交付的公开构建输入与记录不一致：pnpm-workspace\.yaml/);
  // 记录本身被改坏（换行规则/版本）同样拒绝。
  mkdirSync(join(root, 'plugins/external/one'), { recursive: true });
  writeRecord(delivered, '0.16.0');
  assert.throws(() => createPublicBuildView({ root, output: view }), /版本（0\.16\.0）与框架版本（0\.17\.0）不一致/);
  // 删掉记录同样是跳不过校验的路径：判据是「用了独立交付目录」，不是「恰好还有 external 或记录」。
  writeRecord(delivered, '0.17.0');
  writeFileSync(join(delivered, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*' # 手工改过\n");
  rmSync(join(root, 'plugins/external'), { recursive: true, force: true });
  rmSync(join(delivered, PUBLIC_INPUT_RECORD));
  assert.throws(() => createPublicBuildView({ root, output: view }), /缺少交付记录/);
  mkdirSync(join(root, 'plugins/external/one'), { recursive: true });
  rmSync(delivered, { recursive: true, force: true });
  assert.throws(() => createPublicBuildView({ root, output: view }), /不能按现场元数据构造构建视图/);
});

test('交付目录或交付文件是符号链接时拒绝', t => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-build-symlink-'));
  t.after(() => { assert.equal(dirname(base), resolve(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'private');
  mkdirSync(join(root, 'plugins/external/one'), { recursive: true });
  mkdirSync(join(root, 'packages/plugin-manager'), { recursive: true });
  writeFileSync(join(root, 'packages/plugin-manager/package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  const real = join(base, 'real-inputs');
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, 'package.json'), `${JSON.stringify({ version: '0.17.0' }, null, 2)}\n`);
  writeFileSync(join(real, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n");
  writeFileSync(join(real, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies: {}\n  packages/plugin-manager:\n    dependencies: {}\n");
  writeRecord(real, '0.17.0');
  const link = join(root, 'tools/builtin-build');
  mkdirSync(join(root, 'tools'), { recursive: true });
  try { symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('link creation unavailable'); throw error; }
  assert.throws(() => createPublicBuildView({ root, output: join(base, 'view') }), /交付目录不能是符号链接|不能按现场元数据构造构建视图/);
});

// 设计 7.4 第 4 项：没有任何插件声明 buildInputs 时，完整公开视图仍要能构建内置插件、
// 生成完整离线知识与源码索引，且不含 external/私有材料。
test('没有插件声明构建输入时，公开视图仍能产出完整离线知识与源码索引', t => {
  const f = build(t);
  for (const entry of readdirSync(join(f.output, 'plugins/builtin'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(f.output, 'plugins/builtin', entry.name, 'package.json'), 'utf8'));
    assert.equal(manifest.deepseekPlugin.buildInputs, undefined, `${entry.name} 不得再声明 deepseekPlugin.buildInputs`);
  }
  const plugin = join(f.output, 'plugins/builtin/dsh-example');
  for (const knowledge of ['knowledge/guide.md', 'knowledge/prompts.md']) assert.ok(existsSync(join(plugin, knowledge)), `视图缺少离线知识正文：${knowledge}`);
  execFileSync(process.execPath, [join(plugin, 'scripts/build-reference.mjs'), '--root', f.output], { windowsHide: true });
  const index = JSON.parse(readFileSync(join(plugin, 'dist/framework-reference.json'), 'utf8'));
  const paths = new Set(index.files.map(file => file.path));
  for (const path of ['doc/plugin-development.md', 'deploy/README.md', 'scripts/version.mjs', 'packages/plugin-manager/src/plugins.mjs', 'plugins/builtin/dsh-auth/README.md', 'plugins/builtin/dsh-example/README.md', 'env.conf', 'test-report.sh']) {
    assert.ok(paths.has(path), `源码索引缺少公开材料：${path}`);
  }
  assert.ok(!index.files.some(file => file.path.startsWith('plugins/external/')), '源码索引不得包含 external 源码');
  assert.ok(!index.files.some(file => file.path.split('/').includes('.local')), '源码索引不得包含运行数据');
});
