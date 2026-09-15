/**
 * 私有集成环节：把公共框架的根构建元数据逐字节交付到本仓库的 `tools/builtin-build/`。
 *
 * 交付纪律（设计 2.8）：三个文件（package.json / pnpm-workspace.yaml / pnpm-lock.yaml）必须来自
 * **同一份公共框架输入**——一个公共检出或解包后的公共发行目录；这里不读私有 workspace、不生成、
 * 不裁剪。源码入口在站点侧按字节使用交付物：材料缺失、版本不匹配或含私有 workspace 痕迹时直接失败。
 *
 * 用法（在私有集成工作区、合并上游之后执行）：
 *   node private-deploy/deliver-public-inputs.mjs --source <公共检出或发行目录> [--allow-dirty]
 *
 * 交付物：`tools/builtin-build/{package.json,pnpm-workspace.yaml,pnpm-lock.yaml}` 与一份
 * `input.json`（框架版本、来源提交、三个文件的摘要、换行规则）。三件套按 Git 规范形式（LF）落盘并
 * 记录 LF 摘要：Windows 检出的工作区是 CRLF，按工作区字节记摘要会在提交或换机器后不一致。集成提交
 * 后，服务器按 Gitee 集成版本取得这些文件，不需要访问任何本地公共仓库。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicInputFiles, PUBLIC_INPUT_NEWLINE, normalizeNewlines, verifyPublicInputRecord, writePublicInputRecord } from '../packages/plugin-manager/src/public-build-view.mjs';

export const INPUT_DIRECTORY = 'tools/builtin-build';
/** 交付的换行规则：三件套按 Git 规范形式（LF）落盘并记录摘要（与站点侧共用同一实现）。 */
export const NEWLINE = PUBLIC_INPUT_NEWLINE;

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

/** 公共输入里的元数据目录与版本来源：公共检出用根文件，解包发行目录用 source/ 与 tools/builtin-build/。 */
export function locatePublicInput(source) {
  const bundled = resolve(source, INPUT_DIRECTORY);
  const directory = existsSync(resolve(bundled, 'package.json')) ? bundled : source;
  const manifestPath = existsSync(resolve(directory, 'package.json')) ? resolve(directory, 'package.json') : resolve(source, 'source/package.json');
  if (!existsSync(manifestPath)) throw new Error(`公共输入缺少 package.json：${source}；请指向公共检出或解包后的公共发行目录。`);
  for (const name of publicInputFiles) if (!existsSync(resolve(directory, name))) throw new Error(`公共输入不完整：${resolve(directory, name)}`);
  return { directory, manifestPath };
}

/** 公共输入必须是公共框架材料：私有集成树（含 plugins/external）不是那一份输入。 */
function assertPublicSource(source) {
  if (existsSync(resolve(source, 'plugins/external'))) throw new Error(`公共输入含 plugins/external，不是公共框架输入：${source}；请指向公共检出或解包后的公共发行目录。`);
  if (!statSync(source).isDirectory()) throw new Error(`公共输入必须是目录：${source}`);
}

/** 来源提交与「交付的字节是否与提交一致」：检出可用 Git 时记录，发行目录只记录摘要。 */
function describeSource(source, directory, files) {
  if (!existsSync(resolve(source, '.git'))) return { sourceKind: 'release', sourceCommit: null, sourceModified: null };
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true }).trim();
  const commit = git('rev-parse', 'HEAD');
  const modified = Object.keys(files).filter(name => {
    const relative = resolve(directory, name).slice(resolve(source).length + 1).split('\\').join('/');
    return git('status', '--porcelain', '--', relative) !== '';
  });
  return { sourceKind: 'checkout', sourceCommit: commit, sourceModified: modified };
}

export function deliverPublicInputs({ root, source, allowDirty = false } = {}) {
  if (!root || !source) throw new Error('用法：node private-deploy/deliver-public-inputs.mjs --source <公共检出或发行目录> [--allow-dirty]');
  root = resolve(root);
  source = resolve(source);
  if (!existsSync(source)) throw new Error(`公共输入不存在：${source}`);
  assertPublicSource(source);
  const { directory, manifestPath } = locatePublicInput(source);
  const expected = readJson(resolve(root, 'package.json')).version;
  const delivered = readJson(manifestPath).version;
  if (typeof delivered !== 'string' || delivered !== expected) throw new Error(`公共输入版本（${delivered ?? '(缺失)'}）与本仓库框架版本（${expected}）不一致；先完成公共框架集成再交付。`);
  const files = Object.fromEntries(publicInputFiles.map(name => [name, normalizeNewlines(readFileSync(resolve(directory, name)))]));
  const description = describeSource(source, directory, files);
  if (description.sourceModified?.length && !allowDirty) {
    throw new Error(`公共输入的这些文件与 ${description.sourceCommit?.slice(0, 12)} 的记录不同（工作区已修改）：${description.sourceModified.join(', ')}；请在公共框架提交后再交付，或显式加 --allow-dirty 并知悉这一差异。`);
  }
  const target = resolve(root, INPUT_DIRECTORY);
  mkdirSync(target, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    // 不用 cpSync 覆盖：Windows 上覆盖已存在文件遇到非 ASCII 路径会失败（libuv 扩展路径怪癖）。
    writeFileSync(resolve(target, name), bytes);
  }
  // 记录格式只有一份实现（公共模块的 writePublicInputRecord）：发行包与集成交付写的必须是同一种记录。
  return writePublicInputRecord(target, { version: expected, sourceKind: description.sourceKind, sourceCommit: description.sourceCommit,
    sourceModified: description.sourceModified, deliveredAt: new Date().toISOString() });
}

/**
 * 私有门禁的入口：复用公共模块里的交付摘要校验（站点侧同一实现），只多一句「怎么补交付」的提示。
 */
export function verifyDeliveredInputs(root) {
  root = resolve(root);
  try { return verifyPublicInputRecord(root, resolve(root, INPUT_DIRECTORY)); }
  catch (error) {
    if (/缺少交付记录/u.test(error.message)) throw new Error(`${error.message}；运行 node private-deploy/deliver-public-inputs.mjs --source <公共检出或发行目录>`);
    throw error;
  }
}

export function main(args = process.argv.slice(2)) {
  const options = { allowDirty: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--allow-dirty') { options.allowDirty = true; continue; }
    if (['--root', '--source'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--')) { options[args[index].slice(2)] = args[++index]; continue; }
    throw new Error(`未知参数：${args[index]}。用法：node private-deploy/deliver-public-inputs.mjs --source <公共检出或发行目录> [--root <仓库根>] [--allow-dirty]`);
  }
  const root = options.root ? resolve(options.root) : fileURLToPath(new URL('../', import.meta.url));
  const record = deliverPublicInputs({ root, source: options.source, allowDirty: options.allowDirty });
  console.log(JSON.stringify(record, null, 2));
  if (record.sourceModified?.length) console.warn(`注意：交付的元数据与提交 ${record.sourceCommit?.slice(0, 12)} 的记录不同（${record.sourceModified.join(', ')}）；已记入 ${INPUT_DIRECTORY}/input.json。`);
  console.log(`已交付公开构建元数据：${resolve(root, INPUT_DIRECTORY)}；随集成提交后，服务器无需访问公共仓库。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
