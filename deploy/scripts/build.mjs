/** Build this checkout and deploy its complete site selection through the manager. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function save(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function command(bin, args, options) {
  const result = spawnSync(bin, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} ${args[0]} failed (${result.status ?? result.signal}). ${result.stderr ?? ''}`);
  return result.stdout?.trim();
}

/** Require a pinned host base matching the gitlink before building plugin sources. */
export function validateBase(reference, info, hostCommit) {
  if (typeof reference !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/.test(reference)) throw new Error('containerImage must be an immutable registry digest.');
  if (info.Config?.Labels?.['org.opencontainers.image.revision'] !== hostCommit) throw new Error('Host image differs from the gitlink; build the pinned host with deploy/scripts/build-host-image.sh first.');
  if (info.Os !== 'linux') throw new Error('Source deployment requires a Linux host image.');
  return reference.split('@')[0];
}

/** Release only committed sources; retain the old Compose and a stopped data backup. */
export function release({ root = repositoryRoot, config = '.local/deployment.json' } = {}, execute = command) {
  root = resolve(root);
  const run = (bin, args, options = {}) => execute(bin, args, { cwd: root, ...options });
  const capture = (bin, args) => run(bin, args, { stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const git = args => capture('git', args);
  if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Commit source changes before release; the checkout must be clean.');
  const revision = git(['rev-parse', 'HEAD']);
  const hostEntry = git(['ls-tree', 'HEAD', '--', 'deepseek-harness']);
  const hostCommit = /^160000 commit ([a-f0-9]{40})\tdeepseek-harness$/.exec(hostEntry)?.[1];
  if (!hostCommit) throw new Error('The repository must pin a DSH gitlink.');
  const configPath = resolve(root, config);
  const originalConfig = readFileSync(configPath);
  const site = json(configPath);
  if (!Array.isArray(site.plugins) || !site.plugins.length || site.plugins.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id))) throw new Error('Site plugins must explicitly list the plugins to build.');
  const base = JSON.parse(capture('docker', ['image', 'inspect', site.containerImage]))[0];
  const repository = validateBase(site.containerImage, base, hostCommit);
  const pin = json(resolve(root, 'package.json')).packageManager;
  if (capture('pnpm', ['--version']) !== pin.split('@')[1]) throw new Error(`Install the pinned package manager: ${pin}.`);
  const operation = resolve(root, '.local/artifacts', `source-release-${revision.slice(0, 12)}-${randomUUID()}`);
  mkdirSync(operation, { recursive: true });
  const record = { schemaVersion: 1, revision, hostCommit, baseImage: site.containerImage, status: 'building' };
  const recordPath = resolve(operation, 'result.json');
  save(recordPath, record);
  let stopped = false, applying = false, previousArgs;
  try {
    run('pnpm', ['install', '--frozen-lockfile']);
    run('pnpm', ['--filter', '@dsh-plugin/plugin-kit', 'build']);
    run('pnpm', ['--filter', '@dsh-plugin/plugin-manager', 'check']);
    run('pnpm', ['--filter', '@dsh-plugin/plugin-manager', 'build']);
    const manager = resolve(operation, 'plugin-manager.tgz');
    run('pnpm', ['--filter', '@dsh-plugin/plugin-manager', 'pack', '--out', manager]);
    run(process.execPath, ['scripts/package-plugins.mjs', '--plugins', site.plugins.join(','), '--output', resolve(operation, 'plugins')]);
    const cli = resolve(root, 'packages/plugin-manager/dist/cli.mjs');
    const deploymentArgs = ['--root', root, '--config', configPath];
    const paths = JSON.parse(capture(process.execPath, [cli, 'paths', ...deploymentArgs]));
    const activeFile = resolve(paths.artifacts, 'active-compose.json');
    const active = json(activeFile);
    if (active.project !== (site.composeProject ?? 'dsh-plugins')) throw new Error('The active Compose project differs from the site configuration.');
    const previousCompose = json(active.path);
    if (previousCompose.services.dsh.image !== site.containerImage) throw new Error('The active Compose image differs from the site configuration.');
    previousArgs = ['compose', '-p', active.project, '-f', active.path];
    const manifest = resolve(operation, 'plugins/manifest.json');
    // pnpm resolves the old profile references before replacing them with new specs.
    const previousManifest = resolve(root, site.manifest);
    for (const plugin of json(previousManifest).plugins) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(plugin.archive) || !/^[a-f0-9]{64}$/.test(plugin.sha256)) throw new Error('Invalid previous archive descriptor.');
      const source = resolve(dirname(previousManifest), plugin.archive);
      const destination = resolve(dirname(manifest), plugin.archive);
      if (hash(source) !== plugin.sha256 || (existsSync(destination) && hash(destination) !== plugin.sha256)) throw new Error('Previous archive content differs from its manifest.');
      if (!existsSync(destination)) copyFileSync(source, destination);
    }
    run(process.execPath, [cli, 'render-compose', ...deploymentArgs, '--manifest', manifest, '--output', resolve(operation, 'preflight')]);
    const imageContext = resolve(operation, 'image');
    mkdirSync(imageContext);
    copyFileSync(manager, resolve(imageContext, 'plugin-manager.tgz'));
    copyFileSync(resolve(root, 'integrations/docker/manager-update.Dockerfile'), resolve(imageContext, 'Dockerfile'));
    const image = `${repository}:source-${revision.slice(0, 12)}-${hash(manager).slice(0, 12)}`;
    run('docker', ['build', '--network', 'none', '--build-arg', `RUNTIME_IMAGE=${site.containerImage}`, '--build-arg', `MANAGER_SHA256=${hash(manager)}`, '--build-arg', `FRAMEWORK_REVISION=${revision}`, '--tag', image, imageContext]);
    const expectedManager = json(resolve(root, 'packages/plugin-manager/package.json')).version;
    const installedManager = capture('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-p', 'require("/opt/plugin-manager/node_modules/@dsh-plugin/plugin-manager/package.json").version']);
    if (installedManager !== expectedManager) throw new Error('Built manager version differs from source.');
    run('docker', ['push', image]);
    const info = JSON.parse(capture('docker', ['image', 'inspect', image]))[0];
    const reference = info.RepoDigests?.find(value => value.startsWith(`${repository}@sha256:`));
    if (!reference) throw new Error('The published image has no repository digest.');
    validateBase(reference, info, hostCommit);
    if (git(['rev-parse', 'HEAD']) !== revision || git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Sources changed during the build; service has not been stopped.');
    if (!readFileSync(configPath).equals(originalConfig)) throw new Error('Site configuration changed during the build; retry with the new configuration.');
    const backup = resolve(operation, 'backup');
    mkdirSync(backup, { mode: 0o700 });
    copyFileSync(configPath, resolve(backup, 'deployment.json'));
    copyFileSync(active.path, resolve(backup, 'compose.json'));
    copyFileSync(activeFile, resolve(backup, 'active-compose.json'));
    Object.assign(record, { image: reference, manager: expectedManager, plugins: json(manifest).plugins.map(({ id, version }) => ({ id, version })), backup, status: 'prepared' });
    save(recordPath, record);
    run('docker', [...previousArgs, 'stop', 'dsh']);
    stopped = true;
    if (capture('docker', [...previousArgs, 'ps', '--status', 'running', '-q', 'dsh'])) throw new Error('The previous service is still running; backup refused.');
    const mounts = previousCompose.services.dsh.volumes.filter(mount => mount.type === 'bind' && (!mount.read_only || mount.target.startsWith('/run/'))).map(mount => mount.source);
    if (!mounts.length || mounts.some(path => !path.startsWith('/') || path === '/')) throw new Error('Invalid persistent mounts for backup.');
    run('tar', ['-czf', resolve(backup, 'runtime.tar.gz'), '--', ...new Set(mounts)]);
    chmodSync(resolve(backup, 'runtime.tar.gz'), 0o600);
    save(configPath, { ...site, manifest: relative(root, manifest).replaceAll('\\', '/'), containerImage: reference });
    applying = true;
    run(process.execPath, [cli, 'apply-compose', ...deploymentArgs]);
    Object.assign(record, { status: 'ready', completedAt: new Date().toISOString() });
    save(recordPath, record);
    console.log(`Source release ready: ${revision}\nEvidence: ${recordPath}`);
    return record;
  } catch (error) {
    record.status = applying ? 'deployment-failed' : 'build-failed';
    save(recordPath, record);
    // Before installation begins the old profile is unchanged and can be restarted.
    if (stopped && !applying) run('docker', [...previousArgs, 'up', '-d', '--wait', 'dsh']);
    console.error(`Release failed; artifacts and backup retained at ${operation}.`);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Usage: bash deploy/build.sh [--config .local/deployment.json]');
    release({ config: args[1] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
