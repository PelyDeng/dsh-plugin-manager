import { LOCK, OWNER, PENDING, STATE, atomicJSON, canonical, digestPattern, fail, hash, idPattern, json, packageName, readArchive, readOptional, same, synchronizedStopped, within } from './state.mjs';
import { dirname, join, resolve, sep } from 'node:path';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { cliRun, externalStopped, hostCLI, observeManager, runtimeIdentity, stopOwned, verificationIdentity } from './process.mjs';
import { assessVerification, printVerification } from './verification.mjs';
import { randomUUID } from 'node:crypto';
import { runtimeEnvironment } from './config.mjs';
import { assertReleaseMode } from './release.mjs';
export function profileManifest(profileRoot) { return readOptional(join(profileRoot, 'package.json')) ?? {}; }

export function readState(path) {
  const state = readOptional(path);
  if (state && (state.schemaVersion !== 2 || !Array.isArray(state.plugins))) fail('未知受管状态版本；请显式迁移，不能当成空安装。');
  if (state) validateRecordedPlugins(state.plugins);
  if (state?.candidates !== undefined && (!Array.isArray(state.candidates) || state.candidates.some(id => typeof id !== 'string' || !idPattern.test(id)) || new Set(state.candidates).size !== state.candidates.length)) fail('受管候选插件列表无效。');
  return state;
}

export function validateRecordedPlugins(plugins) {
  if (!Array.isArray(plugins) || plugins.some(plugin => !plugin || typeof plugin.id !== 'string' || typeof plugin.package !== 'string' || !idPattern.test(plugin.id) || !packageName.test(plugin.package) || !digestPattern.test(plugin.sha256))) fail('受管包记录格式无效。');
}

export function installedMatches(root, plugin) {
  const manifest = profileManifest(root);
  if (!manifest.dependencies?.[plugin.package] || !manifest.dsh?.profile?.bundles?.includes(plugin.package)) return false;
  const reference = plugin.mode === 'development' ? `link:${canonical(plugin.source)}` : `file:${canonical(plugin.archivePath)}`;
  if (anchoredSpec(root, manifest.dependencies[plugin.package]) !== reference) return false;
  const packageRoot = join(root, 'node_modules', plugin.package);
  if (!existsSync(join(packageRoot, 'package.json'))) return false;
  for (const file of plugin.verifyFiles) {
    const target = join(packageRoot, file);
    if (!existsSync(target) || !within(packageRoot, target) || !statSync(target).isFile()) return false;
    let expected;
    try { expected = readArchive(plugin.archivePath, ['-xzOf', '-', `package/${file}`], statSync(target).size + 1024 * 1024); }
    catch { return false; } // An unreadable archive cannot verify the installed file.
    if (!readFileSync(target).equals(expected)) return false;
  }
  return true;
}

/** Compute package changes without treating discovery as installation ownership. */
export function computeChanges(previous, desired, installed, matches, pending = null) {
  const owned = new Map((previous?.plugins ?? []).map(plugin => [plugin.package, plugin]));
  for (const plugin of pending?.touched ?? []) owned.set(plugin.package, plugin);
  for (const plugin of desired) {
    if ((installed.dependencies?.[plugin.package] || installed.dsh?.profile?.bundles?.includes(plugin.package)) && !owned.has(plugin.package)) fail(`${plugin.id}: 与非受管安装 ${plugin.package} 冲突，不能自动接管。`);
  }
  const selected = new Set(desired.map(plugin => plugin.package));
  for (const plugin of owned.values()) if (!selected.has(plugin.package) && !installed.dependencies?.[plugin.package] && installed.dsh?.profile?.bundles?.includes(plugin.package)) {
    fail(`${plugin.id}: 受管 Bundle 仍存在但依赖已缺失；先用上次清单 --rebuild 恢复该插件，再撤选。官方 CLI 无法删除失去依赖记录的 Bundle，保留归属状态。`);
  }
  const remove = [...owned.values()].filter(plugin => !selected.has(plugin.package) && installed.dependencies?.[plugin.package]);
  const add = desired.filter(plugin => {
    const old = owned.get(plugin.package);
    return !old || old.sha256 !== plugin.sha256 || old.mode !== plugin.mode || old.source !== plugin.source || !matches(plugin);
  });
  return { remove, add };
}

