import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { OWNER, STOPPED, canonical, fail, hash, json, readOptional } from './state.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
/** Keep user arguments out of cmd.exe even on Windows by executing the JS shim. */
export function commandSpec(command) {
  if (command.endsWith('.mjs') || command.endsWith('.cjs') || command.endsWith('.js')) return { command: process.execPath, prefix: [command] };
  if (process.platform !== 'win32') return { command, prefix: [] };
  const located = spawnSync('where.exe', [command], { encoding: 'utf8' });
  const paths = located.status === 0 ? located.stdout.trim().split(/\r?\n/) : [command];
  for (const path of paths) {
    if (/\.(exe|com)$/i.test(path)) return { command: path, prefix: [] };
    const base = dirname(path);
    for (const script of [join(base, 'node_modules', command.replace(/\.cmd$/i, ''), 'bin', 'pnpm.cjs'), join(base, 'node_modules/corepack/dist/pnpm.js')]) {
      if (existsSync(script)) return { command: process.execPath, prefix: [script] };
    }
    if (/\.cmd$/i.test(path) && existsSync(path)) {
      const shim = readFileSync(path, 'utf8');
      const match = shim.match(/%dp0%[\\/]([^"\r\n]+\.(?:m?js|cjs))/i);
      if (match && existsSync(resolve(base, match[1]))) return { command: process.execPath, prefix: [resolve(base, match[1])] };
    }
  }
  fail(`无法安全解析可执行入口 ${command}，请提供其 JS CLI 路径。`);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`命令失败（${result.status}）：${command}`);
  return result;
}

/** Resolve only a requested existing CLI; preparing or downloading a host is separate. */
export function hostCLI(deployment, env = process.env) {
  const options = deployment.options;
  const js = options['dsh-cli-js'] ?? env.DSH_CLI_JS ?? deployment.config.dshCliJs;
  const source = options['harness-root'] ?? env.DSH_HARNESS_ROOT ?? deployment.config.harnessRoot;
  const binary = options['dsh-cli'] ?? env.DSH_CLI ?? deployment.config.dshCli;
  if (source !== undefined || (deployment.mode === 'development' && !js && !binary)) {
    const root = canonical(resolve(deployment.root, source ?? 'deepseek-harness'));
    const entry = join(root, 'apps/cli/src/bin.ts');
    if (!existsSync(entry)) fail(`缺少官方源码宿主：${root}，请显式初始化/准备。`);
    const loader = createRequire(join(root, 'package.json')).resolve('tsx/esm');
    return { command: process.execPath, prefix: ['--import', pathToFileURL(loader).href, entry], cwd: root };
  }
  if (js) {
    const path = resolve(deployment.root, js);
    if (!existsSync(path)) fail(`缺少 DSH CLI：${path}`);
    return { command: process.execPath, prefix: [path], cwd: deployment.root };
  }
  return { ...commandSpec(binary ?? 'dsh'), cwd: deployment.root };
}

export function cliRun(cli, deployment, args, home = deployment.home) {
  const env = { ...process.env, DSH_HOME: home, COREPACK_ENABLE_NETWORK: deployment.offline ? '0' : process.env.COREPACK_ENABLE_NETWORK };
  run(cli.command, [...cli.prefix, 'plugin', '--profile', deployment.profile, ...args], { cwd: cli.cwd, env });
}

export function runtimeIdentity(cli, deployment) {
  const version = spawnSync(cli.command, [...cli.prefix, '--version'], { cwd: cli.cwd, encoding: 'utf8', env: { ...process.env, DSH_HOME: deployment.home } });
  if (version.error || version.status !== 0) fail('无法验证指定 DSH CLI 的版本。');
  const pnpm = commandSpec('pnpm');
  const manager = spawnSync(pnpm.command, [...pnpm.prefix, '--version'], { encoding: 'utf8', cwd: cli.cwd });
  if (manager.error || manager.status !== 0) fail('无法验证 pnpm 版本。');
  const entry = cli.prefix.at(-1);
  let sourceCommit = process.env.DSH_HOST_SOURCE_SHA;
  if (!sourceCommit && entry && existsSync(entry)) {
    const gitRoot = spawnSync('git', ['-C', dirname(entry), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (gitRoot.status === 0 && canonical(gitRoot.stdout.trim()) !== deployment.root) {
      const commit = spawnSync('git', ['-C', dirname(entry), 'rev-parse', 'HEAD'], { encoding: 'utf8' });
      if (commit.status === 0) sourceCommit = commit.stdout.trim();
    }
  }
  return { hostVersion: version.stdout.trim(), packageManager: manager.stdout.trim(), hostEntry: entry && existsSync(entry) ? hash(readFileSync(entry)) : cli.command, ...(sourceCommit ? { sourceCommit } : {}) };
}

/** Evidence probe only. Never change the deployment fingerprint or trust an injected source SHA. */
export function verificationIdentity(cli, deployment, knownVersion) {
  const prefix = cli.prefix ?? [];
  const probe = (command, args, cwd = cli.cwd) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, DSH_HOME: deployment.home } });
    return !result.error && result.status === 0 ? result.stdout.trim() : undefined;
  };
  const rawVersion = knownVersion ?? probe(cli.command, [...prefix, '--version']);
  const version = rawVersion?.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)$/)?.[1];
  let host = { kind: 'unknown', ...(version ? { version } : {}) };
  const entry = prefix.at(-1);
  if (entry && existsSync(entry)) {
    const root = probe('git', ['rev-parse', '--show-toplevel'], dirname(entry));
    if (root) {
      let metadata;
      try { metadata = readOptional(join(root, 'package.json')); } catch { /* Unreadable provenance remains unknown. */ }
      if (metadata?.name === '@deepseek-ai/dsh-root') {
        const commit = probe('git', ['rev-parse', 'HEAD'], root);
        const status = probe('git', ['status', '--porcelain', '--untracked-files=normal'], root);
        if (commit && status !== undefined) host = { ...host, kind: 'source', commit, dirty: status !== '',
          // A clean checkout does not prove ignored compiled JS matches its source.
          identitySource: entry.endsWith('.ts') ? 'detected' : 'declared' };
      }
    }
  }
  return { host, platform: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node } };
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export function observeManager(evidence, expectedRunning, trustedOwned = false) {
  if (evidence.manager === 'process' || (evidence.manager === 'owned' && trustedOwned)) {
    if (!Number.isSafeInteger(evidence.pid) || evidence.pid <= 0 || alive(evidence.pid) !== expectedRunning) fail('原管理者的进程状态与证据不符。');
    return;
  }
  if (typeof evidence.instanceId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(evidence.instanceId)) fail('原管理者实例标识无效。');
  let running;
  if (evidence.manager === 'compose') {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', evidence.instanceId], { encoding: 'utf8' });
    if (result.error || result.status !== 0 || !['true', 'false'].includes(result.stdout.trim())) fail('不能从 Docker 核验指定容器状态。');
    running = result.stdout.trim() === 'true';
  } else if (evidence.manager === 'systemd') {
    const result = spawnSync('systemctl', ['is-active', evidence.instanceId], { encoding: 'utf8' });
    if (result.error || !['active', 'inactive', 'failed'].includes(result.stdout.trim())) fail('不能从 systemd 核验指定服务状态。');
    running = result.stdout.trim() === 'active';
  } else fail('证据 manager 仅支持 process、compose 或 systemd；不能只凭自述绕过停启检查。');
  if (running !== expectedRunning) fail('原管理者的实际运行状态与证据不符。');
}

