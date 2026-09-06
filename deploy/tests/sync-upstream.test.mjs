import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { syncUpstream } from '../scripts/sync-upstream.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sync-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
  const identify = cwd => { git(cwd, 'config', 'user.name', 'Sync test'); git(cwd, 'config', 'user.email', 'sync@example.invalid'); git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.autocrlf', 'false'); };
  const commit = (cwd, file, content) => { writeFileSync(join(cwd, file), content); git(cwd, 'add', file); git(cwd, 'commit', '-m', file); };
  const upstream = join(root, 'upstream'); mkdirSync(upstream); git(upstream, 'init', '-b', 'main'); identify(upstream);
  commit(upstream, '.gitignore', '.local/\n'); commit(upstream, 'framework.txt', 'base\n');
  git(root, 'clone', upstream, 'origin'); const origin = join(root, 'origin'); identify(origin);
  commit(origin, 'private.txt', 'private plugin\n');
  git(root, 'clone', origin, 'checkout'); const checkout = join(root, 'checkout'); identify(checkout);
  git(checkout, 'remote', 'add', 'upstream', upstream);
  return { root, upstream, origin, checkout, git, commit };
}

test('merges private and public changes, preserves local commits and repeats without pushing', t => {
  const f = fixture(t), { checkout, git, commit, origin, upstream } = f;
  commit(checkout, 'local.txt', 'local commit\n');
  commit(origin, 'private-update.txt', 'private update\n');
  commit(upstream, 'framework.txt', 'framework update\n');
  const remoteHead = git(origin, 'rev-parse', 'HEAD');
  syncUpstream(checkout);
  for (const file of ['private.txt', 'private-update.txt', 'local.txt']) assert.ok(existsSync(join(checkout, file)));
  assert.equal(readFileSync(join(checkout, 'framework.txt'), 'utf8'), 'framework update\n');
  const head = git(checkout, 'rev-parse', 'HEAD');
  syncUpstream(checkout);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
  assert.equal(git(origin, 'rev-parse', 'HEAD'), remoteHead);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
});

test('conflicts abort the failed merge and preserve the private checkout', t => {
  const { checkout, upstream, git, commit } = fixture(t);
  commit(checkout, 'framework.txt', 'private customization\n');
  commit(upstream, 'framework.txt', 'public change\n');
  const head = git(checkout, 'rev-parse', 'HEAD');
  assert.throws(() => syncUpstream(checkout), /合并 upstream\/main 失败/);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(checkout, 'framework.txt'), 'utf8'), 'private customization\n');
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  assert.ok(git(checkout, 'branch', '--list', 'codex/before-upstream-*'));
});

test('dirty files and pending deployments block sync; resume and help do not fetch', t => {
  const { checkout, git } = fixture(t);
  git(checkout, 'remote', 'set-url', 'upstream', join(checkout, 'missing-remote'));
  writeFileSync(join(checkout, 'private.txt'), 'uncommitted\n');
  assert.throws(() => syncUpstream(checkout), /工作区改动/);
  mkdirSync(join(checkout, '.local'));
  writeFileSync(join(checkout, '.local/source-release.json'), JSON.stringify({ status: 'deployment-failed' }));
  assert.throws(() => syncUpstream(checkout), /未完成部署/);
  syncUpstream(checkout, ['--resume']); syncUpstream(checkout, ['--help']);
  assert.equal(readFileSync(join(checkout, 'private.txt'), 'utf8'), 'uncommitted\n');
});

test('network failure does not apply already-fetched origin changes', t => {
  const { checkout, origin, git, commit } = fixture(t);
  commit(origin, 'new-private.txt', 'new\n');
  git(checkout, 'remote', 'set-url', 'upstream', join(checkout, 'missing-remote'));
  const head = git(checkout, 'rev-parse', 'HEAD');
  assert.throws(() => syncUpstream(checkout));
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(checkout, 'new-private.txt')), false);
});

test('Linux build entry holds the lock across sync and build, skips sync for resume and stops on conflict', { skip: process.platform !== 'linux' }, t => {
  const { checkout, upstream, git, commit } = fixture(t);
  mkdirSync(join(checkout, 'deploy/scripts'), { recursive: true });
  cpSync(new URL('../build.sh', import.meta.url), join(checkout, 'deploy/build.sh'));
  cpSync(new URL('../scripts/sync-upstream.mjs', import.meta.url), join(checkout, 'deploy/scripts/sync-upstream.mjs'));
  writeFileSync(join(checkout, 'deploy/scripts/build.mjs'), `import {spawnSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; if(spawnSync('flock',['-n','.local/source-release.lock','true']).status!==1) throw Error('lock not held'); writeFileSync('.local/built','ok');`);
  git(checkout, 'add', 'deploy'); git(checkout, 'commit', '-m', 'private entry');
  const run = (...args) => spawnSync('bash', ['deploy/build.sh', ...args], { cwd: checkout, encoding: 'utf8' });
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(checkout, '.local/built'), 'utf8'), 'ok');
  rmSync(join(checkout, '.local/built'));
  commit(checkout, 'framework.txt', 'private conflict\n'); commit(upstream, 'framework.txt', 'public conflict\n');
  assert.notEqual(run().status, 0);
  assert.equal(existsSync(join(checkout, '.local/built')), false);
  assert.equal(run('--resume').status, 0);
});
