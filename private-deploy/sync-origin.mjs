/** Update a deployment checkout only from the integrated Gitee branch. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Called under the checkout deployment lock; never merges GitHub, pushes or updates submodules. */
export function syncOrigin(root, args = [], env = process.env) {
  if (args.includes('--resume') || args.includes('--help')) return;
  // Preserve native error.signal so sourceRelease retains its lock after an interrupted Git child.
  const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true }).trim();
  const entry = process.platform === 'win32' ? '.\\build.ps1' : './build.sh';
  const pointer = resolve(root, '.local/source-release.json');
  if (existsSync(pointer) && ['prepared', 'backing-up', 'applying', 'deployment-failed'].includes(JSON.parse(readFileSync(pointer, 'utf8')).status)) {
    throw new Error(`存在未完成部署；请使用 ${entry} --resume，不更新源码。`);
  }
  for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (existsSync(resolve(root, git('rev-parse', '--git-path', state)))) throw new Error(`存在未完成的 Git 操作；请先完成，再运行 ${entry}。`);
  }
  if (git('status', '--porcelain', '--ignore-submodules=all')) throw new Error('工作区有未提交改动；请先保存并在私有集成库处理，服务尚未停止。');
  if (git('branch', '--show-current') !== 'main') throw new Error('服务器更新要求检出 main 分支。');
  console.log('获取 origin/main（Gitee 集成版本，不下载宿主子模块）…');
  git('fetch', '--no-recurse-submodules', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const target = git('rev-parse', 'origin/main');
  const [ahead, behind] = git('rev-list', '--left-right', '--count', `HEAD...${target}`).split(/\s+/).map(Number);
  if (ahead) throw new Error(`本机有 ${ahead} 个提交尚未包含在 origin/main 中；请在私有集成库保留并合并这些提交、检查后推送 Gitee，再重试。服务器不自动合并或覆盖。`);
  if (behind) {
    const checkpoint = `backup/before-origin-${Date.now()}`;
    git('branch', checkpoint, 'HEAD');
    console.log(`原提交已保留：${checkpoint}`);
    git('-c', 'submodule.recurse=false', 'merge', '--ff-only', target);
  }
  console.log(`源码已就绪：${git('rev-parse', '--short', 'HEAD')}。继续调用框架构建；GitHub 更新由私有集成库处理。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { syncOrigin(fileURLToPath(new URL('../', import.meta.url)), process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