export function externalStopped(deployment) {
  const recorded = join(deployment.profileRoot, STOPPED);
  const file = deployment.options['stopped-file'] ?? deployment.config.stoppedFile ?? (existsSync(recorded) ? recorded : undefined);
  if (!file) fail('external 宿主同步前需要原管理者停服证据 --stopped-file。');
  const evidence = json(resolve(deployment.root, file));
  if (evidence.schemaVersion !== 1 || canonical(evidence.home ?? '') !== deployment.home || evidence.profile !== deployment.profile || evidence.stopped !== true || !evidence.manager || !evidence.instanceId || !Number.isFinite(Date.parse(evidence.stoppedAt))) fail('停服证据无效或目标 home/profile 不匹配。');
  observeManager(evidence, false, canonical(resolve(deployment.root, file)) === canonical(recorded));
  const owner = readOptional(join(deployment.profileRoot, OWNER));
  if (owner) fail('目标 profile 存在本工具的运行记录，应先通过 owned 停止实例。');
}

/** Only the original supervisor can stop the child process it spawned. */
export async function stopOwned(deployment) {
  const path = join(deployment.profileRoot, OWNER);
  const owner = readOptional(path);
  if (!owner) {
    if (existsSync(join(deployment.profileRoot, 'package.json'))) externalStopped(deployment);
    return;
  }
  if (owner.home !== deployment.home || owner.profile !== deployment.profile) fail('运行记录目标不匹配。');
  await new Promise((resolvePromise, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: owner.port });
    socket.setTimeout(10000, () => socket.destroy(new Error('宿主停服超时。')));
    socket.on('connect', () => socket.end(`${JSON.stringify({ token: owner.token })}\n`));
    let response = '';
    socket.on('data', data => { response += data; });
    socket.on('error', reject);
    socket.on('end', () => response.trim() === 'stopped' ? resolvePromise() : reject(new Error('原宿主未确认停止；不按 PID 杀进程。')));
  });
}
