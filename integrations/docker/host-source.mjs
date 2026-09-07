/** Read the supplied host source without changing its checkout or fetching code. */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const officialHostUrl = 'https://github.com/deepseek-ai/deepseek-harness.git';
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Host source Git check failed: ${args[0]}`);
  return result.stdout.trim();
}

/** Capture committed host source, comparing native paths so Windows short names identify the same worktree. */
export function inspectHostSource(repoRoot = defaultRoot) {
  const root = realpathSync.native(repoRoot);
  const path = resolve(root, 'deepseek-harness');
  if (!existsSync(resolve(path, 'package.json'))) throw new Error('The local deepseek-harness source is missing; supply a complete checkout before building.');
  if (realpathSync.native(git(path, ['rev-parse', '--show-toplevel'])) !== realpathSync.native(path)) {
    throw new Error('deepseek-harness is not an initialized independent Git worktree.');
  }
  const repositoryCommit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const commit = git(path, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (git(path, ['status', '--porcelain'])) throw new Error('The official host worktree has changes; source preparation is read-only.');
  const manifest = JSON.parse(git(path, ['show', `${commit}:package.json`]));
  if (typeof manifest.version !== 'string' || typeof manifest.packageManager !== 'string') throw new Error('Host package metadata is incomplete.');
  return { path, commit, version: manifest.version, packageManager: manifest.packageManager, repositoryCommit };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let root = defaultRoot;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--root' && args[0]) root = resolve(defaultRoot, args.shift());
    else throw new Error(`Unknown host-source option: ${flag}`);
  }
  console.log(JSON.stringify(inspectHostSource(root)));
}
