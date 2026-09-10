/** Assemble portable deployment and author starter archives from reviewed release inputs. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyPackage } from '../packages/plugin-manager/src/verify-package.mjs';
import { composeReleases } from '../packages/plugin-manager/src/compose-release.mjs';
import { loadRelease } from '../packages/plugin-manager/src/release.mjs';
import { renderSiteTemplate } from '../packages/plugin-manager/src/framework-config.mjs';
import { hash, readArchive } from '../packages/plugin-manager/src/state.mjs';
import { installManagerArchive } from './manager-tooling.mjs';

const managerCli = '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs';
const hostCli = '/opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js';
const digestReference = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args[0]} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout.trim();
}

/** Match the installed archive label and fixed version probes against the immutable image. */
export function runtimeFromImage(image, version, managerHash, execute = command) {
  if (!digestReference.test(image)) throw new Error('Runtime image must be a registry/repository@sha256 reference.');
  if (!/^[a-f0-9]{64}$/u.test(managerHash)) throw new Error('A verified manager archive SHA256 is required.');
  const [info] = JSON.parse(execute('docker', ['image', 'inspect', image]));
  const platform = `${info?.Os}/${info?.Architecture}`;
  if (!/^linux\/(amd64|arm64)$/u.test(platform) || !/^sha256:[a-f0-9]{64}$/u.test(info?.Id)) throw new Error('Runtime image identity or platform is invalid.');
  if (!info.RepoDigests?.includes(image)) throw new Error('Inspected image does not own the requested repository digest.');
  if (info.Config?.Labels?.['com.dsh-plugin-manager.manager.sha256'] !== managerHash) throw new Error('Runtime manager archive SHA256 does not match the release archive.');
  const hostCommit = info.Config?.Labels?.['org.opencontainers.image.revision'];
  const hostVersion = info.Config?.Labels?.['org.opencontainers.image.version'];
  if (!/^[a-f0-9]{40}$/u.test(hostCommit) || typeof hostVersion !== 'string' || !hostVersion) throw new Error('Runtime is missing the verified host identity labels.');
  if (JSON.stringify(info.Config?.Entrypoint) !== JSON.stringify(['node', managerCli, 'container-start', '--root', '/opt/plugin-project'])) throw new Error('Runtime does not expose the supported manager container entry.');
  for (const [cli, expected] of [[managerCli, version], [hostCli, hostVersion]]) {
    const actual = execute('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', info.Id, cli, '--version']);
    if (actual !== expected) throw new Error(`Runtime version does not match: ${cli}`);
  }
  return { platform, image, hostCommit };
}

function toolArchive(path, name, version, entry) {
  const manifest = JSON.parse(readArchive(path, ['-xzOf', '-', 'package/package.json']).toString('utf8'));
  if (manifest.name !== name || manifest.version !== version) throw new Error(`${name} archive does not match framework ${version}.`);
  return verifyPackage({ package: name, version, verifyFiles: [entry] }, path);
}

/** The allowlist belongs to this release recipe, not to a recursively copied checkout. */
function copyPublic(source, target) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`Release input must not be a link: ${source}`);
  if (info.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source)) {
      if (['node_modules', '.git', '.local', 'dist', 'coverage'].includes(name)) throw new Error(`Unexpected generated/private starter input: ${source}/${name}`);
      copyPublic(join(source, name), join(target, name));
    }
  } else if (info.isFile()) {
    mkdirSync(dirname(target), { recursive: true }); cpSync(source, target);
  } else throw new Error(`Release input is not a regular file: ${source}`);
}

const shell = `#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null || { printf 'Missing prerequisite: Node.js. See README.md.\\n' >&2; exit 1; }
CLI="$ROOT/tools/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs"
HELP=false
for argument in "$@"; do [[ "$argument" != "--help" ]] || HELP=true; done
if [[ ( $# -eq 0 || "$1" == "release" || "$1" == --* ) && "$HELP" == false ]] && command -v flock >/dev/null; then
  mkdir -p "$ROOT/.local"
  exec flock -n "$ROOT/.local/source-release.lock" node "$CLI" release-site --root "$ROOT" "$@"
fi
exec node "$CLI" release-site --root "$ROOT" "$@"
`;
const powershell = `$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'Missing prerequisite: Node.js. See README.md.'
}
& node (Join-Path $PSScriptRoot 'tools/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs') release-site --root $PSScriptRoot @args
exit $LASTEXITCODE
`;

