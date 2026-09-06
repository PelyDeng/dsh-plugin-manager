/** Build, check and package selected plugins without reading runtime configuration. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPlugins, parseOptions, selectPlugins } from './plugins.mjs';
import { preparePluginDependencies, runPluginTask, runPnpm } from './run-plugin-task.mjs';
import { verifyBuildPackage } from './verify-package.mjs';

/** Write one manifest only after every archive has passed validation. */
export function packagePlugins(root, requested, output) {
  const selected = selectPlugins(discoverPlugins(root), requested);
  if (existsSync(output) && readdirSync(output).length) throw new Error('发布目录必须不存在或为空；不会覆盖旧操作产物。');
  mkdirSync(output, { recursive: true });
  if (selected.length) runPnpm(['install', '--frozen-lockfile'], root);
  preparePluginDependencies(root, selected);
  const plugins = [];
  for (const plugin of selected) {
    runPluginTask(root, plugin, 'check');
    const destination = resolve(output, `${plugin.id}.tgz`);
    runPnpm(['pack', '--json', '--out', destination], resolve(root, plugin.directory), { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
    verifyBuildPackage(root, plugin, destination);
    const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
    // pnpm must see a new file spec when the same package version has new bytes.
    const archive = `${plugin.id}-${sha256}.tgz`;
    renameSync(destination, resolve(output, archive));
    plugins.push({ ...plugin, archive, sha256 });
    console.log(`[${plugin.id}] 发布包已验证：${archive}`);
  }
  const manifest = { schemaVersion: 1, plugins };
  const temporary = resolve(output, 'manifest.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, resolve(output, 'manifest.json'));
  return manifest;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv, ['root', 'plugins', 'output']);
  if (!options.root) throw new Error('必须显式指定 --root 项目根目录。');
  const root = resolve(options.root);
  const output = resolve(root, options.output ?? `.local/artifacts/${randomUUID()}/plugins`);
  packagePlugins(root, options.plugins, output);
  console.log(`插件产物：${output}`);
}
