/** 对账诊断必须只读：只报告漂移类别，不写状态、不动容器。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolveDeployment } from '../src/config.mjs';
import { checkRecords } from '../src/check-records.mjs';

// 记录侧的 compose 声明旧镜像，运行容器来自新镜像——生产故障现场的形态。
const RECORDED = `sha256:${'1'.repeat(64)}`;
const CANDIDATE = `sha256:${'2'.repeat(64)}`;
const RUNNING = `sha256:${'3'.repeat(64)}`;

function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

function fixture(t, { candidateImage = CANDIDATE, recordedImage = RECORDED, stopComplete = false, containerImage = RUNNING } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-check-records-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  write(join(root, 'deployment.json'), { composeProject: 'demo', containerImage, profile: 'web' });
  const operation = join(root, '.local/artifacts', `source-release-${randomUUID()}`);
  mkdirSync(join(operation, 'plugins'), { recursive: true });
  writeFileSync(join(operation, 'plugins', 'alpha-abc.tgz'), 'archive');
  write(join(operation, 'plugins/manifest.json'), { plugins: [{ id: 'alpha' }] });
  write(join(operation, 'deployment.json'), { containerImage: candidateImage });
  write(join(operation, 'result.json'), { schemaVersion: 3, inputKind: 'source', status: 'deployment-failed', operation, siteOperation: randomUUID(),
    candidatePath: join(operation, 'deployment.json'), stopComplete, previousRuntime: { containerImage: recordedImage },
    selectedPlugins: [{ id: 'alpha' }], enabledPlugins: ['alpha'] });
  write(join(root, '.local/source-release.json'), { operation, status: 'deployment-failed' });
  const composePath = join(root, '.local/artifacts', randomUUID(), 'compose/compose.override.json');
  write(composePath, { services: { dsh: { image: recordedImage, environment: { DSH_HOME: '/data/dsh-home', DSH_PROFILE: 'web' } } } });
  write(join(root, '.local/artifacts/active-compose.json'), { schemaVersion: 1, path: composePath, appliedAt: '2026-01-01T00:00:00.000Z' });
  const pinned = join(root, '.local/artifacts/pkg/alpha-abc.tgz');
  mkdirSync(dirname(pinned), { recursive: true });
  writeFileSync(pinned, 'archive');
  write(join(root, '.local/data/dsh-home/profiles/web/package.json'), { dependencies: { 'dsh-alpha': `file:${pinned}` } });
  return { root, operation, deployment: resolveDeployment({ root, config: 'deployment.json' }, {}) };
}

/** Minimal docker double: only the read-only commands the diagnosis is allowed to run. */
function docker({ images = [], containers = [] } = {}) {
  const calls = [];
  const execute = (args, options) => {
    calls.push(args.join(' '));
    assert.equal(options?.encoding, 'utf8', 'docker 查询必须捕获输出');
    if (args[0] === 'image') return { status: images.includes(args.at(-1)) ? 0 : 1, stdout: 'sha256:found' };
    if (args[0] === 'ps') return { status: 0, stdout: `${containers.map(item => item.Id).join('\n')}\n` };
    if (args[0] === 'inspect') return { status: 0, stdout: JSON.stringify(containers) };
    throw new Error(`只读诊断不允许执行 docker ${args[0]}`);
  };
  return { execute, calls };
}

const container = (image, { running = true, profile = 'web', home = '/data/dsh-home' } = {}) => ({
  Id: 'a'.repeat(64), Name: '/demo-dsh-1', Image: image, State: { Running: running, Health: { Status: 'healthy' } },
  Config: { Image: image, Env: [`DSH_HOME=${home}`, `DSH_PROFILE=${profile}`], Labels: { 'com.docker.compose.service': 'dsh' } },
  Mounts: [{ Type: 'bind', Destination: '/data', RW: true }],
});

test('运行容器与记录镜像不同代判定为 container-replaced，并指出镜像身份比对必然失败', t => {
  const f = fixture(t);
  const { execute, calls } = docker({ images: [CANDIDATE, RECORDED, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'container-replaced');
  assert.deepEqual(report.conditions, ['container-replaced']);
  assert.ok(report.blockers.some(text => text.includes('不是同一代')));
  assert.ok(report.plan.some(text => text.includes('显式对账事务')));
  assert.ok(calls.every(call => /^(image inspect|ps |inspect )/.test(call)));
});

test('记录镜像已删且容器已被替换时两个条件并存，主判定取镜像缺失', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [CANDIDATE, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'candidate-image-missing');
  assert.ok(report.conditions.includes('container-replaced'), '并存的替换条件必须一并报告');
  assert.ok(report.plan.some(text => text.includes('确认接受新容器身份')) === false);
  assert.ok(report.blockers.some(text => text.includes('不是同一代')));
});

test('候选镜像缺失与容器被替换是两个分支', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'candidate-image-missing');
  assert.equal(report.facts.candidate.present, false);
  assert.ok(report.blockers.some(text => text.includes('失败候选镜像不存在')));
});

test('旧容器已消失判定为 container-evidence-missing，并要求显式接受新容器身份', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [CANDIDATE, RECORDED, RUNNING], containers: [] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'container-evidence-missing');
  assert.ok(!report.blockers.some(text => text.includes('不是同一代')));
  assert.ok(report.plan.some(text => text.includes('确认接受新容器身份')));
});

test('记录与现场一致时不报身份阻断项', t => {
  const f = fixture(t, { recordedImage: RUNNING, containerImage: RUNNING });
  const { execute } = docker({ images: [CANDIDATE, RUNNING], containers: [container(RUNNING, { running: false })] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'consistent');
  assert.ok(!report.blockers.some(text => text.includes('不是同一代')));
});

test('没有发布记录时给出 no-record，且不写任何文件', t => {
  const f = fixture(t);
  rmSync(join(f.root, '.local/source-release.json'));
  const before = readdirSync(f.root, { recursive: true }).length;
  const { execute } = docker({ images: [RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'no-record');
  assert.equal(report.facts.pointer.present, false);
  assert.equal(readdirSync(f.root, { recursive: true }).length, before, '只读诊断不得新增文件');
  assert.ok(report.notice.includes('未写入任何状态'));
});

test('活动 Compose 缺启动参数时给出显式阻断项', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [CANDIDATE, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.ok(report.blockers.some(text => text.includes('未显式声明启动参数')));
  assert.ok(readFileSync(join(f.root, 'deployment.json'), 'utf8').includes('demo'));
});

test('profile 钉住的归档不可达时给出阻断项', t => {
  const f = fixture(t);
  rmSync(join(f.root, '.local/artifacts/pkg/alpha-abc.tgz'));
  const { execute } = docker({ images: [CANDIDATE, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.ok(report.blockers.some(text => text.includes('归档不可达')));
  assert.equal(report.facts.deployment.pinnedArchives[0].present, false);
});
