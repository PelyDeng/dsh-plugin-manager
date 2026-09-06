/** The periodic CLI consumes recorded state, not deployment archive descriptors. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJSON, PENDING, STATE } from '../src/state.mjs';
import { statePlugin } from '../src/installation.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

async function fixture(t, plugins = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-health-'));
  const statuses = { '/': 200, '/weather/ready': 200 };
  const requested = [];
  const server = createServer((request, response) => {
    requested.push(request.url);
    response.writeHead(statuses[request.url] ?? 404); response.end();
  });
  t.after(async () => {
    await new Promise(resolveClose => { server.close(resolveClose); server.closeAllConnections(); });
    assert.equal(dirname(root), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const profile = join(root, '.local/data/dsh-home/profiles/web');
  const packageRoot = join(profile, 'node_modules/weather-plugin');
  const manifest = { dependencies: { 'weather-plugin': 'file:unavailable.tgz' }, dsh: { profile: { bundles: ['weather-plugin'] } } };
  const installed = { name: 'weather-plugin', version: '1.0.0', main: './index.js' };
  atomicJSON(join(profile, 'package.json'), manifest);
  atomicJSON(join(packageRoot, 'package.json'), installed);
  writeFileSync(join(packageRoot, 'index.js'), 'export {};\n');
  atomicJSON(join(profile, STATE), { schemaVersion: 2, plugins: plugins ? [statePlugin({ id: 'weather', package: installed.name, version: installed.version, sha256: 'a'.repeat(64), mode: 'release', healthPath: '/weather/ready' })] : [] });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_') && !['DEPLOYMENT_CONFIG', 'PLUGIN_MANIFEST_FILE'].includes(key)));
  const run = () => execute(process.execPath, [cli, 'health', '--root', root, '--base-url', `http://127.0.0.1:${server.address().port}`], { env, timeout: 15000 });
  return { run, statuses, requested, profile, packageRoot, manifest, installed };
}

test('health CLI accepts real persisted state without release archives or verifyFiles', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.deepEqual(JSON.parse(result.stdout), [{ id: 'weather', installed: true, activated: 'unknown', ready: 'ready' }]);
  assert.deepEqual(f.requested, ['/', '/weather/ready']);
});

test('health CLI rejects package name, version, Bundle and entry drift', async t => {
  const f = await fixture(t);
  for (const override of [{ name: 'other-plugin' }, { version: '2.0.0' }, { main: './missing.js' }]) {
    atomicJSON(join(f.packageRoot, 'package.json'), { ...f.installed, ...override });
    await assert.rejects(f.run(), /安装或 Bundle 漂移|插件入口缺失或无效/);
  }
  atomicJSON(join(f.packageRoot, 'package.json'), f.installed);
  atomicJSON(join(f.profile, 'package.json'), { ...f.manifest, dsh: { profile: { bundles: [] } } });
  await assert.rejects(f.run(), /安装或 Bundle 漂移/);
});

test('health CLI rejects an unhealthy declared plugin endpoint', async t => {
  const f = await fixture(t);
  f.statuses['/weather/ready'] = 503;
  await assert.rejects(f.run(), /就绪探针失败 HTTP 503/);
});

test('health CLI still checks the host when no plugins are enabled', async t => {
  const f = await fixture(t, false);
  assert.deepEqual(JSON.parse((await f.run()).stdout), []);
  f.statuses['/'] = 503;
  await assert.rejects(f.run(), /宿主存活检查失败 HTTP 503/);
});

test('health CLI rejects pending deployment before probing', async t => {
  const f = await fixture(t);
  atomicJSON(join(f.profile, PENDING), {});
  await assert.rejects(f.run(), /部署尚未完成/);
  assert.deepEqual(f.requested, []);
});
