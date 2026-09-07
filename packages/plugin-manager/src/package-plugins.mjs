/** Build, check and package selected plugins without reading runtime configuration. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOptions, sourcePlugins } from './plugins.mjs';
import { preparePluginDependencies, runPluginTask, runPnpm } from './run-plugin-task.mjs';
import { verifyBuildPackage } from './verify-package.mjs';

/** Write one manifest after archive validation; step wraps each synchronous task for progress display. */
export function packagePlugins(root, requested, output, packageDirectory, step = (_label, run) => run()) {
  const selected = sourcePlugins(root, requested, packageDirectory);
  const single = packageDirectory !== undefined;
  if (single && !existsSync(resolve(root, 'pnpm-lock.yaml'))) throw new Error('独立包打包需要包根 pnpm-lock.yaml。');
  if (existsSync(output) && readdirSync(output).length) throw new Error('发布目录必须不存在或为空；不会覆盖旧操作产物。');
  mkdirSync(output, { recursive: true });
  if (selected.length) step('安装插件依赖', () => runPnpm(['install', '--frozen-lockfile', ...(single ? ['--ignore-workspace'] : [])], root));
  preparePluginDependencies(root, selected, step);
  const plugins = [];
  for (const plugin of selected) {
    runPluginTask(root, plugin, 'check', step);
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
  const manifest = { schemaVersion: single ? 2 : 1, plugins };
  const temporary = resolve(output, 'manifest.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, resolve(output, 'manifest.json'));
  return manifest;
}

export function main(argv = process.argv.slice(2), step) {
  const options = parseOptions(argv, ['root', 'plugins', 'output', 'package']);
  if (!options.root) throw new Error('必须显式指定 --root 项目根目录。');
  const root = resolve(options.root);
  const output = resolve(root, options.output ?? `.local/artifacts/${randomUUID()}/plugins`);
  packagePlugins(root, options.plugins, output, options.package, step);
  console.log(`插件产物：${output}`);
}
