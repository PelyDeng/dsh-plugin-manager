import { hostCLI, stopOwned } from './process.mjs';
import { runtimeEnvironment } from './config.mjs';
import { assertReleaseMode } from './release.mjs';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OWNER, STOPPED, atomicJSON, fail, privateFile, readOptional, synchronizedStopped, within } from './state.mjs';
import { acquireLock, finalize } from './installation.mjs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { hostname } from 'node:os';
/** Start one DSH child, keeping startup tokens out of normal logs. */
export async function supervise(deployment, release) {
  assertReleaseMode(release, deployment.mode);
  const cli = hostCLI(deployment);
  const runtime = runtimeEnvironment(deployment, release.plugins);
  mkdirSync(deployment.workspace, { recursive: true });
  const options = deployment.options;
  const port = options.port ?? process.env.DSH_PORT ?? deployment.config.port ?? '7902';
  const host = options.host ?? process.env.DSH_BIND_HOST ?? process.env.DSH_HOST ?? deployment.config.host ?? '127.0.0.1';
  const args = [];
  if (deployment.mode === 'development') for (const plugin of release.plugins) if (plugin.development) {
    const source = resolve(deployment.root, plugin.directory);
    const patch = resolve(source, plugin.development.patch);
    if (!within(source, patch)) fail(`${plugin.id}: 开发 patch 指向插件目录之外。`);
    args.push('--patch', patch);
  }
  for (const patch of deployment.config.patches ?? []) args.push('--patch', resolve(deployment.root, patch));
  args.unshift('--profile', deployment.profile);
  if (deployment.profile === 'web') args.push('--host', host, '--port', String(port), '--no-open');
  const trusted = options['trusted-hosts'] ?? process.env.DSH_TRUSTED_HOSTS ?? deployment.config.trustedHosts;
  if (trusted) for (const value of (Array.isArray(trusted) ? trusted : trusted.split(','))) args.push('--trusted-host', value);
  const env = { ...process.env, ...runtime.variables };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const startupUnlock = acquireLock(deployment.profileRoot);
  let startupLocked = true;
  const ownerPath = join(deployment.profileRoot, OWNER);
  const token = randomUUID();
  let stopped = true;
  let child;
  let server;
  const signals = ['SIGINT', 'SIGTERM']; const stop = () => child?.kill('SIGTERM');
  let exitedResolve;
  const exited = new Promise(resolvePromise => { exitedResolve = resolvePromise; });
  try {
  const justStopped = synchronizedStopped.delete(deployment);
  if (existsSync(ownerPath) || !justStopped) await stopOwned(deployment);
  child = spawn(cli.command, [...cli.prefix, ...args], { cwd: deployment.workspace, env, stdio: ['inherit', 'pipe', 'pipe'] });
  stopped = false;
  child.once('exit', (code, signal) => { stopped = true; exitedResolve({ code, signal }); });
  child.once('error', error => { stopped = true; exitedResolve({ error }); });
  server = createServer({ allowHalfOpen: true }, socket => {
    let input = '';
    socket.on('data', data => {
      input += data;
      if (input.length > 1024) return socket.destroy();
      if (!input.includes('\n')) return;
      try {
        const supplied = Buffer.from(JSON.parse(input).token ?? ''); const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return socket.destroy();
        child.kill('SIGTERM');
        exited.then(() => { socket.end('stopped\n'); });
      } catch { socket.destroy(); }
    });
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  atomicJSON(ownerPath, { home: deployment.home, profile: deployment.profile, host: hostname(), pid: process.pid, port: server.address().port, token });
  rmSync(join(deployment.profileRoot, STOPPED), { force: true });
  if (deployment.config.authUrlDirectWrite) privateFile(deployment.authUrlFile, '', true);
  else rmSync(deployment.authUrlFile, { force: true });
  for (const signal of signals) process.on(signal, stop);
  const publicUrl = options['public-url'] ?? process.env.DSH_PUBLIC_URL ?? deployment.config.publicUrl ?? `http://127.0.0.1:${port}`;
  const output = line => {
    if (line.includes('?token=')) {
      const match = line.match(/\?token=([A-Za-z0-9_-]{43})(?:\s|$)/);
      if (match) privateFile(deployment.authUrlFile, `${publicUrl.replace(/\/$/, '')}/?token=${match[1]}\n`, deployment.config.authUrlDirectWrite === true);
      process.stdout.write(`DSH 认证地址已保存至 ${deployment.authUrlFile}\n`);
    } else process.stdout.write(`${line}\n`);
  };
  createInterface({ input: child.stdout }).on('line', output);
  createInterface({ input: child.stderr }).on('line', output);
    deployment.baseUrl ??= deployment.profile === 'web' ? `http://127.0.0.1:${port}` : undefined;
    let verified = false;
    let lastError;
    for (let attempt = 0; attempt < 40 && !stopped; attempt++) {
      try {
        if (deployment.baseUrl) {
          const response = await fetch(deployment.baseUrl, { signal: AbortSignal.timeout(1000), redirect: 'manual' });
          if (response.status >= 500) throw new Error('DSH 尚未就绪。');
        }
        await finalize(deployment, release, { running: true, locked: true }); verified = true; break;
      } catch (error) { lastError = error; await new Promise(resolvePromise => setTimeout(resolvePromise, 250)); }
    }
    if (!verified) { child.kill('SIGTERM'); throw lastError ?? new Error('DSH 在启动验证前退出。'); }
    startupUnlock(); startupLocked = false;
    process.stdout.write(`${JSON.stringify({ status: 'running', activated: 'unknown', profile: deployment.profile })}\n`);
    const result = await exited;
    if (result.error) throw result.error;
    if (result.code && !result.signal) fail(`DSH 退出码 ${result.code}`);
  } finally {
    server?.close();
    for (const signal of signals) process.off(signal, stop);
    if (child && !stopped) { child.kill('SIGTERM'); await exited; }
    if (child) atomicJSON(join(deployment.profileRoot, STOPPED), { schemaVersion: 1, home: deployment.home, profile: deployment.profile, manager: 'owned', instanceId: token, stopped: true, stoppedAt: new Date().toISOString(), ...(child.pid ? { pid: child.pid } : {}) });
    if (readOptional(ownerPath)?.token === token) rmSync(ownerPath);
    if (startupLocked) startupUnlock();
  }
}
