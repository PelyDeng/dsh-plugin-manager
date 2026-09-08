import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { commandSpec, normalizeEnvironment } from '../src/process.mjs';
import { runPnpm } from '../src/pnpm.mjs';

const windows = { skip: process.platform !== 'win32' };
function fixture(t) {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'command 中文 with spaces ')));
  t.after(() => { assert.equal(dirname(root), realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const put = (path, text) => { path = resolve(root, path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
  const env = normalizeEnvironment({ ...process.env, PATH: root });
  return { root, put, env };
}

test('Windows environment normalization preserves the effective PATH without duplicates or mutating input', windows, () => {
  const original = { Path: 'original tools', OTHER: 'kept' };
  const env = normalizeEnvironment(original);
  env.PATH = `private tools${delimiter}${env.PATH}`;
  const normalized = normalizeEnvironment({ Path: 'stale tools', ...env });
  assert.deepEqual(Object.keys(normalized).filter(key => key.toLowerCase() === 'path'), ['PATH']);
  assert.equal(normalized.PATH, `private tools${delimiter}original tools`);
  assert.deepEqual(original, { Path: 'original tools', OTHER: 'kept' });
});

test('npm never selects a neighboring pnpm Corepack entry', windows, t => {
  const f = fixture(t);
  f.put('npm.cmd', '@node "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
  const npm = f.put('node_modules/npm/bin/npm-cli.js', 'console.log("npm-fixture")');
  f.put('node_modules/corepack/dist/pnpm.js', 'console.log("wrong-pnpm")');
  const spec = commandSpec('npm', { env: f.env, cwd: f.root });
  assert.equal(spec.prefix[0], npm);
  assert.equal(spawnSync(spec.command, [...spec.prefix, '--version'], { env: f.env, encoding: 'utf8' }).stdout.trim(), 'npm-fixture');
});

test('runPnpm resolves a supplied private shim ahead of stale process-level pnpm', windows, t => {
  const f = fixture(t);
  const cli = f.put('node_modules/pnpm/bin/pnpm.cjs', 'console.log(JSON.stringify(process.argv.slice(2)))');
  f.put('node_modules/.bin/pnpm.cmd', '@node "%dp0%\\..\\pnpm\\bin\\pnpm.cjs" %*\r\n');
  const env = normalizeEnvironment({ ...f.env, PATH: resolve(f.root, 'node_modules/.bin'), npm_execpath: 'C:\\missing\\pnpm.cjs' });
  const spec = commandSpec('pnpm', { env, cwd: f.root });
  assert.equal(spec.prefix[0], cli);
  const args = ['--version', '中文 and spaces', 'literal&value', '$(literal)'];
  const result = runPnpm(args, f.root, { env, encoding: 'utf8', stdio: 'pipe' });
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('unrelated commands do not fall through to an installed pnpm entry', windows, t => {
  const f = fixture(t);
  f.put('custom.cmd', '@echo unsupported-wrapper\r\n');
  f.put('node_modules/corepack/dist/pnpm.js', 'console.log("wrong-tool")');
  assert.throws(() => commandSpec('custom', { env: f.env, cwd: f.root }), /无法安全解析/);
});

test('an explicit pnpm JS runner remains usable when no shim is on PATH', windows, t => {
  const f = fixture(t);
  const entry = f.put('runner/pnpm.cjs', 'console.log("explicit-pnpm")');
  const result = runPnpm(['--version'], f.root, { env: { ...f.env, npm_execpath: entry }, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(result.stdout.trim(), 'explicit-pnpm');
});

test('explicit JS entry remains shell-free on every platform', () => {
  assert.deepEqual(commandSpec('tool with spaces.mjs'), { command: process.execPath, prefix: ['tool with spaces.mjs'] });
});
