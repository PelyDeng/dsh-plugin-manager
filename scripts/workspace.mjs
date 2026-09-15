/** Build shared packages and run the explicitly selected plugin tasks. */
import { fileURLToPath } from 'node:url';
import { USAGE, main, runPnpm } from '../packages/plugin-manager/src/run-plugin-task.mjs';
import { parseOptions, sourcePlugins } from '../packages/plugin-manager/src/plugins.mjs';
import { frameworkVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [action, ...args] = process.argv.slice(2);
try {
  // 帮助先于任何校验与构建（设计 7.4 第 2 项）：参数解析会拒绝 --help，而看用法不该先跑一次构建。
  if (action === '--help' || args.includes('--help')) console.log(USAGE);
  else {
    frameworkVersion(root);
    if (!['build', 'check'].includes(action)) throw new Error('任务必须是 build 或 check。');
    // 选集核验必须在安装依赖、构建共享包与写任何输出之前完成（设计 7.4 第 2 项、4.4.1）：
    // 只看「参数名是否存在」会让 `build --external --plugins`（缺值）先跑完一次共享包构建才报错，
    // 所以这里复用与任务入口同一份参数解析与选集发现。
    const options = parseOptions(args, ['root', 'plugins', 'package'], ['external']);
    const scope = options.external ? 'external' : 'builtin';
    const requested = options.plugins ?? (options.package === undefined && scope === 'builtin' ? 'all' : undefined);
    if (scope === 'external' && requested === undefined) throw new Error('--external 必须显式给出插件选集：ID 列表、all 或 none。');
    sourcePlugins(root, requested, options.package, { source: scope });
    if (requested !== undefined && options.plugins === undefined) args.push('--plugins', requested);
    runPnpm(['--filter', '@dsh-plugin-manager/plugin-manager', 'build'], root);
    if (action === 'check') runPnpm(['--filter', '@dsh-plugin-manager/plugin-kit', 'check'], root);
    await main([action, ...args, '--root', root]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
