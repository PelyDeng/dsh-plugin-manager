/** One site operation for source and archive inputs, including saved-tool recovery. */
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commandSpec, normalizeEnvironment } from './process.mjs';
import { inspectDocker, ensureDockerIdentity, assertStoppedCompose } from './docker-runtime.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './private-files.mjs';
import { canonical, hash, STATE, PENDING, same } from './state.mjs';
import { resolveDeployment } from './config.mjs';
import { loadRelease, selectRelease } from './release.mjs';
import { composeReleases } from './compose-release.mjs';
import { readState } from './installation.mjs';
import { resolvePluginSettings } from './plugin-settings.mjs';
import { loadSite, saveJson } from './site-config.mjs';
import { siteArguments, sitePointer, readSitePointer, readSiteRecord, needsSiteResume, fileHash, readSiteJson, verifySavedTooling, toolTreeIdentity } from './site-record.mjs';
import { discoverArchives, prepareArchives } from './site-archives.mjs';
import { initializeArchiveSettings, freezeSiteInputs, verifySiteInputs, materializeSiteDefaults } from './site-inputs.mjs';
import { buildStep, buildMessage } from './site-output.mjs';

let interruptedChild = false;
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

/** Keep the old data guard: only a verified saved operation may continue initialization. */
function checkSiteIdentity(context, recovery) {
  const { root, site, resolvedSite, active, previous, capture, runtimePath } = context;
  if (recovery) return;
  if (active) {
    const oldCompose = readSiteJson(active.path);
    if (active.project !== site.composeProject || oldCompose.services.dsh.image !== previous?.containerImage) throw new Error('The active deployment differs from the site configuration; reconcile its project and image before updating.');
    const old = resolveDeployment({ root, config: runtimePath }, {});
    for (const field of ['dataRoot', 'home', 'workspace', 'authUrlFile', 'artifacts', 'profile']) if (old[field] !== resolvedSite[field]) throw new Error(`Changing ${field} requires an explicit migration; restore the current site value before updating.`);
  } else {
    for (const folder of new Set([site.dataRoot, site.home, site.workspace, 'data', 'deploy-artifacts'])) {
      const path = resolve(root, folder);
      if (existsSync(path) && readdirSync(path).length) throw new Error(`Existing data without an active deployment: ${path}. Restore its deployment records or use explicit migration; initialization will not overwrite it.`);
    }
    if (capture('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${site.composeProject}`])) throw new Error('This Compose project already has containers. Use another project or restore its deployment records.');
  }
  const oldCompose = active && readSiteJson(active.path);
  if (!active || String(oldCompose.services.dsh.environment?.DSH_PORT) !== String(site.port)) capture(process.execPath, ['--input-type=module', '-e', 'import net from "node:net"; const s=net.createServer(); s.once("error",()=>{console.error("Requested port is unavailable.");process.exitCode=1});s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close());', String(site.port)]);
}

function changeSummary(before, after, sources = []) {
  const previous = new Map((before?.plugins ?? []).map(p => [p.id, p])), current = new Set(after.plugins.map(p => p.id));
  for (const plugin of after.plugins) {
    const old = previous.get(plugin.id), origin = sources.find(release => release.plugins.some(p => p.id === plugin.id))?.path;
    buildMessage(`${!old ? '新增' : old.sha256 === plugin.sha256 ? '保留' : '更新'} ${plugin.id} ${plugin.version}${origin ? ` · ${dirname(origin)}` : ''}`);
  }
  for (const plugin of previous.values()) if (!current.has(plugin.id)) buildMessage(`停用 ${plugin.id} · 保留数据与旧归档`);
}

/** Preparation is the only adapter boundary; everything after it uses the same state machine. */
export function releaseSite({ root, config, resume = false, recover = false, dataCompatible = false, rebuildPlugins, skipPluginCheck = false, inputKind = 'archives' } = {}, execute = command, adapter) {
  if (!root) throw new Error('站点部署必须提供 --root。');
  root = canonical(root);
  siteArguments([...(resume ? ['--resume'] : []), ...(recover ? ['--recover'] : []), ...(dataCompatible ? ['--data-compatible'] : []), ...(skipPluginCheck ? ['--skip-plugin-check'] : []), ...(rebuildPlugins === undefined ? [] : ['--rebuild-plugins', rebuildPlugins])]);
  const pointer = sitePointer(root), prior = readSitePointer(root), interrupted = prior && needsSiteResume(prior.status);
  if (interrupted && !resume && !recover) throw new Error('An unfinished deployment is recorded. Keep the site configuration unchanged and use --resume; for business configuration changes use --recover --data-compatible.');
  if ((resume || recover) && !interrupted) throw new Error('No unfinished prepared deployment to resume or recover.');
  const predecessor = resume || recover ? readSiteRecord(root, prior.operation) : null;
  if (recover && predecessor.schemaVersion !== 3) throw new Error('旧 schema 2 请使用原环境高级恢复流程；没有原私有输入快照，不能高层修正配置。');
  inputKind = predecessor?.inputKind ?? (predecessor ? 'source' : inputKind);
  const env = normalizeEnvironment(process.env);
  for (const key of ['DEPLOYMENT_CONFIG', 'PLUGIN_MANIFEST_FILE', 'DSH_DATA_DIR', 'DSH_HOME', 'DSH_WORKSPACE', 'DSH_AUTH_URL_FILE', 'DSH_DEPLOY_ARTIFACTS', 'DSH_PROFILE', 'DSH_PUBLIC_ORIGIN', 'DSH_PUBLIC_URL', 'DSH_STORE_DIR', 'DSH_OFFLINE_STORE_DIR', 'DSH_CACHE_DIR', 'DSH_OFFLINE_CACHE_DIR']) delete env[key];
  const run = (bin, args, options = {}) => execute(bin, args, { cwd: root, env, ...options });
  const step = (label, bin, args) => buildStep(label, () => run(bin, args));
  const capture = (bin, args) => run(bin, args, { stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const probe = (bin, args) => { try { return capture(bin, args); } catch { return null; } };
  const runtime = inspectDocker((args, options) => run('docker', args, { stdio: 'pipe', encoding: 'utf8', ...options }));
  for (const key of Object.keys(env)) if (['DOCKER_HOST', 'DOCKER_CONTEXT'].includes(key.toUpperCase())) delete env[key];
  env.DOCKER_HOST = runtime.endpoint;
  let { site, sitePath, runtimePath, source: sourceInput } = loadSite(root, config, { inputKind, imagePlatform: `linux/${runtime.architecture}`, desktop: runtime.desktop });
  if (predecessor && site.pluginSource !== undefined && site.pluginSource !== inputKind) throw new Error('未完成操作不能更改输入模式。');
  inputKind = site.pluginSource ?? inputKind;
  if (inputKind === 'archives' && rebuildPlugins !== undefined) throw new Error('--rebuild-plugins 仅用于 source。');
  if (inputKind === 'archives' && skipPluginCheck) throw new Error('--skip-plugin-check 仅用于 source：归档部署不构建插件，本来就不跑插件检查。');
  const resolvedSite = resolveDeployment({ root, config: sitePath, 'data-root': site.dataRoot, home: site.home, workspace: site.workspace, artifacts: site.artifacts, profile: site.profile }, {});
  const sitePaths = Object.fromEntries(['dataRoot', 'home', 'workspace', 'authUrlFile', 'artifacts', 'profile'].map(field => [field, resolvedSite[field]]));
  if (predecessor?.schemaVersion === 3 && !same(predecessor.sitePaths, sitePaths)) throw new Error('原持久路径的实际位置已变化；恢复原路径后重试，不会自动迁移。');
  const activeFile = resolve(root, site.artifacts, 'active-compose.json'), active = existsSync(activeFile) ? readSiteJson(activeFile) : null;
  const originalConfig = existsSync(runtimePath) ? readFileSync(runtimePath) : null, previous = originalConfig ? JSON.parse(originalConfig) : null;
  const context = { root, site, sitePath, sourceInput, resolvedSite, runtimePath, previous, active, env, run, step, capture, probe, runtime, execute, adapter, rebuildPlugins, skipPluginCheck,
    inspect: image => JSON.parse(capture('docker', ['image', 'inspect', image]))[0] };
  checkSiteIdentity(context, predecessor);
  if (predecessor) {
    if (predecessor.sitePath !== sitePath || fileHash(sitePath) !== predecessor.siteHash) throw new Error('Resume requires the original unchanged site configuration.');
    if (predecessor.runtime) ensureDockerIdentity(predecessor.runtime, runtime);
    verifySavedTooling(predecessor); verifySiteInputs(predecessor, { recover });
    if (predecessor.schemaVersion === 2) {
      if (capture('git', ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'])) throw new Error('Legacy source recovery requires the original clean source environment.');
      writePrivateFile(resolve(predecessor.operation, `record-before-resume-${randomUUID()}.json`), readFileSync(resolve(predecessor.operation, 'result.json')), { flag: 'wx' });
    }
  }
  const operation = resume ? predecessor.operation : resolve(root, '.local/artifacts', `source-release-${randomUUID()}`);
  ensurePrivateDirectory(operation); context.operation = operation;
  const siteOperation = resume ? predecessor.siteOperation : randomUUID();
  const initialState = !resume && !recover ? readState(resolve(resolvedSite.profileRoot, STATE)) : null;
  let record = resume ? predecessor : { schemaVersion: 3, inputKind, operation, siteOperation, sitePath, sitePaths, siteHash: fileHash(sitePath), status: 'building', previous: active, previousRuntime: previous,
    ...(!existsSync(resolve(resolvedSite.profileRoot, PENDING)) ? { previousStateHash: initialState ? hash(JSON.stringify(initialState)) : null } : {}), runtime };
  context.record = record;
  const recordPath = resolve(operation, 'result.json');
  const persist = (publish = true) => { saveJson(recordPath, record); if (publish) saveJson(pointer, { operation, status: record.status }); };
  if (!recover) persist();
  let stopped = false, installing = false, prepared = resume;
  try {
    if (!resume) {
      let result, releases = [];
      if (recover) {
        const oldTools = verifySavedTooling(predecessor), toolRoot = resolve(operation, 'tooling');
        // Preserve the saved tree's relative links and avoid Node 22's Windows Unicode native-copy path.
        cpSync(oldTools.toolRoot, toolRoot, { recursive: true, dereference: false, verbatimSymlinks: true, filter: () => true });
        const manifest = resolve(operation, 'plugins/manifest.json'), oldRelease = loadRelease(predecessor.manifest);
        composeReleases([oldRelease], dirname(manifest), oldRelease);
        record = { ...predecessor, operation, siteOperation, status: 'building', supersedes: predecessor.operation, toolRoot, managerArchive: resolve(toolRoot, relative(oldTools.toolRoot, predecessor.managerArchive)), manifest, stopComplete: predecessor.stopComplete, inputs: undefined, inputEnvironment: undefined };
        delete record.completedAt; delete record.candidateHash; delete record.toolHash;
        context.record = record;
        result = { manifest, image: predecessor.image, manager: predecessor.manager };
        const pendingFile = resolve(resolvedSite.profileRoot, PENDING), stateFile = resolve(resolvedSite.profileRoot, STATE);
        const pending = existsSync(pendingFile) ? readSiteJson(pendingFile) : null, state = existsSync(stateFile) ? readState(stateFile) : null;
        const expected = predecessor.selectedPlugins;
        if (!predecessor.siteOperation || fileHash(predecessor.candidatePath) !== predecessor.candidateHash) throw new Error('原失败候选缺少可核验的站点安装归属，保留现场。');
        const oldCandidate = readSiteJson(predecessor.candidatePath);
        if (oldCandidate.siteOperation !== predecessor.siteOperation) throw new Error('原失败候选的站点安装归属发生变化，保留现场。');
        const stateHash = state ? hash(JSON.stringify(state)) : null, pendingHash = pending ? hash(JSON.stringify(pending)) : null;
        // A recovery can fail before consuming its already-authorized predecessor transaction.
        const inheritedPending = oldCandidate.siteRecovery?.id === predecessor.siteOperation && pending?.operationId === oldCandidate.siteRecovery.pendingId && pendingHash === oldCandidate.siteRecovery.pendingHash && stateHash === oldCandidate.siteRecovery.stateHash;
        if (pending && (!pending.operationId || (!inheritedPending && pending.desired?.siteOperation !== predecessor.siteOperation) || !same(selectedProof({ plugins: pending.desired?.plugins ?? [] }), expected))) throw new Error('原 pending 无法对应失败候选，不能修正配置。');
        const ownState = state?.siteOperation === predecessor.siteOperation && same(selectedProof(state), expected);
        if (!pending && !ownState && (!Object.hasOwn(predecessor, 'previousStateHash') || stateHash !== predecessor.previousStateHash)) throw new Error('受管成功状态与失败候选或安装前记录不一致，不能修正配置。');
        if (pending) delete record.previousStateHash; else record.previousStateHash = stateHash;
        context.recoveryIntent = { schemaVersion: 1, id: siteOperation, pendingId: pending?.operationId ?? null, pendingHash, stateHash };
      } else if (inputKind === 'source') {
        if (!adapter) throw new Error('source 模式必须由框架源码入口提供源码准备。');
        Object.assign(record, adapter.inspect(context));
        persist(); result = adapter.prepare(context);
      } else {
        releases = discoverArchives(root);
        if (!releases.some(item => item.plugins.length) && !(Array.isArray(site.plugins) && site.plugins.length === 0)) throw new Error('incoming 中没有完整发布目录；请放入 manifest.json 及其引用的全部 tgz。空目录不会卸载插件。');
        result = prepareArchives(context, releases);
      }
      const release = loadRelease(result.manifest);
      // Remember original editable paths rather than reusing the previous private snapshot paths.
      const successful = !predecessor && prior?.status === 'ready' ? readSiteRecord(root, prior.operation, { status: 'ready' }) : predecessor;
      // Applying can replace runtimePath before failing; recovery still describes the prior runtime.
      const current = recover ? predecessor.previousRuntime : previous;
      const currentFramework = current?.frameworkVersion ?? (!predecessor && current && successful?.schemaVersion === 3 && successful.status === 'ready'
        && successful.siteOperation === current.siteOperation && successful.image === current.containerImage
        && successful.manifest === resolve(root, current.manifest ?? '') && successful.candidateHash === hash(originalConfig)
        ? successful.frameworkVersion ?? successful.manager : undefined);
      if (currentFramework) record.previousRuntime = { ...current, frameworkVersion: currentFramework };
      if (successful?.siteInstances) site = { ...site, instances: { ...successful.siteInstances, ...(site.instances ?? {}) } };
      if (inputKind === 'archives') {
        const initialized = initializeArchiveSettings(root, site, release, { fresh: !active && !predecessor });
        if (initialized.site) { site = initialized.site; if (initialized.missing.length) throw new Error(initialized.missing.join('\n')); }
      }
      const configured = resolveDeployment({ root, config: sitePath, 'data-root': site.dataRoot, home: site.home, workspace: site.workspace, artifacts: site.artifacts, profile: site.profile }, {});
      configured.config = site; configured.instances = site.instances ?? {};
      const settings = resolvePluginSettings(configured, release);
      if (inputKind === 'archives' && site.plugins === undefined) {
        const present = new Set(release.plugins.map(p => p.id));
        const state = readState(resolve(resolvedSite.profileRoot, STATE));
        const previouslyEnabled = successful?.enabledPlugins ?? state?.plugins.map(plugin => plugin.id) ?? previous?.plugins ?? [];
        for (const id of previouslyEnabled) if (!present.has(id)) throw new Error(`仍启用的插件 ${id} 缺少产物；请恢复完整目录，停用请显式设置 DSH_PLUGINS。`);
      }
      if (recover && (!same(selectedProof(settings.release), predecessor.selectedPlugins) || !same(settings.release.plugins.map(p => p.id), predecessor.enabledPlugins))) throw new Error('recover 不能改变包、选集或启用状态。');
      const frozen = freezeSiteInputs({ root, operation, site, sitePath, source: sourceInput, release });
      const candidate = { ...frozen.candidate, ...sitePaths, frameworkVersion: result.manager, siteOperation, dockerRuntime: runtime, containerImage: result.image, manifest: relative(root, result.manifest).split('\\').join('/'), ...(context.recoveryIntent ? { siteRecovery: context.recoveryIntent } : {}) };
      record.candidatePath = resolve(operation, 'deployment.json'); saveJson(record.candidatePath, candidate);
      Object.assign(record, { image: result.image, manager: result.manager, manifest: result.manifest, manifestHash: fileHash(result.manifest), candidateHash: fileHash(record.candidatePath),
        inputs: frozen.inputs, inputEnvironment: frozen.environment, siteInstances: site.instances ?? {}, enabledPlugins: frozen.enabled, selectedPlugins: selectedProof(settings.release),
        plugins: release.plugins.map(({ id, version }) => ({ id, version })), toolHash: toolTreeIdentity(record.toolRoot), status: 'prepared' });
      if ((originalConfig && !readFileSync(runtimePath).equals(originalConfig)) || (!originalConfig && existsSync(runtimePath))) throw new Error('Deployment state changed during preparation.');
      verifySavedTooling(record); verifySiteInputs(record);
      changeSummary(previous?.manifest ? loadRelease(resolve(root, previous.manifest)) : null, settings.release, releases);
      buildMessage(`框架 ${currentFramework ?? '首次/旧记录'} → ${record.frameworkVersion ?? result.manager}；宿主镜像 ${current?.containerImage ?? '无'} → ${result.image}`);
      persist(); prepared = true;
    }
    const { cli } = verifySavedTooling(record);
    if (!immutableImage(record.image) || fileHash(record.manifest) !== record.manifestHash || fileHash(record.candidatePath) !== record.candidateHash) throw new Error('Saved release inputs changed; the deployment is retained for inspection.');
    loadRelease(record.manifest); context.inspect(record.image); verifySiteInputs(record);
    const candidate = readSiteJson(record.candidatePath);
    if (candidate.containerImage !== record.image || resolve(root, candidate.manifest) !== record.manifest) throw new Error('Saved deployment configuration changed.');
    if (record.schemaVersion === 3) {
      if (candidate.siteOperation !== record.siteOperation) throw new Error('冻结候选的站点安装归属发生变化，保留现场。');
      const savedDeployment = resolveDeployment({ root, config: record.candidatePath }, {});
      if (!same(record.sitePaths, Object.fromEntries(Object.keys(sitePaths).map(field => [field, savedDeployment[field]])))) throw new Error('冻结候选的持久路径发生变化，保留现场。');
    }
    materializeSiteDefaults(record);
    step(resume ? '恢复部署配置' : '准备部署配置', process.execPath, [cli, 'render-compose', '--root', root, '--config', record.candidatePath, '--output', resolve(operation, `preflight-${randomUUID()}`)]);
    step('核验容器挂载与权限', process.execPath, [cli, 'check-compose', '--root', root, '--config', record.candidatePath]);
    verifySiteInputs(record);
    if (record.previous && !(record.stopComplete ?? record.backupComplete)) {
      const oldArgs = ['compose', '-p', record.previous.project, '-f', record.previous.path];
      step('停止旧服务', 'docker', [...oldArgs, 'stop', 'dsh']); stopped = true;
      if (capture('docker', [...oldArgs, 'ps', '--status', 'running', '-q', 'dsh'])) throw new Error('The previous service is still running; deployment refused.');
      const ids = capture('docker', [...oldArgs, 'ps', '-a', '-q', 'dsh']).split(/\s+/).filter(Boolean);
      assertStoppedCompose(readSiteJson(record.previous.path), ids, record.image, (args, options) => run('docker', args, { stdio: 'pipe', encoding: 'utf8', ...options }), runtime);
      record.stopComplete = true; persist();
    }
    record.status = 'applying'; record.installStarted = true; persist(); installing = true;
    saveJson(runtimePath, candidate);
    step('部署并验证服务', process.execPath, [cli, 'apply-compose', '--root', root, '--config', runtimePath, '--rebuild', ...(resume ? ['--resume'] : [])]);
    record.status = 'ready'; record.completedAt = new Date().toISOString(); persist();
    buildMessage(`发布已完成：${record.inputKind ?? 'source'}\n访问地址：${site.publicUrl}\n启用插件：${record.enabledPlugins?.join(', ') ?? record.plugins?.map(p => p.id).join(', ')}\n发布记录：${recordPath}`);
    return record;
  } catch (error) {
    if (stopped && !installing) record.stopComplete = false;
    record.status = installing || prepared ? 'deployment-failed' : 'build-failed'; persist(!recover || prepared);
    if (stopped && !installing) step('恢复旧服务', 'docker', ['compose', '-p', record.previous.project, '-f', record.previous.path, 'up', '-d', '--wait', 'dsh']);
    console.error(`发布失败；记录保留在 ${operation}。${record.status === 'deployment-failed' ? '暂时问题修复后使用 --resume；同包业务配置修正使用 --recover --data-compatible；换修复包不属于快捷恢复范围。' : '修正输入后重新运行 build。'}`);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const options = siteArguments(process.argv.slice(2)); releaseSite({ root: options.root, config: options.config, resume: options.resume, recover: options.recover, dataCompatible: options['data-compatible'], rebuildPlugins: options['rebuild-plugins'], skipPluginCheck: options['skip-plugin-check'] }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (typeof process.send === 'function') {
    if (interruptedChild) process.disconnect();
    else process.send({ type: 'source-build-finished', code: process.exitCode ?? 0 }, () => process.disconnect());
  }
}
