/** Opt-in consumption of real manager/kit archives and official DSH, with isolated temporary homes. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { runPnpm } from '../src/run-plugin-task.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const [managerArchive, kitArchive, cli, authManifest] = process.argv.slice(2).map(value => resolve(value));
if (![managerArchive, kitArchive, cli, authManifest].every(value => value && existsSync(value))) throw new Error('Usage: external-host-smoke.mjs <manager.tgz> <kit.tgz> <official-cli.js> <auth-manifest.json>');
const operation = mkdtempSync(join(tmpdir(), 'dsh-independent-'));
const tools = join(operation, 'tools'); mkdirSync(tools);
writeFileSync(join(tools, 'package.json'), '{"private":true}');
runPnpm(['add', '--ignore-workspace', managerArchive], tools);
const manager = join(tools, 'node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs');
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DSH_|PLUGIN_|DEPLOYMENT_CONFIG$|DEEPSEEK_)/u.test(name)));
env.DSH_TELEMETRY_DISABLED = '1';
const redact = text => text.replace(/\?token=\S+/gu, '?token=[redacted]');
function run(entry, args, extra = {}) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: operation, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) {
    writeFileSync(join(operation, 'failure.log'), redact((result.stdout ?? '') + (result.stderr ?? '')));
    throw new Error(`Command failed (${result.status}); diagnostics: ${operation}`);
  }
  return result.stdout;
}
const releases = [];
for (const example of ['standalone-plugin', 'standalone-kit']) {
  const source = join(operation, example); cpSync(join(repo, 'examples', example), source, { recursive: true });
  if (example === 'standalone-kit') runPnpm(['add', '--ignore-workspace', '--save-dev', kitArchive], source);
  else runPnpm(['install', '--ignore-workspace'], source);
  const release = join(operation, `${example}-release`);
  run(manager, ['pack', '--root', source, '--package', '.', '--output', release]);
  releases.push(release);
  renameSync(source, `${source}-moved`);
}
const [plainRelease, kitRelease] = releases;
const plain = JSON.parse(readFileSync(join(plainRelease, 'manifest.json')));
const combined = join(operation, 'combined');
run(manager, ['compose-release', '--root', operation, '--output', combined, '--manifest', authManifest, '--manifest', join(plainRelease, 'manifest.json'), '--manifest', join(kitRelease, 'manifest.json')]);
const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
let child, log = '', managedRoot;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (managedRoot) run(manager, ['stop', '--root', managedRoot, '--home', join(managedRoot, '.local/data/home')]);
  else child.kill('SIGTERM');
  for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) throw new Error(`Host failed to stop: ${operation}`);
  child = undefined; managedRoot = undefined;
}
async function start(entry, args, extra, path, status) {
  log = '';
  child = spawn(process.execPath, [entry, ...args], { cwd: operation, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try { if ((await fetch(origin + path, { signal: AbortSignal.timeout(1000) })).status === status) return; } catch { /* The local listener is still starting. */ }
    await delay(100);
  }
  writeFileSync(join(operation, 'host.log'), redact(log));
  throw new Error(`Host not ready: ${operation}`);
}
async function startManaged(label, manifest, path, status) {
  managedRoot = join(operation, label); mkdirSync(managedRoot, { recursive: true });
  const home = join(managedRoot, '.local/data/home');
  const config = join(managedRoot, 'deployment.json');
  await start(manager, ['start', '--root', managedRoot, '--home', home, ...(existsSync(config) ? ['--config', config] : []), '--manifest', manifest, '--plugins', 'all', '--mode', 'release', '--dsh-cli-js', cli, '--port', String(port), '--public-url', origin], { DSH_AUTH_STATE_DIR: join(home, 'auth') }, path, status);
  // Endpoint availability can precede the manager's transaction finalization.
  for (let i = 0; i < 100 && !existsSync(join(home, 'profiles/web/.deepseek-plugin-state.json')); i++) await delay(100);
  return home;
}
try {
  const rawHome = join(operation, 'raw-home');
  run(cli, ['plugin', '--profile', 'web', 'add', `file:${join(plainRelease, plain.plugins[0].archive)}`], { DSH_HOME: rawHome });
  await start(cli, ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { DSH_HOME: rawHome }, '/independent-example/ready', 200);
  await stop(); console.log('PASS official Bundle without manager or kit');
  await startManaged('site-instance', join(plainRelease, 'manifest.json'), '/independent-example/ready', 200);
  run(manager, ['health', '--root', managedRoot, '--home', join(managedRoot, '.local/data/home'), '--port', String(port)]);
  await stop(); console.log('PASS relocated v2 managed release without source');
  writeFileSync(join(operation, 'site-instance/deployment.json'), JSON.stringify({ plugins: ['independent-example'] }));
  const home = await startManaged('site-instance', join(combined, 'manifest.json'), '/auth/health', 200);
  assert.equal((await fetch(origin + '/independent-example/ready')).status, 200);
  console.log('PASS add second application despite prior selection; first application retained');
  const request = (path, data, session) => fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', 'x-dsh-csrf': session?.csrf ?? 'login', ...(session ? { cookie: session.cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  assert.equal((await request('/independent-access-example/identity')).status, 401);
  const password = 'Independent-fixture-2026';
  async function login(username, suppliedPassword = password) {
    const response = await request('/auth/api/login', { username, password: suppliedPassword }); assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).csrf };
  }
  const initial = await login('admin', '123456');
  assert.equal((await request('/auth/api/password', { currentPassword: '123456', newPassword: password }, initial)).status, 200);
  const admin = await login('admin');
  assert.equal((await request('/auth/api/users', { username: 'fixture_user', password, role: 'user', grants: [] }, admin)).status, 200);
  const user = await login('fixture_user');
  assert.equal((await request('/independent-access-example/identity', undefined, user)).status, 403);
  assert.equal((await request('/auth/api/users', { username: 'fixture_reader', password, role: 'user', grants: ['independent-access-example'] }, admin)).status, 200);
  const reader = await login('fixture_reader');
  const allowed = await request('/independent-access-example/identity', undefined, reader); assert.equal(allowed.status, 200); assert.ok((await allowed.json()).owner);
  run(manager, ['health', '--root', managedRoot, '--home', home, '--port', String(port)]);
  await stop(); console.log('PASS kit tgz: anonymous 401, ungranted 403, ordinary authorized 200');
  const settingsPath = join(home, 'plugins/independent-access-example/plugin.json');
  mkdirSync(join(home, 'plugins/independent-access-example'), {recursive: true});
  writeFileSync(settingsPath, JSON.stringify({schemaVersion:1, enabled:true, accessMode:'authenticated', config:{}}));
  const settings = readFileSync(settingsPath, 'utf8');
  const updatedSource = join(operation, 'standalone-kit');
  renameSync(join(operation, 'standalone-kit-moved'), updatedSource);
  const metadataPath = join(updatedSource, 'package.json');
  const metadata = JSON.parse(readFileSync(metadataPath)); metadata.version = '0.1.1'; writeFileSync(metadataPath, JSON.stringify(metadata));
  const updatedRelease = join(operation, 'updated-release');
  run(manager, ['pack','--root',updatedSource,'--package','.','--output',updatedRelease]);
  renameSync(updatedSource, join(operation,'author-removed-again'));
  const updatedCombined = join(operation, 'updated-combined');
  run(manager, ['compose-release','--root',operation,'--output',updatedCombined,'--manifest',authManifest,'--manifest',join(plainRelease,'manifest.json'),'--manifest',join(updatedRelease,'manifest.json'),'--previous',join(combined,'manifest.json')]);
  // Replace the visible directory at a stable path, as a changed container bind mount does.
  renameSync(combined, join(operation, 'combined-history')); cpSync(updatedCombined, combined, { recursive: true });
  await startManaged('site-instance',join(combined,'manifest.json'),'/auth/health',200);
  const returning = await login('fixture_reader');
  assert.equal((await request('/independent-access-example/identity',undefined,returning)).status,200);
  assert.equal(readFileSync(settingsPath,'utf8'),settings);
  assert.equal((await fetch(origin + '/independent-example/ready')).status, 200);
  await stop(); console.log('PASS fixed-path update retains accounts, grants and instance settings');
  writeFileSync(join(operation, 'result.json'), JSON.stringify({ platform: process.platform, node: process.version, managerVersion: '0.3.0', rawBundle: true, relocatedRelease: true, authStatuses: [401, 403, 200], updatePreservesState: true }, null, 2));
  console.log(`Evidence: ${operation}`);
} finally { await stop(); }
