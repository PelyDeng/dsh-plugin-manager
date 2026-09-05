/** Exercise the real Nginx auth_request module with an isolated loopback upstream. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { renderConsoleGateway } from '../../../integrations/docker/render-console-gateway.mjs';

const binary = process.argv[2];
if (!binary) throw new Error('Usage: node console-gateway.smoke.mjs <nginx-binary>');
for (const bad of [0, 65536, '7902; return 200;', '-1', '01']) assert.throws(() => renderConsoleGateway(bad));
const directory = await mkdtemp(join(tmpdir(), 'dsh-gateway-'));
await mkdir(join(directory, 'logs'));
const socketPath = join(directory, 'nginx.sock');
let unavailable = false;
let forwarded;
const backend = createServer((req, res) => {
  if (req.url === '/auth/api/console-access') {
    forwarded = req.headers['x-original-uri'];
    const business = String(forwarded).startsWith('/business/');
    res.statusCode = unavailable ? 503 : business || req.headers.cookie === 'allowed' ? 204 : req.headers.cookie === 'denied' ? 403 : 401;
    if (res.statusCode === 401) res.setHeader('X-DSH-Login', `/auth?returnTo=${encodeURIComponent(forwarded)}`);
    res.end();
  } else {
    res.statusCode = req.url === '/native-denied' ? 401 : 200;
    res.end('upstream');
  }
});
backend.listen(0, '127.0.0.1');
await once(backend, 'listening');
const config = `pid ${directory}/nginx.pid; error_log stderr crit; events {} http {
  access_log ${directory}/access.log; map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  server { listen unix:${socketPath}; location = /logged-probe { return 200; } ${renderConsoleGateway(backend.address().port)} }
}`;
await writeFile(join(directory, 'nginx.conf'), config);
const child = spawn(binary, ['-p', directory, '-c', join(directory, 'nginx.conf'), '-g', 'daemon off;'], { stdio: ['ignore', 'ignore', 'pipe'] });
let errors = '';
child.stderr.on('data', bytes => { errors += bytes; });
const exited = once(child, 'exit');
async function get(path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { host: 'localhost', ...headers } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(errors);
    try { await stat(socketPath); ready = true; break; } catch { await delay(25); }
  }
  assert.ok(ready, errors || 'Nginx did not create its test socket');
  assert.equal((await get('/auth')).status, 200);
  assert.equal((await get('/auth/app.js')).status, 200);
  assert.equal((await get('/business/health')).status, 200);
  assert.equal((await get('/')).status, 401);
  assert.equal((await get('/api', { accept: 'application/json' })).status, 401);
  assert.equal((await get('/api', { accept: 'text/html' })).status, 401);
  assert.equal((await get('/', { accept: 'text/html' }, 'POST')).status, 401);
  const redirect = await get('/?token=opaque%2Bvalue', { accept: 'text/html' });
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.location, '/auth?returnTo=%2F%3Ftoken%3Dopaque%252Bvalue');
  await get(redirect.headers.location);
  await get('/auth/api/session?returnTo=%2F%3Ftoken%3Dopaque%252Bvalue');
  await get('/logged-probe');
  const accessLog = await readFile(join(directory, 'access.log'), 'utf8');
  assert.ok(accessLog.includes('/logged-probe'));
  assert.ok(!accessLog.includes('opaque'), 'Official credentials must not reach inherited access logs');
  assert.equal((await get('/', { cookie: 'denied', accept: 'text/html' })).status, 403);
  assert.equal((await get('/', { cookie: 'allowed' })).status, 200);
  assert.equal((await get('/api', { cookie: 'allowed' })).status, 200);
  assert.equal((await get('/native-denied', { cookie: 'allowed', accept: 'text/html' })).status, 401);
  assert.equal((await get('/api', { 'x-original-uri': '/business/health' })).status, 401);
  assert.equal(forwarded, '/api');
  assert.equal((await get('/__dsh_console_access')).status, 404);
  unavailable = true;
  assert.equal((await get('/', { cookie: 'allowed' })).status, 500);
  assert.equal((await get('/auth')).status, 200);
  console.log('Nginx gateway passed: public auth, delegated business, 401/403, HTML return path, upstream authentication, header spoofing, internal route, fail closed.');
} finally {
  child.kill('SIGTERM');
  await exited;
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
