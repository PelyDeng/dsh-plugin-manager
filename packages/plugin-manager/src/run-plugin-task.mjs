/** Run declared plugin tasks through the repository's package manager. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOptions, sourcePlugins } from './plugins.mjs';
import { runPnpm } from './pnpm.mjs';
export { runPnpm } from './pnpm.mjs';

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
    return manifest.devDependencies?.['@dsh-plugin-manager/plugin-kit']?.startsWith('workspace:');
  });
  if (needsKit) step('准备插件共享依赖', () => runPnpm(['--filter', '@dsh-plugin-manager/plugin-kit', 'build'], root));
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
