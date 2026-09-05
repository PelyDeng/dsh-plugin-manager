/** Validate the official submodule without changing its checkout or fetching code. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const officialHostUrl = 'https://github.com/deepseek-ai/deepseek-harness.git';
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Host source Git check failed: ${args[0]}`);
  return result.stdout.trim();
}

/** Return pinned source identifiers; formal builds read the parent commit, never a moving HEAD later. */
export function inspectHostSource(repoRoot = defaultRoot, { formal = true } = {}) {
  const root = realpathSync(repoRoot);
  const path = resolve(root, 'deepseek-harness');
  if (!existsSync(path)) throw new Error('Initialize the official submodule: git submodule update --init --recursive -- deepseek-harness');
  if (realpathSync(git(path, ['rev-parse', '--show-toplevel'])) !== realpathSync(path)) {
    throw new Error('deepseek-harness is not an initialized independent Git worktree.');
  }
  const repositoryCommit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const entry = git(root, formal ? ['ls-tree', repositoryCommit, '--', 'deepseek-harness'] : ['ls-files', '--stage', '--', 'deepseek-harness']);
  const match = /^160000 (?:commit )?([a-f0-9]{40})(?: 0)?\tdeepseek-harness$/u.exec(entry);
  if (!match) throw new Error('The parent must record deepseek-harness as a gitlink before source preparation.');
  const commit = match[1];
  const modules = formal ? git(root, ['show', `${repositoryCommit}:.gitmodules`]) : readFileSync(resolve(root, '.gitmodules'), 'utf8');
  const moduleConfig = spawnSync('git', ['config', '--file', '-', '--get', 'submodule.deepseek-harness.url'], { input: modules, encoding: 'utf8', windowsHide: true });
  if (moduleConfig.status !== 0 || moduleConfig.stdout.trim() !== officialHostUrl || git(path, ['remote', 'get-url', 'origin']) !== officialHostUrl) {
    throw new Error('The submodule must use the official HTTPS origin.');
  }
  if (git(path, ['rev-parse', '--verify', 'HEAD^{commit}']) !== commit) throw new Error('The host checkout differs from the parent gitlink.');
  if (git(path, ['status', '--porcelain'])) throw new Error('The official host worktree has changes; source preparation is read-only.');
  const manifest = JSON.parse(git(path, ['show', `${commit}:package.json`]));
  if (typeof manifest.version !== 'string' || typeof manifest.packageManager !== 'string') throw new Error('Host package metadata is incomplete.');
  return { path, commit, version: manifest.version, packageManager: manifest.packageManager, repositoryCommit };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let root = defaultRoot;
  let formal = true;
  while (args.length) {
    const flag = args.shift();
    if (flag === '--root' && args[0]) root = resolve(defaultRoot, args.shift());
    else if (flag === '--working-tree') formal = false;
    else throw new Error(`Unknown host-source option: ${flag}`);
  }
  console.log(JSON.stringify(inspectHostSource(root, { formal })));
}
