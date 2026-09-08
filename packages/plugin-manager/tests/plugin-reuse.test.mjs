/** Real Git histories and tarballs exercise selective deployment's provenance boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSelectiveInstallSafe, preparePluginReuse } from '../../../deploy/scripts/plugin-reuse.mjs';
import { readPlugin } from '../src/plugins.mjs';
import { hash, tarCommand } from '../src/state.mjs';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const digest = path => hash(readFileSync(path));
const environment = { nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch, packageManager: 'pnpm@11.19.0', targetArchitecture: 'amd64', hostImage: null };
function fixture(t, dependencies = {}, hostImage = null, prepareInput = () => {}) {
  const buildEnvironment = { ...environment, hostImage };
  const root = mkdtempSync(join(tmpdir(), 'dsh-reuse-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const gitAt = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = args => gitAt(root, args);
  const initialize = directory => {
    mkdirSync(directory, { recursive: true }); gitAt(directory, ['init']);
    gitAt(directory, ['config', 'user.name', 'Fixture']); gitAt(directory, ['config', 'user.email', 'fixture@example.invalid']);
  };
  initialize(root);
  writeFileSync(join(root, '.gitignore'), '.local/\n');
  save(join(root, 'package.json'), { name: 'fixture-root', private: true, packageManager: environment.packageManager });
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  for (const id of ['a', 'b', 'c', 'd']) {
    const directory = join(root, 'plugins', id); mkdirSync(join(directory, 'dist'), { recursive: true });
    save(join(directory, 'package.json'), { name: `fixture-${id}`, version: '0.1.0', type: 'module', main: './dist/index.mjs', files: ['dist', 'cordis.patch.yml', 'README.md'], scripts: { build: 'node build.mjs', check: 'node --check dist/index.mjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, deepseekPlugin: { schemaVersion: 3, id }, ...(dependencies[id] ? { devDependencies: dependencies[id] } : {}) });
    writeFileSync(join(directory, 'README.md'), `Fixture ${id}\n`);
    writeFileSync(join(directory, 'dist/index.mjs'), 'export function apply() {}\n');
    writeFileSync(join(directory, 'build.mjs'), 'console.log("fixture");\n');
    writeFileSync(join(directory, 'cordis.patch.yml'), `- insert:\n    - id: fixture-${id}\n      name: fixture-${id}\n`);
  }
  prepareInput(root);
  const host = join(root, 'deepseek-harness'); initialize(host);
  writeFileSync(join(host, 'host.txt'), 'fixture\n'); gitAt(host, ['add', '.']); gitAt(host, ['commit', '-qm', '宿主基线']);
  const hostCommit = gitAt(host, ['rev-parse', 'HEAD']);
  const commit = () => { git(['add', '.']); git(['commit', '-qm', '更新测试源码']); return git(['rev-parse', 'HEAD']); };
  let revision = commit(), prior, number = 0;
  const site = { plugins: ['a', 'b', 'c', 'd'], artifacts: '.local/runtime', composeProject: 'fixture', hostImage };
  function publish(rebuilt = site.plugins, reuse) {
    const operation = join(root, '.local/artifacts', `release-${++number}`), output = join(operation, 'plugins');
    mkdirSync(output, { recursive: true });
    const plugins = [], pluginBuilds = [], builds = [];
    for (const id of site.plugins) {
      if (!rebuilt.includes(id)) {
        const plugin = reuse.release.plugins.find(p => p.id === id);
        copyFileSync(plugin.archivePath, join(output, plugin.archive));
        const { archivePath, ...saved } = plugin; plugins.push(saved);
        pluginBuilds.push(reuse.builtFrom.find(p => p.id === id));
        builds.push(reuse.release.verification.builds.find(p => p.pluginId === id));
        continue;
      }
      const source = join(root, 'plugins', id), staging = join(operation, 'staging', id);
      mkdirSync(staging, { recursive: true }); cpSync(source, join(staging, 'package'), { recursive: true });
      const archive = `${id}.tgz`, archivePath = join(output, archive);
      execFileSync(tarCommand, ['-czf', archivePath, '-C', staging, 'package'], { windowsHide: true });
      const sha256 = digest(archivePath);
      plugins.push({ ...readPlugin(source), directory: `plugins/${id}`, archive, sha256 });
      pluginBuilds.push({ id, sha256, builtFromRevision: revision });
      builds.push({ pluginId: id, archiveSha256: sha256, nodeVersion: environment.nodeVersion, packageManagerVersion: '11.19.0', lockSha256: digest(join(root, 'pnpm-lock.yaml')) });
    }
    const manifest = join(output, 'manifest.json'); save(manifest, { schemaVersion: 1, plugins, verification: { schemaVersion: 1, builds, runs: [] } });
    const image = `sha256:${'a'.repeat(64)}`;
    const previous = { ...site, containerImage: image, manifest: relative(root, manifest).replaceAll('\\', '/') };
    const candidatePath = join(operation, 'deployment.json'); save(candidatePath, previous);
    const active = { project: site.composeProject, path: join(root, site.artifacts, `compose-${number}.json`) };
    save(active.path, { services: { dsh: { image, environment: { PLUGIN_MANIFEST_FILE: '/opt/plugin-packages/manifest.json' }, volumes: [{ type: 'bind', source: output, target: '/opt/plugin-packages', read_only: true }] } } });
    const recordPath = join(operation, 'result.json');
    save(recordPath, { schemaVersion: 2, operation, revision, hostCommit, hostSourceClean: true, hostSourceCommit: hostCommit, status: 'ready', manifest, manifestHash: digest(manifest), candidatePath, candidateHash: digest(candidatePath), image, buildEnvironment, pluginBuilds });
    prior = { previous, active, recordPath, manifest };
    return prior;
  }
  publish();
  return { root, host, site, git, hostCommit, publish, get prior() { return prior; }, get revision() { return revision; },
    change(path, text) { writeFileSync(join(root, path), text); revision = commit(); return revision; },
    prepare(rebuilt = ['c'], overrides = {}) { return preparePluginReuse({ root, ...prior, site, revision, hostCommit, buildEnvironment, rebuilt, git, ...overrides }); },
    editRecord(fn) { const record = read(prior.recordPath); fn(record); save(prior.recordPath, record); },
  };
}

test('real archives retain their original provenance through C then B then C updates', t => {
  const f = fixture(t), baseline = f.revision;
  const initial = read(f.prior.manifest), aBytes = readFileSync(join(dirname(f.prior.manifest), 'a.tgz'));
  const cRevision = f.change('plugins/c/dist/index.mjs', 'export function apply() { return 1; }\n');
  const first = f.prepare();
  assert.deepEqual(first.release.plugins.map(p => p.id), ['a', 'b', 'd']);
  assert.ok(first.builtFrom.every(p => p.builtFromRevision === baseline));
  assert.deepEqual(first.release.verification.builds.map(p => p.pluginId), ['a', 'b', 'd']);
  assert.equal(first.previousRelease.plugins.length, 4);
  f.publish(['c'], first);
  f.change('plugins/b/dist/index.mjs', 'export function apply() { return 2; }\n');
  const second = f.prepare(['b']);
  assert.equal(second.builtFrom.find(p => p.id === 'c').builtFromRevision, cRevision);
  f.publish(['b'], second);
  f.change('plugins/c/dist/index.mjs', 'export function apply() { return 3; }\n');
  const third = f.prepare(['c']);
  assert.equal(third.builtFrom.find(p => p.id === 'a').builtFromRevision, baseline);
  assert.equal(third.release.plugins.find(p => p.id === 'a').sha256, initial.plugins[0].sha256);
  assert.deepEqual(readFileSync(third.release.plugins.find(p => p.id === 'a').archivePath), aBytes);
});

test('a first deployment selecting every plugin needs no reuse source but validates selection', t => {
  const f = fixture(t);
  const result = f.prepare(f.site.plugins, { previous: null, active: null });
  assert.deepEqual(result.release, { schemaVersion: 2, plugins: [] });
  assert.throws(() => f.prepare(['unknown']), /选集/);
});

test('missing active inputs, malformed origins and damaged archives cannot become a new baseline', t => {
  const f = fixture(t);
  assert.throws(() => f.prepare(['c'], { previous: null, active: null }), /活动部署/);
  const original = read(f.prior.recordPath);
  for (const change of [r => { r.status = 'build-failed'; }, r => { delete r.pluginBuilds; }, r => { r.pluginBuilds[0].sha256 = '0'.repeat(64); }, r => { r.manifestHash = '0'.repeat(64); }, r => { r.candidateHash = '0'.repeat(64); }, r => { delete r.hostSourceClean; }, r => { delete r.buildEnvironment; }]) {
    const record = structuredClone(original); change(record); save(f.prior.recordPath, record);
    assert.throws(() => f.prepare(), /不能复用/);
  }
  save(f.prior.recordPath, original);
  writeFileSync(join(dirname(f.prior.manifest), 'a.tgz'), 'damaged');
  assert.throws(() => f.prepare(), /摘要/);
});

test('environment, host changes and unrelated tracked inputs require full rebuild', t => {
  const f = fixture(t);
  assert.throws(() => f.prepare(['c'], { buildEnvironment: { ...environment, nodeVersion: '99.0.0' } }), /构建环境/);
  writeFileSync(join(f.host, 'host.txt'), 'dirty\n');
  assert.throws(() => f.prepare(), /宿主源码/);
  writeFileSync(join(f.host, 'host.txt'), 'fixture\n');
  f.change('pnpm-lock.yaml', 'lockfileVersion: changed\n');
  assert.throws(() => f.prepare(), /选集之外/);
});

test('an unchanged immutable host image permits reuse without an unused source checkout', t => {
  const image = `registry.example.invalid/dsh@sha256:${'e'.repeat(64)}`;
  const f = fixture(t, {}, image);
  renameSync(f.host, join(f.root, '.local/unused-host'));
  f.editRecord(record => { record.hostSourceClean = false; delete record.hostSourceCommit; });
  const result = f.prepare(['c'], { hostCommit: undefined });
  assert.equal(result.hostCommit, f.hostCommit);
  assert.deepEqual(result.release.plugins.map(p => p.id), ['a', 'b', 'd']);
  const changedImage = `registry.example.invalid/dsh@sha256:${'f'.repeat(64)}`;
  assert.throws(() => f.prepare(['c'], { hostCommit: undefined, site: { ...f.site, hostImage: changedImage }, buildEnvironment: { ...environment, hostImage: changedImage } }), /构建环境/);
  assert.throws(() => f.prepare(['c'], { hostCommit: undefined, site: { ...f.site, hostImage: changedImage } }), /不可变引用/);
  assert.throws(() => f.prepare(['c'], { hostCommit: undefined, site: { ...f.site, hostImage: null } }), /源码及宿主身份/);
  f.editRecord(record => { delete record.hostCommit; });
  assert.throws(() => f.prepare(['c'], { hostCommit: undefined }), /宿主镜像身份/);
});

test('mutable or malformed explicit host references do not establish an image identity', t => {
  const f = fixture(t, {}, 'registry.example.invalid/dsh:latest');
  assert.throws(() => f.prepare(), /不可变引用/);
  for (const value of ['', 'sha256:invalid', `registry.example.invalid/dsh@sha256:${'g'.repeat(64)}`]) {
    f.site.hostImage = value;
    f.editRecord(record => { record.buildEnvironment.hostImage = value; });
    assert.throws(() => f.prepare(['c'], { buildEnvironment: { ...environment, hostImage: value } }), /不可变引用/);
  }
});

test('changed transitive plugin build inputs require their consumers to be rebuilt', t => {
  const f = fixture(t, { a: { 'fixture-b': 'workspace:*' }, b: { 'fixture-c': 'workspace:*' } });
  f.change('plugins/c/dist/index.mjs', 'export function apply() { return 4; }\n');
  assert.throws(() => f.prepare(), /a.*依赖.*c/);
  const result = f.prepare(['a', 'b', 'c']);
  assert.deepEqual(result.release.plugins.map(p => p.id), ['d']);
});

test('a renamed dependency retains its old name for impact checks', t => {
  const f = fixture(t, { a: { 'fixture-c': '*' } });
  const pkg = read(join(f.root, 'plugins/c/package.json')); pkg.name = 'renamed-fixture-c';
  f.change('plugins/c/package.json', JSON.stringify(pkg));
  assert.throws(() => f.prepare(), /a.*依赖.*c/);
});

test('cross-directory renames and mismatched active mounts cannot bypass reuse guards', t => {
  const f = fixture(t), compose = read(f.prior.active.path);
  compose.services.dsh.volumes[0].source = join(f.root, '.local/wrong-release'); save(f.prior.active.path, compose);
  assert.throws(() => f.prepare(), /清单挂载/);
  compose.services.dsh.volumes[0].source = dirname(f.prior.manifest); save(f.prior.active.path, compose);
  renameSync(join(f.root, 'plugins/a/dist/index.mjs'), join(f.root, 'plugins/c/moved.mjs'));
  f.change('plugins/c/README.md', 'Moved source\n');
  assert.throws(() => f.prepare(), /选集之外.*plugins\/a/);
});

test('file dependencies fail before archive reuse', t => {
  const f = fixture(t, { a: { 'fixture-c': 'file:../c' } });
  assert.throws(() => f.prepare(), /file:.*归档/);
});

function vendorInput(root) {
  const stage = join(root, '.local/vendor-input'), output = join(root, 'plugins/a/vendor');
  save(join(stage, 'package/package.json'), { name: 'vendor-fixture', version: '0.1.0', main: 'index.js' });
  writeFileSync(join(stage, 'package/index.js'), 'module.exports = 1;\n');
  mkdirSync(output, { recursive: true });
  execFileSync(tarCommand, ['-czf', join(output, 'fixture.tgz'), '-C', stage, 'package'], { windowsHide: true });
  copyFileSync(join(output, 'fixture.tgz'), join(output, 'fixture.tar.gz'));
}

test('unchanged tracked plugin-local vendor archives retain reusable package provenance', t => {
  const f = fixture(t, { a: { 'vendor-fixture': 'file:vendor/fixture.tgz', 'vendor-second': 'file:./vendor/fixture.tar.gz' } }, null, vendorInput);
  const result = f.prepare();
  assert.deepEqual(result.release.plugins.map(p => p.id), ['a', 'b', 'd']);
  assert.equal(result.builtFrom.find(p => p.id === 'a').builtFromRevision, f.revision);
  const archive = join(f.root, 'plugins/a/vendor/fixture.tgz'), bytes = readFileSync(archive);
  writeFileSync(archive, Buffer.concat([bytes, Buffer.from('changed')]));
  assert.throws(() => f.prepare(), /归档内容.*不一致/);
  writeFileSync(archive, bytes);
  const moved = join(f.root, '.local/missing-vendor.tgz'); renameSync(archive, moved);
  assert.throws(() => f.prepare(), /归档缺失/);
  renameSync(moved, archive);
  f.change('plugins/a/vendor/fixture.tgz', Buffer.concat([bytes, Buffer.from('committed change')]));
  assert.throws(() => f.prepare(), /重建选集之外/);
});

test('untracked and ignored vendor archives cannot be inherited from a successful record', t => {
  const f = fixture(t, { a: { 'vendor-fixture': 'file:vendor/fixture.tgz' } });
  vendorInput(f.root);
  assert.throws(() => f.prepare(), /已跟踪普通文件/);
  writeFileSync(join(f.root, '.git/info/exclude'), 'plugins/a/vendor/\n');
  assert.throws(() => f.prepare(), /已跟踪普通文件/);
});

test('file dependencies still reject external paths, directories and link dependencies', t => {
  const f = fixture(t, { a: { 'vendor-fixture': 'file:vendor/fixture.tgz' } }, null, vendorInput);
  for (const specifier of ['file:../c/vendor.tgz', 'file:vendor', 'link:vendor/fixture.tgz', 'file:vendor/%2e%2e/external.tgz']) {
    const path = join(f.root, 'plugins/a/package.json'), pkg = read(path);
    pkg.devDependencies['vendor-fixture'] = specifier;
    f.change('plugins/a/package.json', JSON.stringify(pkg));
    f.publish();
    assert.throws(() => f.prepare(), /file:|link:/);
  }
});

test('vendor symlinks do not qualify as tracked ordinary archive inputs', t => {
  const f = fixture(t, { a: { 'vendor-fixture': 'file:vendor/fixture.tgz' } }, null, vendorInput);
  const archive = join(f.root, 'plugins/a/vendor/fixture.tgz'), target = join(f.root, '.local/vendor-target.tgz');
  renameSync(archive, target);
  try { symlinkSync(target, archive, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    renameSync(target, archive);
    const vendor = dirname(archive), ordinary = join(f.root, 'plugins/a/vendor-original');
    renameSync(vendor, ordinary);
    symlinkSync(ordinary, vendor, 'junction');
    t.diagnostic('Windows file symlinks require privileges; the equivalent in-plugin junction ancestor is rejected.');
  }
  assert.throws(() => f.prepare(), /普通归档|符号链接/);
});

test('unselected metadata drift fails before archive reuse', t => {
  const f = fixture(t);
  const path = join(f.root, 'plugins/a/package.json'), pkg = read(path);
  pkg.version = '0.2.0'; save(path, pkg);
  assert.throws(() => f.prepare(), /声明.*不一致/);
});

test('installation lifecycle and hooks are rejected without executing package scripts', t => {
  const f = fixture(t), marker = join(f.root, '.local/installed');
  for (const directory of ['', 'packages/helper', 'plugins/a']) {
    const path = join(f.root, directory, 'package.json'), original = existsSync(path) ? readFileSync(path) : null;
    save(path, { name: 'unsafe-install', scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}', 'ran')"` } });
    assert.throws(() => assertSelectiveInstallSafe(f.root), /postinstall/);
    assert.equal(existsSync(marker), false);
    if (original) writeFileSync(path, original); else { assert.ok(path.startsWith(f.root)); rmSync(path); }
  }
  writeFileSync(join(f.root, '.pnpmfile.cjs'), 'throw Error("must not run");');
  assert.throws(() => assertSelectiveInstallSafe(f.root), /hooks/);
});
