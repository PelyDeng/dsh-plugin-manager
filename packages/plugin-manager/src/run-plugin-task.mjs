/** Run declared plugin tasks through the repository's package manager. */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverPlugins, parseOptions, selectPlugins } from './plugins.mjs';

/** Run pnpm without passing repository paths or metadata through a command shell. */
export function runPnpm(args, cwd, options = {}) {
  let command = 'pnpm';
  let prefix = [];
  if (process.platform === 'win32') {
    const candidates = [process.env.npm_execpath, ...(process.env.PATH ?? '').split(delimiter).flatMap(directory => [
      resolve(directory, 'node_modules/corepack/dist/pnpm.js'),
      resolve(directory, 'node_modules/pnpm/bin/pnpm.cjs'),
      resolve(directory, 'pnpm.cjs'),
    ])];
    const cli = candidates.find(candidate => candidate && /pnpm\.(?:c?js)$/u.test(candidate) && existsSync(candidate));
    if (!cli) throw new Error('找不到 pnpm JavaScript 入口；请安装 pnpm/Corepack 或通过 pnpm 运行本命令。');
    command = process.execPath;
    prefix = [cli];
  }
  const result = spawnSync(command, [...prefix, ...args], { cwd, stdio: 'inherit', ...options, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args[0]} 失败，退出码 ${result.status ?? result.signal}。`);
  return result;
}

/** Execute build once before checks; pack callers consume the same checked output. */
export function runPluginTask(root, plugin, action) {
  for (const task of action === 'check' ? ['build', 'check'] : [action]) {
    console.log(`[${plugin.id}] pnpm ${task}`);
    runPnpm(['run', task], resolve(root, plugin.directory));
  }
}

/** Build the local kit once when selected plugin sources declare it as a workspace dependency. */
export function preparePluginDependencies(root, plugins) {
  const needsKit = plugins.some(plugin => {
    const manifest = JSON.parse(readFileSync(resolve(root, plugin.directory, 'package.json'), 'utf8'));
    return manifest.devDependencies?.['@dsh-plugin/plugin-kit']?.startsWith('workspace:');
  });
  if (needsKit) runPnpm(['--filter', '@dsh-plugin/plugin-kit', 'build'], root);
}

export function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (!['build', 'check', 'clean', 'list'].includes(action)) throw new Error('任务必须是 build、check、clean 或 list。');
  const options = parseOptions(args, ['root', 'plugins']);
  if (!options.root) throw new Error('必须显式指定 --root 项目根目录。');
  const root = resolve(options.root);
  const plugins = discoverPlugins(root);
  const selected = action === 'list' && options.plugins === undefined ? plugins : selectPlugins(plugins, options.plugins);
  if (['build', 'check'].includes(action)) preparePluginDependencies(root, selected);
  for (const plugin of selected) {
    if (action === 'list') console.log(`${plugin.id}\t${plugin.package}\tdefault=${plugin.defaultEnabled}`);
    else runPluginTask(root, plugin, action);
  }
}
