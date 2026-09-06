#!/usr/bin/env node
/** The standalone manager requires an explicit project root for project operations. */
import { main as deploy } from './deployment.mjs';
import { readFileSync } from 'node:fs';
import { main as tasks } from './run-plugin-task.mjs';
import { main as pack } from './package-plugins.mjs';
import { main as composeRelease } from './compose-release.mjs';
import { main as catalog } from './plugins.mjs';
import { main as verify } from './verify-package.mjs';
import { main as setApiKey } from './set-api-key.mjs';
import { migrateData, parseMigrationArguments } from './migrate-data.mjs';

export async function main(args = process.argv.slice(2)) {
  const [action, ...rest] = args;
  if (!action || action === '--help') {
    console.log('dsh-plugin <list|build|check|clean|pack|catalog|verify-package|deploy|start|stop|sync|verify|paths|adopt|unlock|health|apply-compose|render-compose|migrate-data|migrate-artifacts|set-api-key> --root <project> [options]\nlist/build/check/pack: --package . 选择独立包；省略时保留 plugins/* 扫描和 --plugins 选集。\nverify-package --root <包根> --package . --archive <tgz>');
    console.log('compose-release --root <交付根> --output <新发布目录> --manifest <清单1> --manifest <清单2>\n--version 显示管理器版本');
  } else if (action === '--version') console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  else if (['list', 'build', 'check', 'clean'].includes(action)) tasks(args);
  else if (action === 'pack') pack(rest);
  else if (action === 'compose-release') composeRelease(rest);
  else if (action === 'catalog') catalog(rest);
  else if (action === 'verify-package') verify(rest);
  else if (action === 'set-api-key') await setApiKey(rest);
  else if (['migrate-data', 'migrate-artifacts'].includes(action)) {
    console.log(JSON.stringify(migrateData({ ...parseMigrationArguments(rest), kind: action === 'migrate-artifacts' ? 'artifacts' : 'data' }), null, 2));
  } else await deploy(args);
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
