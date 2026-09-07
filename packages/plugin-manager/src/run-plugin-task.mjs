/** Run declared plugin tasks through the repository's package manager. */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { parseOptions, sourcePlugins } from './plugins.mjs';

/** Run pnpm without a command shell; forward captured diagnostics only on failure. */
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
  if (result.error || result.status !== 0) {
    if (result.stdout?.length) process.stdout.write(result.stdout);
    if (result.stderr?.length) process.stderr.write(result.stderr);
    throw result.error ?? new Error(`pnpm ${args[0]} 失败，退出码 ${result.status ?? result.signal}。`);
  }
  return result;
}

/** Execute build once before checks; step optionally wraps each synchronous task for progress display. */
export function runPluginTask(root, plugin, action, step = (_label, run) => run()) {
  for (const task of action === 'check' ? ['build', 'check'] : [action]) {
    console.log(`[${plugin.id}] pnpm ${task}`);
    step(`${({ build: '构建', check: '检查', clean: '清理' })[task]}插件 ${plugin.id}`, () =>
      runPnpm([...(plugin.directory === undefined ? ['--ignore-workspace'] : []), 'run', task], resolve(root, plugin.directory ?? '.')));
  }
}

/** Build the local kit once when selected plugin sources declare it as a workspace dependency. */
export function preparePluginDependencies(root, plugins, step = (_label, run) => run()) {
  const needsKit = plugins.some(plugin => {
    if (plugin.directory === undefined) return false;
    const manifest = JSON.parse(readFileSync(resolve(root, plugin.directory, 'package.json'), 'utf8'));
    return manifest.devDependencies?.['@dsh-plugin/plugin-kit']?.startsWith('workspace:');
  });
  if (needsKit) step('准备插件共享依赖', () => runPnpm(['--filter', '@dsh-plugin/plugin-kit', 'build'], root));
}

export function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (!['build', 'check', 'clean', 'list'].includes(action)) throw new Error('任务必须是 build、check、clean 或 list。');
  const options = parseOptions(args, ['root', 'plugins', ...(action === 'clean' ? [] : ['package'])]);
  if (!options.root) throw new Error('必须显式指定 --root 项目根目录。');
  const root = resolve(options.root);
  const requested = action === 'list' && options.plugins === undefined && options.package === undefined ? 'all' : options.plugins;
  const selected = sourcePlugins(root, requested, options.package);
  if (['build', 'check'].includes(action)) preparePluginDependencies(root, selected);
  for (const plugin of selected) {
    if (action === 'list') console.log(`${plugin.id}\t${plugin.package}\tdefault=${plugin.defaultEnabled}`);
    else runPluginTask(root, plugin, action);
  }
}
