import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { discoverPlugins, parseOptions, pluginRecord, selectPlugins } from '../src/plugins.mjs';
import { packagePlugins } from '../src/package-plugins.mjs';
import { verifyBuildPackage as verifyPackage } from '../src/verify-package.mjs';
import { loadRelease } from '../src/release.mjs';
import { resolveDeployment, runtimeEnvironment } from '../src/config.mjs';
import { resolvePluginSettings } from '../src/plugin-settings.mjs';

function fixture(t) {
  const parent = tmpdir();
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, 'catalog-'));
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({ private: true, packageManager: 'pnpm@11.19.0' }));
  writeFileSync(resolve(root, 'pnpm-workspace.yaml'), "packages:\n  - 'plugins/*'\n");
  writeFileSync(resolve(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function plugin(root, id, change = () => {}) {
  const directory = resolve(root, `plugins/plugin-${id}`);
  mkdirSync(directory, { recursive: true });
  const manifest = {
    name: `@fixture/${id}`, version: '1.0.0', description: 'Isolated repository fixture', type: 'module',
    main: './dist/index.mjs', files: ['dist', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } },
    deepseekPlugin: { schemaVersion: 3, id }, scripts: { build: 'node build.mjs', check: 'node check.mjs' },
  };
  change(manifest);
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify(manifest));
  writeFileSync(resolve(directory, 'README.md'), 'Fixture\n');
  writeFileSync(resolve(directory, 'cordis.patch.yml'), '[]\n');
  writeFileSync(resolve(directory, 'build.mjs'), "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.mjs','export function apply() {}\\n');\n");
  writeFileSync(resolve(directory, 'check.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('checked','yes');\n");
  writeFileSync(resolve(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n" + readdirSync(resolve(root, 'plugins')).map(name => `  plugins/${name}: {}\n`).join(''));
  return directory;
}

function run(args, options = {}) {
  return spawnSync(process.execPath, args, { cwd: repositoryRoot, encoding: 'utf8', ...options });
}

test('public auth and example are discovered independently from library packages and enabled by default', () => {
  const plugins = discoverPlugins(repositoryRoot);
  assert.ok(['auth', 'example'].every(id => plugins.some(plugin => plugin.id === id)));
  assert.ok(!plugins.some(plugin => plugin.package.startsWith('@dsh-plugin/')));
  assert.ok(['auth', 'example'].every(id => selectPlugins(plugins).some(plugin => plugin.id === id)));
  assert.ok(plugins.every(plugin => plugin.verifyFiles.includes('cordis.patch.yml')));
});

test('a dropped-in second plugin is listed, selected, checked, built and packed without lifecycle hooks', t => {
  const root = fixture(t);
  plugin(root, 'z', m => { m.deepseekPlugin.defaultEnabled = false; });
  const second = plugin(root, 'a');
  const plugins = discoverPlugins(root);
  assert.deepEqual(plugins.map(p => p.id), ['a', 'z']);
  assert.deepEqual(selectPlugins(plugins).map(p => p.id), ['a']);
  assert.deepEqual(selectPlugins(plugins, 'z,a').map(p => p.id), ['z', 'a']);
  assert.deepEqual(selectPlugins(plugins, 'all').map(p => p.id), ['a', 'z']);
  assert.match(pluginRecord(plugins[0]), /\|-\|-\|-\|package.json,README.md,dist\/index.mjs,cordis.patch.yml$/u);
  for (const action of ['list', 'check', 'build']) {
    const result = run(['scripts/run-plugin-task.mjs', action, '--root', root, '--plugins', 'all']);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readFileSync(resolve(second, 'checked'), 'utf8'), 'yes');
  const recordResult = run(['scripts/plugins.mjs', '--root', root, '--plugins', 'z,a', '--format', 'records']);
  assert.equal(recordResult.status, 0, recordResult.stderr);
  assert.match(recordResult.stdout, /selected\|z\nselected\|a\n$/u);
  const packed = spawnSync('pnpm', ['pack', '--pack-destination', '..'], { cwd: second, shell: process.platform === 'win32', encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const archive = resolve(root, 'plugins/fixture-a-1.0.0.tgz');
  const verified = run(['deploy/scripts/verify-package.mjs', second, archive, root]);
  assert.equal(verified.status, 0, verified.stderr);
  writeFileSync(resolve(second, 'dist/index.mjs'), 'different\n');
  const rejected = run(['deploy/scripts/verify-package.mjs', second, archive, root]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /与本次构建文件不一致/u);
});

test('selection and arguments reject empty, repeated and unknown values', t => {
  const root = fixture(t); plugin(root, 'a'); const plugins = discoverPlugins(root);
  for (const selection of ['', ',', 'a,', ',a', 'a,a', 'missing']) assert.throws(() => selectPlugins(plugins, selection));
  assert.deepEqual(selectPlugins([], 'all'), []);
  assert.deepEqual(selectPlugins(plugins, 'none'), []);
  assert.deepEqual(parseOptions(['--', '--plugins', 'a']), { plugins: 'a' });
  for (const args of [['--plugins'], ['--plugins', ''], ['--plugins', 'a', '--plugins', 'a'], ['--other', 'a']]) assert.throws(() => parseOptions(args));
  const emptyRoot = fixture(t);
  const result = run(['scripts/plugins.mjs', '--root', emptyRoot]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { plugins: [], selected: [] });
});

test('optional metadata and deployment-only settings do not block build, pack or release consumption', t => {
  const root = fixture(t);
  plugin(root, 'minimal', m => {
    delete m.description;
    m.deepseekPlugin.configuration = { entryId: 'minimal', auth: 'consumer' };
    m.deepseekPlugin.runtimeConfig = { variable: 'MINIMAL_CONFIG' };
  });
  const output = resolve(root, 'release');
  packagePlugins(root, 'minimal', output);
  const release = loadRelease(resolve(output, 'manifest.json'));
  const [result] = release.plugins;
  assert.equal(result.healthPath, undefined);
  assert.equal(result.description, undefined);
  assert.deepEqual(result.permissions, []);
  assert.equal(result.displayName, '@fixture/minimal');
  assert.equal(result.defaultEnabled, true);
  assert.deepEqual(result.runtimeConfig, { variable: 'MINIMAL_CONFIG', required: true });
  assert.ok(result.verifyFiles.every(file => typeof file === 'string'));
  const deployment = resolveDeployment({ root }, {});
  assert.throws(() => resolvePluginSettings(deployment, release), /publicOrigin/);
  assert.throws(() => runtimeEnvironment(deployment, release.plugins), /配置/);
});

test('display metadata accepts a local entry and owns its permission namespace', t => {
  const root = fixture(t);
  plugin(root, 'demo', m => { Object.assign(m.deepseekPlugin, { displayName: '示例插件', entryPath: '/demo', permissions: ['demo:access'] }); });
  const [result] = discoverPlugins(root);
  assert.equal(result.displayName, '示例插件');
  assert.equal(result.entryPath, '/demo');
  assert.deepEqual(result.permissions, ['demo:access']);
  const invalid = [
    { displayName: '' }, { displayName: 1 }, { entryPath: '//external.invalid' }, { entryPath: '/demo/../auth' },
    { entryPath: 'https://external.invalid' }, { permissions: ['other:access'] },
    ...['/', '/demo/', '/demo//child', '/demo/.', '/demo/%2e%2e', '/demo?next=1', '/demo#tab', '/demo\\child'].map(entryPath => ({ entryPath })),
    { permissions: ['demo:access', 'demo:access'] }, { permissions: ['demo:*'] }, { permissions: 'demo:access' },
  ];
  for (const meta of invalid) {
    plugin(root, 'demo', m => Object.assign(m.deepseekPlugin, meta));
    assert.throws(() => discoverPlugins(root));
  }
});

test('plugin cleanup removes only generated directories and rejects source or linked paths', t => {
  const root = fixture(t);
  const directory = plugin(root, 'clean');
  const clean = (...outputs) => run([resolve(repositoryRoot, 'scripts/clean-plugin.mjs'), ...outputs], { cwd: directory });
  mkdirSync(resolve(directory, 'dist'));
  mkdirSync(resolve(directory, 'src'));
  writeFileSync(resolve(directory, 'src/keep.ts'), 'source');
  assert.equal(clean('dist').status, 0);
  assert.equal(readFileSync(resolve(directory, 'src/keep.ts'), 'utf8'), 'source');
  for (const output of ['src', '..', '../other', '.', 'node_modules']) assert.notEqual(clean(output).status, 0);
  const external = resolve(root, 'external');
  mkdirSync(external);
  writeFileSync(resolve(external, 'keep'), 'private');
  symlinkSync(external, resolve(directory, 'web'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual(clean('web/assets').status, 0);
  assert.equal(readFileSync(resolve(external, 'keep'), 'utf8'), 'private');
});

test('malformed declarations fail before any task runs', t => {
  const cases = [
    m => { m.deepseekPlugin = null; }, m => { m.deepseekPlugin.schemaVersion = 1; }, m => { m.deepseekPlugin.schemaVersion = 2; },
    m => { m.deepseekPlugin.unknown = true; }, m => { m.deepseekPlugin.id = 'all'; },
    m => { m.deepseekPlugin.id = 'dsh-console'; },
    m => { m.deepseekPlugin.id = 'none'; }, m => { m.scripts.prepack = 'pnpm build'; },
    m => { m.files.push('env.conf'); }, m => { m.files.push('data/'); },
    m => { m.deepseekPlugin.defaultEnabled = 'false'; }, m => { delete m.scripts.build; },
    m => { delete m.scripts.check; }, m => { m.description = 42; }, m => { delete m.files; },
    m => { m.main = '../escape'; }, m => { m.main = '././index.js'; },
    m => { m.deepseekPlugin.healthPath = '//example.com'; }, m => { m.deepseekPlugin.healthPath = '/a/../b'; },
    m => { m.deepseekPlugin.verifyFiles = ['../escape']; }, m => { m.deepseekPlugin.verifyFiles = ['a|b']; },
    m => { m.deepseekPlugin.verifyFiles = ['/absolute']; }, m => { m.deepseekPlugin.verifyFiles = ['a\\b']; },
    m => { m.deepseekPlugin.verifyFiles = ['./index.js']; }, m => { m.deepseekPlugin.verifyFiles = ['a//b']; },
    m => { m.deepseekPlugin.runtimeConfig = { template: 'env.conf.example' }; },
    m => { m.deepseekPlugin.runtimeConfig = { variable: 'EXAMPLE_ENV', template: 'missing.example' }; },
    m => { m.deepseekPlugin.configuration = { auth: 'consumer' }; },
    m => { m.deepseekPlugin.development = { rootVariable: 'EXAMPLE_ROOT' }; },
    m => { delete m.deepseekPlugin; },
  ];
  for (const [index, change] of cases.entries()) {
    const root = fixture(t); plugin(root, `case-${index}`, change);
    assert.throws(() => discoverPlugins(root), `case ${index} must reject`);
  }
  const root = fixture(t); const dir = plugin(root, 'a');
  rmSync(resolve(dir, 'cordis.patch.yml')); assert.throws(() => discoverPlugins(root), /文件不存在/u);
  writeFileSync(resolve(dir, 'package.json'), '{'); assert.throws(() => discoverPlugins(root), SyntaxError);
});

test('duplicate identities and environment variables are rejected across plugins', t => {
  for (const field of ['id', 'package', 'runtimeConfig']) {
    const root = fixture(t);
    const a = plugin(root, 'a', m => { m.deepseekPlugin.runtimeConfig = { variable: 'EXAMPLE_ENV', template: 'env.conf.example' }; });
    writeFileSync(resolve(a, 'env.conf.example'), 'fixture');
    const b = plugin(root, 'b', m => {
      if (field === 'id') m.deepseekPlugin.id = 'a';
      if (field === 'package') m.name = '@fixture/a';
      if (field === 'runtimeConfig') m.deepseekPlugin.development = { rootVariable: 'EXAMPLE_ENV', patch: 'dev.yml' };
    });
    writeFileSync(resolve(b, 'dev.yml'), '[]\n');
    assert.throws(() => discoverPlugins(root), /重复/u);
  }
  for (const name of ['PATH', 'NODE_OPTIONS', 'DSH_HOME', 'BASH_ENV', 'PLUGIN_MANIFEST_FILE']) {
    const root = fixture(t); const dir = plugin(root, 'a', m => { m.deepseekPlugin.runtimeConfig = { variable: name, template: 'env.conf.example' }; });
    writeFileSync(resolve(dir, 'env.conf.example'), 'fixture');
    assert.throws(() => discoverPlugins(root), /保留变量/u);
  }
});

test('unrelated directories and linked directories are ignored; generated files cannot escape via a junction', t => {
  const root = fixture(t); const outside = fixture(t); const dir = plugin(root, 'a');
  mkdirSync(resolve(root, 'tool')); writeFileSync(resolve(root, 'tool/package.json'), '{}');
  symlinkSync(outside, resolve(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(discoverPlugins(root).length, 1);
  symlinkSync(outside, resolve(dir, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => discoverPlugins(root), /目录之外/u);
});

test('metadata files cannot be symlinked outside the plugin directory', t => {
  const root = fixture(t); const outside = fixture(t); const dir = plugin(root, 'a');
  const manifest = resolve(dir, 'package.json');
  writeFileSync(resolve(outside, 'external.json'), readFileSync(manifest));
  rmSync(manifest);
  try { symlinkSync(resolve(outside, 'external.json'), manifest, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows host lacks file symlink privilege; Linux check covers this case'); return; }
    throw error;
  }
  assert.throws(() => discoverPlugins(root), /目录之外/u);
});

test('only plugins children are discovered and the container cannot be an npm package', t => {
  const root = fixture(t);
  const dir = plugin(root, 'a');
  for (const name of ['data', 'deepseek-harness', 'deploy-artifacts', 'old-plugin']) {
    mkdirSync(resolve(root, name));
    writeFileSync(resolve(root, name, 'package.json'), readFileSync(resolve(dir, 'package.json')));
  }
  assert.deepEqual(discoverPlugins(root).map(p => p.directory), ['plugins/plugin-a']);
  writeFileSync(resolve(root, 'plugins/package.json'), '{}');
  assert.throws(() => discoverPlugins(root), /容器目录/u);
  rmSync(resolve(root, 'plugins/package.json'));
  const external = fixture(t);
  symlinkSync(external, resolve(root, 'plugins/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => discoverPlugins(root), /符号链接/u);
});

test('runtime templates are checked without needing a user configuration file', t => {
  const root = fixture(t);
  const dir = plugin(root, 'config', m => {
    m.deepseekPlugin.runtimeConfig = { variable: 'EXAMPLE_CONFIG', template: 'settings.example' };
    m.files.push('settings.example');
  });
  assert.throws(() => discoverPlugins(root), /文件不存在/u);
  writeFileSync(resolve(dir, 'settings.example'), 'TOKEN=\n');
  assert.equal(discoverPlugins(root)[0].runtimeConfig.required, true);
  assert.ok(!discoverPlugins(root)[0].verifyFiles.includes('env.conf'));
});

test('the package pipeline builds once, checks that build, and writes a portable manifest', t => {
  const root = fixture(t);
  const dir = plugin(root, 'a');
  writeFileSync(resolve(dir, 'build.mjs'), "import{mkdirSync,writeFileSync,appendFileSync}from'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/index.mjs','export const value=1;\\n');appendFileSync('trace','build\\n');\n");
  writeFileSync(resolve(dir, 'check.mjs'), "import{appendFileSync}from'node:fs';import{value}from'./dist/index.mjs';if(value!==1)throw Error('build missing');appendFileSync('trace','check\\n');\n");
  writeFileSync(resolve(dir, 'env.conf'), 'TEST_PRIVATE_VALUE=not-published\n');
  const output = resolve(root, 'output with spaces');
  const manifest = packagePlugins(root, 'all', output);
  assert.equal(readFileSync(resolve(dir, 'trace'), 'utf8'), 'build\ncheck\n');
  assert.equal(manifest.plugins[0].archive, `a-${manifest.plugins[0].sha256}.tgz`);
  assert.match(manifest.plugins[0].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.plugins[0].directory, 'plugins/plugin-a');
  assert.equal(readFileSync(resolve(output, 'manifest.json'), 'utf8').includes(root), false);
  writeFileSync(resolve(dir, 'README.md'), 'Updated bytes at the same version\n');
  const updated = packagePlugins(root, 'all', resolve(root, 'updated-output'));
  assert.equal(updated.plugins[0].version, manifest.plugins[0].version);
  assert.notEqual(updated.plugins[0].archive, manifest.plugins[0].archive);
  assert.match(spawnSync('tar', ['-xOf', resolve(root, 'updated-output', updated.plugins[0].archive), 'package/README.md'], { encoding: 'utf8' }).stdout, /Updated bytes/);
  assert.throws(() => packagePlugins(root, 'all', output), /为空/u);
  assert.deepEqual(packagePlugins(root, 'none', resolve(root, 'empty')).plugins, []);
  mkdirSync(resolve(root, 'leak/package'), { recursive: true });
  writeFileSync(resolve(root, 'leak/package/env.conf'), 'TEST_PRIVATE_VALUE=not-published\n');
  const bad = spawnSync('tar', ['-czf', resolve(root, 'private.tgz'), '-C', resolve(root, 'leak'), 'package/env.conf'], { encoding: 'utf8' });
  assert.equal(bad.status, 0, bad.stderr);
  assert.throws(() => verifyPackage(root, discoverPlugins(root)[0], resolve(root, 'private.tgz')), /私密/u);
});
