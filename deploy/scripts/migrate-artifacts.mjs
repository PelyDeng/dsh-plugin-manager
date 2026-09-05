import { fileURLToPath } from 'node:url';
import { migrateData, parseMigrationArguments } from '../../packages/plugin-manager/src/migrate-data.mjs';
const args = process.argv.slice(2);
if (!args.includes('--root')) args.push('--root', fileURLToPath(new URL('../../', import.meta.url)));
try { console.log(JSON.stringify(migrateData({ ...parseMigrationArguments(args), kind: 'artifacts' }), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
