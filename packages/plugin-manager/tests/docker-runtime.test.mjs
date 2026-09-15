import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectDocker, ensureDockerIdentity, dockerArguments, checkDockerMounts, proveDockerHome, assertStoppedBinding, assertNoOverlappingWriters, composeContainers, executeDocker, locationForms, sameOrWithinLocation } from '../src/docker-runtime.mjs';

test('Docker inspection pins the selected local endpoint and rejects remote, Windows and changed engines', t => {
  const saved = { DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.DOCKER_HOST = 'unix:///run/user/1000/docker.sock'; delete process.env.DOCKER_CONTEXT;
  const calls = [], info = { ID: 'engine-a', OSType: 'linux', Architecture: 'aarch64', OperatingSystem: 'Docker Desktop' };
  const execute = args => { calls.push(args); return args.includes('info') ? JSON.stringify(info) : 'v2'; };
  const runtime = inspectDocker(execute);
  assert.deepEqual(runtime, { endpoint: process.env.DOCKER_HOST, id: 'engine-a', architecture: 'arm64', desktop: true });
  assert.ok(calls.every(args => args[0] === '--host' && args[1] === runtime.endpoint));
  ensureDockerIdentity(runtime, { ...runtime });
  assert.throws(() => ensureDockerIdentity(runtime, { ...runtime, id: 'other' }), /Docker/);
  info.OperatingSystem = 'Ubuntu';
  assert.equal(inspectDocker(execute).desktop, ['win32', 'darwin'].includes(process.platform));
  info.OSType = 'windows'; assert.throws(() => inspectDocker(execute), /Linux Docker/);
  process.env.DOCKER_HOST = 'ssh://remote'; assert.throws(() => inspectDocker(execute), /远端 Docker/);
});

test('stopped-container proof reads its original volumes and removes only its own challenge', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-proof-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'user-file'), 'keep');
  const container = { Id: 'a'.repeat(64), State: { Running: false, Restarting: false }, Config: { Env: ['DSH_HOME=/data/home'] } };
  const execute = args => {
    assert.ok(args.includes(`${container.Id}:ro`));
    assert.equal(args.includes('--mount'), false);
    const filename = args.at(-1).split('/').at(-1);
    return readFileSync(join(root, filename), 'utf8');
  };
  assert.equal(proveDockerHome({ home: root }, container, `sha256:${'b'.repeat(64)}`, execute), true);
  assert.deepEqual(readdirSync(root), ['user-file']);
  assert.throws(() => proveDockerHome({ home: root }, container, 'image', () => { throw new Error('mount denied'); }), /mount denied/);
  assert.deepEqual(readdirSync(root), ['user-file']);
  assert.equal(proveDockerHome({ home: root }, { ...container, State: { Running: true } }, 'image', execute), false);
});

test('real Docker mount and stopped-home probes use an isolated disposable container', { skip: !process.env.DSH_DOCKER_PROBE_IMAGE }, t => {
  const runtime = inspectDocker(), run = (args, options) => executeDocker(dockerArguments(runtime, args), options);
  const image = JSON.parse(run(['image', 'inspect', process.env.DSH_DOCKER_PROBE_IMAGE], { encoding: 'utf8' }))[0].Id;
  assert.match(image, /^sha256:[a-f0-9]{64}$/u);
  const root = mkdtempSync(join(tmpdir(), 'dsh-docker-中文 空格-')), home = join(root, 'home'); mkdirSync(home);
  const file = join(root, 'readonly.conf'); writeFileSync(file, 'private-test-content', { mode: 0o600 });
  let id;
  t.after(() => {
    if (id) { assert.match(id, /^[a-f0-9]{64}$/u); run(['rm', id], { stdio: 'pipe' }); }
    assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true });
  });
  checkDockerMounts({ image, user: '1000:1000', volumes: [{ source: home, target: '/data/home' }, { source: file, target: '/run/settings', read_only: true }] }, run);
  assert.deepEqual(readdirSync(home), []);
  id = String(run(['create', '--network', 'none', '--mount', `type=bind,source=${home},target=/data/home`, '--mount', `type=bind,source=${file},target=/run/settings,readonly`, '--env', 'DSH_HOME=/data/home', '--env', 'DSH_PROFILE=web', '--label', 'com.docker.compose.service=dsh', '--entrypoint', 'node', image, '-e', 'process.exit(0)'], { encoding: 'utf8' })).trim();
  const container = JSON.parse(run(['inspect', id], { encoding: 'utf8' }))[0];
  assert.equal(proveDockerHome({ home }, container, image, run), true);
  const binding = { dataRoot: root, home, workspace: join(root, 'workspace'), artifacts: join(root, 'artifacts'), profile: 'web' };
  // Desktop 的挂载证明要起一次性容器：必须显式传本次已核验的镜像，不能用旧容器的镜像。
  assertStoppedBinding([id], binding, run, runtime, image);
  // 容器内 home 必须通过实际挂载映射回绑定的 home；换了绑定目录即拒绝。
  assert.throws(() => assertStoppedBinding([id], { ...binding, home: join(root, 'other-home') }, run, runtime, image), /不一致/);
  assert.deepEqual(readdirSync(home), []);
});

