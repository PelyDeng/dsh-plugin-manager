/** Consume real plugin archives in an isolated, network-disabled DSH runtime container. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRelease } from '../../../packages/plugin-manager/src/release.mjs';

if (!existsSync('/.dockerenv')) throw new Error('This smoke only runs in a disposable Docker container.');
const [manifest, runtimeConfig, results] = process.argv.slice(2);
if (!manifest || !runtimeConfig || !existsSync(runtimeConfig)) throw new Error('Usage: auth-host-smoke.mjs <manifest.json> <isolated closedoff env.conf> [results directory].');
const release = loadRelease(manifest);
for (const id of ['auth', 'closedoff']) if (!release.plugins.some(plugin => plugin.id === id)) throw new Error(`The release must contain ${id}.`);
const root = mkdtempSync(join(tmpdir(), 'dsh-auth-host-'));
const logs = results ?? root;
mkdirSync(logs, { recursive: true, mode: 0o700 });
const home = join(root, 'home');
const binary = process.env.DSH_CLI_JS ?? '/opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const origin = 'http://127.0.0.1:18702';
const env = { ...process.env, DSH_HOME: home, DSH_ACCESS_MODE: 'authenticated', DSH_PUBLIC_ORIGIN: origin };
const cli = (...args) => {
  const result = spawnSync(process.execPath, [binary, ...args], { env, encoding: 'utf8', timeout: 90000 });
  if (result.status !== 0) {
    writeFileSync(join(logs, 'cli-failure.log'), `${result.stdout}\n${result.stderr}`, { mode: 0o600 });
    throw new Error(`DSH plugin command failed; restricted diagnostics: ${logs}`);
  }
  return result.stdout.trim();
};
const hostVersion = cli('--version');
const storeArgs = process.env.DSH_STORE_DIR ? ['--store-dir', process.env.DSH_STORE_DIR] : [];
if (process.env.DSH_CACHE_DIR) storeArgs.push('--cache-dir', process.env.DSH_CACHE_DIR);
const install = name => cli('plugin', '--profile', 'web', 'add', '--offline', ...storeArgs,
  `file:${release.plugins.find(plugin => plugin.id === name).archivePath}`);
install('auth');
install('closedoff');
const profile = join(home, 'profiles/web/package.json');
const require = createRequire(profile);
const { bootstrap } = await import(pathToFileURL(require.resolve('dsh-auth/admin')).href);
const password = randomBytes(24).toString('base64url');
await bootstrap('smoke_admin', password, join(home, 'auth'), ['closedoff']);
env.CLOSEDOFF_ENV_CONF = runtimeConfig;

let child;
let output = '';
async function stop() {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 40 && child.exitCode === null; attempt++) await delay(50);
  if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
}
async function start(mode, ready) {
  output = '';
  child = spawn(process.execPath, [binary, '--profile', 'web', '--host', '127.0.0.1', '--port', '18702', '--no-open'], {
    env: { ...env, DSH_ACCESS_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes.toString(); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${origin}/closedoff-qa/ready`);
      if (response.status === ready) return;
    } catch { /* The newly spawned HTTP listener has not bound yet. */ }
    await delay(100);
  }
  writeFileSync(join(logs, 'host-failure.log'), output, { mode: 0o600 });
  throw new Error(`DSH host not ready; restricted diagnostics: ${logs}`);
}
const get = (path, cookie) => fetch(origin + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
try {
  await start('authenticated', 200);
  assert.equal((await get('/closedoff-qa')).status, 303);
  assert.equal((await get('/closedoff-qa/identity')).status, 401);
  const login = await fetch(`${origin}/auth/api/login`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-dsh-csrf': 'login' },
    body: JSON.stringify({ username: 'smoke_admin', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/closedoff-qa', cookie)).status, 200);
  assert.equal((await get('/closedoff-qa/identity', cookie)).status, 200);
  assert.equal((await get('/closedoff-qa/conversations', cookie)).status, 200);
  assert.equal((await get('/auth/api/console-access')).status, 401);
  assert.equal((await get('/auth/api/console-access', cookie)).status, 204);
  for (const asset of ['app.js', 'catalog-view.js', 'icons.svg', 'style.css']) {
    assert.equal((await get(`/auth/${asset}`)).status, 200);
  }
  const catalog = await (await get('/auth/api/plugins', cookie)).json();
  const closedoff = catalog.plugins.find(plugin => plugin.id === 'closedoff');
  assert.equal(closedoff.version, release.plugins.find(plugin => plugin.id === 'closedoff').version);
  assert.ok(closedoff.tools.length > 0);
  assert.equal(catalog.plugins.filter(plugin => plugin.id === 'auth').length, 1);
  const authVersion = catalog.plugins.find(plugin => plugin.id === 'auth').version;
  assert.equal(authVersion, release.plugins.find(plugin => plugin.id === 'auth').version);
  assert.ok(catalog.accessTargets.some(target => target.id === 'dsh-console'));
  await stop();
  await start('authenticated', 200);
  assert.equal((await get('/closedoff-qa/identity', cookie)).status, 200);
  await stop();

  cli('plugin', '--profile', 'web', 'remove', '--config.offline=true', ...storeArgs, 'dsh-auth');
  const removed = JSON.parse(readFileSync(profile, 'utf8'));
  assert.equal(removed.dependencies?.['dsh-auth'], undefined);
  assert.ok(!removed.dsh?.profile?.bundles?.includes('dsh-auth'));
  await start('authenticated', 503);
  assert.equal((await get('/closedoff-qa/identity', cookie)).status, 503);
  await stop();
  await start('standalone', 200);
  assert.equal((await get('/closedoff-qa')).status, 200);
  assert.equal((await get('/closedoff-qa/conversations')).status, 200);
  await stop();

  install('auth');
  await start('authenticated', 200);
  assert.equal((await get('/closedoff-qa/identity', cookie)).status, 200);
  const result = { hostVersion, auth: authVersion, closedoff: closedoff.version,
    installedArchives: true, sharedHost: true, registeredTools: closedoff.tools.length,
    persistedLogin: true, removeReinstall: true, missingProviderDenied: true, standalone: true };
  writeFileSync(join(logs, 'result.json'), JSON.stringify(result) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally { await stop(); }
