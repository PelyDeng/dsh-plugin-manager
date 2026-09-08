import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inspectDocker, ensureDockerIdentity, dockerArguments, checkDockerMounts, proveDockerHome, assertStoppedCompose, executeDocker } from '../src/docker-runtime.mjs';

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
  const compose = { services: { dsh: { image, environment: { DSH_HOME: '/data/home', DSH_PROFILE: 'web' }, volumes: [{ type: 'bind', source: home, target: '/data/home' }, { type: 'bind', source: file, target: '/run/settings', read_only: true }] } } };
  assertStoppedCompose(compose, [id], image, run, runtime);
  const wrong = join(root, 'wrong.conf'); writeFileSync(wrong, 'different-source');
  compose.services.dsh.volumes[1].source = wrong;
  assert.throws(() => assertStoppedCompose(compose, [id], image, run, runtime), /来源不匹配/);
  assert.deepEqual(readdirSync(home), []);
});

test('backup proof rejects missing, running, wrong-image and wrong native-source containers', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stopped-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const id = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`;
  const compose = { services: { dsh: { image, environment: { DSH_HOME: '/data', DSH_PROFILE: 'web' }, volumes: [{ type: 'bind', source: root, target: '/data' }] } } };
  const container = { Id: id, State: { Running: false, Restarting: false }, Config: { Image: image, Labels: { 'com.docker.compose.service': 'dsh' }, Env: ['DSH_HOME=/data', 'DSH_PROFILE=web'] }, Mounts: [{ Type: 'bind', Source: root, Destination: '/data', RW: true }] };
  const execute = () => JSON.stringify([container]);
  assertStoppedCompose(compose, [id], image, execute, { desktop: false });
  assert.throws(() => assertStoppedCompose(compose, [], image, execute, { desktop: false }), /旧容器/);
  container.State.Restarting = true;
  assert.throws(() => assertStoppedCompose(compose, [id], image, execute, { desktop: false }), /完全停止/);
  container.State.Restarting = false; container.Config.Image = 'another-image';
  assert.throws(() => assertStoppedCompose(compose, [id], image, execute, { desktop: false }), /镜像/);
  container.Config.Image = image; container.Mounts[0].Source = dirname(root);
  assert.throws(() => assertStoppedCompose(compose, [id], image, execute, { desktop: false }), /来源不匹配/);
});