/** A lock is never stolen solely because a timeout elapsed. */
export function acquireLock(profileRoot) {
  mkdirSync(profileRoot, { recursive: true });
  const path = join(profileRoot, LOCK);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail(`profile 正在同步或上次进程中断；检查 ${path} 后显式 unlock。`); throw error; }
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, host: hostname(), createdAt: new Date().toISOString() })}\n`);
  closeSync(fd);
  return () => rmSync(path);
}

export function packageManagerArguments(deployment, action) {
  const args = [action];
  if (deployment.offline) args.push(action === 'remove' ? '--config.offline=true' : '--offline');
  if (deployment.store) args.push('--store-dir', canonical(resolve(deployment.root, deployment.store)));
  if (deployment.cache) args.push('--cache-dir', canonical(resolve(deployment.root, deployment.cache)));
  return args;
}

export function installationArguments(deployment, action, plugin) {
  const args = packageManagerArguments(deployment, action);
  args.push(action === 'remove' ? plugin.package : `${deployment.mode === 'development' ? 'link:' : 'file:'}${deployment.mode === 'development' ? plugin.source : plugin.archivePath}`);
  return args;
}

export function batchAddArguments(deployment, plugins) {
  const first = installationArguments(deployment, 'add', plugins[0]);
  return [...first.slice(0, -1), ...plugins.map(plugin => installationArguments(deployment, 'add', plugin).at(-1))];
}

export function anchoredSpec(profileRoot, spec) {
  if (typeof spec !== 'string') fail('profile 依赖 spec 必须是字符串。');
  const match = spec.match(/^(file:|link:)(.*)$/);
  return match ? `${match[1]}${canonical(resolve(profileRoot, match[2]))}` : spec;
}

export function statePlugin(plugin) {
  return { id: plugin.id, package: plugin.package, version: plugin.version, sha256: plugin.sha256, mode: plugin.mode, ...(plugin.healthPath ? { healthPath: plugin.healthPath } : {}), ...(plugin.source ? { source: plugin.source } : {}) };
}

/** Preflight in an isolated profile before stopping or modifying the live target. */
export function preflightInstall(deployment, plugins, changes, cli, execute = cliRun) {
  const preflightHome = join(deployment.dataRoot, '.deployment-private', randomUUID(), 'preflight-home');
  const root = join(preflightHome, 'profiles', deployment.profile);
  mkdirSync(preflightHome, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(root), { recursive: true });
  const mutated = new Set([...changes.add, ...changes.remove].map(plugin => plugin.package));
  const retained = dependencyEvidence(deployment.profileRoot, mutated);
  if (existsSync(deployment.profileRoot)) cpSync(deployment.profileRoot, root, { recursive: true, dereference: true, filter: path => ![LOCK, OWNER, PENDING, 'node_modules'].includes(path.split(sep).at(-1)) });
  else mkdirSync(root, { recursive: true });
  if (existsSync(join(root, 'package.json'))) {
    // Only the isolated candidate is edited; the live profile is changed by official CLI operations.
    const candidate = profileManifest(root);
    candidate.dependencies ??= {};
    for (const name of Object.keys(candidate.dependencies)) candidate.dependencies[name] = anchoredSpec(deployment.profileRoot, candidate.dependencies[name]);
    for (const plugin of changes.remove) {
      delete candidate.dependencies[plugin.package];
      if (candidate.dsh?.profile?.bundles) candidate.dsh.profile.bundles = candidate.dsh.profile.bundles.filter(name => name !== plugin.package);
    }
    for (const plugin of changes.add) candidate.dependencies[plugin.package] = installationArguments(deployment, 'add', plugin).at(-1);
    atomicJSON(join(root, 'package.json'), candidate);
    execute(cli, deployment, packageManagerArguments(deployment, 'install'), preflightHome);
  } else if (changes.add.length) execute(cli, deployment, batchAddArguments(deployment, changes.add), preflightHome);
  if (!same(retained, dependencyEvidence(root, mutated))) fail('隔离安装改变了要保留的依赖或 Bundle；拒绝修改目标 profile。');
  for (const plugin of plugins) if (!installedMatches(root, plugin)) fail(`${plugin.id}: 隔离安装验证失败。`);
  return preflightHome;
}

export function dependencyEvidence(profileRoot, excluded) {
  const manifest = profileManifest(profileRoot);
  const evidence = {};
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (excluded.has(name)) continue;
    if (!packageName.test(name)) fail('profile 包名无效。');
    const packageRoot = join(profileRoot, 'node_modules', name);
    const file = join(packageRoot, 'package.json');
    if (!existsSync(file)) fail(`要保留的依赖 ${name} 缺少安装。`);
    const metadata = json(file);
    const main = metadata.main ?? 'index.js';
    const entry = resolve(packageRoot, main);
    if (metadata.main && !existsSync(entry)) fail(`要保留的依赖 ${name} 入口无法解析。`);
    evidence[name] = { spec: anchoredSpec(profileRoot, spec), packageHash: hash(readFileSync(file)), entryHash: existsSync(entry) && statSync(entry).isFile() ? hash(readFileSync(entry)) : null,
      bundle: (manifest.dsh?.profile?.bundles ?? []).includes(name) };
  }
  return evidence;
}

/** Synchronize only owned packages; pending state survives every partial failure. */
export async function synchronize(deployment, release, options = {}) {
  assertReleaseMode(release, deployment.mode);
  synchronizedStopped.delete(deployment);
  const runtime = runtimeEnvironment(deployment, release.plugins);
  const plugins = release.plugins.map(plugin => ({ ...plugin, mode: deployment.mode, ...(deployment.mode === 'development' ? { source: canonical(resolve(deployment.root, plugin.directory)) } : {}) }));
  const releaseLock = acquireLock(deployment.profileRoot);
  let pending;
  let operationStarted = false;
  const pendingPath = join(deployment.profileRoot, PENDING);
  try {
  const previous = readState(join(deployment.profileRoot, STATE));
  if (options.freshContainer && existsSync(join(deployment.profileRoot, OWNER))) fail('共享 home 存在运行记录；先由原管理者确认旧容器退出并处理记录，不能覆盖同步。');
  pending = readOptional(pendingPath);
  if (pending && pending.schemaVersion !== 2) fail('未知操作日志版本；请显式迁移。');
  if (pending) {
    validateRecordedPlugins(pending.touched);
    if (typeof pending.operationId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pending.operationId)) fail('操作日志标识无效。');
  }
  if (deployment.options.recover && deployment.options.resume) fail('--recover 与 --resume 不能同时使用。');
  if (deployment.options.recover && (!pending || !deployment.options['data-compatible'])) fail('--recover 需要未完成部署及 --data-compatible，明确确认目标包能够读取当前持久数据。');
  if (deployment.options['data-compatible'] && !deployment.options.recover) fail('--data-compatible 仅用于 --recover。');
  const cli = options.cli ?? hostCLI(deployment);
  const environment = { os: process.platform, architecture: process.arch, node: process.versions.node, mode: deployment.mode, ...(options.cli ? {} : runtimeIdentity(cli, deployment)) };
  const verification = assessVerification(release, release.verification?.runs.length
    ? verificationIdentity(cli, deployment, environment.hostVersion)
    : { host: { kind: 'unknown' }, platform: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node } }, deployment.mode);
  printVerification(verification);
  const patches = (deployment.config.patches ?? []).map(path => canonical(resolve(deployment.root, path)));
  const desired = { schemaVersion: 2, candidates: deployment.candidates ?? plugins.map(plugin => plugin.id), plugins: plugins.map(statePlugin), configurations: runtime.configurations, patches, environment };
  const desiredHash = hash(JSON.stringify(desired));
  if (pending && !deployment.options.recover && (!deployment.options.resume || pending.desiredHash !== desiredHash)) fail('存在未完成部署；使用原清单和配置 --resume，或选择修复清单并显式 --recover --data-compatible。');
  const legacy = [join(deployment.profileRoot, '.deepseek-plugin-managed.json'), join(deployment.home, '.managed-dsh-plugins')];
  if (!previous && !pending && legacy.some(existsSync)) fail('发现旧受管候选记录，请先显式迁移并核实包归属。');
  const environmentChanged = previous?.environment && !same(previous.environment, environment);
  if (environmentChanged && !deployment.options.rebuild) fail('运行环境已变化；请在目标环境预检后显式 --rebuild。');
  const execute = options.execute ?? cliRun;
    const changes = computeChanges(previous, plugins, profileManifest(deployment.profileRoot), plugin => !environmentChanged && installedMatches(deployment.profileRoot, plugin), pending);
    const configurationChanged = !previous || !same(previous.candidates, desired.candidates) || !same(previous.configurations, desired.configurations) || !same(previous.patches ?? [], patches) || environmentChanged;
    if (!changes.add.length && !changes.remove.length && !configurationChanged && !pending) {
      if (options.freshContainer) synchronizedStopped.add(deployment);
      return { changed: false, status: 'installed', activated: 'unknown', plugins: desired.plugins, verification };
    }
    if (!options.skipPreflight && (changes.add.length || changes.remove.length)) preflightInstall(deployment, plugins, changes, cli, execute);
    if (deployment.hostMode === 'owned' && !options.freshContainer) await stopOwned(deployment);
    else if (!options.freshContainer) externalStopped(deployment);
    if (pending && deployment.options.recover) {
      const history = join(deployment.dataRoot, '.deployment-private', pending.operationId, 'pending-before-recovery.json');
      mkdirSync(dirname(history), { recursive: true, mode: 0o700 });
      atomicJSON(history, pending);
      pending = { schemaVersion: 2, operationId: randomUUID(), supersedes: pending.operationId, desiredHash, desired, touched: pending.touched, status: 'pending' };
    }
    pending ??= { schemaVersion: 2, operationId: randomUUID(), desiredHash, desired, touched: [], status: 'pending' };
    atomicJSON(pendingPath, pending);
    operationStarted = true;
    const backup = join(deployment.dataRoot, '.deployment-private', pending.operationId, 'profile-before');
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    if (!existsSync(backup)) cpSync(deployment.profileRoot, backup, { recursive: true, dereference: false, filter: path => ![LOCK, OWNER].includes(path.split(sep).at(-1)) });
    for (const [action, items] of [['remove', changes.remove], ['add', changes.add]]) {
      for (const plugin of items) {
        if (!pending.touched.some(item => item.package === plugin.package)) pending.touched.push(statePlugin(plugin));
        pending.phase = `${action}:${plugin.id}`;
        atomicJSON(pendingPath, pending);
        if (action === 'remove') execute(cli, deployment, installationArguments(deployment, action, plugin));
      }
      if (action === 'add' && items.length) execute(cli, deployment, batchAddArguments(deployment, items));
    }
    for (const plugin of plugins) if (!installedMatches(deployment.profileRoot, plugin)) fail(`${plugin.id}: 安装或 Bundle 验证失败。`);
    const after = profileManifest(deployment.profileRoot);
    for (const plugin of changes.remove) if (after.dependencies?.[plugin.package] || after.dsh?.profile?.bundles?.includes(plugin.package)) fail(`${plugin.id}: 撤选后仍有依赖或 Bundle，保留恢复日志。`);
    pending.status = 'awaiting-start'; pending.phase = 'installed'; atomicJSON(pendingPath, pending);
    synchronizedStopped.add(deployment);
    return { changed: true, status: 'awaiting-start', activated: 'unknown', plugins: desired.plugins, verification };
  } catch (error) {
    if (pending && operationStarted) { pending.status = 'failed'; pending.error = '部署未完成，请核实实际状态后恢复。'; atomicJSON(pendingPath, pending); }
    throw error;
  } finally { releaseLock(); }
}

/** Check the declared endpoint without accepting cross-origin redirects. */
async function probePlugin(deployment, plugin, fetcher) {
  if (!plugin.healthPath) return 'not-provided';
  if (!deployment.baseUrl) fail(`${plugin.id}: 就绪探针需要 --base-url。`);
  const base = new URL(deployment.baseUrl);
  const target = new URL(plugin.healthPath, base);
  if (target.origin !== base.origin) fail('健康探针不能跳转到其他来源。');
  const response = await fetcher(target, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) fail(`${plugin.id}: 就绪探针失败 HTTP ${response.status}`);
  return 'ready';
}

/** Periodic health uses installed metadata and HTTP probes, without reading release archives. */
export async function verifyHealth(deployment, state, fetcher = fetch) {
  if (!deployment.baseUrl) fail('宿主存活检查需要 --base-url。');
  const host = await fetcher(deployment.baseUrl, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
  if (host.status >= 500) fail(`宿主存活检查失败 HTTP ${host.status}`);
  const manifest = profileManifest(deployment.profileRoot);
  const results = [];
  for (const plugin of state.plugins) {
    const packageRoot = join(deployment.profileRoot, 'node_modules', plugin.package);
    const installed = readOptional(join(packageRoot, 'package.json'));
    if (!manifest.dependencies?.[plugin.package] || !manifest.dsh?.profile?.bundles?.includes(plugin.package)
      || installed?.name !== plugin.package || installed?.version !== plugin.version
      || typeof installed.main !== 'string' || !installed.main) fail(`${plugin.id}: 安装或 Bundle 漂移。`);
    const entry = resolve(packageRoot, installed.main);
    if (!within(packageRoot, entry) || !existsSync(entry) || !statSync(entry).isFile()) fail(`${plugin.id}: 插件入口缺失或无效。`);
    results.push({ id: plugin.id, installed: true, activated: 'unknown', ready: await probePlugin(deployment, plugin, fetcher) });
  }
  return results;
}

/** Probes are per plugin; host liveness never substitutes for plugin activation. */
export async function verifyReady(deployment, release, fetcher = fetch) {
  const results = [];
  for (const plugin of release.plugins) {
    if (!installedMatches(deployment.profileRoot, plugin)) fail(`${plugin.id}: 安装或 Bundle 漂移。`);
    const ready = await probePlugin(deployment, plugin, fetcher);
    results.push({ id: plugin.id, installed: true, activated: 'unknown', ready });
  }
  return results;
}

/** Finalize a started operation only after the selected installation and probes pass. */
export async function finalize(deployment, release, { running = false, locked = false } = {}) {
  assertReleaseMode(release, deployment.mode);
  const unlock = locked ? () => {} : acquireLock(deployment.profileRoot);
  try {
    const pendingPath = join(deployment.profileRoot, PENDING);
    const pending = readOptional(pendingPath);
    if (pending && !running) {
      const file = deployment.options['started-file'] ?? deployment.config.startedFile;
      if (!file) fail('记录配置已应用需要原管理者启动证据 --started-file。');
      const evidence = json(resolve(deployment.root, file));
      if (evidence.schemaVersion !== 1 || canonical(evidence.home ?? '') !== deployment.home || evidence.profile !== deployment.profile || evidence.started !== true || !evidence.manager || !evidence.instanceId || !Number.isFinite(Date.parse(evidence.startedAt))) fail('启动证据无效。');
      observeManager(evidence, true);
    }
    const results = await verifyReady(deployment, release);
    if (pending) {
      if (pending.status !== 'awaiting-start') fail('本次操作尚未完成安装。');
      if (!same(pending.desired.plugins.map(item => [item.id, item.sha256]), release.plugins.map(item => [item.id, item.sha256]))) fail('验证清单与待启动操作不一致。');
      const current = runtimeEnvironment(deployment, release.plugins);
      const patches = (deployment.config.patches ?? []).map(path => canonical(resolve(deployment.root, path)));
      if (!same(pending.desired.configurations, current.configurations) || !same(pending.desired.patches ?? [], patches)) fail('验证配置与待启动操作不一致；不能将旧配置标为已应用。');
      atomicJSON(join(deployment.profileRoot, STATE), pending.desired);
      rmSync(pendingPath);
    }
    return results;
  } finally { unlock(); }
}

/** Explicitly accept named legacy installations without claiming their new package or config is applied. */
export async function adoptLegacy(deployment, release, ids) {
  assertReleaseMode(release, deployment.mode);
  if (!Array.isArray(ids) || !ids.length || ids.includes('all') || ids.includes('none') || new Set(ids).size !== ids.length) fail('adopt 需要 --plugins 精确列出待接管 ID，不能使用 all/none。');
  const unlock = acquireLock(deployment.profileRoot);
  try {
    if (existsSync(join(deployment.profileRoot, STATE)) || existsSync(join(deployment.profileRoot, PENDING))) fail('已存在新版受管状态或未完成操作，不能重新接管。');
    if (deployment.hostMode === 'owned') await stopOwned(deployment); else externalStopped(deployment);
    const manifest = profileManifest(deployment.profileRoot);
    const plugins = ids.map(id => {
      const plugin = release.plugins.find(item => item.id === id);
      if (!plugin) fail(`发布清单未声明 ${id}。`);
      const installed = readOptional(join(deployment.profileRoot, 'node_modules', plugin.package, 'package.json'));
      if (!installed || installed.name !== plugin.package || !manifest.dependencies?.[plugin.package] || !manifest.dsh?.profile?.bundles?.includes(plugin.package)) fail(`${id}: 缺少可核验的安装和 Bundle，拒绝接管。`);
      return { id, package: plugin.package, version: installed.version, sha256: '0'.repeat(64), mode: 'legacy' };
    });
    atomicJSON(join(deployment.profileRoot, STATE), { schemaVersion: 2, plugins, configurations: {}, patches: [] });
    return { status: 'adopted-requires-sync', plugins: plugins.map(plugin => plugin.id) };
  } finally { unlock(); }
}
