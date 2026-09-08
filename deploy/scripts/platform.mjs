/** Source-entry prerequisites only; system software is never installed here. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commandSpec, normalizeEnvironment } from '../../packages/plugin-manager/src/process.mjs';
import { tarCommand, canonical, within } from '../../packages/plugin-manager/src/state.mjs';
import { inspectDocker } from '../../packages/plugin-manager/src/docker-runtime.mjs';
import { ensurePrivateDirectory } from '../../packages/plugin-manager/src/private-files.mjs';

export function checkSourceNode(platform = process.platform, version = process.versions.node) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error('Source deployment supports Windows, macOS and Linux.');
  const [major, minor] = version.split('.').map(Number);
  if (!(major === 22 && minor >= 19 || major >= 24)) throw new Error('Use Node.js ^22.19 or >=24.');
}

export function prepareSourceRelease(root) {
  checkSourceNode();
  const env = normalizeEnvironment(process.env);
  for (const name of ['git', 'npm', tarCommand]) {
    const cli = commandSpec(name, { env, cwd: root });
    const result = spawnSync(cli.command, [...cli.prefix, '--version'], { env, cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Missing or unusable prerequisite: ${name}. ${result.error?.message ?? result.stderr ?? ''}`);
  }
  const runtime = inspectDocker();
  // Freeze the effective local daemon before any source update or deployment subprocess.
  for (const key of Object.keys(env)) if (['DOCKER_HOST', 'DOCKER_CONTEXT'].includes(key.toUpperCase())) delete env[key];
  env.DOCKER_HOST = runtime.endpoint;
  const local = resolve(root, '.local');
  if (!within(canonical(root), canonical(local))) throw new Error('Project .local must stay inside the explicit repository root.');
  ensurePrivateDirectory(local);
  return { env, runtime };
}