test('the stopped-service proof accepts zero containers and rejects running or foreign mounts, without image generations', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stopped-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const id = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`;
  const binding = { dataRoot: join(root, 'data'), home: join(root, 'data-home'), workspace: join(root, 'workspace'), artifacts: join(root, 'artifacts'), profile: 'web' };
  mkdirSync(binding.home, { recursive: true });
  const container = { Id: id, State: { Running: false, Restarting: false }, Config: { Image: image, Labels: { 'com.docker.compose.service': 'dsh' }, Env: ['DSH_HOME=/data/home', 'DSH_PROFILE=web'] }, Mounts: [{ Type: 'bind', Source: binding.home, Destination: '/data/home', RW: true }] };
  const execute = () => JSON.stringify([container]);
  // 零容器是合法已停现场：不再要求旧容器存在。
  assert.deepEqual(assertStoppedBinding([], binding, execute, { desktop: false }), []);
  assertStoppedBinding([id], binding, execute, { desktop: false });
  container.State.Restarting = true;
  assert.throws(() => assertStoppedBinding([id], binding, execute, { desktop: false }), /未完全停止/);
  container.State.Restarting = false;
  // 容器属于哪一代镜像不再作为准入条件：只核对停服、profile、home 映射与可写挂载归属。
  container.Config.Image = 'another-image';
  assertStoppedBinding([id], binding, execute, { desktop: false });
  const wrongHome = { ...container, Mounts: [{ Type: 'bind', Source: join(root, 'other'), Destination: '/data/home', RW: true }] };
  assert.throws(() => assertStoppedBinding([id], binding, () => JSON.stringify([wrongHome]), { desktop: false }), /不一致/);
  const foreign = { ...container, Mounts: [...container.Mounts, { Type: 'bind', Source: join(root, 'elsewhere'), Destination: '/data/other', RW: true }] };
  assert.throws(() => assertStoppedBinding([id], binding, () => JSON.stringify([foreign]), { desktop: false }), /不属于站点绑定/);
  const foreignProfile = { ...container, Config: { ...container.Config, Env: ['DSH_HOME=/data/home', 'DSH_PROFILE=other'] } };
  assert.throws(() => assertStoppedBinding([id], binding, () => JSON.stringify([foreignProfile]), { desktop: false }), /profile 与站点绑定不一致/);
});

test('current service containers come from a live project query, not from old records', () => {
  const calls = [];
  const containers = composeContainers(args => { calls.push(args); return args.includes('-a') ? `${'a'.repeat(64)}\n` : ''; }, { desktop: false }, 'site');
  assert.deepEqual(containers, { running: [], all: ['a'.repeat(64)] });
  assert.equal(calls.length, 2);
  for (const args of calls) assert.ok(args.includes('label=com.docker.compose.project=site'));
});

test('overlapping container writers are refused even when this project has no container', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-writers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { dataRoot: join(root, 'data'), home: join(root, 'data-home'), workspace: join(root, 'workspace'), artifacts: join(root, 'artifacts'), profile: 'web' };
  const mount = source => [{ Type: 'bind', Source: source, Destination: '/data', RW: true }];
  const running = { Id: 'c'.repeat(64), State: { Running: true }, Mounts: mount(binding.dataRoot) };
  const stopped = { Id: 'd'.repeat(64), State: { Running: false }, Mounts: mount(binding.dataRoot) };
  const readonly = { Id: 'e'.repeat(64), State: { Running: true }, Mounts: [{ ...mount(binding.home)[0], RW: false }] };
  const execute = containers => args => args[0] === 'ps' ? containers.map(container => container.Id).join('\n') : JSON.stringify(containers);
  // 本项目零容器不等于没有写入者：其他容器写同一批持久目录同样要拦住。
  assert.deepEqual(assertNoOverlappingWriters(binding, execute([]), { desktop: false }), []);
  assert.deepEqual(assertNoOverlappingWriters(binding, execute([stopped, readonly]), { desktop: false }), [stopped, readonly]);
  assert.throws(() => assertNoOverlappingWriters(binding, execute([running]), { desktop: false }), /正在写入站点持久目录/);
  // 挂载父目录同样是重叠写入者。
  const parent = { ...running, Mounts: mount(root) };
  assert.throws(() => assertNoOverlappingWriters(binding, execute([parent]), { desktop: false }), /正在写入站点持久目录/);
});

test('Desktop mount proof refuses to fall back to the old container image', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { dataRoot: join(root, 'data'), home: join(root, 'home'), workspace: join(root, 'workspace'), artifacts: join(root, 'artifacts'), profile: 'web' };
  const container = { Id: 'a'.repeat(64), State: { Running: false, Restarting: false }, Config: { Image: 'old-image', Labels: { 'com.docker.compose.service': 'dsh' }, Env: ['DSH_HOME=/data/home', 'DSH_PROFILE=web'] }, Mounts: [{ Type: 'bind', Source: binding.home, Destination: '/data/home', RW: true }] };
  // 旧容器的镜像可能已被删除：证明只能用本次已核验的镜像，缺了就直接失败。
  assert.throws(() => assertStoppedBinding([container.Id], binding, () => JSON.stringify([container]), { desktop: true }), /本次已核验的运行镜像/);
});

test('Desktop mount proof must really read the challenge back from the host directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-probe-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binding = { dataRoot: root, home, workspace: join(root, 'workspace'), artifacts: join(root, 'artifacts'), profile: 'web' };
  const container = { Id: 'a'.repeat(64), State: { Running: false, Restarting: false }, Config: { Labels: { 'com.docker.compose.service': 'dsh' }, Env: ['DSH_HOME=/data/home', 'DSH_PROFILE=web'] }, Mounts: [{ Type: 'bind', Source: home, Destination: '/data/home', RW: true }] };
  const image = `sha256:${'b'.repeat(64)}`;
  const inspect = JSON.stringify([container]);
  // 探针必须把挑战内容从宿主机目录读回来：返回别的内容说明容器挂的不是这个目录，一律拒绝。
  const wrong = args => (args[0] === 'run' ? 'not-the-challenge' : inspect);
  assert.throws(() => assertStoppedBinding([container.Id], binding, wrong, { desktop: true }, image), /挂载的数据目录与站点绑定不一致/);
  // 探针自己失败（容器起不来）同样拒绝，不能把「没证明成」当成「证明通过」。
  const failing = args => { if (args[0] === 'run') throw new Error('docker run failed'); return inspect; };
  assert.throws(() => assertStoppedBinding([container.Id], binding, failing, { desktop: true }, image), /docker run failed/);
  // 正例：探针从真实主机目录读回挑战内容才通过。
  const right = args => (args[0] === 'run' ? readFileSync(join(home, args.at(-1).split('/').at(-1)), 'utf8') : inspect);
  assert.doesNotThrow(() => assertStoppedBinding([container.Id], binding, right, { desktop: true }, image));
});

test('Docker Desktop VM path spellings are compared in one path space', t => {
  // VM 写法本身就是独立路径空间：不能拿它去和主机路径做字符串比较。
  assert.deepEqual(locationForms('/run/desktop/mnt/host/c/site/data'), [{ space: 'vm', path: '/run/desktop/mnt/host/c/site/data' }]);
  assert.equal(sameOrWithinLocation('/run/desktop/mnt/host/c/site/data', '/run/desktop/mnt/host/c/site/data/plugins'), true);
  assert.equal(sameOrWithinLocation('/run/desktop/mnt/host/c/other', '/run/desktop/mnt/host/c/site/data'), false);
  if (process.platform !== 'win32') return;
  // CI 的临时目录可能是 8.3 短名或联接点：locationForms 内部按 canonical 归一，这里必须用同一份路径比较。
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-desktop-space-')));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vm = path => `/run/desktop/mnt/host/${path[0].toLowerCase()}/${path.slice(3).replace(/\\/gu, '/')}`;
  const binding = { dataRoot: root, home, workspace: join(root, 'workspace'), artifacts: join(root, 'artifacts'), profile: 'web' };
  // Windows 上同一目录会派生 VM 写法：容器 inspect 给任何一种写法都要能认出来。
  assert.ok(locationForms(home).some(form => form.path === vm(home)));
  const mount = source => [{ Type: 'bind', Source: source, Destination: source === home ? '/data/home' : '/data', RW: true }];
  const writer = { Id: 'f'.repeat(64), State: { Running: true }, Mounts: mount(vm(root)) };
  const execute = containers => args => args[0] === 'ps' ? containers.map(container => container.Id).join('\n') : JSON.stringify(containers);
  // 重叠写入者用 VM 写法报出来时同样要拦住（字符串比较会判成「不重叠」）。
  assert.throws(() => assertNoOverlappingWriters(binding, execute([writer]), { desktop: true }), /正在写入站点持久目录/);
  // 本站点自己的可写挂载用 VM 写法报出来时不能再被误判为「不属于站点绑定」。
  const stopped = { Id: 'a'.repeat(64), State: { Running: false, Restarting: false }, Config: { Labels: { 'com.docker.compose.service': 'dsh' }, Env: ['DSH_HOME=/data/home', 'DSH_PROFILE=web'] }, Mounts: mount(vm(home)) };
  // Desktop 的 home 同一性用探针证明：替身把挑战内容从真实主机目录读回来。
  const probe = args => args[0] === 'run' ? readFileSync(join(home, args.at(-1).split('/').at(-1)), 'utf8') : JSON.stringify([stopped]);
  assert.doesNotThrow(() => assertStoppedBinding([stopped.Id], binding, probe, { desktop: true }, `sha256:${'b'.repeat(64)}`));
});
