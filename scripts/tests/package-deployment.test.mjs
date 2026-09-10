import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assembleDeployment, runtimeFromImage, zipTree } from '../package-deployment.mjs';
import { hash, tarCommand } from '../../packages/plugin-manager/src/state.mjs';
import { decodeFrameworkConfig, renderSiteTemplate } from '../../packages/plugin-manager/src/framework-config.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const version = '0.9.0', image = `registry.example/dsh@sha256:${'a'.repeat(64)}`, imageId = `sha256:${'b'.repeat(64)}`, commit = 'c'.repeat(40);
const managerHash = 'd'.repeat(64);
const managerCli = '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs';
const runtime = { platform: 'linux/amd64', image, hostCommit: commit };
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path, value) => write(path, JSON.stringify(value));

test('runtime metadata requires the exact manager archive, immutable image and actual version probes', () => {
  const info = { Id: imageId, Os: 'linux', Architecture: 'amd64', RepoDigests: [image], Config: { Labels: { 'org.opencontainers.image.revision': commit, 'org.opencontainers.image.version': '0.1.5-alpha.2', 'com.dsh-plugin-manager.manager.sha256': managerHash }, Entrypoint: ['node', managerCli, 'container-start', '--root', '/opt/plugin-project'] } };
  const calls = [];
  const execute = (bin, args) => {
    assert.equal(bin, 'docker'); calls.push(args);
    if (args[0] === 'image') return JSON.stringify([info]);
    assert.ok(args.includes(imageId)); assert.ok(args.includes('--read-only')); assert.ok(args.includes('none'));
    return args.includes(managerCli) ? version : '0.1.5-alpha.2';
  };
  assert.deepEqual(runtimeFromImage(image, version, managerHash, execute), runtime);
  assert.equal(calls.filter(args => args[0] === 'run').length, 2);
  assert.throws(() => runtimeFromImage('registry.example/dsh:latest', version, managerHash, execute), /sha256/);
  assert.throws(() => runtimeFromImage(image, '0.9.1', managerHash, execute), /version/);
  assert.throws(() => runtimeFromImage(image, version, undefined, execute), /SHA256/);
  assert.throws(() => runtimeFromImage(image, version, 'e'.repeat(64), execute), /archive SHA256 does not match/);
  delete info.Config.Labels['com.dsh-plugin-manager.manager.sha256'];
  assert.throws(() => runtimeFromImage(image, version, managerHash, execute), /archive SHA256 does not match/);
  info.Config.Labels['com.dsh-plugin-manager.manager.sha256'] = managerHash;
  info.RepoDigests = [`other.example/dsh@sha256:${'a'.repeat(64)}`];
  assert.throws(() => runtimeFromImage(image, version, managerHash, execute), /digest/);
  info.RepoDigests = [image]; info.Config.Labels['org.opencontainers.image.revision'] = 'unverified';
  assert.throws(() => runtimeFromImage(image, version, managerHash, execute), /identity/);
});

