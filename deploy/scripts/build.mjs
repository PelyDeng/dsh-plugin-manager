/** Initialize or update one checkout's site using committed source and saved release inputs. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildHostImage } from '../../integrations/docker/host-image.mjs';
import { loadSite, readJson as json, saveJson as save } from './site.mjs';
import { resolveDeployment } from '../../packages/plugin-manager/src/config.mjs';
import { buildMessage, buildStep } from './build-output.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const immutableImage = value => typeof value === 'string' && /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(value);
function command(bin, args, options) {
  const result = spawnSync(bin, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} ${args[0]} failed (${result.status ?? result.signal}). ${result.stderr ?? ''}`);
  return result.stdout?.trim() ?? '';
}

/** Require an immutable Linux image for a recoverable container deployment. */
export function validateBase(reference, info) {
  if (!immutableImage(reference)) throw new Error('Host image must be an immutable image ID or registry digest.');
  if (info.Os !== 'linux') throw new Error('Source deployment requires a Linux host image.');
  return info.Id;
}

/** Initialize missing inputs; resume only the saved image, packages and unchanged site preferences. */
export function release({ root = repositoryRoot, config, resume = false } = {}, execute = command, buildHost = buildHostImage) {
  root = resolve(root);
  const env = { ...process.env };
  // Source releases take their deployment choices from the saved site file.
  for (const key of ['DEPLOYMENT_CONFIG', 'PLUGIN_MANIFEST_FILE', 'DSH_DATA_DIR', 'DSH_HOME', 'DSH_WORKSPACE', 'DSH_AUTH_URL_FILE', 'DSH_DEPLOY_ARTIFACTS', 'DSH_PROFILE', 'DSH_PUBLIC_ORIGIN', 'DSH_PUBLIC_URL', 'DSH_STORE_DIR', 'DSH_OFFLINE_STORE_DIR', 'DSH_CACHE_DIR', 'DSH_OFFLINE_CACHE_DIR']) delete env[key];
  const run = (bin, args, options = {}) => execute(bin, args, { cwd: root, env, ...options });
  const step = (label, bin, args) => buildStep(label, () => run(bin, args));
  const capture = (bin, args) => run(bin, args, { stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const probe = (bin, args) => { try { return capture(bin, args); } catch { return null; } };
  const git = args => capture('git', args);
  buildStep('检查构建环境', () => {
    for (const [bin, args] of [['docker', ['info']], ['docker', ['compose', 'version']], ['npm', ['--version']], ['tar', ['--version']]]) capture(bin, args);
  });
  if (git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'])) throw new Error('Commit source changes before release; the checkout must be clean.');
  const revision = git(['rev-parse', 'HEAD']);
  const host = resolve(root, 'deepseek-harness');
  const hostCommit = existsSync(resolve(host, '.git')) ? git(['-C', host, 'rev-parse', 'HEAD']) : undefined;
  const { site, sitePath, runtimePath } = loadSite(root, config);
  const resolvedSite = resolveDeployment({ root, config: sitePath, 'data-root': site.dataRoot, home: site.home, workspace: site.workspace, artifacts: site.artifacts, profile: site.profile }, {});
  const pointer = resolve(root, '.local/source-release.json');
  const prior = existsSync(pointer) ? json(pointer) : null;
  if (prior && (typeof prior.operation !== 'string' || !resolve(prior.operation).startsWith(resolve(root, '.local/artifacts') + (process.platform === 'win32' ? '\\' : '/')))) throw new Error('Invalid saved operation location.');
  const interrupted = prior && ['prepared', 'backing-up', 'applying', 'deployment-failed'].includes(prior.status);
  if (interrupted && !resume) throw new Error('An unfinished deployment is recorded. Keep the site configuration unchanged and run bash deploy/build.sh --resume.');
  if (resume && !interrupted) throw new Error('No unfinished prepared deployment to resume. Run bash deploy/build.sh normally.');
  const inspect = image => JSON.parse(capture('docker', ['image', 'inspect', image]))[0];
  const activeFile = resolve(root, site.artifacts, 'active-compose.json');
  const active = existsSync(activeFile) ? json(activeFile) : null;
  const originalConfig = existsSync(runtimePath) ? readFileSync(runtimePath) : null;
  const previous = originalConfig ? JSON.parse(originalConfig) : null;
  const previousCompose = active && json(active.path);
  if (!resume && active && (active.project !== site.composeProject || previousCompose.services.dsh.image !== previous?.containerImage)) throw new Error('The active deployment differs from the site configuration; reconcile its project and image before updating.');
  if (!resume && active) {
    const old = resolveDeployment({ root, config: runtimePath }, {});
    for (const field of ['dataRoot', 'home', 'workspace', 'authUrlFile', 'artifacts', 'profile']) if (old[field] !== resolvedSite[field]) throw new Error(`Changing ${field} requires an explicit migration; restore the current site value before updating.`);
  }
  if (!resume && !active) {
    for (const folder of new Set([site.dataRoot, site.home, site.workspace, 'data', 'deploy-artifacts'])) {
      const path = resolve(root, folder);
      if (existsSync(path) && readdirSync(path).length) throw new Error(`Existing data without an active deployment: ${path}. Restore its deployment records or use explicit migration; initialization will not overwrite it.`);
    }
    if (capture('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${site.composeProject}`])) throw new Error('This Compose project already has containers. Use another project or restore its deployment records.');
  }
  if (!resume && (!active || String(previousCompose.services.dsh.environment?.DSH_PORT) !== String(site.port))) {
    capture(process.execPath, ['--input-type=module', '-e', 'import net from "node:net"; const s=net.createServer(); s.once("error",()=>{console.error("Requested port is unavailable.");process.exitCode=1});s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close());', String(site.port)]);
  }
  const operation = resume ? prior.operation : resolve(root, '.local/artifacts', `source-release-${revision.slice(0, 12)}-${randomUUID()}`);
  mkdirSync(operation, { recursive: true });
  const recordPath = resolve(operation, 'result.json');
  const record = resume ? json(recordPath) : { schemaVersion: 2, operation, revision, hostCommit, sitePath, siteHash: hash(sitePath), status: 'building', previous: active, previousRuntime: previous };
  if (resume && (record.schemaVersion !== 2 || record.sitePath !== sitePath || record.siteHash !== hash(sitePath))) throw new Error('Resume requires the original unchanged site configuration. The saved release and backup are retained.');
  const persist = () => { save(recordPath, record); save(pointer, { operation, status: record.status }); };
  persist();
  let stopped = false, installing = false;
  try {
    const cli = resolve(operation, 'tooling/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs');
    if (!resume) {
      const pin = json(resolve(root, 'package.json')).packageManager;
      if (!/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/.test(pin)) throw new Error('packageManager must pin a pnpm version.');
      if (probe('pnpm', ['--version']) !== pin.slice(5)) {
        const tooling = resolve(root, '.local/tooling/pnpm');
        step('准备构建工具', 'npm', ['install', '--prefix', tooling, '--ignore-scripts', '--no-audit', '--no-fund', pin]);
        env.PATH = `${resolve(tooling, 'node_modules/.bin')}${delimiter}${env.PATH ?? ''}`;
        if (capture('pnpm', ['--version']) !== pin.slice(5)) throw new Error('Could not prepare the pinned pnpm version.');
      }
      step('安装项目依赖', 'pnpm', ['install', '--frozen-lockfile']);
      step('构建 plugin-kit', 'pnpm', ['--filter', '@dsh-plugin-manager/plugin-kit', 'build']);
      step('构建 plugin-manager', 'pnpm', ['--filter', '@dsh-plugin-manager/plugin-manager', 'build']);
      record.managerArchive = resolve(operation, 'plugin-manager.tgz');
      step('打包 plugin-manager', 'pnpm', ['--filter', '@dsh-plugin-manager/plugin-manager', 'pack', '--out', record.managerArchive]);
      record.managerHash = hash(record.managerArchive);
      step('准备发布工具', 'npm', ['install', '--prefix', resolve(operation, 'tooling'), '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', record.managerArchive]);
      run(process.execPath, ['scripts/package-plugins.mjs', '--plugins', site.plugins.join(',') || 'none', '--output', resolve(operation, 'plugins')]);
      const manifest = resolve(operation, 'plugins/manifest.json');
      if (active) {
        const oldManifest = resolve(root, previous.manifest);
        for (const p of json(oldManifest).plugins) {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(p.archive) || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error('Invalid previous archive descriptor.');
          const source = resolve(dirname(oldManifest), p.archive), destination = resolve(dirname(manifest), p.archive);
          if (hash(source) !== p.sha256 || (existsSync(destination) && hash(destination) !== p.sha256)) throw new Error('Previous archive content differs from its manifest.');
          if (!existsSync(destination)) copyFileSync(source, destination);
        }
      }
      const candidate = { ...site, manifest: relative(root, manifest).replaceAll('\\', '/') };
      record.candidatePath = resolve(operation, 'deployment.json');
      save(record.candidatePath, candidate);
      step('准备部署配置', process.execPath, [cli, 'render-compose', '--root', root, '--config', record.candidatePath, '--output', resolve(operation, 'preflight')]);
      let baseReference = site.hostImage ?? previous?.containerImage;
      let base;
      if (baseReference) {
        if (!immutableImage(baseReference)) throw new Error('Host image must be immutable.');
        if (probe('docker', ['image', 'inspect', baseReference]) === null) {
          if (baseReference.startsWith('sha256:')) baseReference = null;
          else step('拉取宿主镜像', 'docker', ['pull', baseReference]);
        }
        if (baseReference) {
          base = inspect(baseReference);
          if (!site.hostImage && hostCommit && base.Config?.Labels?.['org.opencontainers.image.revision'] !== hostCommit) baseReference = null;
        }
      }
      let image;
      if (!baseReference) {
        if (!existsSync(resolve(host, '.git'))) throw new Error('The checkout is incomplete: supply deepseek-harness source before deployment. build.sh does not download official source.');
        const built = buildStep('构建 DSH 宿主镜像', () => buildHost({ root, ...(site.hostImageConfig ? { config: site.hostImageConfig } : {}) }));
        image = built.imageId;
        record.hostBuild = built.resultFile;
      } else {
        validateBase(baseReference, base);
        const baseTag = `dsh-local/source-base:${base.Id.slice(7)}`;
        run('docker', ['tag', base.Id, baseTag]);
        const imageContext = resolve(operation, 'image'); mkdirSync(imageContext);
        copyFileSync(record.managerArchive, resolve(imageContext, 'plugin-manager.tgz'));
        copyFileSync(resolve(root, 'integrations/docker/manager-update.Dockerfile'), resolve(imageContext, 'Dockerfile'));
        image = `dsh-local/source:${revision.slice(0, 12)}-${record.managerHash.slice(0, 12)}`;
        step('构建部署镜像', 'docker', ['build', '--network', 'none', '--build-arg', `RUNTIME_IMAGE=${baseTag}`, '--build-arg', `MANAGER_SHA256=${record.managerHash}`, '--build-arg', `FRAMEWORK_REVISION=${revision}`, '--tag', image, imageContext]);
        if (inspect(baseTag).Id !== base.Id) throw new Error('The base image changed during construction.');
      }
      const info = inspect(image);
      validateBase(info.Id, info);
      record.hostCommit = info.Config?.Labels?.['org.opencontainers.image.revision'];
      const manager = json(resolve(root, 'packages/plugin-manager/package.json')).version;
      if (capture('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', info.Id, '-p', 'require("/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/package.json").version']) !== manager) throw new Error('Built manager version differs from source.');
      let reference = info.Id;
      if (site.publishImage) {
        const tag = `${site.publishImage}:source-${revision.slice(0, 12)}-${record.managerHash.slice(0, 12)}`;
        run('docker', ['tag', info.Id, tag]); step('推送部署镜像', 'docker', ['push', tag]);
        reference = inspect(tag).RepoDigests?.find(value => value.startsWith(`${site.publishImage}@sha256:`));
        if (!reference) throw new Error('The published image has no matching digest.');
      }
      if (git(['rev-parse', 'HEAD']) !== revision || git(['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all']) || hash(sitePath) !== record.siteHash) throw new Error('Source or site preferences changed during the build; service has not been stopped.');
      if ((originalConfig && !readFileSync(runtimePath).equals(originalConfig)) || (!originalConfig && existsSync(runtimePath))) throw new Error('Deployment state changed during the build.');
      candidate.containerImage = reference;
      save(record.candidatePath, candidate);
      Object.assign(record, { image: reference, manager, candidateHash: hash(record.candidatePath), manifestHash: hash(manifest), manifest, plugins: json(manifest).plugins.map(({ id, version }) => ({ id, version })), status: 'prepared' });
      persist();
    }
    if (!immutableImage(record.image) || hash(record.manifest) !== record.manifestHash || hash(record.managerArchive) !== record.managerHash || hash(record.candidatePath) !== record.candidateHash) throw new Error('Saved release inputs changed; the deployment is retained for inspection.');
    inspect(record.image);
    const candidate = json(record.candidatePath);
    if (candidate.containerImage !== record.image || resolve(root, candidate.manifest) !== record.manifest) throw new Error('Saved deployment configuration changed.');
    if (resume) step('恢复部署配置', process.execPath, [cli, 'render-compose', '--root', root, '--config', record.candidatePath, '--output', resolve(operation, 'resume-preflight')]);
    if (record.previous && !record.backupComplete) {
      const backup = resolve(operation, 'backup'); mkdirSync(backup, { recursive: true, mode: 0o700 });
      record.backup = backup; record.status = 'backing-up'; persist();
      save(resolve(backup, 'deployment.json'), record.previousRuntime);
      save(resolve(backup, 'active-compose.json'), record.previous);
      copyFileSync(record.previous.path, resolve(backup, 'compose.json'));
      const oldArgs = ['compose', '-p', record.previous.project, '-f', record.previous.path];
      step('停止旧服务', 'docker', [...oldArgs, 'stop', 'dsh']); stopped = true;
      if (capture('docker', [...oldArgs, 'ps', '--status', 'running', '-q', 'dsh'])) throw new Error('The previous service is still running; backup refused.');
      const mounts = json(record.previous.path).services.dsh.volumes.filter(m => m.type === 'bind' && (!m.read_only || m.target.startsWith('/run/'))).map(m => m.source);
      if (!mounts.length || mounts.some(path => !path.startsWith('/') || path === '/')) throw new Error('Invalid persistent mounts for backup.');
      const archive = resolve(backup, `runtime-${randomUUID()}.tar.gz`);
      step('备份运行数据', 'tar', ['-czf', archive, '--', ...new Set(mounts)]); chmodSync(archive, 0o600);
      record.backupArchive = archive; record.backupComplete = true; persist();
    }
    record.status = 'applying'; persist(); installing = true;
    save(runtimePath, candidate);
    step('部署并验证服务', process.execPath, [cli, 'apply-compose', '--root', root, '--config', runtimePath, '--rebuild', ...(resume ? ['--resume'] : [])]);
    record.status = 'ready'; record.completedAt = new Date().toISOString(); persist();
    buildMessage(`发布已完成：${record.revision.slice(0, 12)}\n访问地址：${site.publicUrl}\n发布记录：${recordPath}`);
    return record;
  } catch (error) {
    record.status = installing || resume ? 'deployment-failed' : 'build-failed'; persist();
    if (stopped && !installing) step('恢复旧服务', 'docker', ['compose', '-p', record.previous.project, '-f', record.previous.path, 'up', '-d', '--wait', 'dsh']);
    console.error(`Release failed; inputs retained at ${operation}.${record.status === 'deployment-failed' ? ' Retry the saved deployment with bash deploy/build.sh --resume.' : ' Correct the build error and run bash deploy/build.sh again.'}`);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.includes('--help')) console.log('bash deploy/build.sh [--config <site.json>] [--resume]\nFirst run creates .local/site.json; .local/deployment.json and release records are generated.\nRequires Linux, Node.js ^22.19 or >=24, npm, Git, Docker Compose, tar and flock. pnpm is prepared automatically.');
    else {
      if (process.platform !== 'linux') throw new Error('Source deployment requires Linux and Docker Compose.');
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (!(major === 22 && minor >= 19 || major >= 24)) throw new Error('Use Node.js ^22.19 or >=24.');
      while (args.length) {
        const flag = args.shift();
        if (flag === '--resume' && !options.resume) options.resume = true;
        else if (flag === '--config' && !options.config && args[0] && !args[0].startsWith('--')) options.config = args.shift();
        else throw new Error(`Unknown or duplicate argument: ${flag}. Use --help.`);
      }
      release(options);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
