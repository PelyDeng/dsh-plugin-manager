/** Remove only named build outputs of a managed plugin; never traverse a linked directory. */
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { discoverPlugins } from '../packages/plugin-manager/src/plugins.mjs';

const root = realpathSync(process.cwd());
const repositoryRoot = resolve(root, '../..');
if (!discoverPlugins(repositoryRoot).some(plugin => realpathSync(resolve(repositoryRoot, plugin.directory)) === root)) {
  throw new Error('清理命令必须在受管插件目录运行。');
}
const outputs = process.argv.slice(2);
const allowed = new Set(['dist', 'lib', 'web/assets', 'coverage']);
if (outputs.length === 0 || outputs.some(output => !allowed.has(output))) throw new Error('只能清理明确声明的构建产物目录。');
for (const output of outputs) {
  let current = root;
  for (const part of output.split('/')) {
    current = resolve(current, part);
    if (existsSync(current) && (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink())) {
      throw new Error(`拒绝清理非普通目录或链接：${output}。`);
    }
  }
}
for (const output of outputs) rmSync(resolve(root, output), { recursive: true, force: true });
