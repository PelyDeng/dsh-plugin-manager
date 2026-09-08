import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { syncOrigin } from '../sync-origin.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh 私有同步 with spaces '));
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

test('fast-forwards only the integrated origin and repeats without fetching upstream', t => {
  const f = fixture(t), { checkout, git, commit, origin, upstream } = f;
  commit(origin, 'private-update.txt', 'private update\n');
  commit(upstream, 'framework.txt', 'framework update\n');
  git(checkout, 'remote', 'set-url', 'upstream', join(checkout, 'missing-upstream'));
  const remoteHead = git(origin, 'rev-parse', 'HEAD');
  syncOrigin(checkout);
  for (const file of ['private.txt', 'private-update.txt']) assert.ok(existsSync(join(checkout, file)));
  assert.equal(readFileSync(join(checkout, 'framework.txt'), 'utf8'), 'base\n');
  const head = git(checkout, 'rev-parse', 'HEAD');
  assert.equal(head, remoteHead);
  syncOrigin(checkout);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
  assert.equal(git(origin, 'rev-parse', 'HEAD'), remoteHead);
  assert.equal(git(checkout, 'status', '--porcelain'), '');
});

test('local commits and diverged origin stop without starting a merge', t => {
  const { checkout, origin, git, commit } = fixture(t);
  commit(checkout, 'framework.txt', 'private customization\n');
  const head = git(checkout, 'rev-parse', 'HEAD');
  assert.throws(() => syncOrigin(checkout), /本机.*提交/);
  commit(origin, 'framework.txt', 'integrated change\n');
  assert.throws(() => syncOrigin(checkout), /本机.*提交/);
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(checkout, 'framework.txt'), 'utf8'), 'private customization\n');
  assert.equal(git(checkout, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(checkout, '.git/MERGE_HEAD')), false);
});

test('dirty files and pending deployments block sync; resume and help do not fetch', t => {
  const { checkout, git } = fixture(t);
  git(checkout, 'remote', 'set-url', 'upstream', join(checkout, 'missing-remote'));
  writeFileSync(join(checkout, 'private.txt'), 'uncommitted\n');
  assert.throws(() => syncOrigin(checkout), /工作区.*改动/);
  mkdirSync(join(checkout, '.local'));
  writeFileSync(join(checkout, '.local/source-release.json'), JSON.stringify({ status: 'deployment-failed' }));
  assert.throws(() => syncOrigin(checkout), /未完成部署/);
  syncOrigin(checkout, ['--resume']); syncOrigin(checkout, ['--help']);
  assert.equal(readFileSync(join(checkout, 'private.txt'), 'utf8'), 'uncommitted\n');
});

test('origin network failure leaves the checkout unchanged', t => {
  const { checkout, origin, git, commit } = fixture(t);
  commit(origin, 'new-private.txt', 'new\n');
  git(checkout, 'remote', 'set-url', 'origin', join(checkout, 'missing-remote'));
  const head = git(checkout, 'rev-parse', 'HEAD');
  assert.throws(() => syncOrigin(checkout));
  assert.equal(git(checkout, 'rev-parse', 'HEAD'), head);
  assert.equal(existsSync(join(checkout, 'new-private.txt')), false);
});

function workerSource(label, code = 0) {
  return `import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--help')) console.log('private help');
else {
  if (process.env.PRIVATE_CHECK_FLOCK === '1' && spawnSync('flock', ['-n', '.local/source-release.lock', 'true']).status !== 1) throw Error('worker lost flock');
  const lock = JSON.parse(readFileSync('.local/source-release.node.lock'));
  writeFileSync('.local/worker.json', JSON.stringify({ label: ${JSON.stringify(label)}, args, cwd: process.cwd(), preparedRoot: process.env.PRIVATE_PREPARED_ROOT, pid: process.pid, owner: lock.pid }));
  process.exitCode = ${code}; process.send({ type: 'source-build-finished', code: ${code} });
}
`;
}

function entryFixture(t) {
  const f = fixture(t), { checkout, origin, git } = f;
  const files = ['build.sh', 'build.ps1', 'private-deploy/release.mjs', 'private-deploy/sync-origin.mjs',
    'deploy/scripts/release.mjs', 'deploy/scripts/build-output.mjs',
    ...['lock', 'state', 'private-files', 'process'].map(name => `packages/plugin-manager/src/${name}.mjs`)];
  for (const file of files) {
    mkdirSync(dirname(join(checkout, file)), { recursive: true });
    cpSync(new URL('../../' + file, import.meta.url), join(checkout, file));
  }
  // Exercise the real private coordinator and public locks without requiring Docker or installation.
  writeFileSync(join(checkout, 'deploy/scripts/platform.mjs'), `export function prepareSourceRelease(root) { return { env: { ...process.env, PRIVATE_PREPARED_ROOT: root } }; }`);
  writeFileSync(join(checkout, 'deploy/scripts/build.mjs'), workerSource('old'));
  writeFileSync(join(checkout, 'deploy/scripts/deployment.mjs'), `console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 5;`);
  git(checkout, 'add', 'build.sh', 'build.ps1', 'private-deploy', 'deploy', 'packages');
  git(checkout, 'commit', '-m', '建立私有入口隔离测试');
  git(origin, 'fetch', checkout, 'main'); git(origin, 'merge', '--ff-only', 'FETCH_HEAD');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
  const run = (...args) => spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'sh',
    process.platform === 'win32' ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(checkout, 'build.ps1'), ...args] : [join(checkout, 'build.sh'), ...args],
    { cwd: f.root, env, encoding: 'utf8', windowsHide: true });
  return { ...f, env, run, worker: join(checkout, '.local/worker.json'), lock: join(checkout, '.local/source-release.node.lock') };
}

