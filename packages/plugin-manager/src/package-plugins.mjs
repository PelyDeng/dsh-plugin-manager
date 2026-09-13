/** Build, check and package selected plugins without reading runtime configuration. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { parseOptions, sourcePlugins } from './plugins.mjs';
import { runPnpmAsync } from './pnpm.mjs';
import { preparePluginDependencies, replayPluginOutput, runPluginTaskAsync, runPnpm } from './run-plugin-task.mjs';
import { verifyBuildPackage } from './verify-package.mjs';
import { validateVerification } from './verification.mjs';

/**
 * 并行打包的默认并发数。
 *
 * 每个插件各自起一个 pnpm + 打包器进程，彼此不共享文件；并发能把「一个接一个等进程启动」
 * 的等待压掉大半。上限取 4 是实测结果：4 个插件（auth、example、butler、agents-group）在
 * 88 核服务器上，逐个打包 97.4s，并发 3 是 70.9s，并发 4 是 62.3s，并发 6 回到 63.0s ——
 * 再高已经没有收益，只剩更多内存与磁盘争用。核数少时退到 `核数 - 1`，单核机器与逐个打包一致。
 */
function defaultConcurrency() {
  const cpus = typeof availableParallelism === 'function' ? availableParallelism() : 2;
  return Math.max(1, Math.min(4, cpus - 1));
}

/**
 * 按并发上限跑完每一项，结果保持原顺序。
 *
 * 任一项失败就停止派发新的，等在跑的收尾，然后抛第一个错误：失败点可复现，也不会把
 * 后续插件的时间浪费掉。结果按序号回填，所以并发不影响 `manifest.json` 里的顺序。
 */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0, failure;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (error) { failure ??= error; }
    }
  });
  await Promise.all(runners);
  if (failure !== undefined) throw failure;
  return results;
}

/**
 * 构建并打包选中的插件。
 *
 * `skipCheck` 默认为 **true**：插件检查（`pnpm typecheck` 等）是开发期门禁，仓库的
 * CI 与 `pnpm check` 已会在同一提交上跑它；日常构建再对每个插件重复一次只是把反馈
 * 拖长（实测 5 个插件约 56 秒），且不改变任何产物。需要在本机确认检查时用
 * `--verify-plugin-check` 显式要回来。
 *
 * 每个插件的构建与打包并行进行（上限见 `concurrency`），共享依赖的安装与准备仍是单线：
 * 那两步动的是同一份 `node_modules`，先做完再并行。
 */
export async function packagePlugins(root, requested, output, packageDirectory, step = (_label, run) => run(), { skipCheck = true, concurrency = defaultConcurrency() } = {}) {
  const selected = sourcePlugins(root, requested, packageDirectory);
  const single = packageDirectory !== undefined;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数。');
  if (single && !existsSync(resolve(root, 'pnpm-lock.yaml'))) throw new Error('独立包打包需要包根 pnpm-lock.yaml。请在作者项目根执行 pnpm install --ignore-workspace 生成锁文件后重试。');
  if (existsSync(output) && readdirSync(output).length) throw new Error('发布目录必须不存在或为空；不会覆盖旧操作产物。请换一个新的发布目录（例如 v2）后重试。');
  mkdirSync(output, { recursive: true });
  if (selected.length) step('安装插件依赖', () => runPnpm(['install', '--frozen-lockfile', ...(single ? ['--ignore-workspace'] : [])], root));
  preparePluginDependencies(root, selected, step);
  const plugins = await mapWithLimit(selected, concurrency, async plugin => {
    // 'build' 走的是同一条「构建 + 打包」路径，只是不再追加开发期的检查步骤。
    await runPluginTaskAsync(root, plugin, skipCheck ? 'build' : 'check', step);
    return await step(`打包插件 ${plugin.id}`, async () => {
      const destination = resolve(output, `${plugin.id}.tgz`);
      // pnpm 的 JSON 清单没人读（校验读的是归档本身），所以只回放它的报错。
      const captured = await runPnpmAsync([...(single ? ['--ignore-workspace'] : []), 'pack', '--json', '--out', destination], resolve(root, plugin.directory ?? '.'), { maxBuffer: 32 * 1024 * 1024 });
      replayPluginOutput(plugin.id, { stderr: captured.stderr });
      verifyBuildPackage(root, plugin, destination);
      const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
      // pnpm must see a new file spec when the same package version has new bytes.
      const archive = `${plugin.id}-${sha256}.tgz`;
      renameSync(destination, resolve(output, archive));
      console.log(`[${plugin.id}] 发布包已验证：${archive}`);
      return { ...plugin, archive, sha256 };
    });
  });
  const lockPath = resolve(root, 'pnpm-lock.yaml');
  const packageManagerVersion = plugins.length ? runPnpm(['--version'], root, { stdio: ['ignore', 'pipe', 'pipe'] }).stdout.toString().trim() : undefined;
  const verification = validateVerification({ schemaVersion: 1, builds: plugins.map(plugin => ({
    pluginId: plugin.id, archiveSha256: plugin.sha256, nodeVersion: process.versions.node, packageManagerVersion,
    ...(existsSync(lockPath) ? { lockSha256: createHash('sha256').update(readFileSync(lockPath)).digest('hex') } : {}),
  })), runs: [] }, plugins);
  const manifest = { schemaVersion: single ? 2 : 1, plugins, verification };
  const temporary = resolve(output, 'manifest.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, resolve(output, 'manifest.json'));
  return manifest;
}

export async function main(argv = process.argv.slice(2), step) {
  // 默认跳过插件检查（见 packagePlugins 说明）；--verify-plugin-check 把它要回来。
  const options = parseOptions(argv, ['root', 'plugins', 'output', 'package', 'concurrency'], ['skip-plugin-check', 'verify-plugin-check']);
  if (!options.root) throw new Error('必须显式指定 --root 项目根目录。');
  const root = resolve(options.root);
  const output = resolve(root, options.output ?? `.local/artifacts/${randomUUID()}/plugins`);
  const skipCheck = options['verify-plugin-check'] === true ? false : true;
  const concurrency = options.concurrency === undefined ? defaultConcurrency() : Number(options.concurrency);
  const manifest = await packagePlugins(root, options.plugins, output, options.package, step, { skipCheck, concurrency });
  console.log(`插件产物：${output}`);
  console.log(`交付插件：${manifest.plugins.map(plugin => plugin.id).join(',') || 'none'}`);
  console.log('下一步：交付整个发布目录（manifest.json 和全部 tgz）；部署者放入 incoming/<应用目录> 后执行 build，并请求插件声明的 healthPath。');
}
