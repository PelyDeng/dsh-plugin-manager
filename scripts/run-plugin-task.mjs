import { fileURLToPath } from 'node:url';
import { main } from '../packages/plugin-manager/src/run-plugin-task.mjs';
const args = process.argv.slice(2);
if (!args.includes('--root')) args.push('--root', fileURLToPath(new URL('../', import.meta.url)));
try { await main(args); } catch (error) { console.error(error.message); process.exitCode = 1; }
