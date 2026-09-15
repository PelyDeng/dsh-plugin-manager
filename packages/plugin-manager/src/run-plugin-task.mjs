/** Run declared plugin tasks through the repository's package manager. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOptions, sourcePlugins } from './plugins.mjs';
import { diagnoseToolFailure } from './build-diagnostics.mjs';
import { runPnpm, runPnpmAsync, runPnpmCaptured } from './pnpm.mjs';
export { runPnpm } from './pnpm.mjs';

const TASK_LABELS = { build: '构建', check: '检查', clean: '清理' };
const tasks = action => (action === 'check' ? ['build', 'check'] : [action]);
const taskLabel = (task, plugin) => `${TASK_LABELS[task]}插件 ${plugin.id}`;
const taskArgs = (plugin, task) => [...(plugin.directory === undefined ? ['--ignore-workspace'] : []), 'run', task];

/**
 * 回放被捕获的构建输出，按插件加前缀。
 *
 * 并行构建时几个插件的输出会同时产生，原样写出会互相穿插；加了前缀，日志里每一行都能看出
 * 属于哪个插件，也不用为每个插件单独开日志文件。
 */
export function replayPluginOutput(id, { stdout = '', stderr = '' } = {}) {
  const prefix = `[${id}] `;
  for (const [text, write] of [[stdout, line => process.stdout.write(line)], [stderr, line => process.stderr.write(line)]]) {
    if (!text.trim()) continue;
    for (const line of text.split('\n')) if (line) write(`${prefix}${line}\n`);
  }
}

/** 失败时补上「已知形态 → 怎么办」的提示；没有命中就保持原样。 */
function withDiagnosis(id, error) {
  const hint = diagnoseToolFailure(`${error?.captured?.stdout ?? ''}\n${error?.captured?.stderr ?? ''}`);
  if (hint) process.stderr.write(`[${id}] 已知问题提示：\n${hint.split('\n').map(line => `[${id}] ${line}`).join('\n')}\n`);
  return error;
}

/** Execute build once before checks; step optionally wraps each synchronous task for progress display. */
export function runPluginTask(root, plugin, action, step = (_label, run) => run()) {
  for (const task of tasks(action)) {
    console.log(`[${plugin.id}] pnpm ${task}`);
    // 检查这一步输出少、但对报错的可读性要求最高：捕获后再回放，好在失败时补提示。
    // 构建与清理保持继承 stdio，长任务的过程输出不该被吞到最后一次性打印。
    if (task !== 'check') {
      step(taskLabel(task, plugin), () => runPnpm(taskArgs(plugin, task), resolve(root, plugin.directory ?? '.')));
      continue;
    }
    step(taskLabel(task, plugin), () => {
      try {
        const captured = runPnpmCaptured(taskArgs(plugin, task), resolve(root, plugin.directory ?? '.'));
        replayPluginOutput(plugin.id, captured);
      } catch (error) {
        replayPluginOutput(plugin.id, error.captured);
        throw withDiagnosis(plugin.id, error);
      }
    });
  }
}

/** 与 {@link runPluginTask} 同一条路径，但走异步进程，好让调用方并行调度多个插件。 */
export async function runPluginTaskAsync(root, plugin, action, step = (_label, run) => run()) {
  for (const task of tasks(action)) {
    console.log(`[${plugin.id}] pnpm ${task}`);
    await step(taskLabel(task, plugin), async () => {
      try {
        replayPluginOutput(plugin.id, await runPnpmAsync(taskArgs(plugin, task), resolve(root, plugin.directory ?? '.')));
      } catch (error) {
        // pnpm 层已经把捕获到的输出原样转发过，这里只补提示。
        throw withDiagnosis(plugin.id, error);
      }
    });
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

/** 各命令的用法：帮助不该要求先有项目根，所以放在解析参数之前。 */
export const USAGE = [
  'build  [--root <项目根>] [--plugins <ID列表>] [--external] [--package <独立包目录>]',
  'check  [--root <项目根>] [--plugins <ID列表>] [--external] [--package <独立包目录>]',
  'clean  [--root <项目根>] [--plugins <ID列表>] [--external]',
  'list   [--root <项目根>] [--plugins <ID列表>] [--external] [--package <独立包目录>]',
  'pack   [--root <项目根>] [--plugins <ID列表>] [--external] [--output <新目录>] [--concurrency <正整数>]',
  '',
  '默认发现并构建框架内置源码（plugins/builtin），省略 --plugins 表示全部；逗号分隔的 ID 列表要加引号，避免 PowerShell 拆成数组。',
  '--external 是作者对 plugins/external 私有源码的显式调用，必须显式给出选集（ID 列表、all 或 none），不透传给站点 build。',
  'pack 只构建、打包并做内容寻址；类型检查用 check，归档与源码一致性用 verify-package，交付目录合规用 verify-release。',
].join('\n');

export function main(argv = process.argv.slice(2)) {
  const [action, ...args] = argv;
  if (argv.includes('--help')) { console.log(USAGE); return; }
  if (!['build', 'check', 'clean', 'list'].includes(action)) throw new Error('任务必须是 build、check、clean 或 list。');
  const options = parseOptions(args, ['root', 'plugins', ...(action === 'clean' ? [] : ['package'])], ['external']);
  if (!options.root) throw new Error('必须显式指定 --root 项目根目录。');
  const root = resolve(options.root);
  // 发现范围由 --external 决定：内置命令未点名时构建全部 builtin；external 必须显式给出选集。
  // `--package .` 自带唯一插件，不能与选集同用。
  const scope = options.external ? 'external' : 'builtin';
  const defaults = options.package === undefined && (action === 'list' || scope === 'builtin');
  const requested = options.plugins ?? (defaults ? 'all' : undefined);
  if (options.external && requested === undefined) throw new Error('--external 必须显式给出插件选集：ID 列表、all 或 none。');
  const selected = sourcePlugins(root, requested, options.package, { source: scope });
  if (['build', 'check'].includes(action)) preparePluginDependencies(root, selected);
  for (const plugin of selected) {
    if (action === 'list') console.log(`${plugin.id}\t${plugin.package}`);
    else runPluginTask(root, plugin, action);
  }
}
