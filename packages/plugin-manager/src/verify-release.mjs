/**
 * 独立校验完整发布目录：只读、可进 CI、不接触任何部署状态。
 *
 * 产物合规是**构建侧**的事，不该在部署时才发现。`loadRelease` 已经实现了全部静态校验
 * （清单格式、产物路径越界、包摘要、包结构与入口、清单与包内元数据一致），本命令把它从
 * 部署链里拿出来独立成一条入口：作者或 CI 先跑它，部署侧只做部署。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRelease } from './release.mjs';

const SKIP = new Set(['node_modules', '.git', '.local']);

/** 找一个发布目录里的清单：优先目录根，其次向下找有限层数，避免遍历整棵交付树。 */
export function findManifest(directory, depth = 3) {
  const root = resolve(directory);
  const direct = resolve(root, 'manifest.json');
  if (existsSync(direct)) return direct;
  for (const name of readdirSync(root).sort()) {
    if (SKIP.has(name)) continue;
    const child = resolve(root, name);
    if (!statSync(child).isDirectory()) continue;
    const found = depth > 1 ? findManifest(child, depth - 1) : (existsSync(resolve(child, 'manifest.json')) ? resolve(child, 'manifest.json') : null);
    if (found) return found;
  }
  return null;
}

/**
 * 校验单个清单。返回结构化结论而不是直接抛错，便于一次报告多个发布目录。
 * 摘要是内容寻址的：它同时证明了"归档没被换过"与"同一份字节只核验一次"。
 */
export function verifyRelease(manifestPath) {
  const path = resolve(manifestPath);
  let release;
  try { release = loadRelease(path); }
  catch (error) { return { ok: false, manifest: path, error: error.message }; }
  return {
    ok: true,
    manifest: path,
    schemaVersion: release.schemaVersion,
    plugins: release.plugins.map(plugin => ({
      id: plugin.id,
      package: plugin.package,
      version: plugin.version,
      archive: relative(resolve(path, '..'), plugin.archivePath).split(sep).join('/'),
      sha256: plugin.sha256,
      healthPath: plugin.healthPath ?? null,
    })),
    verification: release.verification ? release.verification.runs?.length ?? 0 : 0,
  };
}

/** 收集待校验目录：显式给出的每个 --release 都展开成它自己的清单。 */
export function collectManifests(directories) {
  const manifests = [], missing = [];
  for (const directory of directories) {
    if (!existsSync(directory)) { missing.push(directory); continue; }
    const manifest = findManifest(directory);
    if (manifest) manifests.push(manifest); else missing.push(directory);
  }
  return { manifests, missing };
}

export function formatReport(results) {
  const lines = [];
  for (const result of results) {
    if (!result.ok) { lines.push(`不合规：${result.manifest}\n  ${result.error}`); continue; }
    lines.push(`合规：${result.manifest}（清单 schema ${result.schemaVersion}，${result.plugins.length} 个插件）`);
    for (const plugin of result.plugins) lines.push(`  ${plugin.id} ${plugin.version} ← ${plugin.archive}（摘要 ${plugin.sha256.slice(0, 12)}）`);
  }
  const failed = results.filter(result => !result.ok).length;
  lines.push(failed ? `结论：${results.length} 个发布目录中 ${failed} 个不合规。` : `结论：${results.length} 个发布目录全部合规。`);
  return lines.join('\n');
}

export function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || !args.length) {
    console.log('verify-release：只读校验完整发布目录（清单格式、产物摘要、包结构与元数据一致性）。\n用法：verify-release --release <发布目录> [--release <发布目录> ...]\n它不接触部署状态，可在 CI 或交付前独立运行。');
    return args.includes('--help') ? 0 : 1;
  }
  const directories = [];
  // --release 可重复；parseOptions 只接受一次，因此先自行收集。
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--release') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--release 需要目录参数。');
      directories.push(value); index += 1;
    }
  }
  if (!directories.length) throw new Error('用法：verify-release --release <发布目录> [--release <发布目录> ...]');
  const { manifests, missing } = collectManifests(directories);
  if (missing.length) throw new Error(`发布目录不存在或其中没有 manifest.json：${missing.join('、')}`);
  const results = manifests.map(verifyRelease);
  console.log(formatReport(results));
  return results.every(result => result.ok) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
