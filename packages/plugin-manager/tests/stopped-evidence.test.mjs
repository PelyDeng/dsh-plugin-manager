/** compose 停写证据的容器状态判定：容器不存在是合法零容器现场，其余错误必须保持「无法核实」。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeContainerState, verifyStoppedEvidence } from '../src/process.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDeployment } from '../src/config.mjs';

const runtime = { endpoint: 'unix:///var/run/docker.sock', id: 'engine', desktop: false, architecture: 'amd64' };
const spawnWith = result => () => result;

test('容器状态判定区分运行、已停、已删除与无法核实', () => {
  assert.equal(composeContainerState(runtime, 'abc', spawnWith({ status: 0, stdout: 'true\n', stderr: '' })), 'running');
  assert.equal(composeContainerState(runtime, 'abc', spawnWith({ status: 0, stdout: 'false\n', stderr: '' })), 'stopped');
  assert.equal(composeContainerState(runtime, 'abc', spawnWith({ status: 1, stdout: '', stderr: 'Error: No such object: abc\n' })), 'absent');
  assert.equal(composeContainerState(runtime, 'abc', spawnWith({ status: 1, stdout: '', stderr: 'Error: No such container: abc\n' })), 'absent');
  // 引擎不可用、权限错误、输出异常都不是「零容器」：必须留在无法核实。
  assert.equal(composeContainerState(runtime, 'abc', spawnWith({ status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n' })), 'unavailable');
  assert.equal(composeContainerState(runtime, 'abc', spawnWith({ status: 1, stdout: '', stderr: 'permission denied\n' })), 'unavailable');
  assert.equal(composeContainerState(runtime, 'abc', spawnWith({ error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }), status: null })), 'unavailable');
  assert.equal(composeContainerState(runtime, 'abc', spawnWith({ status: 0, stdout: 'maybe\n', stderr: '' })), 'unavailable');
});

test('compose 证据在容器状态无法核实时失败，不静默放行', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stopped-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployment = resolveDeployment({ root, home: 'data/home' }, {});
  const evidence = join(root, 'stopped.json');
  writeFileSync(evidence, `${JSON.stringify({ schemaVersion: 1, home: deployment.home, profile: 'web', manager: 'compose', instanceId: 'deadbeef', stopped: true, stoppedAt: new Date().toISOString() })}\n`);
  // 引擎不可用（inspect 抛错）时必须报「需要可用的本机 Docker 引擎」，不能当成已停现场。
  assert.throws(() => verifyStoppedEvidence('stopped.json', deployment, { engine: { inspect: () => { throw new Error('没有可用的引擎'); } } }), /需要可用的本机 Docker 引擎/);
  // 引擎能查但状态读不出来：保留现场，不静默放行。
  const unavailable = { inspect: () => runtime, state: () => 'unavailable', assertNoWriters: () => { throw new Error('不该走到写入者核对'); } };
  assert.throws(() => verifyStoppedEvidence('stopped.json', deployment, { engine: unavailable }), /不能从 Docker 核验指定容器状态/);
  // 容器仍在运行：证据不符。
  const running = { inspect: () => runtime, state: () => 'running', assertNoWriters: () => { throw new Error('不该走到写入者核对'); } };
  assert.throws(() => verifyStoppedEvidence('stopped.json', deployment, { engine: running }), /实际运行状态与证据不符/);
});

test('容器已删除但引擎无重叠写入者时通过，有写入者时拒绝', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stopped-absent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployment = resolveDeployment({ root, home: 'data/home' }, {});
  writeFileSync(join(root, 'stopped.json'), `${JSON.stringify({ schemaVersion: 1, home: deployment.home, profile: 'web', manager: 'compose', instanceId: 'gone-container', stopped: true, stoppedAt: new Date().toISOString() })}\n`);
  const seen = [];
  const absent = { inspect: () => runtime, state: () => 'absent', assertNoWriters: (directories) => { seen.push(directories); } };
  const result = verifyStoppedEvidence('stopped.json', deployment, { engine: absent });
  assert.equal(result.instanceId, 'gone-container');
  assert.equal(seen.length, 1, '已删除的容器仍要核对引擎上的重叠写入者');
  assert.equal(seen[0].home, deployment.home);
  // 引擎里还有别的写入者：拒绝。
  const overlapping = { inspect: () => runtime, state: () => 'stopped', assertNoWriters: () => { throw new Error('容器 abc 正在写入站点持久目录：/srv/data'); } };
  assert.throws(() => verifyStoppedEvidence('stopped.json', deployment, { engine: overlapping }), /正在写入站点持久目录/);
});

test('实例标识先按格式校验，不被当成 Docker 参数', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stopped-id-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const deployment = resolveDeployment({ root, home: 'data/home' }, {});
  const evidence = join(root, 'stopped.json');
  // 证据是操作者给的文件：像 --help 这样的值不能被透传给 docker inspect。
  writeFileSync(evidence, `${JSON.stringify({ schemaVersion: 1, home: deployment.home, profile: 'web', manager: 'compose', instanceId: '--help', stopped: true, stoppedAt: new Date().toISOString() })}\n`);
  assert.throws(() => verifyStoppedEvidence('stopped.json', deployment), /实例标识无效/);
});
