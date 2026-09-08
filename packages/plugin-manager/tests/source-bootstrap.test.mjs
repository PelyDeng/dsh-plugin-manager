/** Exercise the real source worker from a complete Git archive without workspace dependencies. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sourceRelease } from '../../../deploy/scripts/release.mjs';
import { tarCommand } from '../src/state.mjs';
import { normalizeEnvironment } from '../src/process.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
function command(bin, args, cwd, env) {
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
function snapshot(t, version = '11.19.0') {
  const base = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'bootstrap 完整源码 ')));
  t.after(() => { assert.equal(dirname(base), realpathSync.native(tmpdir())); rmSync(base, { recursive: true, force: true }); });
  const root = resolve(base, 'checkout'), bin = resolve(base, 'bin'), marker = resolve(base, 'install.json');
  mkdirSync(root); mkdirSync(bin);
  // Archive the index so this test also covers a staged candidate before it is committed.
  const tree = command('git', ['write-tree'], repository);
  const archive = resolve(base, 'source.tar');
  command('git', ['archive', '--format=tar', '--output', archive, tree], repository);
  command(tarCommand, ['-xf', 'source.tar', '-C', 'checkout'], base);
  command('git', ['init', '-q'], root);
  // Detached Git maintenance can still write .git while the fixture is being removed.
  command('git', ['config', 'maintenance.auto', 'false'], root);
  command('git', ['add', '.'], root);
  const commit = () => command('git', ['-c', 'user.name=Bootstrap Test', '-c', 'user.email=bootstrap@example.invalid', 'commit', '-qm', '初始化独立验收源码'], root);
  commit();
  const pnpm = `const fs=require('node:fs');if(process.argv[2]==='--version'){console.log(${JSON.stringify(version)});}else{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),pin:JSON.parse(fs.readFileSync('package.json')).packageManager,lock:fs.readFileSync('pnpm-lock.yaml','utf8')}));console.error('BOOTSTRAP_INSTALL_REACHED');process.exit(42);}`;
  const npm = `console.error('UNEXPECTED_NPM_INSTALL');process.exit(43);`;
  for (const [name, source] of [['pnpm', pnpm], ['npm', npm]]) {
    writeFileSync(resolve(bin, `${name}.cjs`), source);
    if (process.platform === 'win32') writeFileSync(resolve(bin, `${name}.cmd`), `@node "%~dp0\\${name}.cjs" %*\r\n`);
    else writeFileSync(resolve(bin, name), `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  }
  const env = normalizeEnvironment(process.env); env.PATH = `${bin}${delimiter}${env.PATH ?? ''}`;
  const absent = () => {
    for (const path of ['node_modules', 'packages/plugin-manager/node_modules', 'packages/plugin-kit/node_modules', 'deepseek-harness/node_modules']) assert.equal(existsSync(resolve(root, path)), false, path);
  };
  absent();
  return { root, bin, marker, env, absent, commit, preflight: () => ({ env }) };
}

test('complete dependency-free source serves public and worker help without installing or initializing', t => {
  const f = snapshot(t);
  for (const entry of ['deploy/scripts/release.mjs', 'deploy/scripts/build.mjs']) {
    const output = command(process.execPath, [entry, '--help'], f.root, f.env);
    assert.match(output, /build\.ps1/); assert.match(output, /build\.sh/);
  }
  f.absent(); assert.equal(existsSync(f.marker), false); assert.equal(existsSync(resolve(f.root, '.local')), false);
});

test('real fresh worker reaches the pinned install and releases its lock after an ordinary bootstrap failure', async t => {
  const f = snapshot(t);
  assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight }), 1);
  const observed = JSON.parse(readFileSync(f.marker, 'utf8'));
  assert.deepEqual(observed.args, ['install', '--frozen-lockfile']);
  assert.equal(observed.pin, 'pnpm@11.19.0');
  assert.equal(existsSync(resolve(f.root, '.local/source-release.node.lock')), false);
  assert.equal(existsSync(resolve(f.root, '.local/env.conf')), false);
  f.absent();
});

test('source deployment rejects unsynchronized framework versions before installing or stopping a site', t => {
  const f = snapshot(t);
  const path = resolve(f.root, 'package.json');
  const workspace = JSON.parse(readFileSync(path, 'utf8'));
  workspace.version = '0.99.0';
  writeFileSync(path, JSON.stringify(workspace, null, 2) + '\n');
  command('git', ['add', 'package.json'], f.root); f.commit();
  const result = spawnSync(process.execPath, ['deploy/scripts/build.mjs'], { cwd: f.root, env: f.env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /框架版本或文档未同步/);
  assert.equal(existsSync(f.marker), false);
  assert.equal(existsSync(resolve(f.root, '.local/env.conf')), false);
  assert.match(command(process.execPath, ['deploy/scripts/build.mjs', '--help'], f.root, f.env), /build\.ps1/);
  f.absent();
});

test('fresh workers reject malformed arguments, dirty source and pending recovery before installing', async t => {
  const f = snapshot(t);
  const invalid = spawnSync(process.execPath, ['deploy/scripts/build.mjs', '--unknown'], { cwd: f.root, env: f.env, encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Unknown or duplicate argument/); assert.doesNotMatch(invalid.stderr, /ERR_MODULE_NOT_FOUND/);
  appendFileSync(resolve(f.root, 'README.md'), '\nDirty fixture\n');
  assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight }), 1);
  assert.equal(existsSync(f.marker), false);
  command('git', ['add', 'README.md'], f.root); f.commit();
  const pointer = resolve(f.root, '.local/source-release.json'), original = JSON.stringify({ status: 'prepared', operation: 'preserved-operation' });
  writeFileSync(pointer, original);
  assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight }), 1);
  assert.equal(await sourceRelease({ root: f.root, args: ['--resume'], preflight: f.preflight }), 1);
  assert.equal(readFileSync(pointer, 'utf8'), original);
  assert.equal(existsSync(f.marker), false); assert.equal(existsSync(resolve(f.root, '.local/source-release.node.lock')), false);
  f.absent();
});

test('a private update is read by the fresh bootstrap worker before pinned installation', async t => {
  const f = snapshot(t, '11.19.1');
  const beforeBuild = () => {
    const path = resolve(f.root, 'package.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.packageManager = 'pnpm@11.19.1'; writeFileSync(path, JSON.stringify(manifest));
    appendFileSync(resolve(f.root, 'pnpm-lock.yaml'), '\n# updated-before-bootstrap\n');
    command('git', ['add', 'package.json', 'pnpm-lock.yaml'], f.root); f.commit();
  };
  assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight, beforeBuild }), 1);
  const observed = JSON.parse(readFileSync(f.marker, 'utf8'));
  assert.equal(observed.pin, 'pnpm@11.19.1'); assert.match(observed.lock, /updated-before-bootstrap/);
  assert.equal(existsSync(resolve(f.root, '.local/source-release.node.lock')), false);
});

test('a signalled bootstrap descendant keeps the source lock for manual verification', { skip: process.platform === 'win32' ? 'POSIX child signal reporting is unavailable on Windows.' : false }, async t => {
  const f = snapshot(t);
  writeFileSync(resolve(f.bin, 'pnpm'), `#!${process.execPath}\nif(process.argv[2]==='--version') console.log('11.19.0'); else process.kill(process.pid, 'SIGKILL');\n`, { mode: 0o755 });
  assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight }), 1);
  assert.equal(existsSync(resolve(f.root, '.local/source-release.node.lock')), true);
  assert.equal(existsSync(f.marker), false);
  f.absent();
});
