/** 对账诊断必须只读：只报告现场差异，不写状态、不动容器；旧记录不构成发布准入。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolveDeployment } from '../src/config.mjs';
import { checkRecords } from '../src/check-records.mjs';

// 记录侧的 compose 声明旧镜像，运行容器来自新镜像——生产故障现场的形态。
const RECORDED = `sha256:${'1'.repeat(64)}`;
const CANDIDATE = `sha256:${'2'.repeat(64)}`;
const RUNNING = `sha256:${'3'.repeat(64)}`;

function write(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

/** 已删除机制留下的词汇不允许再出现在诊断输出里（设计 3 节：只报现场差异，不设准入）。 */
const REMOVED_VOCABULARY = /对账事务|不是同一代|续跑|拦下|--resume|--recover|needsResume|stopComplete|previousStateHash/u;

function fixture(t, { candidateImage = CANDIDATE, recordedImage = RECORDED, containerImage = RUNNING, pointerStatus = 'deployment-failed' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-check-records-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  write(join(root, 'deployment.json'), { composeProject: 'demo', containerImage, profile: 'web' });
  const operation = join(root, '.local/artifacts', `source-release-${randomUUID()}`);
  mkdirSync(join(operation, 'plugins'), { recursive: true });
  writeFileSync(join(operation, 'plugins', 'alpha-abc.tgz'), 'archive');
  write(join(operation, 'plugins/manifest.json'), { plugins: [{ id: 'alpha' }] });
  write(join(operation, 'deployment.json'), { containerImage: candidateImage });
  write(join(operation, 'result.json'), { schemaVersion: 3, inputKind: 'source', status: 'deployment-failed', operation, siteOperation: randomUUID(),
    candidatePath: join(operation, 'deployment.json'), previousRuntime: { containerImage: recordedImage },
    selectedPlugins: [{ id: 'alpha' }], enabledPlugins: ['alpha'] });
  write(join(root, '.local/source-release.json'), { operation, status: pointerStatus });
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

test('运行容器与记录镜像不同代只作现场差异，不再声称身份比对必然失败', t => {
  const f = fixture(t);
  const { execute, calls } = docker({ images: [CANDIDATE, RECORDED, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'container-replaced');
  assert.deepEqual(report.conditions, ['container-replaced']);
  assert.ok(report.differences.some(text => text.includes('允许的现场差异')));
  assert.doesNotMatch(JSON.stringify(report), REMOVED_VOCABULARY);
  assert.ok(calls.every(call => /^(image inspect|ps |inspect )/.test(call)));
});

test('构建计时只读读出最慢阶段，缺失或越界都不报错、不写文件', t => {
  const f = fixture(t);
  const timingPath = join(f.operation, 'timings.json');
  write(timingPath, { schemaVersion: 1, buildId: 'build-1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:10:00.000Z',
    wallMs: 600000, sumMs: 900000, overlapMs: 300000, exitCode: 0, status: 'ready', environment: { frameworkVersion: '0.18.0', inputKind: 'source' },
    stages: [{ id: 'stage-1-1', label: '构建运行镜像', elapsedMs: 500000, status: 'done' }, { id: 'stage-1-2', label: '构建内置插件', elapsedMs: 9000, status: 'done' }] });
  const recordPath = join(f.operation, 'result.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  record.timings = { path: timingPath };
  write(recordPath, record);
  const before = readdirSync(f.root, { recursive: true }).length;
  const { execute } = docker({ images: [CANDIDATE, RECORDED, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  const timings = report.facts.saved.build.timings;
  assert.equal(timings.slowest[0].label, '构建运行镜像');
  assert.equal(timings.slowest[0].elapsedMs, 500000);
  assert.equal(timings.wallMs, 600000);
  assert.equal(timings.stageCount, 2);
  // 报告要能分辨「哪一次构建」以及最慢阶段是否被截断。
  assert.equal(timings.buildId, 'build-1');
  assert.equal(timings.stagesTotal, 2);
  assert.equal(timings.slowestLimit, 5);
  assert.equal(timings.environment.frameworkVersion, '0.18.0');
  assert.equal(readdirSync(f.root, { recursive: true }).length, before, '只读诊断不得写文件');
  assert.doesNotMatch(JSON.stringify(report), REMOVED_VOCABULARY);
  // 路径越界与文件损坏都只报缺失：老记录与删掉计时的构建不该让诊断失败。
  const outside = join(dirname(f.root), `outside-timings-${randomUUID()}.json`);
  write(outside, { schemaVersion: 1, stages: [] });
  t.after(() => rmSync(outside, { force: true }));
  for (const path of [outside, join(f.operation, 'missing.json'), timingPath]) {
    const next = JSON.parse(readFileSync(recordPath, 'utf8'));
    next.timings = { path };
    write(recordPath, next);
    if (path === timingPath) writeFileSync(timingPath, 'not json');
    const result = checkRecords(f.deployment, execute);
    assert.equal(result.facts.saved.build.timings, null, `${path} 不应产生计时事实`);
    assert.ok(result.conditions.length, '计时缺失不改变既有判定');
  }
});

test('计时路径必须真的在站点根内：另一盘符的绝对路径不算越界', t => {
  const f = fixture(t);
  // Windows 上 relative('C:\\站点', 'E:\\x') 返回绝对路径而不是 '..'，只比较前缀会把它当成根内路径
  // 读出来、并把绝对路径写进报告。这里要一个真实的第二块盘：单盘机器显式跳过，不假装通过。
  const candidates = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:\\`).filter(drive => {
    try { return existsSync(drive) && !resolve(f.root).toLowerCase().startsWith(drive.toLowerCase()); } catch { return false; }
  });
  if (process.platform !== 'win32' || !candidates.length) { t.skip('需要一块与站点根不同的盘符（或非 Windows）：本机没有'); return; }
  const outside = join(candidates[0], `dsh-check-records-${randomUUID()}`, 'timings.json');
  mkdirSync(dirname(outside), { recursive: true });
  write(outside, { schemaVersion: 1, stages: [{ label: '不该被读到的阶段', elapsedMs: 1, status: 'done' }] });
  t.after(() => rmSync(dirname(outside), { recursive: true, force: true }));
  const recordPath = join(f.operation, 'result.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  record.timings = { path: outside };
  write(recordPath, record);
  const { execute } = docker({ images: [CANDIDATE, RECORDED, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.facts.saved.build.timings, null, '另一盘符的计时文件必须按越界处理');
  assert.ok(!JSON.stringify(report).includes('不该被读到的阶段'), '越界文件不得被读取');
  assert.ok(!JSON.stringify(report).includes(outside.replace(/\\/g, '\\\\')), '报告里不得出现越界的绝对路径');
});

test('失败指针只作诊断，不再声称会被未完成操作拦下', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [CANDIDATE, RECORDED, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.facts.pointer.status, 'deployment-failed');
  assert.equal(report.facts.pointer.unfinished, true);
  assert.ok(report.differences.some(text => text.includes('只作诊断')));
  assert.doesNotMatch(JSON.stringify(report), /拦下/u);
});

test('记录镜像已删且容器已被替换时两个条件并存，主判定取镜像缺失', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [CANDIDATE, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'candidate-image-missing');
  assert.ok(report.conditions.includes('container-replaced'), '并存的替换条件必须一并报告');
  assert.doesNotMatch(JSON.stringify(report), REMOVED_VOCABULARY);
  assert.ok(report.differences.some(text => text.includes('允许的现场差异')));
});

test('候选镜像缺失与容器被替换是两个分支', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'candidate-image-missing');
  assert.equal(report.facts.candidate.present, false);
  assert.ok(report.differences.some(text => text.includes('候选镜像不在本机')));
});

test('旧容器已消失只作诊断，不再要求显式接受新容器身份', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [CANDIDATE, RECORDED, RUNNING], containers: [] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'container-evidence-missing');
  assert.ok(report.differences.some(text => text.includes('旧容器已不存在')));
  assert.ok(report.plan.some(text => text.includes('只作诊断')));
  assert.doesNotMatch(JSON.stringify(report), REMOVED_VOCABULARY);
});

test('记录与现场一致时按正常流程发布', t => {
  const f = fixture(t, { recordedImage: RUNNING, containerImage: RUNNING });
  const { execute } = docker({ images: [CANDIDATE, RUNNING], containers: [container(RUNNING, { running: false })] });
  const report = checkRecords(f.deployment, execute);
  assert.equal(report.classification, 'consistent');
  assert.ok(report.plan.some(text => text.includes('按正常流程发布')));
  assert.doesNotMatch(JSON.stringify(report), REMOVED_VOCABULARY);
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
  assert.ok(report.notice.includes('不阻断普通 build'));
});

test('活动 Compose 缺启动参数时给出差异项', t => {
  const f = fixture(t);
  const { execute } = docker({ images: [CANDIDATE, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.ok(report.differences.some(text => text.includes('未显式声明启动参数')));
  assert.ok(readFileSync(join(f.root, 'deployment.json'), 'utf8').includes('demo'));
});

test('profile 钉住的归档不可达时给出差异项', t => {
  const f = fixture(t);
  rmSync(join(f.root, '.local/artifacts/pkg/alpha-abc.tgz'));
  const { execute } = docker({ images: [CANDIDATE, RUNNING], containers: [container(RUNNING)] });
  const report = checkRecords(f.deployment, execute);
  assert.ok(report.differences.some(text => text.includes('归档不可达')));
  assert.equal(report.facts.deployment.pinnedArchives[0].present, false);
});