/** Return staged trees so their real independent consumption can be checked before publication. */
export function assembleDeployment({ root, manager, kit, authManifest, images, output }, { inspectRuntime = runtimeFromImage, installTools = installManagerArchive } = {}) {
  if (![root, manager, kit, authManifest, output].every(value => typeof value === 'string' && value)) throw new Error('Explicit root, tool archives, auth manifest and new output are required.');
  root = resolve(root); output = resolve(output); manager = resolve(manager); kit = resolve(kit);
  const version = json(join(root, 'package.json')).version;
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Expected a stable framework version.');
  if (existsSync(output) && readdirSync(output).length) throw new Error('Release output must be new or empty.');
  if (!Array.isArray(images) || !images.length) throw new Error('At least one verified public runtime is required.');
  const managerHash = hash(readFileSync(manager)), kitHash = hash(readFileSync(kit));
  toolArchive(manager, '@dsh-plugin-manager/plugin-manager', version, 'dist/cli.mjs');
  toolArchive(kit, '@dsh-plugin-manager/plugin-kit', version, 'dist/index.mjs');
  const runtimes = images.map(image => inspectRuntime(image, version, managerHash));
  if (new Set(runtimes.map(runtime => runtime.platform)).size !== runtimes.length) throw new Error('Only one runtime per platform may be published.');
  const authRelease = loadRelease(resolve(authManifest));
  const auth = authRelease.plugins.find(plugin => plugin.id === 'auth');
  if (!auth || auth.package !== 'dsh-auth' || auth.version !== version || auth.configuration?.auth !== 'provider') throw new Error('Optional auth must be the matching framework authentication provider.');
  for (const doc of ['deploy/DEPLOYMENT.md', 'deploy/STARTERS.md', 'incoming/README.md', 'LICENSE']) if (!existsSync(join(root, doc))) throw new Error(`Missing public release document: ${doc}`);
  const deployment = join(output, 'dsh-deployment'), starters = join(output, 'dsh-starters');
  mkdirSync(deployment, { recursive: true }); mkdirSync(starters);
  const tooling = installTools({ archive: manager, output: join(deployment, 'tools'), version });
  if (tooling.sha256 !== managerHash) throw new Error('Installed manager bytes differ from the verified release archive.');
  const metadata = { schemaVersion: 1, frameworkVersion: version, manager: { version, sha256: tooling.sha256 }, runtimes };
  write(join(deployment, 'framework-runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  write(join(deployment, 'build.sh'), shell); write(join(deployment, 'build.ps1'), powershell);
  write(join(deployment, 'env.conf.example'), renderSiteTemplate('archives'));
  write(join(deployment, '.gitignore'), '.local/\nincoming/*\n!incoming/README.md\n');
  copyPublic(join(root, 'deploy/DEPLOYMENT.md'), join(deployment, 'README.md'));
  copyPublic(join(root, 'incoming/README.md'), join(deployment, 'incoming/README.md'));
  copyPublic(join(root, 'LICENSE'), join(deployment, 'LICENSE'));
  composeReleases([{ ...authRelease, plugins: [auth] }], join(deployment, 'optional/auth'));
  copyPublic(join(root, 'deploy/STARTERS.md'), join(starters, 'README.md'));
  copyPublic(join(root, 'LICENSE'), join(starters, 'LICENSE'));
  for (const name of ['standalone-plugin', 'standalone-kit']) {
    const source = join(root, 'examples', name), target = join(starters, name);
    for (const path of ['src', 'package.json', 'cordis.patch.yml', 'README.md', name === 'standalone-kit' ? 'tsdown.config.mjs' : 'build.mjs']) copyPublic(join(source, path), join(target, path));
    copyPublic(join(root, 'LICENSE'), join(target, 'LICENSE'));
    write(join(target, '.gitignore'), 'node_modules/\ndist/\n.local/\n');
    if (name === 'standalone-kit') {
      copyPublic(kit, join(target, 'vendor/plugin-kit.tgz'));
      if (hash(readFileSync(join(target, 'vendor/plugin-kit.tgz'))) !== kitHash) throw new Error('Kit bytes changed after verification.');
      const manifest = json(join(target, 'package.json'));
      manifest.devDependencies = { ...manifest.devDependencies, '@dsh-plugin-manager/plugin-kit': 'file:vendor/plugin-kit.tgz' };
      write(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  return { version, deployment, starters, metadata };
}

// Python's standard zipfile preserves a portable file tree, without shell interpolation.
const zipProgram = `import pathlib, stat, sys, zipfile
root, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob('*')):
        if path.is_symlink(): raise ValueError('ZIP input cannot contain links: ' + str(path))
        if not path.is_file(): continue
        relative = path.relative_to(root)
        if '.local' in relative.parts or '.git' in relative.parts: raise ValueError('Private release path: ' + str(relative))
        if path.name in ('package-lock.json', '.package-lock.json') and relative.parts[0] == 'tools': continue
        info = zipfile.ZipInfo(root.name + '/' + relative.as_posix(), (2020, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = (stat.S_IFREG | (0o755 if path.suffix == '.sh' else 0o644)) << 16
        archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
with zipfile.ZipFile(output) as archive:
    if archive.testzip() is not None: raise ValueError('ZIP checksum verification failed')
`;
export function zipTree(root, archive, python = process.platform === 'win32' ? 'python' : 'python3') {
  command(python, ['-c', zipProgram, root, archive]);
}

export function packageDeployment(options, dependencies) {
  const result = assembleDeployment(options, dependencies);
  const archives = [
    [result.deployment, `dsh-plugin-manager-deployment-${result.version}.zip`],
    [result.starters, `dsh-plugin-manager-starters-${result.version}.zip`],
  ].map(([source, filename]) => {
    const path = resolve(options.output, filename); zipTree(source, path, options.python); return path;
  });
  return { ...result, archives };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = { images: [] }, values = { '--root': 'root', '--manager': 'manager', '--kit': 'kit', '--auth-manifest': 'authManifest', '--output': 'output', '--python': 'python' };
    const args = process.argv.slice(2);
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if ((!Object.hasOwn(values, flag) && flag !== '--image') || !value || value.startsWith('--')) throw new Error('Usage: package-deployment.mjs --root <framework> --manager <tgz> --kit <tgz> --auth-manifest <json> --image <repository@sha256> --output <new-directory> [--python <executable>]');
      if (flag === '--image') options.images.push(value);
      else if (options[values[flag]]) throw new Error(`Repeated argument: ${flag}`);
      else options[values[flag]] = value;
    }
    console.log(JSON.stringify(packageDeployment(options)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
