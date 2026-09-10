export { sourceArguments, sourceRelease } from '../../packages/plugin-manager/src/site-coordinator.mjs';
import { sourceRelease } from '../../packages/plugin-manager/src/site-coordinator.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await sourceRelease({ root: fileURLToPath(new URL('../../', import.meta.url)), args: process.argv.slice(2) }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
