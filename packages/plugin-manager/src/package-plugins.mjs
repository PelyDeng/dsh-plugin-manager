/** Build, check and package selected plugins without reading runtime configuration. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOptions, sourcePlugins } from './plugins.mjs';
import { preparePluginDependencies, runPluginTask, runPnpm } from './run-plugin-task.mjs';
import { verifyBuildPackage } from './verify-package.mjs';
import { validateVerification } from './verification.mjs';

/**
 * 构建并打包选中的插件。
 *
 * `skipCheck` 默认为 **true**：插件检查（`pnpm typecheck` 等）是开发期门禁，仓库的
 * CI 与 `pnpm check` 已会在同一提交上跑它；日常构建再对每个插件重复一次只是把反馈
 * 拖长（实测 5 个插件约 56 秒），且不改变任何产物。需要在本机确认检查时用
 * `--verify-plugin-check` 显式要回来。
 */
export function packagePlugins(root, requested, output, packageDirectory, step = (_label, run) => run(), { skipCheck = true } = {}) {
  const selected = sourcePlugins(root, requested, packageDirectory);
  const single = packageDirectory !== undefined;
  if (single && !existsSync(resolve(root, 'pnpm-lock.yaml'))) throw new Error('独立包打包需要包根 pnpm-lock.yaml。请在作者项目根执行 pnpm install --ignore-workspace 生成锁文件后重试。');
  if (existsSync(output) && readdirSync(output).length) throw new Error('发布目录必须不存在或为空；不会覆盖旧操作产物。请换一个新的发布目录（例如 v2）后重试。');
  mkdirSync(output, { recursive: true });
  if (selected.length) step('安装插件依赖', () => runPnpm(['install', '--frozen-lockfile', ...(single ? ['--ignore-workspace'] : [])], root));
  preparePluginDependencies(root, selected, step);
  const plugins = [];
  for (const plugin of selected) {
    // 'build' 走的是同一条「构建 + 打包」路径，只是不再追加开发期的检查步骤。
    runPluginTask(root, plugin, skipCheck ? 'build' : 'check', step);
    step(`打包插件 ${plugin.id}`, () => {
      const destination = resolve(output, `${plugin.id}.tgz`);
      runPnpm([...(single ? ['--ignore-workspace'] : []), 'pack', '--json', '--out', destination], resolve(root, plugin.directory ?? '.'), { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
      verifyBuildPackage(root, plugin, destination);
      const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
      // pnpm must see a new file spec when the same package version has new bytes.
      const archive = `${plugin.id}-${sha256}.tgz`;
      renameSync(destination, resolve(output, archive));
      plugins.push({ ...plugin, archive, sha256 });
      console.log(`[${plugin.id}] 发布包已验证：${archive}`);
    });
  }
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

export function main(argv = process.argv.slice(2), step) {
  // 默认跳过插件检查（见 packagePlugins 说明）；--verify-plugin-check 把它要回来。
  const options = parseOptions(argv, ['root', 'plugins', 'output', 'package'], ['skip-plugin-check', 'verify-plugin-check']);
  if (!options.root) throw new Error('必须显式指定 --root 项目根目录。');
  const root = resolve(options.root);
  const output = resolve(root, options.output ?? `.local/artifacts/${randomUUID()}/plugins`);
  const skipCheck = options['verify-plugin-check'] === true ? false : true;
  const manifest = packagePlugins(root, options.plugins, output, options.package, step, { skipCheck });
  console.log(`插件产物：${output}`);
  console.log(`交付插件：${manifest.plugins.map(plugin => plugin.id).join(',') || 'none'}`);
  console.log('下一步：交付整个发布目录（manifest.json 和全部 tgz）；部署者放入 incoming/<应用目录> 后执行 build，并请求插件声明的 healthPath。');
}
