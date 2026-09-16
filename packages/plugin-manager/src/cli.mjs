#!/usr/bin/env node
/** The standalone manager requires an explicit project root for project operations. */
import { readFileSync } from 'node:fs';

export async function main(args = process.argv.slice(2)) {
  const [action, ...rest] = args;
  if (!action || action === '--help') {
    console.log(`DSH Plugin Manager

按角色选择命令；除 --version 外都需要显式 --root。

插件作者：
  list / build / check / clean    发现和验证插件源码
  pack                            生成完整发布目录
  verify-package                  校验已生成的插件归档
  verify-release                  只读校验完整发布目录，可在 CI 或交付前独立运行

部署者：
  release-site                    部署包 build 使用的站点发布入口
  deploy / start / stop / sync    底层安装与运行操作
  health / verify                 读取部署记录并检查状态
  check-records                   只读核对发布记录与现场，判定漂移类别并给出对账计划
  container-start                 完整运行镜像容器入口（通常由镜像 ENTRYPOINT 调用）

维护者：
  compose-release                 合并多个完整发布目录
  catalog / paths / adopt / unlock
  migrate-site                    一次性把旧站点迁移到 managed 授权集合与稳定绑定
  migrate-data / migrate-artifacts
  set-api-key

常用参数：
  list/build/check/pack: --package . 选择独立包；省略时保留 plugins/builtin/* 扫描和 --plugins 选集。
  verify-package: --root <包根> --package . --archive <tgz>
  compose-release: --root <交付根> --output <新发布目录> --manifest <清单> [--verification-report <报告.json>]
  --verification-report 可重复；记录仅作安装提示，不是兼容认证。
  --version 显示管理器版本`);
  } else if (action === '--version') console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  else if (action === 'archives-worker') {
    // 部署包站点的构建 worker：由 release-site 的展示端拉起。任何结果都要回报结束消息，
    // 否则协调器会认为 worker 没有正常收尾并保留源码锁，下一次 build 就会被拒绝。
    const { archivesWorker, reportArchivesFinish } = await import('./archives-worker.mjs');
    try { process.exitCode = await archivesWorker(rest); }
    finally { reportArchivesFinish(process.exitCode ?? 1); }
  }
  else if (action === 'release-site') {
    const { siteArguments } = await import('./site-record.mjs');
    // doctor/unlock remain usable without importing deployment or kit implementations.
    const routeIndex = rest.findIndex((value, index) => ['doctor', 'unlock-source', 'release'].includes(value) && (index === 0 || !['--root', '--config'].includes(rest[index - 1])));
    const route = routeIndex < 0 ? undefined : rest.splice(routeIndex, 1)[0];
    const options = siteArguments(rest);
    if (!options.root) throw new Error('release-site 必须明确 --root 站点目录。');
    const forwarded = rest.filter((value, index) => value !== '--root' && rest[index - 1] !== '--root');
    const { sourceRelease } = await import('./site-coordinator.mjs');
    process.exitCode = await sourceRelease({ root: options.root, args: route ? [route, ...forwarded] : forwarded, defaultInputKind: 'archives' });
  }
  else if (['list', 'build', 'check', 'clean'].includes(action)) (await import('./run-plugin-task.mjs')).main(args);
  else if (action === 'pack') await (await import('./package-plugins.mjs')).main(rest);
  else if (action === 'compose-release') (await import('./compose-release.mjs')).main(rest);
  else if (action === 'catalog') (await import('./plugins.mjs')).main(rest);
  else if (action === 'verify-package') (await import('./verify-package.mjs')).main(rest);
  else if (action === 'verify-release') process.exitCode = (await import('./verify-release.mjs')).main(rest);
  else if (action === 'check-records') (await import('./check-records.mjs')).main(rest);
  else if (action === 'set-api-key') await (await import('./set-api-key.mjs')).main(rest);
  else if (['migrate-data', 'migrate-artifacts'].includes(action)) {
    const { migrateData, parseMigrationArguments } = await import('./migrate-data.mjs');
    console.log(JSON.stringify(migrateData({ ...parseMigrationArguments(rest), kind: action === 'migrate-artifacts' ? 'artifacts' : 'data' }), null, 2));
  } else if (action === 'migrate-site') (await import('./migrate-site.mjs')).main(rest);
  else await (await import('./deployment.mjs')).main(args);
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
