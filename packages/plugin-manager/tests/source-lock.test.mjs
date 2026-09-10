import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { acquireSourceLock, inspectSourceLock, needsSourceResume, sourceLockCommand, sourceRecoveryIdentity, unlockSource } from '../../../deploy/scripts/source-lock.mjs';
import { sourceRelease } from '../../../deploy/scripts/release.mjs';

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), '源码恢复 with spaces ')));
  t.after(() => { assert.equal(dirname(root), realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const put = (path, value) => { path = resolve(root, path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const lock = resolve(root, '.local/source-release.node.lock');
  const record = status => { mkdirSync(resolve(root, '.local/artifacts/retained'), { recursive: true }); put('.local/source-release.json', { operation: resolve(root, '.local/artifacts/retained'), status }); };
  return { root, put, lock, record };
}

function recoveryLock(f) {
  const identity = sourceRecoveryIdentity();
  const supported = ['linux', 'win32'].includes(process.platform);
  if (supported) assert.ok(identity.bootId, 'native boot identity must be available');
  else assert.equal(identity.bootId, undefined, 'unsupported platforms must not invent a boot identity');
  // Simulate an earlier boot only where recovery supports a native boot identity.
  f.put('.local/source-release.node.lock', { pid: process.pid, workerPid: process.pid, host: hostname(), createdAt: new Date().toISOString(), token: 'retained-token',
    recovery: { ...identity, ...(supported ? { bootId: process.platform === 'linux' ? '00000000-0000-0000-0000-000000000000' : '2000-01-01T00:00:00.000Z' } : {}) } });
  return supported;
}

test('doctor and recovery help need no preflight, source update, dependencies or local directory', async t => {
  const f = fixture(t), forbidden = () => { throw Error('must not run'); };
  for (const args of [['doctor'], ['doctor', '--help'], ['unlock-source', '--help'], ['unlock-source']]) {
    assert.equal(await sourceRelease({ root: f.root, args, preflight: forbidden, beforeBuild: forbidden }), 0);
    assert.equal(existsSync(resolve(f.root, '.local')), false);
  }
  for (const args of [['doctor', '--force'], ['unlock-source', '--force'], ['unlock-source', '--help', '--help']]) {
    await assert.rejects(sourceRelease({ root: f.root, args, preflight: forbidden }), /用法/);
  }
});

test('build and recovery share one resume decision and preserve saved inputs', t => {
  const f = fixture(t);
  f.put('build.sh', '#!/usr/bin/env bash\n'); f.put('build.ps1', '# PowerShell entry\n');
  const command = process.platform === 'win32' ? '.\\build.ps1' : 'bash build.sh';
  for (const status of ['building', 'build-failed', 'ready', 'prepared', 'backing-up', 'applying', 'deployment-failed']) {
    f.record(status);
    const bytes = readFileSync(resolve(f.root, '.local/source-release.json'));
    const report = inspectSourceLock(f.root);
    assert.equal(report.status, status);
    assert.equal(report.next, command + (needsSourceResume(status) ? ' --resume' : ''));
    assert.deepEqual(readFileSync(resolve(f.root, '.local/source-release.json')), bytes);
  }
  f.record('unknown'); assert.match(inspectSourceLock(f.root).reasons.join(), /发布记录无效/);
});

test('running owners and live managed process groups prevent unlock', t => {
  const f = fixture(t), release = acquireSourceLock(f.root);
  release.update({ recovery: sourceRecoveryIdentity() }); release.retain();
  const bytes = readFileSync(f.lock);
  assert.match(inspectSourceLock(f.root).reasons.join(), /运行中/);
  assert.throws(() => unlockSource(f.root), /无法安全解锁/);
  assert.deepEqual(readFileSync(f.lock), bytes);
  assert.equal(existsSync(resolve(f.root, '.local/source-release.control.lock')), false);
});

test('legacy, foreign-host, malformed and incomplete locks remain untouched', t => {
  const f = fixture(t);
  const base = { pid: 2147483647, host: hostname(), createdAt: new Date().toISOString(), token: 'legacy' };
  for (const value of [base, { ...base, host: 'another-host' }, { ...base, workerPid: -1 }, '{bad json',
    { ...base, recovery: { schema: 1, platform: process.platform } },
    { ...base, recovery: { schema: 1, platform: process.platform, bootId: 'invalid-identity' } }]) {
    f.put('.local/source-release.node.lock', value);
    const bytes = readFileSync(f.lock);
    assert.ok(inspectSourceLock(f.root).reasons.length);
    assert.throws(() => unlockSource(f.root));
    assert.deepEqual(readFileSync(f.lock), bytes);
  }
});

test('reboot recovery requires native boot identity and preserves every other state file', t => {
  const f = fixture(t), supported = recoveryLock(f); f.record('deployment-failed');
  for (const path of ['.local/source-release.lock', '.local/data/profile/lock.json', '.local/data/profile/pending.json']) f.put(path, 'preserve');
  const bytes = readFileSync(f.lock), record = readFileSync(resolve(f.root, '.local/source-release.json'));
  const directory = resolve(f.root, '.local/artifacts/source-lock-recovery');
  if (supported) {
    unlockSource(f.root);
    assert.equal(existsSync(f.lock), false);
    assert.deepEqual(readFileSync(resolve(directory, readdirSync(directory)[0])), bytes);
  } else {
    assert.match(inspectSourceLock(f.root).reasons.join(), /缺少.*启动身份/);
    assert.throws(() => unlockSource(f.root), /无法安全解锁/);
    assert.deepEqual(readFileSync(f.lock), bytes);
    assert.equal(existsSync(directory), false);
  }
  assert.deepEqual(readFileSync(resolve(f.root, '.local/source-release.json')), record);
  for (const path of ['.local/source-release.lock', '.local/data/profile/lock.json', '.local/data/profile/pending.json']) assert.equal(readFileSync(resolve(f.root, path), 'utf8'), 'preserve');
});

test('recovery and new deployments both refuse a held metadata control lock', t => {
  const f = fixture(t); recoveryLock(f); f.put('.local/source-release.control.lock', 'held');
  const bytes = readFileSync(f.lock);
  assert.throws(() => acquireSourceLock(f.root), /元数据/);
  assert.throws(() => unlockSource(f.root), /元数据/);
  assert.match(inspectSourceLock(f.root).reasons.join(), /control/);
  assert.deepEqual(readFileSync(f.lock), bytes);
});

test('unreadable deployment state and unsafe backup paths prevent mutation', t => {
  const f = fixture(t); recoveryLock(f); f.put('.local/source-release.json', '{bad json');
  const bytes = readFileSync(f.lock);
  assert.throws(() => unlockSource(f.root), /无法安全解锁/);
  f.record('building'); f.put('.local/artifacts/source-lock-recovery', 'not a directory');
  assert.throws(() => unlockSource(f.root)); assert.deepEqual(readFileSync(f.lock), bytes);
});

test('symlink locks cannot redirect recovery', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); f.put('outside-lock.json', 'preserve'); mkdirSync(resolve(f.root, '.local'));
  symlinkSync(resolve(f.root, 'outside-lock.json'), f.lock);
  assert.throws(() => unlockSource(f.root), /普通文件/);
  assert.equal(readFileSync(resolve(f.root, 'outside-lock.json'), 'utf8'), 'preserve');
});

function interrupted(t, orphan = false) {
  const f = fixture(t);
  f.put('deploy/scripts/build.mjs', orphan
    ? 'import {spawn} from "node:child_process"; import {writeFileSync} from "node:fs"; const p=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); writeFileSync("orphan.json",JSON.stringify({pid:p.pid})); p.unref(); process.exitCode=130;'
    : 'process.exitCode=130;');
  const module = new URL('../../../deploy/scripts/release.mjs', import.meta.url).href;
  f.put('runner.mjs', `import {sourceRelease} from ${JSON.stringify(module)}; process.exitCode=await sourceRelease({root:${JSON.stringify(f.root)},preflight:async()=>({env:process.env})});`);
  const run = spawnSync(process.execPath, [resolve(f.root, 'runner.mjs')], { detached: true, cwd: f.root, encoding: 'utf8', timeout: 15000 });
  assert.equal(run.status, 130, `${run.error ?? ''}\n${run.stderr}`);
  return f;
}

test('Linux interrupted release can unlock after its real owner and worker groups exit', { skip: process.platform !== 'linux' }, t => {
  const f = interrupted(t); f.record('building');
  assert.deepEqual(inspectSourceLock(f.root).reasons, []);
  assert.equal(sourceLockCommand(f.root, ['unlock-source']), 0);
  assert.equal(existsSync(f.lock), false);
});

test('Linux orphan worker descendant prevents unlock even after both recorded PIDs exit', { skip: process.platform !== 'linux' }, t => {
  const f = interrupted(t, true), { pid } = JSON.parse(readFileSync(resolve(f.root, 'orphan.json')));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const report = inspectSourceLock(f.root);
  assert.ok(report.processes.filter(item => item.pid).every(item => item.state === '已退出'));
  assert.match(report.reasons.join(), /进程组.*运行中/);
  assert.equal(sourceLockCommand(f.root, ['unlock-source']), 1);
  assert.equal(existsSync(f.lock), true);
});

test('Linux legacy flock blocks recovery without changing the old lock', { skip: process.platform !== 'linux' }, t => {
  const f = interrupted(t), bytes = readFileSync(f.lock);
  const module = new URL('../../../deploy/scripts/source-lock.mjs', import.meta.url).href;
  const result = spawnSync('flock', ['-n', resolve(f.root, '.local/source-release.lock'), process.execPath, '--input-type=module', '-e',
    `import {sourceLockCommand,inspectSourceLock} from ${JSON.stringify(module)}; if(!inspectSourceLock(${JSON.stringify(f.root)}).reasons.some(reason=>reason.includes('flock')))throw Error('doctor missed flock'); sourceLockCommand(${JSON.stringify(f.root)},['unlock-source']);`], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /外层锁/);
  assert.deepEqual(readFileSync(f.lock), bytes);
  assert.deepEqual(inspectSourceLock(f.root).reasons, []);
});

test('Windows same-boot interrupted release is diagnosed but never assumes orphan descendants are gone', { skip: process.platform !== 'win32' }, t => {
  const f = interrupted(t);
  assert.match(inspectSourceLock(f.root).reasons.join(), /无法证明所有子进程/);
  assert.throws(() => unlockSource(f.root), /无法安全解锁/);
  assert.equal(existsSync(f.lock), true);
});
