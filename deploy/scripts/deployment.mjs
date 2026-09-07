import { fileURLToPath } from 'node:url';
import { main } from '../../packages/plugin-manager/src/deployment.mjs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
const args = process.argv.slice(2);
if (!args.includes('--root')) args.push('--root', fileURLToPath(new URL('../../', import.meta.url)));
const root = args[args.indexOf('--root') + 1];
if (!args.includes('--config') && !process.env.DEPLOYMENT_CONFIG && typeof root === 'string' && existsSync(resolve(root, '.local/env.conf'))) args.push('--config', '.local/env.conf');
try { await main(args); } catch (error) { console.error(error.message); process.exitCode = 1; }
