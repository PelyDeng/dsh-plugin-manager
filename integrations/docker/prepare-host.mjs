/** Explicitly install and build the pinned official host using its own package manager. */
import { spawnSync } from 'node:child_process';
import { inspectHostSource } from './host-source.mjs';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--working-tree')) throw new Error('Usage: node deploy/scripts/prepare-host.mjs [--working-tree]');
const host = inspectHostSource(undefined, { formal: !args.includes('--working-tree') });
console.log(`Preparing official DSH ${host.commit} with ${host.packageManager}`);
for (const command of [['install', '--frozen-lockfile'], ['run', 'build']]) {
  const result = spawnSync('corepack', [host.packageManager, ...command], {
    cwd: host.path, stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true,
    // Upstream CI mode skips developer Git-hook installation, which cannot own a submodule's common Git config.
    env: { ...process.env, CI: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
inspectHostSource(undefined, { formal: !args.includes('--working-tree') });
