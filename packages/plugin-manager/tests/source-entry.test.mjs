import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceArguments, sourceRelease } from '../../../deploy/scripts/release.mjs';
import { acquireFileLock } from '../src/lock.mjs';

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'source 入口 with spaces ')));
  t.after(() => { assert.equal(dirname(root), realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const put = (path, text) => { path = resolve(root, path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); return path; };
  const lock = resolve(root, '.local/source-release.node.lock');
  return { root, put, lock, preflight: async () => ({ env: { ...process.env, ENTRY_TEST: 'frozen env' } }) };
}

test('source argument validation rejects unsupported, duplicate and missing options', () => {
  assert.deepEqual(sourceArguments(['--config', '中文 with spaces.conf', '--resume']), ['--config', '中文 with spaces.conf', '--resume']);
  assert.deepEqual(sourceArguments(['--rebuild-plugins', 'alpha,charlie']), ['--rebuild-plugins', 'alpha,charlie']);
  for (const args of [['--config'], ['--config', '--resume'], ['--resume', '--resume'], ['--unknown'], ['other']]) assert.throws(() => sourceArguments(args), /argument/);
  for (const value of ['', 'all', 'none', 'dsh-console', 'alpha,alpha', 'alpha,', 'Alpha', 'alpha beta', '../alpha']) assert.throws(() => sourceArguments(['--rebuild-plugins', value]), /argument/);
  assert.throws(() => sourceArguments(['--resume', '--rebuild-plugins', 'alpha']), /--resume/);
  assert.throws(() => sourceArguments(['--rebuild-plugins', 'alpha', '--rebuild-plugins', 'beta']), /argument/);
});

test('skip-plugin-check is a value-less switch that composes with resume and rejects duplicates', () => {
  assert.deepEqual(sourceArguments(['--skip-plugin-check']), ['--skip-plugin-check']);
  assert.deepEqual(sourceArguments(['--skip-plugin-check', '--resume']), ['--skip-plugin-check', '--resume']);
  assert.throws(() => sourceArguments(['--skip-plugin-check', '--skip-plugin-check']), /argument/);
  // 它不参与「互斥」那一组：跳过检查与恢复原操作并不冲突。
  assert.deepEqual(sourceArguments(['--skip-plugin-check', '--recover', '--data-compatible']), ['--skip-plugin-check', '--recover', '--data-compatible']);
});

test('partial build selection reaches the private update and fresh worker under the source lock', async t => {
  const f = fixture(t), args = ['--rebuild-plugins', 'alpha,charlie'];
  f.put('deploy/scripts/build.mjs', 'import {writeFileSync} from "node:fs"; writeFileSync("selection.json", JSON.stringify(process.argv.slice(2))); process.send({type:"source-build-finished",code:0});');
  let updated = false;
  assert.equal(await sourceRelease({ root: f.root, args, preflight: f.preflight, beforeBuild: (_root, actual) => { assert.deepEqual(actual, args); assert.ok(existsSync(f.lock)); updated = true; } }), 0);
  assert.ok(updated);
  assert.deepEqual(JSON.parse(readFileSync(resolve(f.root, 'selection.json'))), args);
  await assert.rejects(sourceRelease({ root: f.root, args: ['--rebuild-plugins', 'alpha,alpha'], beforeBuild: () => { throw new Error('must not sync'); } }), /argument/);
});

test('help and explicit management retain their routes without preflight, lock or source updates', async t => {
  const f = fixture(t);
  f.put('deploy/scripts/build.mjs', 'if(process.argv[2]!=="--help")process.exitCode=3;');
  f.put('deploy/scripts/deployment.mjs', 'if(process.argv[2]!=="paths")process.exitCode=4;');
  const forbidden = () => { throw new Error('must not prepare or sync'); };
  for (const args of [['--help'], ['release', '--help'], ['paths', '--root', f.root]]) {
    assert.equal(await sourceRelease({ root: f.root, args, preflight: forbidden, beforeBuild: forbidden }), 0);
    assert.equal(existsSync(resolve(f.root, '.local')), false);
  }
});

test('one source lock covers the update and a fresh build worker with frozen environment', async t => {
  const f = fixture(t);
  f.put('deploy/scripts/build.mjs', 'throw new Error("old source must not execute")');
  const beforeBuild = async (root, args, env) => {
    assert.equal(root, f.root); assert.deepEqual(args, []); assert.equal(env.ENTRY_TEST, 'frozen env');
    assert.equal(existsSync(f.lock), true);
    await assert.rejects(sourceRelease({ root, preflight: f.preflight }), /源码部署正在执行/);
    f.put('deploy/scripts/build.mjs', 'import {readFileSync,writeFileSync} from "node:fs"; const lock=JSON.parse(readFileSync(".local/source-release.node.lock")); writeFileSync("observed.json",JSON.stringify({env:process.env.ENTRY_TEST,worker:process.pid,pid:lock.pid,args:process.argv.slice(2)})); process.send({type:"source-build-finished",code:0});');
  };
  assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight, beforeBuild }), 0);
  const observed = JSON.parse(readFileSync(resolve(f.root, 'observed.json')));
  assert.equal(observed.env, 'frozen env'); assert.equal(observed.pid, process.pid); assert.notEqual(observed.worker, process.pid);
  assert.equal(existsSync(f.lock), false);
});

