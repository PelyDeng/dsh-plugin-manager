#!/usr/bin/env node
/** The standalone manager requires an explicit project root for project operations. */
import { main as deploy } from './deployment.mjs';
import { main as tasks } from './run-plugin-task.mjs';
import { main as pack } from './package-plugins.mjs';
import { main as catalog } from './plugins.mjs';
import { main as verify } from './verify-package.mjs';
import { main as setApiKey } from './set-api-key.mjs';
import { migrateData, parseMigrationArguments } from './migrate-data.mjs';

export async function main(args = process.argv.slice(2)) {
  const [action, ...rest] = args;
  if (!action || action === '--help') {
    console.log('dsh-plugin <list|build|check|clean|pack|catalog|deploy|start|stop|sync|verify|paths|adopt|unlock|health|apply-compose|render-compose|migrate-data|migrate-artifacts|set-api-key> --root <project> [options]');
  } else if (['list', 'build', 'check', 'clean'].includes(action)) tasks(args);
  else if (action === 'pack') pack(rest);
  else if (action === 'catalog') catalog(rest);
  else if (action === 'verify-package') verify(rest);
  else if (action === 'set-api-key') await setApiKey(rest);
  else if (['migrate-data', 'migrate-artifacts'].includes(action)) {
    console.log(JSON.stringify(migrateData({ ...parseMigrationArguments(rest), kind: action === 'migrate-artifacts' ? 'artifacts' : 'data' }), null, 2));
  } else await deploy(args);
}

await main().catch(error => { console.error(error.message); process.exitCode = 1; });
