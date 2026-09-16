/**
 * archives 入口的构建 worker（由随包管理器自己的 CLI 拉起）。
 *
 * 部署包站点没有源码检出，不能像 source 入口那样用 `<站点根>/deploy/scripts/build.mjs`：那个文件只
 * 存在于源码树里，而且它固定跑 source 流程。这里让管理器在自己的进程里跑同一条站点发布，进度仍按
 * `DSH_BUILD_PROGRESS` 标记上报给展示端，所以两种入口的终端体验一致，部署包不需要额外文件。
 */
import { siteArguments } from './site-record.mjs';

/**
 * 构建结束后回一个结束消息。
 *
 * 协调器（`site-coordinator.mjs`）只有在收到这条消息、且它的退出码与 worker 退出码一致时，才认为
 * worker 正常收尾并释放源码锁；source 入口的 `deploy/scripts/build.mjs` 一直这么做。缺了这一步，
 * 每次 archives 构建都会留下 `.local/source-release.node.lock`，下一次 build 会被直接拒绝。
 */
export function reportArchivesFinish(code) {
  if (typeof process.send !== 'function') return;
  process.send({ type: 'source-build-finished', code }, () => process.disconnect());
}

/** 跑一次 archives 发布；返回进程退出码（0 成功、1 失败）。 */
export async function archivesWorker(argv) {
  const options = siteArguments(argv);
  if (!options.root) throw new Error('archives-worker 需要 --root <站点根>。');
  const { releaseSite } = await import('./site-release.mjs');
  try {
    const record = await releaseSite({ ...options, inputKind: 'archives' });
    return record?.status === 'ready' ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}
