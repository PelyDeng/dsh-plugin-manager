/**
 * 语法门禁：枚举目标目录（缺省 `web`）下全部顶层 .js 并逐个 `node --check`。
 *
 * 旧写法 `node --check web/*.js` 依赖 shell 展开 glob，Windows 的 cmd/PowerShell 不展开、
 * CI 的 windows-latest 矩阵会直接把字面量 `web/*.js` 传给 node，门禁形同虚设。这里由 Node
 * 自己枚举目录，逐个文件显式调用 `node --check`，行为在三类 shell 上一致；新增 .js 文件
 * 自动纳入门禁，不再需要逐个追加到 package.json。
 *
 * closedoff 与 blog 的 check:web 都经相对路径调用本脚本（群组内共享一份实现）；
 * 只检查顶层：共享复制的页面脚本都在 `web/` 根上，子目录只放字体、图片等静态媒体。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const target = process.argv[2] ?? 'web';
const directory = resolve(target);
const files = readdirSync(directory).filter(name => name.endsWith('.js')).sort();
if (!files.length) {
  console.error(`check-web：${directory} 下没有可检查的 .js 文件；门禁目录为空通常是配置错误。`);
  process.exit(1);
}
let failed = 0;
for (const name of files) {
  const path = join(directory, name);
  if (!statSync(path).isFile()) continue;
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'pipe', windowsHide: true });
  if (result.status !== 0 || result.error) {
    failed++;
    process.stderr.write(`[check-web] ${name}\n${result.stderr?.toString() || result.error?.message || ''}\n`);
  }
}
if (failed) {
  console.error(`check-web：${failed}/${files.length} 个文件语法检查未通过。`);
  process.exit(1);
}
console.log(`check-web：${files.length} 个文件语法检查通过。`);
