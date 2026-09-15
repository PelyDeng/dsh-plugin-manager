/** Build, check and package selected plugins without reading runtime configuration. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { parseOptions, sourcePlugins } from './plugins.mjs';
import { runPnpmAsync } from './pnpm.mjs';
import { preparePluginDependencies, replayPluginOutput, runPluginTaskAsync, runPnpm, USAGE } from './run-plugin-task.mjs';
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
 * 这里只做构建、打包与内容寻址，**不做完整静态检查**：类型检查等开发期门禁由仓库 CI 与
 * `pnpm check` 承担，归档与源码字节一致由独立的 `verify-package` 命令承担，交付目录的合规
 * 由 `verify-release` 承担。pack 的输出只说明生成了什么，不说"已验证"。
 *
 * 每个插件的构建与打包并行进行（上限见 `concurrency`），共享依赖的安装与准备仍是单线：
 * 那两步动的是同一份 `node_modules`，先做完再并行。
 */
export async function packagePlugins(root, requested, output, packageDirectory, step = (_label, run) => run(), { concurrency = defaultConcurrency(), workspaceRoot = root, source = 'builtin' } = {}) {
  const selected = sourcePlugins(root, requested, packageDirectory, { source });
  const single = packageDirectory !== undefined;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数。');
  if (single && !existsSync(resolve(root, 'pnpm-lock.yaml'))) throw new Error('独立包打包需要包根 pnpm-lock.yaml。请在作者项目根执行 pnpm install --ignore-workspace 生成锁文件后重试。');
  if (existsSync(output) && readdirSync(output).length) throw new Error('发布目录必须不存在或为空；不会覆盖旧操作产物。请换一个新的发布目录（例如 v2）后重试。');
  mkdirSync(output, { recursive: true });
  // 安装与构建发生在 workspaceRoot（内置构建用只含公开输入的隔离视图），插件发现仍按 root：
  // 站点侧的源码树可能同时含私有/外部源码，不能在那里做一次全 workspace 安装。
  if (selected.length) step('安装插件依赖', () => runPnpm(['install', '--frozen-lockfile', ...(single ? ['--ignore-workspace'] : [])], workspaceRoot));
  preparePluginDependencies(workspaceRoot, selected, step);
  const plugins = await mapWithLimit(selected, concurrency, async plugin => {
    await runPluginTaskAsync(workspaceRoot, plugin, 'build', step);
    return await step(`打包插件 ${plugin.id}`, async () => {
      const destination = resolve(output, `${plugin.id}.tgz`);
      // pnpm 的 JSON 清单没人读（校验读的是归档本身），所以只回放它的报错。
      const captured = await runPnpmAsync([...(single ? ['--ignore-workspace'] : []), 'pack', '--json', '--out', destination], resolve(workspaceRoot, plugin.directory ?? '.'), { maxBuffer: 32 * 1024 * 1024 });
      replayPluginOutput(plugin.id, { stderr: captured.stderr });
      const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
      // pnpm must see a new file spec when the same package version has new bytes.
      const archive = `${plugin.id}-${sha256}.tgz`;
      renameSync(destination, resolve(output, archive));
      console.log(`[${plugin.id}] 已生成：${archive}`);
      return { ...plugin, archive, sha256 };
    });
  });
  // 验证记录必须描述真正执行安装的那份锁与管理器，而不是发现源码的目录。
  const lockPath = resolve(workspaceRoot, 'pnpm-lock.yaml');
  const packageManagerVersion = plugins.length ? runPnpm(['--version'], workspaceRoot, { stdio: ['ignore', 'pipe', 'pipe'] }).stdout.toString().trim() : undefined;
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
  // 帮助与用法放在解析参数之前：查用法不该先备好项目根。
  if (argv.includes('--help')) { console.log(USAGE); return; }
  // 已移除的旗标明确说出替代命令，不静默接受，也不让作者以为是拼写错误。
  const removed = argv.find(value => ['--skip-plugin-check', '--verify-plugin-check'].includes(value));
  if (removed) throw new Error(`${removed} 已移除：pack 只构建、打包并做内容寻址；类型检查用 check，归档与源码一致性用 verify-package，交付目录合规用 verify-release。`);
  const options = parseOptions(argv, ['root', 'plugins', 'output', 'package', 'concurrency', 'workspace-root'], ['external']);
  if (!options.root) throw new Error('必须显式指定 --root 项目根目录。');
  const root = resolve(options.root);
  const workspaceRoot = options['workspace-root'] === undefined ? root : resolve(options['workspace-root']);
  const output = resolve(root, options.output ?? `.local/artifacts/${randomUUID()}/plugins`);
  const concurrency = options.concurrency === undefined ? defaultConcurrency() : Number(options.concurrency);
  // 与 build/check 同一契约：内置默认全量；--external 是作者显式调用，必须显式给出选集。
  const source = options.external ? 'external' : 'builtin';
  if (options.external && options.plugins === undefined && options.package === undefined) throw new Error('--external 必须显式给出插件选集：ID 列表、all 或 none。');
  const manifest = await packagePlugins(root, options.plugins ?? (options.package === undefined ? 'all' : undefined), output, options.package, step, { concurrency, workspaceRoot, source });
  console.log(`插件产物：${output}`);
  console.log(`交付插件：${manifest.plugins.map(plugin => plugin.id).join(',') || 'none'}`);
  console.log('下一步：需要自检时先跑 verify-package（归档与源码一致）与 verify-release（交付目录合规），再把整个发布目录交给部署者。');
}
