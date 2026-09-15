import { LOCK, OWNER, STATE, atomicJSON, canonical, fail, hash, idPattern, json, openArchiveMembers, packageName, readOptional, same, synchronizedStopped, within } from './state.mjs';
import { dirname, join, resolve, sep } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { acquireFileLock, withLockControl } from './lock.mjs';
import { cliRun, externalStopped, hostCLI, observeManager, runtimeIdentity, stopOwned, verificationIdentity } from './process.mjs';
import { assessVerification, printVerification } from './verification.mjs';
import { randomUUID } from 'node:crypto';
import { runtimeEnvironment } from './config.mjs';
import { assertReleaseMode } from './release.mjs';
import { prepareFrameworkCredentials } from './framework-credentials.mjs';
import { assertBindingMatches, readBinding, resolveSiteIdentity, BINDING } from './site-binding.mjs';
export function profileManifest(profileRoot) { return readOptional(join(profileRoot, 'package.json')) ?? {}; }

/**
 * 受管授权集合（profile 状态 schema 3）的字段校验。
 *
 * schema 3 只描述「管理器长期管理哪些包」与「最近一次完整安装验证的环境」：它不代表本次发布已
 * 成功，也不携带 status/phase/operationId/touched 等恢复工作流字段。旧 schema 2 记录只读留给
 * migrate-site 迁移，日常入口遇到时明确拒绝而不是当成空安装。
 */
function validateManaged(state) {
  const fields = ['schemaVersion', 'siteId', 'profile', 'managed', 'environment'];
  if (!state || state.schemaVersion !== 3 || typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).some(key => !fields.includes(key))) fail('受管授权集合格式无效。');
  // siteId/profile 是 schema 3 的必需身份（设计 2.6）：缺身份的状态无法证明属于哪个站点。
  for (const field of ['siteId', 'profile']) {
    if (typeof state[field] !== 'string' || !state[field].trim()) fail(`受管授权集合缺少 ${field}；请用 migrate-site 显式迁移或重建授权。`);
  }
  const managed = state.managed;
  if (!Array.isArray(managed) || managed.some(entry => !entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !idPattern.test(entry.id)
    || typeof entry.package !== 'string' || !packageName.test(entry.package))
    || new Set(managed.map(entry => entry.package)).size !== managed.length || new Set(managed.map(entry => entry.id)).size !== managed.length) fail('受管授权集合必须是不重复的 id/package 集合。');
  if (state.environment !== undefined && (typeof state.environment !== 'object' || state.environment === null || Array.isArray(state.environment))) fail('受管授权集合的 environment 无效。');
  return state;
}

export function readState(path) {
  const state = readOptional(path);
  if (state && state.schemaVersion !== 3) fail('旧受管状态版本（schema 2）；请用 migrate-site 显式迁移，不能当成空安装。');
  return state ? validateManaged(state) : state;
}

/**
 * 站点身份（设计 2.6、5.1）：容器内由本次部署配置提供，宿主路径由稳定绑定提供。
 *
 * 不从旧状态继承身份：缺少身份时拒绝写授权集合，避免把一个站点的授权悄悄带到另一个站点。
 */
function stateIdentity(deployment) {
  const siteId = resolveSiteIdentity(deployment.root, deployment.config?.siteId);
  if (typeof siteId !== 'string' || !siteId.trim()) fail('缺少站点身份 siteId（部署配置与站点绑定都没有）；拒绝写受管授权集合。');
  return siteId.trim();
}

/**
 * 读取**本次部署**的受管授权集合：schema 3 的 siteId/profile 必须与本次部署一致（设计 2.6、5.1）。
 *
 * 只校验字段存在会让另一个站点或另一个 profile 的授权被当成自己的现场继续使用：既可能让本次发布
 * 误判为“无需改变”，也会在写入时用当前身份重写别人的授权。因此读取与写入用同一份身份判定。
 */
export function readDeploymentState(deployment) {
  const state = readState(join(deployment.profileRoot, STATE));
  if (!state) return state;
  const siteId = stateIdentity(deployment);
  if (state.siteId !== siteId || state.profile !== deployment.profile) {
    fail(`受管授权集合属于站点 ${state.siteId}（profile ${state.profile}），与本次部署 ${siteId}（profile ${deployment.profile}）不一致；拒绝在另一站点的授权上继续，请核实部署目录或走显式迁移。`);
  }
  return state;
}

/**
 * schema 3 授权集合文件的唯一构造处：所有写入都经过这里，避免同步/接管/迁移各自拼一份对象。
 * `managed` 传 Map 或数组；`environment` 不传表示接管尚未验证目标环境，不写入该字段。
 */