function fixture(t) {
  const parent = realpathSync(tmpdir()), base = realpathSync(mkdtempSync(join(parent, 'dsh-release-package-')));
  t.after(() => { assert.equal(dirname(base), parent); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'framework'); mkdirSync(root);
  json(join(root, 'package.json'), { version });
  for (const path of ['deploy/DEPLOYMENT.md', 'deploy/STARTERS.md', 'incoming/README.md', 'LICENSE']) write(join(root, path), `Public fixture: ${path}\n`);
  for (const name of ['standalone-plugin', 'standalone-kit']) cpSync(join(repo, 'examples', name), join(root, 'examples', name), { recursive: true });
  write(join(root, 'examples/standalone-kit/.local/private'), 'never-package-this');
  write(join(root, 'plugins/private-plugin/secrets.json'), 'never-package-this');
  function archive(name, files, metadata) {
    const input = join(base, `${name}-input`); mkdirSync(join(input, 'package'), { recursive: true });
    json(join(input, 'package/package.json'), { name, version, type: 'module', ...metadata });
    for (const [path, contents] of Object.entries(files)) write(join(input, 'package', path), contents);
    const output = join(base, `${name.replaceAll('/', '-')}.tgz`);
    const result = spawnSync(tarCommand, ['-czf', output, '-C', input, 'package'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return output;
  }
  const manager = archive('manager', { 'dist/cli.mjs': `console.log(process.argv.includes('--version') ? '${version}' : JSON.stringify({home:'fixture-home'}));\n` }, { name: '@dsh-plugin-manager/plugin-manager', main: 'dist/cli.mjs', exports: { '.': './dist/cli.mjs' } });
  const kit = archive('kit', { 'dist/index.mjs': 'export const fixture = true;\n' }, { name: '@dsh-plugin-manager/plugin-kit', main: 'dist/index.mjs' });
  const auth = archive('auth', { 'dist/index.mjs': 'export function apply() {}\n', 'README.md': 'Authentication fixture\n', 'cordis.patch.yml': '[]\n' }, { name: 'dsh-auth', deepseekPlugin: { schemaVersion: 3, id: 'auth', configuration: { entryId: 'auth', auth: 'provider' } } });
  const authManifest = join(base, 'auth-manifest.json');
  json(authManifest, { schemaVersion: 2, plugins: [{ id: 'auth', package: 'dsh-auth', version, archive: 'auth.tgz', sha256: hash(readFileSync(auth)), configuration: { entryId: 'auth', auth: 'provider' }, verifyFiles: ['package.json', 'dist/index.mjs', 'README.md', 'cordis.patch.yml'] }] });
  return { root, manager, kit, authManifest, images: [image], output: join(root, '.local/output') };
}

test('deployment contains installed tools and optional auth; starters copy independently with a relative kit archive', t => {
  const options = fixture(t);
  const result = assembleDeployment(options, { inspectRuntime: (actualImage, actualVersion, actualHash) => {
    assert.equal(actualImage, image); assert.equal(actualVersion, version); assert.equal(actualHash, hash(readFileSync(options.manager)));
    return runtime;
  } });
  assert.deepEqual(JSON.parse(readFileSync(join(options.root, 'package.json'))), { version });
  assert.equal(existsSync(join(options.root, 'node_modules')), false);
  assert.equal(result.metadata.manager.sha256, hash(readFileSync(options.manager)));
  assert.equal(readFileSync(join(result.deployment, 'env.conf.example'), 'utf8'), renderSiteTemplate('archives'));
  const config = decodeFrameworkConfig(readFileSync(join(result.deployment, 'env.conf.example'), 'utf8')).config;
  assert.equal(config.pluginSource, 'archives'); assert.equal(config.plugins, undefined);
  assert.equal(existsSync(join(result.deployment, '.local')), false);
  assert.equal(existsSync(join(result.deployment, 'plugins')), false);
  assert.equal(existsSync(join(result.deployment, 'incoming/auth')), false);
  assert.deepEqual(JSON.parse(readFileSync(join(result.deployment, 'optional/auth/manifest.json'))).plugins.map(plugin => plugin.id), ['auth']);
  const starter = join(result.starters, 'standalone-kit');
  const manifest = JSON.parse(readFileSync(join(starter, 'package.json')));
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.devDependencies['@dsh-plugin-manager/plugin-kit'], 'file:vendor/plugin-kit.tgz');
  assert.equal(hash(readFileSync(join(starter, 'vendor/plugin-kit.tgz'))), hash(readFileSync(options.kit)));
  assert.equal(existsSync(join(starter, '.local')), false);
  assert.equal(existsSync(join(starter, 'README.md.tmpl')), false);
  assert.equal(existsSync(join(starter, 'LICENSE')), true);
  const moved = join(dirname(options.output), 'moved deployment'); cpSync(result.deployment, moved, { recursive: true });
  const cli = join(moved, 'tools/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs');
  assert.equal(spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', cwd: moved }).stdout.trim(), version);
  assert.match(readFileSync(join(moved, 'build.sh'), 'utf8'), /flock -n[\s\S]*release-site --root/);
  assert.throws(() => assembleDeployment(options, { inspectRuntime: () => runtime }), /new or empty/);
});

test('mismatched tool versions and repeated runtime platforms fail before staging a deployment', t => {
  const options = fixture(t);
  json(join(options.root, 'package.json'), { version: '0.9.1' });
  assert.throws(() => assembleDeployment(options, { inspectRuntime: () => runtime }), /archive does not match/);
  assert.equal(existsSync(options.output), false);
  json(join(options.root, 'package.json'), { version });
  assert.throws(() => assembleDeployment({ ...options, images: [image, image] }, { inspectRuntime: () => runtime }), /one runtime per platform/);
  assert.equal(existsSync(options.output), false);
});

test('zip output includes hidden ignore files, excludes installation locks and preserves executable shell mode', t => {
  const python = process.env.DSH_RELEASE_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  if (spawnSync(python, ['--version'], { timeout: 5000 }).status !== 0) { t.skip('Set DSH_RELEASE_PYTHON to a Python 3 executable for ZIP verification.'); return; }
  const options = fixture(t), tree = join(options.output, 'dsh-deployment');
  write(join(tree, '.gitignore'), '.local/\n'); write(join(tree, 'build.sh'), '#!/bin/sh\n');
  write(join(tree, 'tools/package-lock.json'), '{"fixture":"not-published"}');
  const zip = join(options.output, 'deployment.zip'); zipTree(tree, zip, python);
  const inspect = spawnSync(python, ['-c', "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({i.filename:i.external_attr >> 16 for i in z.infolist()}))", zip], { encoding: 'utf8' });
  assert.equal(inspect.status, 0, inspect.stderr);
  const entries = JSON.parse(inspect.stdout);
  assert.deepEqual(Object.keys(entries), ['dsh-deployment/.gitignore', 'dsh-deployment/build.sh']);
  assert.equal(entries['dsh-deployment/build.sh'] & 0o777, 0o755);
  write(join(tree, '.local/private.json'), '{}');
  assert.throws(() => zipTree(tree, join(options.output, 'invalid.zip'), python), /Private release path/);
});
