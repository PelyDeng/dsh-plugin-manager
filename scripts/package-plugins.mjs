import { fileURLToPath } from 'node:url';
import { main } from '../packages/plugin-manager/src/package-plugins.mjs';
import { buildStep } from '../deploy/scripts/build-output.mjs';
import { frameworkVersion } from './version.mjs';
const args = process.argv.slice(2);
if (!args.includes('--root')) args.push('--root', fileURLToPath(new URL('../', import.meta.url)));
try {
  if (!args.includes('--help')) frameworkVersion(fileURLToPath(new URL('../', import.meta.url)));
  await main(args, buildStep);
} catch (error) { console.error(error.message); process.exitCode = 1; }
