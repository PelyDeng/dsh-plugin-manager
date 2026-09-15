/** 唯一站点部署主路径：稳定绑定与本次输入 → 准备 → 停旧 → 候选容器内安装启动 → 验证。 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commandSpec, normalizeEnvironment } from './process.mjs';
import { inspectDocker, composeContainers, assertNoOverlappingWriters, assertStoppedBinding } from './docker-runtime.mjs';
import { ensurePrivateDirectory } from './private-files.mjs';
import { canonical, STATE } from './state.mjs';
import { resolveDeployment } from './config.mjs';
import { loadReleaseInputs } from './release.mjs';
import { readState } from './installation.mjs';
import { resolvePluginSettings } from './plugin-settings.mjs';
import { loadSite, saveJson } from './site-config.mjs';
import { siteArguments, sitePointer, fileHash, readSiteJson, verifySavedTooling, toolTreeIdentity, removedArguments } from './site-record.mjs';
import { prepareDeployment } from './site-archives.mjs';
import { initializeArchiveSettings, freezeSiteInputs, verifySiteInputs, materializeSiteDefaults } from './site-inputs.mjs';
import { buildStep, buildMessage } from './site-output.mjs';
import { readBinding, assertBindingMatches, assertSiteMarks, initializeBinding } from './site-binding.mjs';
import { checkCompose } from './apply-compose.mjs';

let interruptedChild = false;

/**
 * 说明这一轮实际执行的是哪份管理工具。
 *
 * 发布可能由**当前源码**执行，也可能由发布目录里安装好的**工具快照**执行（快照由
 * `scripts/manager-tooling.mjs` 打包并安装）。两者行为不同却看不出区别，曾出现「源码明明
 * 改了、这轮却按旧行为跑」的困惑，所以这里把它打出来。
 */
export function describeTooling(modulePath, record) {
  const cli = resolve(fileURLToPath(modulePath));
  const toolRoot = typeof record?.toolRoot === 'string' ? resolve(record.toolRoot) : null;
  const snapshot = toolRoot !== null && cli.startsWith(`${toolRoot}${sep}`);
  return [
    `执行工具：${snapshot ? `工具快照 ${toolRoot}` : '当前源码检出'}`,
    `工具入口：${cli}`,
    ...(toolRoot === null ? [] : [`工具目录：${toolRoot}`]),
    ...(typeof record?.managerHash === 'string' ? [`工具归档摘要：${record.managerHash.slice(0, 16)}…`] : []),
  ].join('\n');
}

function command(bin, args, options) {
  const cli = commandSpec(bin, { env: options?.env, cwd: options?.cwd });
  const result = spawnSync(cli.command, [...cli.prefix, ...args], { stdio: 'inherit', windowsHide: true, ...options });
  if (result.signal) interruptedChild = true;
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error(`${bin} ${args[0]} failed (${result.status ?? result.signal}). ${result.stderr ?? ''}`), { signal: result.signal });
  return result.stdout?.trim() ?? '';
}
const immutableImage = value => typeof value === 'string' && /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(value);

function selectedProof(release) { return release.plugins.map(({ id, package: name, sha256 }) => ({ id, package: name, sha256 })).sort((a, b) => a.id.localeCompare(b.id)); }

/**
 * 没有绑定且不是全新站点时拒绝：旧数据、旧状态或已有容器都必须经显式迁移导入，不能自动
 * 补建绑定来掩盖数据丢失（设计 5.1）。
 */
