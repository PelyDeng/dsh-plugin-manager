/** Public scripts and private update hooks share one checkout-wide source release. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSourceLock, sourceLockCommand, sourceRecoveryIdentity } from './site-lock.mjs';
import { canonical } from './state.mjs';
import { buildStep } from './site-output.mjs';
import { siteArguments } from './site-record.mjs';
import { readFrameworkConfig, resolveSiteConfig } from './framework-config.mjs';

/** archives 入口的 worker 动作名：随包管理器 CLI 自带，因此部署包不依赖站点根的任何源码文件。 */
export const ARCHIVES_WORKER_ACTION = 'archives-worker';

function runEntry(root, entry, args) {
  const result = spawnSync(process.execPath, [resolve(root, 'deploy/scripts', entry), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  return result.status ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
}

/** Validate before preflight or a private source update can change the checkout. */
export function sourceArguments(args) {
  siteArguments(args);
  return [...args];
}

/**
 * 加载展示端。
 *
 * 必须等到源码同步之后再加载：私有入口是**静态**引入公共协调器的，所以协调器（连同它静态
 * 引入的展示端）在快进检出之前就进了模块缓存 —— 一次发布里展示端跑的会是上一版代码，新加的
 * 进度行与汇总表要等下一次发布才看得见。
 *
 * 所以这里按需动态加载，并带一次性查询串：即使别的模块已缓存过旧副本，读到的也是快进后的
 * 文件。展示端与阶段上报之间的协议没有版本依赖：旧副本照常发事件，新副本照常展示。
 */
export async function loadPresenter() {
  const url = new URL('./site-output.mjs', import.meta.url);
  url.searchParams.set('presenter', `${process.pid}-${Date.now()}`);
  return (await import(url.href)).presentBuild;
}

/** beforeBuild runs under the same lock; the build worker loads updated source afterwards. */
export async function sourceRelease({ root, args = [], beforeBuild, preflight, presenter = loadPresenter, defaultInputKind = 'source' } = {}) {
  if (!root) throw new Error('Source release requires an explicit repository root.');
  root = canonical(root);
  if (['doctor', 'unlock-source'].includes(args[0])) return sourceLockCommand(root, args);
  const source = !args[0] || args[0] === 'release' || args[0].startsWith('--');
  if (!source) return runEntry(root, 'deployment.mjs', args);
  const buildArgs = args[0] === 'release' ? args.slice(1) : [...args];
  if (buildArgs.includes('--help')) {
    if (existsSync(resolve(root, 'deploy/scripts/build.mjs'))) return runEntry(root, 'build.mjs', ['--help']);
    console.log('build [--config <env.conf>]\n产物放入 incoming/<发布目录>/；首次自动创建 .local/env.conf。构建只做构建与打包，插件检查由仓库 CI 与 check 命令承担。'); return 0;
  }
  const options = siteArguments(buildArgs);
  const configPath = resolve(root, options.config ?? '.local/env.conf');
  const framework = existsSync(configPath) && configPath.endsWith('.conf') ? readFrameworkConfig(configPath) : undefined;
  const config = framework?.config ?? (existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {});
  // 输入形态由入口决定（源码检出入口 source、发行包入口 archives），站点配置不再有 pluginSource 字段。
  const inputKind = defaultInputKind;
  resolveSiteConfig(root, config, { inputKind, source: framework });
  const prepare = preflight ?? (await import('./site-platform.mjs')).prepareSiteRelease;
  const prepared = await buildStep('准备站点运行时', () => prepare(root, { inputKind }));
  const env = prepared?.env ?? process.env;
  const path = resolve(root, '.local/source-release.node.lock');
  const recovery = sourceRecoveryIdentity();
  const unlock = acquireSourceLock(root, `源码部署正在执行或上次进程中断；请运行 build 脚本 doctor 查看 ${path}，再使用 unlock-source 安全解锁。不要删除旧 source-release.lock。`);
  let interrupted, workerStarted = false, finishedCode, confirmed = false;
  const interrupt = () => { interrupted ??= 'SIGINT'; };
  const terminate = () => { interrupted ??= 'SIGTERM'; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    unlock.update({ recovery });
    if (beforeBuild && inputKind === 'source') await buildStep('同步 Gitee 集成版本', () => beforeBuild(root, buildArgs, env));
    if (interrupted) return interrupted === 'SIGINT' ? 130 : 143;
    // 输入形态决定 worker：source 用检出里的 `deploy/scripts/build.mjs`（它负责同步后的源码流程）；
    // archives 站点没有源码检出，改用随包管理器自己的 CLI（`archives-worker`），部署包不需要额外文件。
    const entry = inputKind === 'archives'
      ? fileURLToPath(new URL('./cli.mjs', import.meta.url))
      : resolve(root, 'deploy/scripts/build.mjs');
    const workerArgs = inputKind === 'archives' ? [ARCHIVES_WORKER_ACTION, '--root', root, ...buildArgs] : [...buildArgs];
    // 同步之后才加载展示端：这一次发布就用快进后的代码渲染进度与汇总。
    const present = await presenter();
    // 计时记录要能回答「这次慢在哪」：把本次发布的身份与输入形态一起落盘，便于跨次对比。
    const manifest = (() => { try { return JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')); } catch { return {}; } })();
    const code = await present(entry, workerArgs, {
      logDirectory: resolve(root, '.local/artifacts/build-logs'), cwd: root, env,
      metadata: { frameworkVersion: manifest.version ?? null, inputKind, node: process.versions.node, platform: process.platform,
        architecture: process.arch, targetArchitecture: prepared?.runtime?.architecture ?? null, packageManager: manifest.packageManager ?? null },
      onSpawn: child => {
        workerStarted = true;
        unlock.update({ workerPid: child.pid, recovery: { ...recovery, ...(process.platform === 'linux' ? { workerGroup: child.pid } : {}) } });
        child.once('exit', (_code, signal) => { if (signal) interrupted ??= signal; });
      },
      onFinished: code => { finishedCode = code; },
    });
    confirmed = finishedCode === code;
    // A killed worker can leave synchronous descendants alive even after its own exit.
    if (code === 130 || code === 143) interrupted ??= code === 130 ? 'SIGINT' : 'SIGTERM';
    return code;
  } catch (error) {
    // Private update hooks propagate a terminated subprocess through error.signal.
    if (typeof error?.signal === 'string' && error.signal) interrupted ??= error.signal;
    throw error;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    if (interrupted || (workerStarted && !confirmed)) {
      unlock.retain();
      console.error(`无法确认构建进程正常结束，源码锁已保留：${path}。请运行 build 脚本 doctor 查看原因，再运行 unlock-source 安全解锁；随后直接运行普通构建。`);
    } else unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await sourceRelease({ root: fileURLToPath(new URL('../../', import.meta.url)), args: process.argv.slice(2) }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
