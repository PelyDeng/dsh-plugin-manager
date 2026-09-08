/** Public scripts and private update hooks share one checkout-wide source release. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireFileLock } from '../../packages/plugin-manager/src/lock.mjs';
import { canonical } from '../../packages/plugin-manager/src/state.mjs';
import { presentBuild } from './build-output.mjs';

function runEntry(root, entry, args) {
  const result = spawnSync(process.execPath, [resolve(root, 'deploy/scripts', entry), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
}

/** Validate before preflight or a private source update can change the checkout. */
export function sourceArguments(args) {
  const copy = [...args], seen = new Set();
  while (copy.length) {
    const flag = copy.shift();
    if (seen.has(flag)) throw new Error(`Unknown or duplicate argument: ${flag}. Use --help.`);
    seen.add(flag);
    if (flag === '--resume') continue;
    if (flag === '--config' && copy[0] && !copy[0].startsWith('--')) { copy.shift(); continue; }
    throw new Error(`Unknown or duplicate argument: ${flag}. Use --help.`);
  }
  return [...args];
}

/** beforeBuild runs under the same lock; the build worker loads updated source afterwards. */
export async function sourceRelease({ root, args = [], beforeBuild, preflight } = {}) {
  if (!root) throw new Error('Source release requires an explicit repository root.');
  root = canonical(root);
  const source = !args[0] || args[0] === 'release' || args[0].startsWith('--');
  if (!source) return runEntry(root, 'deployment.mjs', args);
  const buildArgs = args[0] === 'release' ? args.slice(1) : [...args];
  if (buildArgs.includes('--help')) return runEntry(root, 'build.mjs', ['--help']);
  sourceArguments(buildArgs);
  const prepare = preflight ?? (await import('./platform.mjs')).prepareSourceRelease;
  const prepared = await prepare(root);
  const env = prepared?.env ?? process.env;
  const path = resolve(root, '.local/source-release.node.lock');
  const unlock = acquireFileLock(path, `源码部署正在执行或上次进程中断；核实本机持锁者及其子进程均已退出后再清理 ${path}，不要删除旧 source-release.lock。`);
  let interrupted, workerStarted = false, finishedCode, confirmed = false;
  const interrupt = () => { interrupted ??= 'SIGINT'; };
  const terminate = () => { interrupted ??= 'SIGTERM'; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    if (beforeBuild && !buildArgs.includes('--resume')) await beforeBuild(root, buildArgs, env);
    if (interrupted) return interrupted === 'SIGINT' ? 130 : 143;
    const code = await presentBuild(resolve(root, 'deploy/scripts/build.mjs'), buildArgs, {
      logDirectory: resolve(root, '.local/artifacts/build-logs'), cwd: root, env,
      onSpawn: child => {
        workerStarted = true;
        unlock.update({ workerPid: child.pid });
        child.once('exit', (_code, signal) => { if (signal) interrupted ??= signal; });
      },
      onFinished: code => { finishedCode = code; },
    });
    confirmed = finishedCode === code;
    // A killed worker can leave synchronous descendants alive even after its own exit.
    if (code === 130 || code === 143) interrupted ??= code === 130 ? 'SIGINT' : 'SIGTERM';
    return code;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    if (interrupted || (workerStarted && !confirmed)) {
      unlock.retain();
      console.error(`无法确认构建进程正常结束，源码锁已保留：${path}。核实持锁者及其子进程均已退出后再清理该文件，然后按发布记录使用 build 脚本或 --resume。`);
    } else unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await sourceRelease({ root: fileURLToPath(new URL('../../', import.meta.url)), args: process.argv.slice(2) }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