function assertFreshSite(root, resolvedSite, composeProject, active, capture) {
  if (active) throw new Error('发现活动部署但没有站点绑定；请使用显式迁移导入，不会从活动部署自动重建绑定。');
  for (const folder of new Set([resolvedSite.dataRoot, resolvedSite.home, resolvedSite.workspace, 'data', 'deploy-artifacts'])) {
    const path = resolve(root, folder);
    if (existsSync(path) && readdirSync(path).length) throw new Error(`存在数据但没有站点绑定：${path}；请使用显式迁移导入，初始化不会覆盖旧数据。`);
  }
  if (existsSync(resolve(resolvedSite.profileRoot, STATE))) throw new Error('存在受管状态但没有站点绑定；请使用显式迁移导入。');
  if (capture('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${composeProject}`])) throw new Error('该 Compose 项目已有容器；更换项目名或使用显式迁移导入。');
}

/**
 * 唯一部署主路径（设计 5.3）：取得部署锁由外层 source 入口负责；这里读取绑定与本次输入，准备
 * 工具/镜像与合并清单，停止绑定目标的当前服务，起候选容器按 2.6 安装并启动，最后写诊断记录。
 * 不接受 resume/recover；所有已完成的安全事实从当前现场重新取得。
 */
export function releaseSite(options = {}, execute = command, adapter) {
  const { root: rawRoot, config, inputKind: initialKind = 'archives', ...rest } = options;
  const removedKey = Object.keys(rest).find(key => Object.hasOwn(removedArguments, key));
  if (removedKey) throw new Error(`已移除的站点参数：${removedKey}；${removedArguments[removedKey]}`);
  if (Object.keys(rest).length) throw new Error(`未知站点发布参数：${Object.keys(rest).join(', ')}。`);
  if (!rawRoot) throw new Error('站点部署必须提供 --root。');
  const root = canonical(rawRoot);
  const env = normalizeEnvironment(process.env);
  for (const key of ['DEPLOYMENT_CONFIG', 'PLUGIN_MANIFEST_FILE', 'DSH_DATA_DIR', 'DSH_HOME', 'DSH_WORKSPACE', 'DSH_AUTH_URL_FILE', 'DSH_DEPLOY_ARTIFACTS', 'DSH_PROFILE', 'DSH_PUBLIC_ORIGIN', 'DSH_PUBLIC_URL', 'DSH_STORE_DIR', 'DSH_OFFLINE_STORE_DIR', 'DSH_CACHE_DIR', 'DSH_OFFLINE_CACHE_DIR']) delete env[key];
  const run = (bin, args, options = {}) => execute(bin, args, { cwd: root, env, ...options });
  const step = (label, bin, args) => buildStep(label, () => run(bin, args));
  const capture = (bin, args) => run(bin, args, { stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const probe = (bin, args) => { try { return capture(bin, args); } catch { return null; } };
  const runtime = inspectDocker((args, options) => run('docker', args, { stdio: 'pipe', encoding: 'utf8', ...options }));
  for (const key of Object.keys(env)) if (['DOCKER_HOST', 'DOCKER_CONTEXT'].includes(key.toUpperCase())) delete env[key];
  env.DOCKER_HOST = runtime.endpoint;
  let { site, sitePath, runtimePath, source: sourceInput } = loadSite(root, config, { inputKind: initialKind, imagePlatform: `linux/${runtime.architecture}`, desktop: runtime.desktop });
  // 输入形态由入口决定（源码检出入口 source、发行包入口 archives），站点配置不再有 pluginSource 字段。
  const inputKind = initialKind;
  const resolvedSite = resolveDeployment({ root, config: sitePath, 'data-root': site.dataRoot, home: site.home, workspace: site.workspace, artifacts: site.artifacts, profile: site.profile }, {});
  const sitePaths = Object.fromEntries(['dataRoot', 'home', 'workspace', 'authUrlFile', 'artifacts', 'profile'].map(field => [field, resolvedSite[field]]));
  const composeProject = site.composeProject ?? 'dsh-plugins';
  const activeFile = resolve(root, site.artifacts, 'active-compose.json'), active = existsSync(activeFile) ? readSiteJson(activeFile) : null;
  const originalConfig = existsSync(runtimePath) ? readFileSync(runtimePath) : null;
  // 稳定绑定：正常 build 只读；真正空的新站点才初始化绑定与目录标记。
  let binding = readBinding(root);
  if (binding) {
    assertBindingMatches(root, resolvedSite, composeProject);
    assertSiteMarks(binding);
  } else {
    assertFreshSite(root, resolvedSite, composeProject, active, capture);
    binding = initializeBinding(root, { dataRoot: resolvedSite.dataRoot, home: resolvedSite.home, workspace: resolvedSite.workspace, authUrlFile: resolvedSite.authUrlFile, artifacts: resolvedSite.artifacts, profile: resolvedSite.profile, composeProject }, `site-${randomUUID()}`);
  }
  const operation = resolve(root, '.local/artifacts', `source-release-${randomUUID()}`);
  ensurePrivateDirectory(operation);
  const recordPath = resolve(operation, 'result.json');
  const pointer = sitePointer(root);
  const record = { schemaVersion: 3, inputKind, operation, siteId: binding.siteId, sitePath, sitePaths, siteHash: fileHash(sitePath), status: 'building', previous: active, runtime };
  // 展示端会把逐步计时写到它的私有目录，并把路径通过环境变量交给本次 worker：登记在第一次写入之前，
  // 否则后续 persist() 会用内存里的记录整体覆盖 result.json，把这条线索丢掉。
  if (process.env.DSH_BUILD_TIMINGS) record.timings = { path: resolve(process.env.DSH_BUILD_TIMINGS) };
  const persist = (publish = true) => { saveJson(recordPath, record); if (publish) saveJson(pointer, { operation, status: record.status }); };
  persist();
  const context = { root, site, sitePath, sourceInput, resolvedSite, runtimePath, previous: active, active, env, run, step, capture, probe, runtime, execute, adapter, operation, record,
    // 归档缓存根固定为**本次已解析的 artifacts 根**下 plugin-packages（设计 4.2）：它必须与迁移
    // 保全旧 file: 引用时使用的位置一致，否则自定义 artifacts 的站点迁移后容器会挂到另一个目录。
    cacheRoot: resolve(resolvedSite.artifacts, 'plugin-packages'),
    inspect: image => JSON.parse(capture('docker', ['image', 'inspect', image]))[0] };
  record.toolRoot = undefined;
  let stopped = false, installStarted = false, prepared = false;
  try {
    // 唯一部署准备：工具、运行镜像、内置构建与 incoming 外部归档合并成一份候选（设计 5.3）。
    // 源码检出通过 adapter 提供工具与运行镜像；发行包用自带的 tools/ 与 framework-runtime.json。
    if (adapter?.inspect) { Object.assign(record, buildStep('检查源码与宿主身份', () => adapter.inspect(context))); persist(); }
    const result = buildStep('准备部署输入', () => prepareDeployment(context));
    const release = buildStep('加载发布清单', () => loadReleaseInputs(result.manifest));
    if (inputKind === 'archives') {
      const initialized = initializeArchiveSettings(root, site, release, { fresh: !active });
      if (initialized.site) { site = initialized.site; if (initialized.missing.length) throw new Error(initialized.missing.join('\n')); }
    }
    const configured = resolveDeployment({ root, config: sitePath, 'data-root': site.dataRoot, home: site.home, workspace: site.workspace, artifacts: site.artifacts, profile: site.profile }, {});
    configured.config = site; configured.instances = site.instances ?? {};
    const settings = resolvePluginSettings(configured, release);
    // 选区核对在停旧之前完成（设计 5.3 第 2 步）：显式选集必须都能在合并后的候选里找到；
    // 没有显式选集时，上次仍启用的插件不能在本次候选中消失。两条来源路径共用同一份规则。
    const present = new Set(release.plugins.map(plugin => plugin.id));
    if (Array.isArray(site.plugins)) {
      for (const id of site.plugins) if (!present.has(id)) throw new Error(`选集里的插件 ${id} 缺少产物；请放入完整发布目录或显式停用。`);
    } else {
      const state = readState(resolve(resolvedSite.profileRoot, STATE));
      for (const id of state?.managed.map(entry => entry.id) ?? []) if (!present.has(id)) throw new Error(`仍启用的插件 ${id} 缺少产物；请恢复完整目录，停用请显式设置 DSH_PLUGINS。`);
    }
    const frozen = buildStep('冻结站点输入', () => freezeSiteInputs({ root, operation, site, sitePath, source: sourceInput, release }));
    const candidate = { ...frozen.candidate, ...sitePaths, siteId: binding.siteId, frameworkVersion: result.manager, dockerRuntime: runtime, containerImage: result.image, manifest: relative(root, result.manifest).split('\\').join('/'),
      pluginCacheRoot: resolve(resolvedSite.artifacts, 'plugin-packages'), pluginCacheManifest: result.cacheManifest ?? 'manifest.json' };
    record.candidatePath = resolve(operation, 'deployment.json'); saveJson(record.candidatePath, candidate);
    Object.assign(record, { image: result.image, manager: result.manager, manifest: result.manifest, manifestHash: fileHash(result.manifest), candidateHash: fileHash(record.candidatePath),
      inputs: frozen.inputs, inputEnvironment: frozen.environment, siteInstances: site.instances ?? {}, enabledPlugins: frozen.enabled, selectedPlugins: selectedProof(settings.release),
      plugins: release.plugins.map(({ id, version }) => ({ id, version })), cacheManifest: result.cacheManifest ?? null, toolHash: buildStep('核验工具树身份', () => toolTreeIdentity(record.toolRoot)), status: 'prepared' });
    if ((originalConfig && !readFileSync(runtimePath).equals(originalConfig)) || (!originalConfig && existsSync(runtimePath))) throw new Error('Deployment state changed during preparation.');
    buildStep('核验已保存工具', () => verifySavedTooling(record)); buildStep('核验站点输入', () => verifySiteInputs(record));
    persist(); prepared = true;
    const { cli } = verifySavedTooling(record);
    if (!immutableImage(record.image) || fileHash(record.manifest) !== record.manifestHash || fileHash(record.candidatePath) !== record.candidateHash) throw new Error('Saved release inputs changed; the deployment is retained for inspection.');
    buildStep('加载发布清单', () => loadReleaseInputs(record.manifest)); buildStep('核验站点输入', () => verifySiteInputs(record));
    const candidateNow = readSiteJson(record.candidatePath);
    if (candidateNow.containerImage !== record.image || resolve(root, candidateNow.manifest) !== record.manifest) throw new Error('Saved deployment configuration changed.');
    buildStep('写入站点默认配置', () => materializeSiteDefaults(record));
    // 停旧前核验候选配置、挂载与权限：这是内部的一次渲染核验，不再有公开的 check-compose 动作。
    // 核验失败时旧服务保持运行。
    const candidateDeployment = resolveDeployment({ root, config: record.candidatePath }, {});
    buildStep('核验容器挂载与权限', () => checkCompose(candidateDeployment, release, (args, options) => run('docker', args, { stdio: 'pipe', encoding: 'utf8', ...options }), runtime));
    // 停止目标来自站点绑定与实时查询（设计 3、5.3）：按 Compose 项目查当前容器并停止；
    // 零容器是合法已停现场，不因缺少旧记录、旧容器或旧镜像拒绝部署。旧记录只作诊断。
    const inspect = (args, options) => run('docker', args, { stdio: 'pipe', encoding: 'utf8', ...options });
    const current = composeContainers(inspect, runtime, composeProject);
    if (current.running.length) {
      step('停止当前服务', 'docker', ['stop', ...current.running]);
      stopped = true;
      if (composeContainers(inspect, runtime, composeProject).running.length) throw new Error('当前服务仍在运行；拒绝继续部署。');
    }
    // 停写证明分两步，零容器时两步都要做（设计 5.1、6.2）：
    // 1) 本项目容器必须已停、profile/home 映射与绑定一致，Desktop 证明使用**本次**的镜像；
    // 2) 本机引擎上任何容器都不得仍在写同一批持久目录——共享挂载写入者不限于本项目。
    assertStoppedBinding(composeContainers(inspect, runtime, composeProject).all, binding, inspect, runtime, record.image);
    assertNoOverlappingWriters(binding, inspect, runtime);
    record.status = 'applying'; record.installStarted = true; persist(); installStarted = true;
    saveJson(runtimePath, candidateNow);
    step('部署并验证服务', process.execPath, [cli, 'apply-compose', '--root', root, '--config', runtimePath]);
    record.status = 'ready'; record.completedAt = new Date().toISOString();
    // 结果日志写失败不回滚已就绪的服务：现场以 check-records 与周期健康为准（设计 5.4）。
    try { persist(); } catch (error) { console.error(`业务结果已知、记录写入失败：${error.message}`); }
    buildMessage(`发布已完成：${record.inputKind ?? 'source'}\n访问地址：${site.publicUrl}\n启用插件：${record.enabledPlugins?.join(', ') ?? record.plugins?.map(p => p.id).join(', ')}\n发布记录：${recordPath}`);
    return record;
  } catch (error) {
    record.status = installStarted || stopped ? 'deployment-failed' : 'build-failed'; persist();
    console.error(`发布失败；记录保留在 ${operation}。修正输入后重新运行 build；现场以 check-records 与周期健康为准，不读取旧状态继续。`);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const options = siteArguments(process.argv.slice(2)); releaseSite({ root: options.root, config: options.config }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (typeof process.send === 'function') {
    if (interruptedChild) process.disconnect();
    else process.send({ type: 'source-build-finished', code: process.exitCode ?? 0 }, () => process.disconnect());
  }
}
