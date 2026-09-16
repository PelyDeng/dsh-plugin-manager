/**
 * archives 入口的构建 worker（由随包管理器自己的 CLI 拉起）。
 *
 * 部署包站点没有源码检出，不能像 source 入口那样用 `<站点根>/deploy/scripts/build.mjs`：那个文件只
 * 存在于源码树里，而且它固定跑 source 流程。这里让管理器在自己的进程里跑同一条站点发布，进度仍按
 * `DSH_BUILD_PROGRESS` 标记上报给展示端，所以两种入口的终端体验一致，部署包不需要额外文件。
 */
import { siteArguments } from './site-record.mjs';

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
