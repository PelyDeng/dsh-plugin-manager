#!/usr/bin/env node
/** The standalone manager requires an explicit project root for project operations. */
import { readFileSync } from 'node:fs';

export async function main(args = process.argv.slice(2)) {
  const [action, ...rest] = args;
  if (!action || action === '--help') {
    console.log('dsh-plugin-manager <list|build|check|clean|pack|catalog|verify-package|deploy|start|stop|sync|verify|paths|adopt|unlock|health|apply-compose|check-compose|render-compose|migrate-data|migrate-artifacts|set-api-key> --root <project> [options]\nlist/build/check/pack: --package . 选择独立包；省略时保留 plugins/* 扫描和 --plugins 选集。\nverify-package --root <包根> --package . --archive <tgz>');
    console.log('compose-release --root <交付根> --output <新发布目录> --manifest <清单1> --manifest <清单2> [--verification-report <报告.json>]\n--verification-report 可重复；记录仅作安装提示，不是兼容认证。\n--version 显示管理器版本');
  } else if (action === '--version') console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  else if (action === 'release-site') {
    const { siteArguments } = await import('./site-record.mjs');
    // doctor/unlock remain usable without importing deployment or kit implementations.
    const routeIndex = rest.findIndex((value, index) => ['doctor', 'unlock-source', 'release'].includes(value) && (index === 0 || !['--root', '--config', '--rebuild-plugins'].includes(rest[index - 1])));
    const route = routeIndex < 0 ? undefined : rest.splice(routeIndex, 1)[0];
    const options = siteArguments(rest);
    if (!options.root) throw new Error('release-site 必须明确 --root 站点目录。');
    const forwarded = rest.filter((value, index) => value !== '--root' && rest[index - 1] !== '--root');
    const { sourceRelease } = await import('./site-coordinator.mjs');
    process.exitCode = await sourceRelease({ root: options.root, args: route ? [route, ...forwarded] : forwarded, defaultInputKind: 'archives' });
  }
  else if (['list', 'build', 'check', 'clean'].includes(action)) (await import('./run-plugin-task.mjs')).main(args);
  else if (action === 'pack') (await import('./package-plugins.mjs')).main(rest);
  else if (action === 'compose-release') (await import('./compose-release.mjs')).main(rest);
  else if (action === 'catalog') (await import('./plugins.mjs')).main(rest);
  else if (action === 'verify-package') (await import('./verify-package.mjs')).main(rest);
  else if (action === 'set-api-key') await (await import('./set-api-key.mjs')).main(rest);
  else if (['migrate-data', 'migrate-artifacts'].includes(action)) {
    const { migrateData, parseMigrationArguments } = await import('./migrate-data.mjs');
    console.log(JSON.stringify(migrateData({ ...parseMigrationArguments(rest), kind: action === 'migrate-artifacts' ? 'artifacts' : 'data' }), null, 2));
  } else await (await import('./deployment.mjs')).main(args);
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
