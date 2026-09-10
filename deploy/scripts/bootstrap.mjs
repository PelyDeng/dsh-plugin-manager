/** Prepare source dependencies before importing manager modules that consume the kit package. */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, resolve } from 'node:path';
import { buildStep } from './build-output.mjs';
import { assertSelectiveInstallSafe } from './plugin-reuse.mjs';
import { readSitePointer, needsSiteResume } from '../../packages/plugin-manager/src/site-record.mjs';

export function sourceDependenciesAvailable(root) {
  try {
    createRequire(resolve(root, 'packages/plugin-manager/package.json')).resolve('@dsh-plugin-manager/plugin-kit/model-key');
    return true;
  } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return false; }
}

/** The CLI bootstrap and ordinary source release use exactly the same pinned install. */
export function ensurePinnedPnpm(root, env, execute) {
  const run = (bin, args, options = {}) => execute(bin, args, { cwd: root, env, ...options });
  const capture = (bin, args) => run(bin, args, { stdio: 'pipe', encoding: 'utf8' });
  const pin = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).packageManager;
  if (!/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/.test(pin)) throw new Error('packageManager must pin a pnpm version.');
  let version;
  try { version = capture('pnpm', ['--version']); } catch { /* A missing or wrong pnpm is prepared locally. */ }
  if (version !== pin.slice(5)) {
    const tooling = resolve(root, '.local/tooling/pnpm');
    buildStep('准备构建工具', () => run('npm', ['install', '--prefix', tooling, '--ignore-scripts', '--no-audit', '--no-fund', pin]));
    env.PATH = `${resolve(tooling, 'node_modules/.bin')}${delimiter}${env.PATH ?? ''}`;
    if (capture('pnpm', ['--version']) !== pin.slice(5)) throw new Error('Could not prepare the pinned pnpm version.');
  }
}

export function prepareWorkspaceDependencies(root, env, execute) {
  ensurePinnedPnpm(root, env, execute);
  buildStep('安装项目依赖', () => execute('pnpm', ['install', '--frozen-lockfile'], { cwd: root, env }));
}

/** Only a new CLI worker bootstraps; importing release() never performs installation. */
export function bootstrapSource(root, args, env, execute) {
  if (args.includes('--rebuild-plugins')) assertSelectiveInstallSafe(root);
  if (sourceDependenciesAvailable(root)) return false;
  if (args.includes('--resume')) throw new Error('Source dependencies are missing for --resume. Restore the original workspace dependencies; saved images, archives and tooling have been retained.');
  const status = execute('git', ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  if (status) throw new Error('Commit source changes before release; the checkout must be clean.');
  if (needsSiteResume(readSitePointer(root)?.status)) throw new Error('An unfinished deployment is recorded. Use the build script with --resume; source dependencies have not been installed.');
  prepareWorkspaceDependencies(root, env, execute);
  if (!sourceDependenciesAvailable(root)) throw new Error('Workspace installation did not provide the plugin-kit package required by the source manager.');
  return true;
}
