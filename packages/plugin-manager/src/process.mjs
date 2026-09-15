import { spawnSync } from 'node:child_process';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { OWNER, STOPPED, canonical, fail, hash, json, readOptional } from './state.mjs';
import { assertNoOverlappingWriters, dockerArguments, executeDocker, inspectDocker } from './docker-runtime.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
/** A copied Windows environment must not contain competing Path/PATH entries. */
export function normalizeEnvironment(env = process.env) {
  const result = { ...env };
  if (process.platform === 'win32') {
    const keys = Object.keys(result).filter(key => key.toLowerCase() === 'path');
    const value = keys.length ? result[keys.at(-1)] : undefined;
    for (const key of keys) delete result[key];
    if (value !== undefined) result.PATH = value;
  }
  return result;
}

/** Keep user arguments out of cmd.exe even on Windows by executing the requested JS shim. */
export function commandSpec(command, { env = process.env, cwd } = {}) {
  if (command.endsWith('.mjs') || command.endsWith('.cjs') || command.endsWith('.js')) return { command: process.execPath, prefix: [command] };
  if (process.platform !== 'win32') return { command, prefix: [] };
  env = normalizeEnvironment(env);
  // Native filesystem lookup preserves Unicode paths, unlike locale-encoded where.exe output.
  const extensions = extname(command) ? [''] : ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')];
  const directories = /[\\/]/.test(command) ? [''] : [cwd ?? process.cwd(), ...(env.PATH ?? '').split(delimiter)];
  const paths = directories.flatMap(directory => extensions.map(extension => resolve(cwd ?? process.cwd(), directory.replace(/^"|"$/g, ''), command + extension)))
    .filter(path => existsSync(path) && statSync(path).isFile());
  const name = basename(command).replace(/\.cmd$/i, '').toLowerCase();
  for (const path of paths) {
    if (/\.(exe|com)$/i.test(path)) return { command: path, prefix: [] };
    const base = dirname(path);
    const scripts = name === 'npm' ? ['node_modules/npm/bin/npm-cli.js']
      : name === 'pnpm' ? ['node_modules/pnpm/bin/pnpm.cjs', 'node_modules/corepack/dist/pnpm.js', 'pnpm.cjs'] : [];
    for (const relative of scripts) {
      const script = join(base, relative);
      if (existsSync(script)) return { command: process.execPath, prefix: [script] };
    }
    if (/\.cmd$/i.test(path) && existsSync(path)) {
      const shim = readFileSync(path, 'utf8');
      const match = shim.match(/%(?:dp0%|~dp0)[\\/]([^"\r\n]+\.(?:m?js|cjs))/i);
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
  return { ...commandSpec(binary ?? 'dsh', { env, cwd: deployment.root }), cwd: deployment.root };
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

/**
 * 声明的 compose 容器现在处于什么状态：`running` / `stopped` / `absent` / `unavailable`。
 *
 * 容器已被删除是合法现场（设计 6.2：零容器时查当前引擎与重叠可写挂载，不要求拿已经删除的旧 ID
 * 再做 inspect）；只有 Docker 明确报「不存在」才算零容器，其余错误保持「无法核实」并要求人工处理。
 */
export function composeContainerState(runtime, instanceId, spawn = spawnSync) {
  const result = spawn('docker', dockerArguments(runtime, ['inspect', '--format', '{{.State.Running}}', instanceId]), { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status === null) return 'unavailable';
  const output = String(result.stdout ?? '').trim();
  if (result.status === 0) return output === 'true' ? 'running' : output === 'false' ? 'stopped' : 'unavailable';
  return /no such (?:object|container)/iu.test(String(result.stderr ?? '')) ? 'absent' : 'unavailable';
}

/**
 * 容器来源的默认引擎适配器：先用锁定 endpoint 的运行时，再按实例标识查状态，最后查重叠写入者。
 *
 * 抽成一个对象是为了让这条链可以被确定性验证（测试注入替身即可），而不是只有真实 Docker 才能走到。
 */
const pinnedEngine = {
  inspect: () => inspectDocker(),
  state: (runtime, instanceId) => composeContainerState(runtime, instanceId),
  assertNoWriters: (directories, runtime) => assertNoOverlappingWriters(directories, (args, options) => executeDocker(dockerArguments(runtime, args), options), runtime),
};

/**
 * 停写证据的唯一核验实现：字段语义加实时状态查询。
 *
 * 字段形状（schemaVersion=1、home、profile、manager、instanceId、stopped、stoppedAt）与
 * `observeManager` 的实查都在这里，同步、站点迁移等入口只复用，不再各自写一份较弱的检查。
 * 调用方各自决定后续处置（同步还会拒绝残留 OWNER，迁移会先备份再移走旧记录）。
 *
 * compose 来源单独处理：声明的那一个容器可能已被删除，此时按设计 6.2 走「零容器」路径——查本机
 * 引擎与所有重叠可写挂载来证明没有写入者，而不是要求旧 ID 回来，也不是直接放行。process/systemd
 * 部署不含容器写入者，因此只有容器来源才需要 Docker。
 */
export function verifyStoppedEvidence(file, deployment, { trustedOwned = false, engine } = {}) {
  const path = resolve(deployment.root, file);
  const evidence = json(path);
  if (evidence.schemaVersion !== 1 || canonical(evidence.home ?? '') !== deployment.home || evidence.profile !== deployment.profile || evidence.stopped !== true || !evidence.manager || !evidence.instanceId || !Number.isFinite(Date.parse(evidence.stoppedAt))) fail('停服证据无效或目标 home/profile 不匹配。');
  if (evidence.manager === 'compose') {
    // 实例标识先按同一条格式校验（与 observeManager 一致）：证据里的标识不该被当成 docker 参数。
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/u.test(evidence.instanceId)) fail('原管理者实例标识无效。');
    const docker = engine ?? pinnedEngine;
    let runtime;
    try { runtime = docker.inspect(); }
    catch (error) { fail(`容器来源的停写证据需要可用的本机 Docker 引擎：${error.message}`); }
    const state = docker.state(runtime, evidence.instanceId);
    if (state === 'running') fail('原管理者的实际运行状态与证据不符。');
    if (state === 'unavailable') fail('不能从 Docker 核验指定容器状态；保留现场并人工核实引擎与容器。');
    // stopped 与 absent 都继续：再核对本机引擎上有没有别的容器仍在写同一批持久目录。
    docker.assertNoWriters({ dataRoot: deployment.dataRoot, home: deployment.home, workspace: deployment.workspace, artifacts: deployment.artifacts }, runtime);
    return evidence;
  }
  observeManager(evidence, false, trustedOwned || canonical(path) === canonical(join(deployment.profileRoot, STOPPED)));
  return evidence;
}

export function externalStopped(deployment) {
  const recorded = join(deployment.profileRoot, STOPPED);
  const file = deployment.options['stopped-file'] ?? deployment.config.stoppedFile ?? (existsSync(recorded) ? recorded : undefined);
  if (!file) fail('external 宿主同步前需要原管理者停服证据 --stopped-file。');
  verifyStoppedEvidence(file, deployment);
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
