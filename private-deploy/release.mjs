/** Private updates reuse the public checkout lock and start a fresh build worker afterwards. */
import { fileURLToPath } from 'node:url';
import { sourceRelease } from '../deploy/scripts/release.mjs';
import { syncOrigin } from './sync-origin.mjs';

try {
  process.exitCode = await sourceRelease({
    root: fileURLToPath(new URL('../', import.meta.url)),
    args: process.argv.slice(2),
    beforeBuild: syncOrigin,
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
