/** Prepare the shared DSH image; plugin packages remain independent deployment inputs. */
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectHostSource } from './host-source.mjs';
import { tarCommand } from '../../packages/plugin-manager/src/state.mjs';
import { imageDefaults, readFrameworkConfig, validateImageConfig } from '../../packages/plugin-manager/src/framework-config.mjs';
import { ensurePrivateDirectory } from '../../packages/plugin-manager/src/private-files.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const managerInputs = ['integrations/docker', 'packages/plugin-kit', 'packages/plugin-manager', 'scripts/manager-tooling.mjs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const defaults = imageDefaults;

/** Parse literal configuration without executing shell code or implicitly opening credentials. */
export function loadImageConfig(root, filename) {
  return validateImageConfig(filename ? readFrameworkConfig(resolve(root, filename)).image : defaults);
}

export { validateImageConfig };

const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
function atomicJson(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function command(bin, args, options = {}, execute = spawnSync) {
  const result = execute(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} failed${result.status === null ? '' : ` (${result.status})`}: ${result.error?.message ?? result.stderr ?? ''}`);
  return result.stdout?.trim() ?? '';
}

function loginRegistry(config, docker) {
  if (config.REGISTRY_USERNAME) docker(['login', config.REGISTRY_HOST, '--username', config.REGISTRY_USERNAME, '--password-stdin'], { input: config.REGISTRY_PASSWORD });
}

/** Reuse literal registry credentials for a matching deployment-image destination only. */
export function withRegistryAuthentication(config, target, operation, execute = spawnSync) {
  config = validateImageConfig(config);
  if (!config.REGISTRY_USERNAME) return operation([]);
  if (target.split('/')[0] !== config.REGISTRY_HOST) throw new Error('Deployment image registry differs from the configured credential destination.');
  const auth = ensurePrivateDirectory(resolve(tmpdir(), `dsh-image-auth-${randomUUID()}`));
  const flags = ['--config', auth];
  try {
    loginRegistry(config, (args, settings) => command('docker', [...flags, ...args], settings, execute));
    return operation(flags);
  } finally { rmSync(auth, { recursive: true, force: true }); }
}

/** Only registry responses explicitly describing absence permit upstream fallback. */
export function isMissingImage(error) {
  if (/unauthori[sz]ed|denied|forbidden|certificate|tls|timeout|timed out|no matching manifest|connection|credential|\b50[0234]\b/iu.test(error)) return false;
  return /manifest unknown|name unknown|manifest for .+ not found|unknown: (?:repository|artifact) .+ not found/iu.test(error);
}

/** Hash build inputs, excluding business plugins and checkout location. */
export function recipeHash(source, inputs) {
  const hash = createHash('sha256');
  for (const subdirectory of managerInputs) {
    const visit = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (['dist','node_modules','coverage'].includes(entry.name)) continue;
        const path = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Manager build inputs must not contain symbolic links.');
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) hash.update(relative(source, path).replaceAll('\\', '/')).update('\0').update(readFileSync(path, 'utf8').replaceAll('\r\n', '\n')).update('\0');
      }
    };
    const path = resolve(source, subdirectory);
    if (statSync(path).isDirectory()) visit(path);
    else hash.update(subdirectory).update('\0').update(readFileSync(path, 'utf8').replaceAll('\r\n','\n')).update('\0');
  }
  return hash.update(JSON.stringify(inputs)).digest('hex');
}

/** Resolve only a digest belonging to the requested repository. */
export function repositoryDigest(image, inspection) {
  let repository = image.split('@')[0];
  if (repository.split('/').at(-1).includes(':')) repository = repository.slice(0, repository.lastIndexOf(':'));
  const normalize = value => value.replace(/^docker\.io\//u, '').replace(/^library\//u, '');
  const found = inspection.RepoDigests?.find(value => normalize(value.split('@')[0]) === normalize(repository));
  if (!found || !/@sha256:[a-f0-9]{64}$/u.test(found)) throw new Error('Pulled image has no matching repository digest.');
  return found;
}

/** Prepare or explicitly publish a shared image, preserving operation results on failure. */
export function buildHostImage(options = {}, { execute = spawnSync, inspectSource = inspectHostSource } = {}) {
  const root = realpathSync(resolve(repositoryRoot, options.root ?? '.'));
  if (options.config && options.configValues) throw new Error('Select one host image configuration source.');
  const config = options.configValues ? validateImageConfig(options.configValues) : loadImageConfig(root, options.config);
  if (options.publish && config.HARBOR_ENABLED !== 'true') throw new Error('--publish requires an explicitly enabled registry configuration.');
  if (options.publish && options.workingTree) throw new Error('Development working-tree images cannot be published.');
  if (options.publish && !config.REGISTRY_USERNAME) throw new Error('Publishing requires registry credentials with write permission.');
  if (options.resume && !options.publish) throw new Error('--resume requires --publish.');
  const previousPath = options.resume && resolve(root, options.resume);
  const previous = previousPath && readJson(previousPath);
  if (previous && (previous.schemaVersion !== 1 || previous.development || !previous.imageId || !previous.toolchainId || !previous.baseImageId)) throw new Error('Only a verified formal build can resume publishing.');
  const host = previous ? null : inspectSource(root);
  const operationId = options.operationId ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(operationId)) throw new Error('Invalid operation ID.');
  if (!options.artifacts && existsSync(resolve(root, 'deploy-artifacts'))) throw new Error('Select --artifacts explicitly for existing operation records.');
  const artifactsRoot = resolve(root, options.artifacts ?? '.local/artifacts');
  const insideRoot = relative(root, artifactsRoot);
  const outsideRoot = insideRoot === '..' || /^\.\.[\\/]/u.test(insideRoot) || isAbsolute(insideRoot);
  if (!insideRoot || (!outsideRoot && !/^(?:\.local[\\/]artifacts|deploy-artifacts)(?:[\\/]|$)/u.test(insideRoot))) throw new Error('In-repository host artifacts must stay under .local/artifacts or explicitly selected deploy-artifacts.');
  const operation = resolve(artifactsRoot, operationId);
  if (!previous && existsSync(operation)) throw new Error('Operation directory exists; use a new operation ID.');
  if (!previous) { mkdirSync(artifactsRoot, { recursive: true }); mkdirSync(operation); }
  const resultFile = previousPath || resolve(operation, 'host-image.json');
  const state = previous || { schemaVersion: 1, operationId, status: 'preparing', hostCommit: host.commit, repositoryCommit: host.repositoryCommit, platform: config.DSH_IMAGE_PLATFORM, development: Boolean(options.workingTree) };
  atomicJson(resultFile, state);
  const auth = ensurePrivateDirectory(resolve(tmpdir(), `dsh-image-auth-${randomUUID()}`));
  const run = (bin, args, settings) => command(bin, args, settings, execute);
  const docker = (args, settings) => run('docker', ['--config', auth, ...args], settings);
  const inspect = image => JSON.parse(docker(['image', 'inspect', image]))[0];
  const pull = image => {
    const result = execute('docker', ['--config', auth, 'pull', '--platform', config.DSH_IMAGE_PLATFORM, image], { encoding: 'utf8', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status === 0) return true;
    const error = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (isMissingImage(error)) return false;
    throw new Error(`Image pull failed; upstream fallback is prohibited: ${error}`);
  };
  const publish = () => {
    if (state.platform !== config.DSH_IMAGE_PLATFORM || !state.image?.startsWith(`${config.REGISTRY_HOST}/${config.APP_PROJECT}/${config.IMAGE_NAME}:`) || !state.toolchainImage?.startsWith(`${config.REGISTRY_HOST}/${config.APP_PROJECT}/`) || !state.cachedBase?.startsWith(`${config.REGISTRY_HOST}/${config.BASE_PROJECT}/`)) throw new Error('Publishing destination or platform changed; create a new operation.');
    const runtimeInfo = inspect(state.imageId);
    if (runtimeInfo.Config?.Labels?.['org.opencontainers.image.revision'] !== state.hostCommit || runtimeInfo.Config?.Labels?.['com.deepseek-plugin.dsh.runtime-recipe'] !== state.recipe) throw new Error('Recorded runtime image does not match the saved build.');
    for (const [id, image] of [[state.baseImageId, state.cachedBase], [state.toolchainId, state.toolchainImage], [state.imageId, state.image]]) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(id) || inspect(id).Id !== id) throw new Error('Recorded immutable image is unavailable.');
      docker(['tag', id, image]);
      docker(['push', image], { stdio: 'inherit' });
    }
    state.reference = repositoryDigest(state.image, inspect(state.image));
    if (!pull(state.reference)) throw new Error('Published runtime cannot be pulled by digest.');
    Object.assign(state, { status: 'published', published: true }); atomicJson(resultFile, state);
  };
  try {
    if (config.HARBOR_ENABLED === 'true') loginRegistry(config, docker);
    if (previous) { publish(); return { ...state, resultFile }; }
    const managerSource = resolve(operation, 'manager-source');
    const harnessSource = resolve(operation, 'harness-source');
    mkdirSync(managerSource); mkdirSync(harnessSource);
    if (options.workingTree) {
      for (const path of managerInputs) cpSync(resolve(root, path), resolve(managerSource, path), { recursive: true, dereference: false, filter: path => !path.split(/[\\/]/).some(part => ['dist','node_modules','coverage'].includes(part)) });
    } else {
      const archive = resolve(operation, 'manager-source.tar');
      run('git', ['-C', root, 'archive', '--format=tar', '--output', archive, host.repositoryCommit, ...managerInputs]);
      run(tarCommand, ['-xf', 'manager-source.tar', '-C', 'manager-source'], { cwd: operation });
    }
    // Extract the official tar inside Linux so Windows does not materialize Git symlinks.
    const hostArchive = resolve(harnessSource, 'harness-source.tar');
    run('git', ['-C', host.path, 'archive', '--format=tar', '--output', hostArchive, host.commit]);
    const hostManager = host.packageManager;
    const pluginManager = readJson(resolve(managerSource, 'package.json')).packageManager;
    for (const value of [hostManager, pluginManager]) if (!/^pnpm@[0-9]+\.[0-9]+\.[0-9]+(?:\+sha[0-9]+\.[a-f0-9]+)?$/u.test(value)) throw new Error('Source packageManager must pin pnpm.');
    const pluginPnpmVersion = pluginManager.slice(5).split('+')[0];
    const harbor = config.HARBOR_ENABLED === 'true';
    const cachedBase = harbor ? `${config.REGISTRY_HOST}/${config.BASE_PROJECT}/dsh-base:${sha256(`${config.DSH_SOURCE_BASE_IMAGE}\n${config.DSH_IMAGE_PLATFORM}`).slice(0, 24)}` : undefined;
    let base = config.DSH_SOURCE_BASE_IMAGE;
    if (harbor && pull(cachedBase)) base = cachedBase;
    else {
      if (harbor && config.ALLOW_UPSTREAM !== 'true') throw new Error('Cached base image is absent and upstream access is disabled.');
      if (!pull(base)) throw new Error('Upstream base image is absent.');
    }
    const baseInfo = inspect(base);
    const baseRef = repositoryDigest(base, baseInfo);
    const baseDigest = baseRef.split('@')[1];
    const toolchainRecipe = sha256(`${readFileSync(resolve(managerSource, 'integrations/docker/toolchain.Dockerfile'), 'utf8').replaceAll('\r\n', '\n')}\n${baseDigest}\n${config.DSH_DEBIAN_MIRROR}\n${config.DSH_IMAGE_PLATFORM}\n${hostManager}\n${pluginManager}`);
    const namespace = harbor ? `${config.REGISTRY_HOST}/${config.APP_PROJECT}` : 'dsh-local';
    const toolchain = `${namespace}/dsh-build-toolchain:${toolchainRecipe.slice(0, 32)}`;
    const empty = resolve(operation, 'empty'); mkdirSync(empty);
    const shared = ['--platform', config.DSH_IMAGE_PLATFORM];
    if (!harbor || !pull(toolchain)) {
      if (harbor && config.ALLOW_UPSTREAM !== 'true') throw new Error('Cached toolchain is absent and preparation is disabled.');
      docker(['build', ...shared, '--file', resolve(managerSource, 'integrations/docker/toolchain.Dockerfile'), '--build-arg', `BASE_IMAGE=${baseRef}`, '--build-arg', `DEBIAN_MIRROR=${config.DSH_DEBIAN_MIRROR}`, '--build-arg', `HOST_PACKAGE_MANAGER=${hostManager}`, '--build-arg', `PLUGIN_PACKAGE_MANAGER=${pluginManager}`, '--tag', toolchain, empty], { stdio: 'inherit' });
    }
    const toolchainInfo = inspect(toolchain);
    const toolchainRef = harbor && toolchainInfo.RepoDigests?.length ? repositoryDigest(toolchain, toolchainInfo) : toolchain;
    const recipe = recipeHash(managerSource, { baseDigest, toolchainRecipe, toolchainId: toolchainInfo.Id, platform: config.DSH_IMAGE_PLATFORM, hostManager, pluginManager });
    const imageTag = `${host.version}-${host.commit}-${recipe.slice(0, 20)}`;
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(imageTag)) throw new Error('Host version and build identifiers do not form a valid image tag.');
    const runtime = `${namespace}/${config.IMAGE_NAME}:${imageTag}`;
    Object.assign(state, { status: 'building', recipe, baseRef, baseImageId: baseInfo.Id, cachedBase, toolchainRecipe, toolchainId: toolchainInfo.Id, toolchainImage: toolchain, image: runtime, version: host.version });
    atomicJson(resultFile, state);
    if (!harbor || !pull(runtime)) {
      if (harbor && config.ALLOW_UPSTREAM !== 'true') throw new Error('Cached runtime is absent and preparation is disabled.');
      docker(['build', ...shared, '--file', resolve(managerSource, 'integrations/docker/dsh-runtime.Dockerfile'), '--build-context', `harness-source=${harnessSource}`, '--build-context', `manager-source=${managerSource}`, '--build-arg', `BASE_IMAGE=${baseRef}`, '--build-arg', `TOOLCHAIN_IMAGE=${toolchainRef}`, '--build-arg', `HOST_PACKAGE_MANAGER=${hostManager}`, '--build-arg', `PLUGIN_PNPM_VERSION=${pluginPnpmVersion}`, '--build-arg', `DSH_COMMIT_SHA=${host.commit}`, '--build-arg', `DSH_VERSION=${host.version}`, '--build-arg', `DSH_RECIPE_HASH=${recipe}`, '--tag', runtime, empty], { stdio: 'inherit' });
    }
    if (inspect(toolchainRef).Id !== toolchainInfo.Id) throw new Error('Toolchain reference moved during preparation; retry with unchanged inputs.');
    const info = inspect(runtime);
    for (const [key, expected] of Object.entries({ 'org.opencontainers.image.revision': host.commit, 'org.opencontainers.image.version': host.version, 'com.deepseek-plugin.dsh.runtime-recipe': recipe })) if (info.Config?.Labels?.[key] !== expected) throw new Error(`Runtime label does not match: ${key}`);
    if (`${info.Os}/${info.Architecture}` !== config.DSH_IMAGE_PLATFORM) throw new Error('Runtime platform does not match.');
    const version = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'node', info.Id, '/opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', '--version']);
    if (version !== host.version) throw new Error('Runtime CLI version does not match.');
    Object.assign(state, { status: 'built', imageId: info.Id, published: false });
    if (harbor && info.RepoDigests?.length) state.reference = repositoryDigest(runtime, info);
    atomicJson(resultFile, state);
    if (options.publish) publish();
    return { ...state, resultFile };
  } catch (error) {
    state.status = state.imageId ? 'publish-failed' : 'failed'; atomicJson(resultFile, state); throw error;
  } finally {
    rmSync(auth, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const arg = args.shift();
      if (arg === '--publish') options.publish = true;
      else if (arg === '--working-tree') options.workingTree = true;
      else if (['--root', '--config', '--operation-id', '--resume', '--artifacts'].includes(arg)) {
        const value = args.shift(); if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
        options[arg === '--operation-id' ? 'operationId' : arg.slice(2)] = value;
      } else if (arg === '--help') {
        console.log('build-host-image.sh [--config <root-relative-file>] [--publish] [--resume <host-image.json>] [--artifacts <directory>] [--operation-id <id>] [--working-tree]\nDefaults to <root>/.local/env.conf when present; explicit legacy image conf is supported.'); process.exit(0);
      } else throw new Error(`Unknown argument: ${arg}`);
    }
    const configured = resolve(repositoryRoot, options.root ?? '.', '.local/env.conf');
    if (!options.config && existsSync(configured)) options.config = configured;
    console.log(JSON.stringify(buildHostImage(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