test('resume skips source sync and normal worker failure releases only the Node source lock', async t => {
  const f = fixture(t);
  f.put('.local/source-release.lock', 'legacy flock inode');
  f.put('deploy/scripts/build.mjs', 'process.exitCode=7; process.send({type:"source-build-finished",code:7});');
  assert.equal(await sourceRelease({ root: f.root, args: ['--resume'], preflight: f.preflight, beforeBuild: () => { throw new Error('must not sync'); } }), 7);
  assert.equal(existsSync(f.lock), false);
  assert.equal(readFileSync(resolve(f.root, '.local/source-release.lock'), 'utf8'), 'legacy flock inode');
});

test('private update failures preserve signal evidence without retaining locks for ordinary errors', async t => {
  for (const signal of [undefined, null, 'SIGKILL', 'SIGTERM']) {
    const f = fixture(t), error = Object.assign(new Error('private update failed'), { signal });
    f.put('.local/source-release.lock', 'legacy flock inode');
    await assert.rejects(sourceRelease({ root: f.root, preflight: f.preflight, beforeBuild: async () => { throw error; } }), value => value === error);
    assert.equal(existsSync(f.lock), Boolean(signal));
    if (signal) assert.equal(JSON.parse(readFileSync(f.lock)).workerPid, undefined);
    assert.equal(readFileSync(resolve(f.root, '.local/source-release.lock'), 'utf8'), 'legacy flock inode');
  }
});

test('a signal received during a successful private update prevents the worker and retains its lock', async t => {
  const f = fixture(t);
  assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight, beforeBuild: () => { process.emit('SIGTERM'); } }), 143);
  assert.equal(existsSync(f.lock), true);
  assert.equal(JSON.parse(readFileSync(f.lock)).workerPid, undefined);
});

test('interrupted workers retain their source lock and block another deployment', async t => {
  const f = fixture(t);
  f.put('deploy/scripts/build.mjs', 'process.exitCode=130;');
  assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight }), 130);
  const lock = JSON.parse(readFileSync(f.lock));
  assert.equal(lock.pid, process.pid); assert.ok(Number.isSafeInteger(lock.workerPid));
  await assert.rejects(sourceRelease({ root: f.root, preflight: f.preflight }), /源码部署正在执行/);
});

test('an old owner cannot remove or rewrite a replacement lock', t => {
  const f = fixture(t);
  const release = acquireFileLock(f.lock);
  writeFileSync(f.lock, JSON.stringify({ token: 'another owner', pid: process.pid }));
  assert.throws(() => release.update({ workerPid: process.pid }), /ownership changed/);
  assert.throws(release, /ownership changed/);
  assert.equal(JSON.parse(readFileSync(f.lock)).token, 'another owner');
});

test('unconfirmed or mismatched completion retains the source lock even without a signal', async t => {
  for (const source of ['process.exitCode=1;', 'process.send({type:"source-build-finished",code:0}); process.exitCode=1;']) {
    const f = fixture(t);
    f.put('deploy/scripts/build.mjs', source);
    assert.equal(await sourceRelease({ root: f.root, preflight: f.preflight }), 1);
    assert.equal(existsSync(f.lock), true);
  }
});

test('public deploy platform scripts preserve arguments, working directory and exit status', t => {
  const f = fixture(t);
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  for (const path of ['deploy/build.sh', 'deploy/build.ps1']) {
    mkdirSync(dirname(resolve(f.root, path)), { recursive: true }); copyFileSync(resolve(repo, path), resolve(f.root, path));
  }
  f.put('deploy/scripts/release.mjs', 'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()})); process.exitCode=7;');
  const args = ['paths', '--config', '中文 config with spaces.conf', '--home', 'data/home with spaces'];
  const binary = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const command = process.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(f.root, 'deploy/build.ps1'), ...args] : [resolve(f.root, 'deploy/build.sh'), ...args];
  const result = spawnSync(binary, command, { cwd: tmpdir(), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, args);
  assert.equal(realpathSync.native(JSON.parse(result.stdout).cwd), realpathSync.native(tmpdir()));
});

test('Windows presenter termination stops its synchronous descendant and retains the source lock', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const marker = resolve(f.root, 'descendant.json');
  const descendant = f.put('descendant.mjs', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid})); setTimeout(()=>{},6000);`);
  f.put('deploy/scripts/build.mjs', `import {spawnSync} from 'node:child_process'; spawnSync(process.execPath,[${JSON.stringify(descendant)}],{stdio:'inherit',windowsHide:true}); process.send({type:'source-build-finished',code:0});`);
  const module = new URL('../../../deploy/scripts/release.mjs', import.meta.url).href;
  const runner = f.put('runner.mjs', `
    import {existsSync} from 'node:fs';
    import {sourceRelease} from ${JSON.stringify(module)};
    const timer=setInterval(()=>{if(existsSync(${JSON.stringify(marker)})){clearInterval(timer);process.emit('SIGTERM');}},25);
    try { process.exitCode=await sourceRelease({root:${JSON.stringify(f.root)},preflight:async()=>({env:process.env})}); }
    finally { clearInterval(timer); }
  `);
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 143, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  const { pid } = JSON.parse(readFileSync(marker));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(existsSync(f.lock), true);
});
