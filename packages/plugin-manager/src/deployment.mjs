import { checkDataSelection, parseArguments, resolveDeployment } from './config.mjs';
import { join, resolve } from 'node:path';
import { LOCK, STATE, fail, json } from './state.mjs';
import { hostname } from 'node:os';
import { alive, stopOwned } from './process.mjs';
import { rmSync } from 'node:fs';
import { acquireLock, adoptLegacy, finalize, readState, synchronize } from './installation.mjs';
import { randomUUID } from 'node:crypto';
import { packagePlugins } from './package-plugins.mjs';
import { withLockControl } from './lock.mjs';
import { loadReleaseInputs, selectRelease, assertReleaseMode } from './release.mjs';
import { prepareOfflineDependencies } from './offline.mjs';
import { supervise } from './supervisor.mjs';
import { verifyHealth } from './installation.mjs';
import { applyPluginSettings, resolvePluginSettings } from './plugin-settings.mjs';
import { existsSync } from 'node:fs';
import { applyCompose } from './apply-compose.mjs';
/** Public CLI shared by Bash, PowerShell and the container entrypoint. */
export async function main(args = process.argv.slice(2)) {
  const options = parseArguments([...args]);
  if (options.help) { console.log('deployment.mjs deploy|start|stop|sync|verify|adopt|apply-compose|paths|health|container-start|unlock --root <project> --config <env.conf|deployment.json> --plugins all|none|id,... --manifest path --home path --profile web --host-mode owned|external --stopped-file path --started-file path'); return; }
  const deployment = resolveDeployment(options);
  if (options.action === 'health') {
    // 存活检查是只读诊断：缺少身份时也照常报告现场，身份一致性由写入路径强制（设计 2.6、5.4）。
    const state = readState(join(deployment.profileRoot, STATE));
    if (!state) fail('尚无已验证的部署状态。');
    deployment.baseUrl ??= `http://127.0.0.1:${options.port ?? process.env.DSH_PORT ?? deployment.config.port ?? 7902}`;
    console.log(JSON.stringify(await verifyHealth(deployment, state))); return;
  }
  if (options.action === 'paths') { console.log(JSON.stringify({ root: deployment.root, dataRoot: deployment.dataRoot, home: deployment.home, workspace: deployment.workspace, artifacts: deployment.artifacts, profile: deployment.profile }, null, 2)); return; }
  if (options.action === 'unlock') {
    const path = join(deployment.profileRoot, LOCK);
    // 没有锁就直接返回：取 control 锁会顺手创建 profile 目录，而「解锁」不该在空站点上补建目录，
    // 也不该把「本来就没有锁」报成一次文件系统错误。
    if (!existsSync(path)) { console.log('没有残留的 profile 锁。'); return; }
    // 显式解锁与取锁、残留锁退役共用同一把 control 锁：解锁期间不会有别的进程刚取得这把锁。
    withLockControl(path, () => {
      const lock = json(path);
      if (lock.host !== hostname() || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 || alive(lock.pid)) fail('不能确认锁拥有者已退出；保留锁。');
      rmSync(path);
    });
    return;
  }
  if (options.action === 'stop') { await stopOwned(deployment); return; }
  const allowed = ['deploy', 'start', 'sync', 'verify', 'adopt', 'apply-compose', 'container-start'];
  if (!allowed.includes(options.action)) fail(`未知操作：${options.action}`);
  if (!['verify'].includes(options.action)) checkDataSelection(deployment);
  if (!deployment.manifest) {
    if (['sync', 'verify', 'adopt', 'container-start', 'apply-compose'].includes(options.action)) fail('该操作需要 --manifest。');
    const state = readState(join(deployment.profileRoot, STATE));
    const selection = deployment.selection ?? (state ? state.managed.map(entry => entry.id).join(',') || 'none' : undefined);
    const output = join(deployment.artifacts, randomUUID(), 'plugins');
    console.warn('兼容提示：未提供 --manifest，将从当前源码自动生成发布包。外部部署建议使用 pack 输出的完整发布目录；该兼容路径将在后续版本收紧。');
    await packagePlugins(deployment.root, Array.isArray(selection) ? selection.join(',') || 'none' : selection, output);
    deployment.manifest = join(output, 'manifest.json');
  }
  const candidates = selectRelease(loadReleaseInputs(resolve(deployment.root, deployment.manifest)), deployment.selection);
  assertReleaseMode(candidates, deployment.mode);
  if (options.action === 'apply-compose') { console.log(JSON.stringify(applyCompose(deployment, candidates))); return; }
  const settings = resolvePluginSettings(deployment, candidates);
  const release = settings.release;
  applyPluginSettings(deployment, settings);
  if (options.action === 'adopt') { console.log(JSON.stringify(await adoptLegacy(deployment, release, options.plugins?.split(',')))); return; }
  if (options.action === 'verify') { console.log(JSON.stringify(await finalize(deployment, release))); return; }
  prepareOfflineDependencies(deployment);
  const start = ['start', 'container-start'].includes(options.action);
  if (start) deployment.hostMode = 'owned';
  // 安装到就绪共用一个 profile 锁：中间释放会给并发写入留出竞争窗口（设计 5.2）。
  // 锁句柄必须交给 supervisor：它在这把锁下完成启动验收，并在就绪后释放；这里的 finally
  // 只是兜底（release 幂等，重复调用不会重复解锁）。
  const unlock = acquireLock(deployment.profileRoot);
  try {
    const result = await synchronize(deployment, release, { freshContainer: options.action === 'container-start', locked: true });
    console.log(JSON.stringify(result));
    if (start) await supervise(deployment, release, { locked: true, unlock });
  } finally { unlock(); }
}

export { tarCommand } from './state.mjs';
export { canonical } from './state.mjs';
export { atomicJSON } from './state.mjs';
export { parseArguments } from './config.mjs';
export { resolveDeployment } from './config.mjs';
export { checkDataSelection } from './config.mjs';
export { loadRelease } from './release.mjs';
export { loadReleaseInputs } from './release.mjs';
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