export function managedFile(deployment, managed, environment) {
  return {
    schemaVersion: 3,
    siteId: stateIdentity(deployment),
    profile: deployment.profile,
    managed: managed instanceof Map ? [...managed.values()] : managed,
    ...(environment !== undefined ? { environment } : {}),
  };
}

/** profile 里声明的 Bundle 包名集合：一次提取，避免多处重复可选链。 */
export function bundlesOf(installed) {
  return installed?.dsh?.profile?.bundles ?? [];
}

/**
 * 计算本次要对受管包执行的变更。
 *
 * `managed` 是持久授权集合（id/package 映射），它只回答「哪些包归管理器管」，不存版本与摘要；
 * 安装现状由 `matches`（实际安装与本次归档/依赖/Bundle/入口字节相符）回答。因此：
 * - add = 目标包不在授权内，或实际安装与本次目标不符（换字节、换模式、换源都落入后者）；
 * - remove = 已授权但不在本次选集（无论依赖/Bundle 现状：两者都已无时只清授权，依赖或 Bundle
 *   残留由同步流程清理，这是 2.6 中断表「remove 已完成、授权尚未删除」的入口）；
 * - 实际存在目标包却不在授权内 = 非受管安装，拒绝自动接管，显式 adopt 是唯一入口。
 */
export function computeChanges(managed, desired, installed, matches) {
  const owned = new Map((managed ?? []).map(entry => [entry.package, entry]));
  const byId = new Map((managed ?? []).map(entry => [entry.id, entry]));
  const bundles = bundlesOf(installed);
  for (const plugin of desired) {
    if ((installed.dependencies?.[plugin.package] || bundles.includes(plugin.package)) && !owned.has(plugin.package)) fail(`${plugin.id}: 与非受管安装 ${plugin.package} 冲突，不能自动接管。`);
    // 授权映射冲突：同 package 已授权给别的 id，或同 id 已对应别的 package 时拒绝，不静默改写授权。
    const byPackage = owned.get(plugin.package), byIdEntry = byId.get(plugin.id);
    if ((byPackage && byPackage.id !== plugin.id) || (byIdEntry && byIdEntry.package !== plugin.package)) fail(`${plugin.id}: 与既有受管映射冲突（${plugin.package} 与 ID 的对应关系不一致）。`);
  }
  const selected = new Set(desired.map(plugin => plugin.package));
  const remove = [...owned.values()].filter(entry => !selected.has(entry.package));
  const add = desired.filter(plugin => !owned.has(plugin.package) || !matches(plugin));
  return { remove, add };
}

export function installedMatches(root, plugin) {
  const manifest = profileManifest(root);
  if (!manifest.dependencies?.[plugin.package] || !bundlesOf(manifest).includes(plugin.package)) return false;
  const reference = plugin.mode === 'development' ? `link:${canonical(plugin.source)}` : `file:${canonical(plugin.archivePath)}`;
  if (anchoredSpec(root, manifest.dependencies[plugin.package]) !== reference) return false;
  const packageRoot = join(root, 'node_modules', plugin.package);
  const installed = readOptional(join(packageRoot, 'package.json'));
  // 包名与版本必须与本次目标一致：装错包或版本不符不算相符（设计 4.1「安装后包名/版本/入口/Bundle 正确」）。
  if (!installed || installed.name !== plugin.package || installed.version !== plugin.version) return false;
  const files = plugin.verifyFiles.filter(file => file !== 'package.json');
  for (const file of files) {
    const target = join(packageRoot, file);
    if (!existsSync(target) || !within(packageRoot, target) || !statSync(target).isFile()) return false;
  }
  // 一次解压取出全部待校验成员：逐个成员各跑一次 tar 会把整包重解压 N 遍。
  let packed;
  try { packed = openArchiveMembers(plugin.archivePath, files.map(file => `package/${file}`)); }
  catch { return false; } // An unreadable archive cannot verify the installed file.
  try {
    for (const file of files) {
      if (!readFileSync(join(packageRoot, file)).equals(packed.read(`package/${file}`))) return false;
    }
  } finally { packed.close(); }
  return true;
}

/** Compute package changes without treating discovery as installation ownership. */

