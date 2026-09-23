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
import { frameworkCredentialEnvironment, prepareFrameworkCredentials } from './framework-credentials.mjs';
import { forwardContainerLoopback } from './container-forward.mjs';
/** Start one DSH child, keeping startup tokens out of normal logs. */
export async function supervise(deployment, release, { locked = false, unlock } = {}) {
  prepareFrameworkCredentials(deployment);
  assertReleaseMode(release, deployment.mode);
  const cli = hostCLI(deployment);
  const runtime = runtimeEnvironment(deployment, release.plugins);
  // 官方宿主从 0.1.6 起只在**全局必需条目**（agent-loop、webserver 等）激活失败时拒绝启动，
  // 其余条目失败或一直等到依赖都只打印一条警告，进程照常服务。受管插件正属于后者，所以
  // "端口能访问"不再等于"插件起来了"：这里把托管条目的未激活当作启动失败。
  const managedNames = new Set();
  for (const plugin of release.plugins) {
    managedNames.add(plugin.id);
    if (plugin.package) managedNames.add(plugin.package);
  }
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
  const env = { ...process.env, ...runtime.variables, ...frameworkCredentialEnvironment(deployment) };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  // `locked` 表示调用方在安装阶段就持有同一 profile 锁，并把锁句柄一并传入：锁必须连续覆盖
  // 安装到启动验收（设计 5.2）。就绪后由这里释放；调用方未传句柄时说明它自己负责释放。
  const startupUnlock = locked ? unlock ?? (() => {}) : acquireLock(deployment.profileRoot);
  let startupLocked = !locked;
  const ownerPath = join(deployment.profileRoot, OWNER);
  const token = randomUUID();
  let stopped = true;
  let child;
  let server;
  let closeForward;
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
  if (options.action === 'container-start' && deployment.profile === 'web' && process.env.DSH_CONTAINER_LOOPBACK_FORWARD === '1') {
    if (host !== '127.0.0.1') fail('容器转发要求官方宿主使用回环监听。');
    closeForward = await forwardContainerLoopback(Number(port));
  }
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
  // —— 启动诊断解析：世代描述表驱动 ——
  // 宿主对必需失败一律非零退出，失败判定不依赖文案；解析只为两件事——把诊断块原样转报，
  // 并把未激活条目/被跳过 bundle 的身份比对进托管名单。
  //
  // 抬头与明细按官方世代演进，GENERATIONS 每项是一代的抬头锚点（含 severity），新增世代
  // 只加表项与对应明细形状，不改控制流：
  // - 可选警告（alpha.1/alpha.2 相同）：`dsh: warning: N entr(y|ies) did not activate`，随后每行是
  //   `<入口 id> (<模块名>): <原因>`，原因用 error.stack，本身可以多行。
  // - 必需失败 alpha.1：`... required startup failure: N entry did not activate` + 同款平铺明细行。
  // - 必需失败 alpha.2：`dsh: startup failed: N required plugin(s) did not activate` + 分组明细——
  //   `Failed plugins (N):` 下每项是 2 空格缩进的 `<id>[ (required)]`，其 `Package:` 与原因行 4 空格
  //   缩进；`Plugins waiting for services (N):` 是 2 空格缩进的两列表，可选条目也并入这份诊断。
  // 0.1.7-alpha.1/2 未改诊断格式，表项与 alpha.2 逐字一致。抬头的 `(?:^|: )` 容忍 Error 包装
  // 前缀（如 `Error: dsh: ...`）。
  //
  // 这里**不能**按抬头里的条数收行：原因里的换行可能长得就像一条明细行，会把真正的条目挤掉，
  // 结果托管插件没激活却被当成成功（用真实 0.1.6 宿主复现过）。受管条目本来就有限，任何一条
  // 形状相符的行都拿来比对托管名单即可，误判需要原因里恰好写出托管插件的 id 或包名。
  const GENERATIONS = [
    { id: 'alpha.1/2 警告', header: /(?:^|: )warning: \d+ entr(?:y|ies) did not activate$/, severity: 'warning' },
    { id: 'alpha.1 必需失败（平铺）', header: /(?:^|: )required startup failure: \d+ entr(?:y|ies) did not activate$/, severity: 'required' },
    { id: 'alpha.2 必需失败（分组）', header: /(?:^|: )startup failed: \d+ required plugins? did not activate$/, severity: 'required' },
  ];
  // 宿主 0.1.7 起对解析失败的 profile bundle 裸行直写该行（stderr、无时间戳前缀）后跳过这一层
  // 继续启动，"启动成功"不再等于"站点插件全部就位"：被跳过的托管 bundle 必须按启动失败处理。
  // error 文本可能多行，这里只判定首行，余行按当前世代明细规则自然流过；`(?:^|: )` 容忍仅为
  // 对齐抬头风格。
  const SKIPPED_BUNDLE = /(?:^|: )dsh: skipping profile bundle "([^"]+)": (.*)$/;
  // 必需失败明细行的形状库（具名锚点；平铺行在警告与必需两态的正则与取值不同，保留两支）。
  const shapes = {
    flatWarning: line => { const m = /^(\S+) \(([^)]*)\): (.*)$/.exec(line); return m && { id: m[1], name: m[2], reason: m[3] }; },
    flatRequired: line => { const m = /^(\S+) \(([^)]*)\): /.exec(line); return m && { id: m[1], name: m[2] }; },
    failedEntry: line => { const m = /^ {2}(\S+?)(?: \(required\))?$/.exec(line); return m && { id: m[1] }; },
    waitingEntry: line => { const m = /^ {2}(\S+?)(?: \(required\))? {2,}(\S.*)$/.exec(line); return m && { id: m[1], service: m[2] }; },
    packageLine: line => { const m = /^ {4}Package: (\S+)$/.exec(line); return m && { name: m[1] }; },
    reasonLine: line => /^ {4}\S/.test(line),
  };
  const inactive = new Map();
  const requiredFailures = [];
  const skippedBundles = new Map();
  let severity = 'warning';
  let unnamedEntry = null;
  const noteActivation = line => {
    const skipped = SKIPPED_BUNDLE.exec(line);
    if (skipped) { skippedBundles.set(skipped[1], skipped[2]); return; }
    const header = GENERATIONS.find(g => g.header.test(line));
    if (header) {
      severity = header.severity;
      unnamedEntry = null;
      if (severity === 'required') requiredFailures.push(line);
      return;
    }
    if (severity === 'required') {
      requiredFailures.push(line);
      const flat = shapes.flatRequired(line);
      const failedEntry = shapes.failedEntry(line);
      const waitingEntry = shapes.waitingEntry(line);
      const packageLine = shapes.packageLine(line);
      if (flat) inactive.set(flat.id, { name: flat.name, reason: '' });
      else if (failedEntry) { unnamedEntry = { name: '', reason: '' }; inactive.set(failedEntry.id, unnamedEntry); }
      else if (waitingEntry && waitingEntry.id !== 'Plugin') inactive.set(waitingEntry.id, { name: '', reason: `waiting for services: ${waitingEntry.service}` });
      else if (packageLine && unnamedEntry) unnamedEntry.name = packageLine.name;
      else if (unnamedEntry && shapes.reasonLine(line)) unnamedEntry.reason ||= line.trim();
      return;
    }
    const entry = shapes.flatWarning(line);
    if (entry) inactive.set(entry.id, { name: entry.name, reason: entry.reason });
  };
  // 托管条目未激活、或托管 bundle 被宿主跳过，都一定是失败；返回 undefined 表示没有证据
  // 说明托管内容没起来。
  const activationError = () => {
    const broken = [...inactive].filter(([id, entry]) => managedNames.has(id) || managedNames.has(entry.name));
    const skippedManaged = [...skippedBundles].filter(([bundle]) => managedNames.has(bundle));
    if (!broken.length && !skippedManaged.length) return undefined;
    const parts = [];
    if (broken.length) parts.push(`托管插件未激活：${broken.map(([id, entry]) => `${id} (${entry.name}) ${entry.reason}`).join('；')}`);
    if (skippedManaged.length) parts.push(`宿主跳过了托管 bundle：${skippedManaged.map(([bundle, error]) => `${bundle}（${error}）`).join('；')}`);
    return new Error(`${parts.join('。')}。请按插件日志修正后直接重新运行普通 build。`);
  };
  let reportActivationFailure; const activationFailed = new Promise(resolvePromise => { reportActivationFailure = resolvePromise; });
  const output = line => {
    noteActivation(line);
    // 激活审计在 Loader 结算之后，可能晚于就绪探测；警告什么时候到都要立刻判定。
    // 分组诊断的条目身份跨多行到达（id 行先到、Package 行后到），这里只发信号，
    // 消息在最终抛出时按最新状态构造。
    if (activationError()) reportActivationFailure({});
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
    const startupDeadline = performance.now() + 60_000;
    while (!stopped && performance.now() < startupDeadline) {
      // 就绪探测可能早于宿主的激活审计，所以在写"已启动"之前先核对已有诊断。
      if (activationError()) break;
      try {
        if (deployment.baseUrl) {
          const response = await fetch(deployment.baseUrl, { signal: AbortSignal.timeout(1000), redirect: 'manual' });
          if (response.status >= 500) throw new Error('DSH 尚未就绪。');
        }
        await finalize(deployment, release, { running: true, locked: true }); verified = true; break;
      } catch (error) { lastError = error; await new Promise(resolvePromise => setTimeout(resolvePromise, 250)); }
    }
    if (!verified) {
      child.kill('SIGTERM');
      const activationFailure = activationError();
      if (activationFailure) {
        // alpha.2 起必需失败的官方诊断会把可选条目并进同一份分组，托管插件可能混在其中：
        // 托管判定优先，官方必需失败块跟随转报，两份证据都要出现在最终错误里。
        if (requiredFailures.length) activationFailure.message += `\n未激活的必需条目：\n${requiredFailures.join('\n')}`;
        throw activationFailure;
      }
      throw new Error((stopped ? 'DSH 在启动验证前退出。' : 'DSH 在 60 秒内未通过启动验证，请检查宿主日志；修正后直接重新运行普通 build。') + (requiredFailures.length ? `\n未激活的必需条目：\n${requiredFailures.join('\n')}` : ''), { cause: lastError });
    }
    startupUnlock(); startupLocked = false;
    process.stdout.write(`${JSON.stringify({ status: 'running', activated: 'unknown', profile: deployment.profile })}\n`);
    const outcome = await Promise.race([exited.then(result => ({ result })), activationFailed]);
    if (!('result' in outcome)) {
      child.kill('SIGTERM');
      // 走到这里时诊断流已稳定，按最终状态构造托管失败消息；必需失败块同样跟随转报。
      const lateActivationFailure = activationError() ?? new Error('托管插件未激活。');
      if (requiredFailures.length) lateActivationFailure.message += `\n未激活的必需条目：\n${requiredFailures.join('\n')}`;
      throw lateActivationFailure;
    }
    const result = outcome.result;
    if (result.error) throw result.error;
    if (result.code && !result.signal) fail(`DSH 退出码 ${result.code}`);
  } finally {
    await closeForward?.();
    server?.close();
    for (const signal of signals) process.off(signal, stop);
    if (child && !stopped) { child.kill('SIGTERM'); await exited; }
    if (child) atomicJSON(join(deployment.profileRoot, STOPPED), { schemaVersion: 1, home: deployment.home, profile: deployment.profile, manager: 'owned', instanceId: token, stopped: true, stoppedAt: new Date().toISOString(), ...(child.pid ? { pid: child.pid } : {}) });
    if (readOptional(ownerPath)?.token === token) rmSync(ownerPath);
    if (startupLocked) startupUnlock();
  }
}
