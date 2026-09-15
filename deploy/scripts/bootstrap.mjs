/** Prepare source dependencies before importing manager modules that consume the kit package. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildStep } from './build-output.mjs';
import { ensurePinnedPnpm } from '../../packages/plugin-manager/src/pnpm.mjs';

export function sourceDependenciesAvailable(root) {
  try {
    createRequire(resolve(root, 'packages/plugin-manager/package.json')).resolve('@dsh-plugin-manager/plugin-kit/model-key');
    return true;
  } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return false; }
}

// 固定 pnpm 版本属于构建输入准备，管理器在隔离视图里安装依赖时也要用：唯一实现在 pnpm 模块里。
export { ensurePinnedPnpm };

/**
 * 在 `installRoot` 安装依赖，但固定 pnpm 版本始终按 `sourceRoot` 的根清单决定。
 *
 * 内置构建的 `installRoot` 是只含公开输入的隔离视图；视图清单是复制来的，不能作为
 * 「本项目要哪个 pnpm」的权威来源，所以两者分开。
 */
export function prepareWorkspaceDependencies(sourceRoot, env, execute, installRoot = sourceRoot) {
  ensurePinnedPnpm(sourceRoot, env, execute);
  buildStep('安装项目依赖', () => execute('pnpm', ['install', '--frozen-lockfile'], { cwd: installRoot, env }));
}

/** Only a new CLI worker bootstraps; importing release() never performs installation. */
export function bootstrapSource(root, args, env, execute) {
  if (sourceDependenciesAvailable(root)) return false;
  const status = execute('git', ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all'], { cwd: root, env, stdio: 'pipe', encoding: 'utf8' });
  if (status) throw new Error('Commit source changes before release; the checkout must be clean.');
  prepareWorkspaceDependencies(root, env, execute);
  if (!sourceDependenciesAvailable(root)) throw new Error('Workspace installation did not provide the plugin-kit package required by the source manager.');
  return true;
}
