/**
 * 清理 manager 包自身的构建产物（dist/coverage）。
 *
 * 不清理任何运行数据：`.local/data`、`.local/artifacts` 与备份是站点现场与回滚证据，
 * 由部署流程管理，clean 永不触碰（AGENTS.md 约束）。manager 也不是受管插件目录，
 * 不能复用仓库根的 clean-plugin.mjs（那里按插件发现校验目录归属）。
 */
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
for (const output of ['dist', 'coverage']) {
  const path = resolve(packageRoot, output);
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error(`拒绝清理非普通目录：${output}`);
  rmSync(path, { recursive: true, force: true });
}
console.log('plugin-manager：已清理 dist 与 coverage（不触 .local 数据与备份）。');
