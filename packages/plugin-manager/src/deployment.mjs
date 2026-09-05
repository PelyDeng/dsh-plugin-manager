import { checkDataSelection, parseArguments, resolveDeployment } from './config.mjs';
import { join, resolve } from 'node:path';
import { LOCK, STATE, fail, json } from './state.mjs';
import { hostname } from 'node:os';
import { alive, stopOwned } from './process.mjs';
import { rmSync } from 'node:fs';
import { adoptLegacy, finalize, readState, synchronize } from './installation.mjs';
import { randomUUID } from 'node:crypto';
import { packagePlugins } from './package-plugins.mjs';
import { loadRelease, selectRelease } from './release.mjs';
import { renderCompose } from './compose.mjs';
import { prepareOfflineDependencies } from './offline.mjs';
import { supervise } from './supervisor.mjs';
/** Public CLI shared by Bash, PowerShell and the container entrypoint. */
export async function main(args = process.argv.slice(2)) {
  const options = parseArguments([...args]);
  if (options.help) { console.log('deployment.mjs deploy|start|stop|sync|verify|adopt|paths|render-compose|unlock --plugins all|none|id,... --manifest path --home path --profile web --host-mode owned|external --stopped-file path --started-file path --resume | --recover --data-compatible'); return; }
  const deployment = resolveDeployment(options);
  if (options.action === 'paths') { console.log(JSON.stringify({ root: deployment.root, dataRoot: deployment.dataRoot, home: deployment.home, workspace: deployment.workspace, artifacts: deployment.artifacts, profile: deployment.profile }, null, 2)); return; }
  if (options.action === 'unlock') {
    const path = join(deployment.profileRoot, LOCK); const lock = json(path);
    if (lock.host !== hostname() || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || alive(lock.pid)) fail('不能确认锁拥有者已退出；保留锁。');
    rmSync(path); return;
  }
  if (options.action === 'stop') { await stopOwned(deployment); return; }
  const allowed = ['deploy', 'start', 'sync', 'verify', 'adopt', 'render-compose', 'container-start'];
  if (!allowed.includes(options.action)) fail(`未知操作：${options.action}`);
  if (!['verify', 'render-compose'].includes(options.action)) checkDataSelection(deployment);
  if (!deployment.manifest) {
    if (['sync', 'verify', 'adopt', 'container-start', 'render-compose'].includes(options.action)) fail('该操作需要 --manifest。');
    const state = readState(join(deployment.profileRoot, STATE));
    const selection = deployment.selection ?? (state ? state.plugins.map(plugin => plugin.id).join(',') || 'none' : undefined);
    const output = join(deployment.artifacts, randomUUID(), 'plugins');
    packagePlugins(deployment.root, Array.isArray(selection) ? selection.join(',') || 'none' : selection, output);
    deployment.manifest = join(output, 'manifest.json');
  }
  const release = selectRelease(loadRelease(resolve(deployment.root, deployment.manifest)), deployment.selection);
  if (options.action === 'adopt') { console.log(JSON.stringify(await adoptLegacy(deployment, release, options.plugins?.split(',')))); return; }
  if (options.action === 'render-compose') { console.log(JSON.stringify(renderCompose(deployment, release, resolve(deployment.root, options.output ?? join(deployment.artifacts, randomUUID()))))); return; }
  if (options.action === 'verify') { console.log(JSON.stringify(await finalize(deployment, release))); return; }
  prepareOfflineDependencies(deployment);
  const start = ['start', 'container-start'].includes(options.action);
  if (start) deployment.hostMode = 'owned';
  const result = await synchronize(deployment, release, { freshContainer: options.action === 'container-start' });
  console.log(JSON.stringify(result));
  if (start) await supervise(deployment, release);
}

export { tarCommand } from './state.mjs';
export { canonical } from './state.mjs';
export { atomicJSON } from './state.mjs';
export { parseArguments } from './config.mjs';
export { resolveDeployment } from './config.mjs';
export { checkDataSelection } from './config.mjs';
export { loadRelease } from './release.mjs';
export { selectRelease } from './release.mjs';
export { runtimeEnvironment } from './config.mjs';
export { commandSpec } from './process.mjs';
export { hostCLI } from './process.mjs';
export { computeChanges } from './installation.mjs';
export { acquireLock } from './installation.mjs';
export { preflightInstall } from './installation.mjs';
export { synchronize } from './installation.mjs';
export { verifyReady } from './installation.mjs';
export { finalize } from './installation.mjs';
export { adoptLegacy } from './installation.mjs';
export { supervise } from './supervisor.mjs';
export { renderCompose } from './compose.mjs';
export { prepareOfflineDependencies } from './offline.mjs';
