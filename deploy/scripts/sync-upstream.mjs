/** Merge private and public updates before building; deployment recovery keeps its saved inputs. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Called under build.sh's checkout lock. Never resets, pushes or updates host submodules. */
export function syncUpstream(root, args = []) {
  if (args.includes('--resume') || args.includes('--help')) return;
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const pointer = resolve(root, '.local/source-release.json');
  if (existsSync(pointer) && ['prepared', 'backing-up', 'applying', 'deployment-failed'].includes(JSON.parse(readFileSync(pointer, 'utf8')).status)) {
    throw new Error('存在未完成部署；不更新源码，请使用 bash deploy/build.sh --resume。');
  }
  if (git('status', '--porcelain', '--ignore-submodules=all')) throw new Error('请先提交或保存工作区改动，再同步上游；服务尚未停止。');
  if (!git('branch', '--show-current')) throw new Error('请在私有仓库分支上执行构建，不能在分离 HEAD 上自动合并。');
  if (!git('remote').split('\n').includes('upstream')) {
    git('remote', 'add', 'upstream', 'https://github.com/PelyDeng/dsh-plugin.git');
    git('remote', 'set-url', '--push', 'upstream', 'DISABLED');
  }
  // Fetch both histories before changing the checkout; network failures leave local commits intact.
  for (const remote of ['origin', 'upstream']) {
    console.log(`获取 ${remote}/main（不下载宿主子模块）…`);
    git('fetch', '--no-recurse-submodules', remote, 'main');
  }
  const checkpoint = `codex/before-upstream-${Date.now()}`;
  let saved = false;
  for (const remote of ['origin', 'upstream']) {
    const ref = `${remote}/main`;
    const target = git('rev-parse', ref);
    if (git('merge-base', 'HEAD', ref) === target) continue;
    if (!saved) { git('branch', checkpoint, 'HEAD'); saved = true; console.log(`原提交已保留：${checkpoint}`); }
    console.log(`合并 ${ref}，保留私有提交…`);
    try { git('merge', '--no-edit', ref); }
    catch (error) {
      const mergeHead = resolve(root, git('rev-parse', '--git-path', 'MERGE_HEAD'));
      if (existsSync(mergeHead)) git('merge', '--abort');
      throw new Error(`合并 ${ref} 失败，构建已停止；原提交保留在 ${checkpoint}。请手工解决后重试。`, { cause: error });
    }
  }
  console.log(`源码同步完成：${git('rev-parse', '--short', 'HEAD')}。合并提交仅保存在本机，不自动推送。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { syncUpstream(fileURLToPath(new URL('../../', import.meta.url)), process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