/** A lock is never stolen solely because a timeout elapsed. */
export function acquireLock(profileRoot) {
  const path = join(profileRoot, LOCK);
  // 取锁也在 control 锁内：与残留锁退役、显式解锁共享同一套互斥，否则退役方可能搬走刚新建的锁。
  return withLockControl(path, () => acquireFileLock(path, `profile 正在同步或上次进程中断；检查 ${path} 后显式 unlock。`));
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

/** Preflight in an isolated profile before stopping or modifying the live target. */
export function preflightInstall(deployment, plugins, changes, cli, execute = cliRun) {
  const preflightHome = join(deployment.dataRoot, '.deployment-private', randomUUID(), 'preflight-home');
  const root = join(preflightHome, 'profiles', deployment.profile);
  mkdirSync(preflightHome, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(root), { recursive: true });
  const mutated = new Set([...changes.add, ...changes.remove].map(plugin => plugin.package));
  const retained = dependencyEvidence(deployment.profileRoot, mutated);
  if (existsSync(deployment.profileRoot)) cpSync(deployment.profileRoot, root, { recursive: true, dereference: true, filter: path => ![LOCK, OWNER, 'node_modules'].includes(path.split(sep).at(-1)) });
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

/**
 * 同步 profile 到本次目标。
 *
 * 顺序固定（设计 2.6）：停写与 profile 锁下读授权与实际安装 → 目标包实际存在却不在授权内时拒绝
 * 自动接管（显式 adopt 是唯一入口）→ 新纳入的包先原子写入授权再执行官方 CLI → 对受管包求差执行
 * remove/add → 撤选完成后（依赖与 Bundle 都消失）才移除授权 → 验证实际安装（包名/版本/依赖引用/
 * Bundle/入口字节）通过才更新 environment。任何失败只报错并停止本次流程，下一次从第一步重新计算，
 * 不读取失败步骤；授权集合不是待完成任务队列，未安装的授权可长期存在。
 */
export async function synchronize(deployment, release, options = {}) {
  assertReleaseMode(release, deployment.mode);
  prepareFrameworkCredentials(deployment);
  synchronizedStopped.delete(deployment);
  const runtime = runtimeEnvironment(deployment, release.plugins);
  const plugins = release.plugins.map(plugin => ({ ...plugin, mode: deployment.mode, ...(deployment.mode === 'development' ? { source: canonical(resolve(deployment.root, plugin.directory)) } : {}) }));
  // `locked` 表示调用方已经持有同一 profile 锁，并把锁一直留到启动验收结束（设计 5.2：安装锁
  // 覆盖安装、归属写入与启动验收，中间释放会给并发写入留出竞争窗口）。
  const releaseLock = options.locked ? () => {} : acquireLock(deployment.profileRoot);
  try {
    if (options.freshContainer && existsSync(join(deployment.profileRoot, OWNER))) fail('共享 home 存在运行记录；先由原管理者确认旧容器退出并处理记录，不能覆盖同步。');
    // 宿主绑定存在时，本次解析出的持久路径必须与它逐项一致（设计 2.6、5.1）：只比 STATE 里的
    // siteId/profile 不够——STATE 缺失（首次安装，或换了 home/profile 根）时，那一步会提前返回，
    // 同步会把本站点身份写进绑定之外的目录。容器内不挂载 .local，没有绑定，这一步自然跳过。
    if (existsSync(join(deployment.root, BINDING))) assertBindingMatches(deployment.root, deployment, deployment.config.composeProject ?? 'dsh-plugins');
    const previous = readDeploymentState(deployment) ?? { schemaVersion: 3, managed: [] };
    const managed = new Map(previous.managed.map(entry => [entry.package, entry]));
    const legacy = [join(deployment.profileRoot, '.deepseek-plugin-managed.json'), join(deployment.home, '.managed-dsh-plugins')];
    if (!previous.managed.length && legacy.some(existsSync)) fail('发现旧受管候选记录，请先用 migrate-site 显式迁移并核实包归属。');
    const cli = options.cli ?? hostCLI(deployment);
    const environment = { os: process.platform, architecture: process.arch, node: process.versions.node, mode: deployment.mode, ...(options.cli ? {} : runtimeIdentity(cli, deployment)) };
    const verification = assessVerification(release, release.verification?.runs.length
      ? verificationIdentity(cli, deployment, environment.hostVersion)
      : { host: { kind: 'unknown' }, platform: { os: process.platform, architecture: process.arch, nodeVersion: process.versions.node } }, deployment.mode);
    printVerification(verification);
    // environment 缺失或变化都使安装重用失效（设计 2.6）：接管后的包必须在目标环境重新装并核实。
    const environmentChanged = !same(previous.environment, environment);
    const installed = profileManifest(deployment.profileRoot);
    const changes = computeChanges(previous.managed, plugins, installed, plugin => !environmentChanged && installedMatches(deployment.profileRoot, plugin));
    const summary = () => plugins.map(entry => ({ id: entry.id, package: entry.package, version: entry.version }));
    if (!changes.add.length && !changes.remove.length && !environmentChanged && previous.environment !== undefined) {
      if (options.freshContainer) synchronizedStopped.add(deployment);
      return { changed: false, status: 'installed', activated: 'unknown', plugins: summary(), verification };
    }
    // 隔离安装只用于「本次要改包、且当前 profile 有待保留的非受管依赖」：没有非受管依赖时
    // 官方 CLI 直接按目标收敛即可，不必先造隔离候选（设计 3 节 preflight 条件保留）。
    const retained = Object.entries(installed.dependencies ?? {}).filter(([name]) => !managed.has(name));
    // 有非受管依赖时保留同一份证据：隔离安装与实际安装后都不得改变它们（设计 5.3）。
    const mutated = new Set([...changes.add, ...changes.remove].map(plugin => plugin.package));
    const retainedEvidence = retained.length ? dependencyEvidence(deployment.profileRoot, mutated) : null;
    if (!options.skipPreflight && (changes.add.length || changes.remove.length) && retained.length) preflightInstall(deployment, plugins, changes, cli, options.execute ?? cliRun);
    if (deployment.hostMode === 'owned' && !options.freshContainer) await stopOwned(deployment);
    else if (!options.freshContainer) externalStopped(deployment);
    const execute = options.execute ?? cliRun;
    // 新纳入的包先写授权（原子），再执行官方 CLI：崩溃后这些包仍是受管对象，哪怕尚未装成。
    for (const plugin of changes.add) if (!managed.has(plugin.package)) managed.set(plugin.package, { id: plugin.id, package: plugin.package });
    if (changes.add.length || changes.remove.length) {
      atomicJSON(join(deployment.profileRoot, STATE), managedFile(deployment, managed));
    }
    const backup = join(deployment.dataRoot, '.deployment-private', randomUUID(), 'profile-before');
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    if (!existsSync(backup)) cpSync(deployment.profileRoot, backup, { recursive: true, dereference: false, filter: path => ![LOCK, OWNER].includes(path.split(sep).at(-1)) });
    // 对受管包求差执行 remove/add；remove 逐个执行，add 批量执行。
    for (const plugin of changes.remove) {
      if (profileManifest(deployment.profileRoot).dependencies?.[plugin.package]) execute(cli, deployment, installationArguments(deployment, 'remove', plugin));
      // 官方 CLI 删不掉失去依赖记录的 Bundle：对精确受管包直接剔除遗留 Bundle，模板与其他内容不动。
      const after = profileManifest(deployment.profileRoot);
      if (after.dependencies?.[plugin.package]) fail(`${plugin.id}: 撤选后依赖仍存在，保留授权与现场。`);
      const bundles = bundlesOf(after);
      if (bundles.includes(plugin.package)) {
        const next = profileManifest(deployment.profileRoot);
        next.dsh.profile.bundles = next.dsh.profile.bundles.filter(name => name !== plugin.package);
        atomicJSON(join(deployment.profileRoot, 'package.json'), next);
      }
      managed.delete(plugin.package);
    }
    if (changes.add.length) execute(cli, deployment, batchAddArguments(deployment, changes.add));
    // 实际安装后复核同一份保留证据：不因隔离安装曾通过就忽略真实目标的变化（设计 5.3）。
    if (retainedEvidence && !same(retainedEvidence, dependencyEvidence(deployment.profileRoot, mutated))) fail('实际安装改变了要保留的非受管依赖或 Bundle；保持停服并报告差异，使用安装层备份显式处理。');
    // 实际安装结果验证通过才更新 environment；随后由启动流程验证就绪。
    for (const plugin of plugins) if (!installedMatches(deployment.profileRoot, plugin)) fail(`${plugin.id}: 安装或 Bundle 验证失败。`);
    atomicJSON(join(deployment.profileRoot, STATE), managedFile(deployment, managed, environment));
    synchronizedStopped.add(deployment);
    return { changed: true, status: 'installed', activated: 'unknown', plugins: summary(), verification };
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
  for (const entry of state.managed) {
    const packageRoot = join(deployment.profileRoot, 'node_modules', entry.package);
    const installed = readOptional(join(packageRoot, 'package.json'));
    if (!manifest.dependencies?.[entry.package] || !bundlesOf(manifest).includes(entry.package)
      || installed?.name !== entry.package || typeof installed.main !== 'string' || !installed.main) fail(`${entry.id}: 安装或 Bundle 漂移。`);
    const main = resolve(packageRoot, installed.main);
    if (!within(packageRoot, main) || !existsSync(main) || !statSync(main).isFile()) fail(`${entry.id}: 插件入口缺失或无效。`);
    // 探针地址来自已安装包内声明，不从发布归档读取。
    results.push({ id: entry.id, installed: true, activated: 'unknown', ready: await probePlugin(deployment, { ...entry, healthPath: installed.deepseekPlugin?.healthPath }, fetcher) });
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

/**
 * 启动后验证：就绪探针通过才认为本次启动可信。
 *
 * 受管授权集合与 environment 由 synchronize 维护；这里不再消费 pending、也不写 STATE——结果记录
 * 写失败不会锁死下一次发布，现场以 check-records 与周期健康为准。
 */
export async function finalize(deployment, release, { running = false, locked = false } = {}) {
  assertReleaseMode(release, deployment.mode);
  prepareFrameworkCredentials(deployment);
  const unlock = locked ? () => {} : acquireLock(deployment.profileRoot);
  try {
    if (!running) {
      const file = deployment.options['started-file'] ?? deployment.config.startedFile;
      if (!file) fail('记录配置已应用需要原管理者启动证据 --started-file。');
      const evidence = json(resolve(deployment.root, file));
      if (evidence.schemaVersion !== 1 || canonical(evidence.home ?? '') !== deployment.home || evidence.profile !== deployment.profile || evidence.started !== true || !evidence.manager || !evidence.instanceId || !Number.isFinite(Date.parse(evidence.startedAt))) fail('启动证据无效。');
      observeManager(evidence, true);
    }
    return await verifyReady(deployment, release);
  } finally { unlock(); }
}

/**
 * 显式接管点名安装：只向受管授权集合增量加入映射，不宣称目标版本、配置或环境已应用。
 *
 * 已有 schema 3 时保留全部原授权；相同映射幂等；ID 或 package 的冲突映射拒绝。接管后不写
 * environment，下一次普通 build 完成目标环境安装验证。旧 schema/损坏状态由 migrate-site 处理，
 * 这里不越权清空其他授权、不越过活动锁。
 */
export async function adoptLegacy(deployment, release, ids) {
  assertReleaseMode(release, deployment.mode);
  if (!Array.isArray(ids) || !ids.length || ids.includes('all') || ids.includes('none') || new Set(ids).size !== ids.length) fail('adopt 需要 --plugins 精确列出待接管 ID，不能使用 all/none。');
  const unlock = acquireLock(deployment.profileRoot);
  try {
    // 先核实站点绑定与停写：绑定存在时本次目标必须与它一致，路径漂移拒绝接管。
    const binding = readBinding(deployment.root);
    if (binding) assertBindingMatches(deployment.root, deployment, deployment.config.composeProject ?? 'dsh-plugins');
    const previous = readDeploymentState(deployment) ?? { schemaVersion: 3, managed: [] };
    const managed = new Map(previous.managed.map(entry => [entry.package, entry]));
    const byId = new Map(previous.managed.map(entry => [entry.id, entry]));
    if (deployment.hostMode === 'owned') await stopOwned(deployment); else externalStopped(deployment);
    const manifest = profileManifest(deployment.profileRoot);
    const bundles = bundlesOf(manifest);
    const adopted = [];
    for (const id of ids) {
      const plugin = release.plugins.find(item => item.id === id);
      if (!plugin) fail(`发布清单未声明 ${id}。`);
      const installed = readOptional(join(deployment.profileRoot, 'node_modules', plugin.package, 'package.json'));
      if (!installed || installed.name !== plugin.package || !manifest.dependencies?.[plugin.package] || !bundles.includes(plugin.package)) fail(`${id}: 缺少可核验的安装和 Bundle，拒绝接管。`);
      const byPackage = managed.get(plugin.package), byIdEntry = byId.get(id);
      if ((byPackage && byPackage.id !== id) || (byIdEntry && byIdEntry.package !== plugin.package)) fail(`${id}: 与既有受管映射冲突（ID 与 package 对应关系不一致），拒绝接管。`);
      if (byPackage && byPackage.id === id) continue; // 已有相同映射，幂等。
      const entry = { id, package: plugin.package };
      managed.set(plugin.package, entry); byId.set(id, entry);
      adopted.push(entry);
    }
    if (!adopted.length) return { status: 'adopted-unchanged', plugins: ids };
    atomicJSON(join(deployment.profileRoot, STATE), managedFile(deployment, managed));
    return { status: 'adopted-requires-sync', plugins: adopted.map(entry => entry.id) };
  } finally { unlock(); }
}