test('the private platform entry fast-forwards origin and starts updated source with intact arguments and environment', t => {
  const f = entryFixture(t);
  f.commit(f.origin, 'deploy/scripts/build.mjs', workerSource('updated', 7));
  const args = ['--config', '中文 --help 配置 with spaces.conf'];
  const result = f.run(...args);
  assert.equal(result.status, 7, result.stderr);
  const observed = JSON.parse(readFileSync(f.worker));
  assert.equal(observed.label, 'updated'); assert.deepEqual(observed.args, args);
  assert.equal(resolve(observed.cwd), resolve(f.checkout)); assert.equal(resolve(observed.preparedRoot), resolve(f.checkout));
  assert.notEqual(observed.pid, observed.owner);
  assert.equal(f.git(f.checkout, 'rev-parse', 'HEAD'), f.git(f.origin, 'rev-parse', 'HEAD'));
  assert.equal(existsSync(f.lock), false);
  assert.match(f.git(f.checkout, 'branch', '--list', 'backup/before-origin-*'), /backup\/before-origin-/);
  assert.equal(f.git(f.checkout, 'branch', '--list', '*codex*'), '');
});

test('help and management need no sync or deployment preflight; resume preserves source and pending input', t => {
  const f = entryFixture(t);
  f.git(f.checkout, 'remote', 'set-url', 'origin', join(f.root, 'missing-origin'));
  writeFileSync(join(f.checkout, 'framework.txt'), 'dirty source preserved');
  assert.equal(f.run('--help').status, 0);
  assert.equal(f.run('release', '--help').status, 0);
  const args = ['paths', '--config', '中文 config with spaces.conf'];
  const management = f.run(...args);
  assert.equal(management.status, 5, management.stderr); assert.deepEqual(JSON.parse(management.stdout), args);
  assert.equal(existsSync(f.lock), false); assert.equal(existsSync(f.worker), false);
  mkdirSync(join(f.checkout, '.local'), { recursive: true });
  const pointer = join(f.checkout, '.local/source-release.json'), original = JSON.stringify({ status: 'prepared', operation: 'preserved' });
  writeFileSync(pointer, original);
  assert.equal(f.run('--resume').status, 0);
  assert.equal(readFileSync(pointer, 'utf8'), original);
  assert.equal(readFileSync(join(f.checkout, 'framework.txt'), 'utf8'), 'dirty source preserved');
  assert.equal(existsSync(f.lock), false);
});

test('invalid arguments and ordinary sync failures do not build and release the source lock', t => {
  const f = entryFixture(t);
  f.git(f.checkout, 'remote', 'set-url', 'origin', join(f.root, 'missing-origin'));
  const invalid = f.run('--unsupported');
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Unknown or duplicate argument/);
  const failed = f.run();
  assert.equal(failed.status, 1); assert.equal(existsSync(f.worker), false); assert.equal(existsSync(f.lock), false);
});

test('Linux flock continuously covers Git sync and the worker without reacquiring the same lock', { skip: process.platform !== 'linux' }, t => {
  const f = entryFixture(t), bin = join(f.root, 'bin'); mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  assert.ok(!realGit.includes("'"));
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nflock -n .local/source-release.lock true && exit 97\n[ -f .local/source-release.node.lock ] || exit 98\nprintf '%s\\n' "$*" >> .local/sync-lock-evidence\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  f.env.PATH = `${bin}${delimiter}${process.env.PATH}`; f.env.PRIVATE_CHECK_FLOCK = '1';
  f.commit(f.origin, 'deploy/scripts/build.mjs', workerSource('locked-new-worker'));
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const evidence = readFileSync(join(f.checkout, '.local/sync-lock-evidence'), 'utf8');
  assert.match(evidence, /fetch --no-recurse-submodules origin/); assert.match(evidence, /merge --ff-only/); assert.match(evidence, /rev-parse --short HEAD/);
  assert.equal(JSON.parse(readFileSync(f.worker)).label, 'locked-new-worker');
  assert.equal(existsSync(f.lock), false); assert.equal(existsSync(join(f.checkout, '.local/source-release.lock')), true);
  rmSync(f.worker);
  const locked = spawnSync('flock', ['-n', '.local/source-release.lock', 'sh', 'build.sh'], { cwd: f.checkout, env: f.env, encoding: 'utf8' });
  assert.notEqual(locked.status, 0); assert.equal(existsSync(f.worker), false);
});

test('a signalled Git child retains the shared source lock before any worker starts', { skip: process.platform === 'win32' ? 'POSIX child signal reporting is unavailable on Windows.' : false }, t => {
  const f = entryFixture(t), bin = join(f.root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nkill -KILL $$\n', { mode: 0o755 });
  f.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  const result = f.run();
  assert.equal(result.status, 1); assert.equal(existsSync(f.worker), false);
  assert.equal(existsSync(f.lock), true);
  assert.equal(JSON.parse(readFileSync(f.lock)).workerPid, undefined);
});
