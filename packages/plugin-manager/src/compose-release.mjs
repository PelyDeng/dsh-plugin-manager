/** Assemble existing releases without source checkouts, dependency installation or builds. */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadRelease } from './release.mjs';
import { parseOptions } from './plugins.mjs';
import { hash, within } from './state.mjs';
import { mergeVerification } from './verification.mjs';

/** Validate all inputs before writing a new portable release; never choose conflict winners. */
export function composeRelease(manifests, output, previous, verificationReports = []) {
  if (!manifests.length) throw new Error('至少提供一个 --manifest。');
  const releases = manifests.map(path => loadRelease(path));
  return composeReleases(releases, output, previous && loadRelease(previous), verificationReports);
}

/**
 * 组合并复制归档。
 *
 * `output` 是本次操作的发布目录（manifest.json + 摘要命名 tgz）。`options.cacheRoot` 可选：给定
 * 时归档按**实际字节摘要**追加复制到缓存根（默认 `.local/artifacts/plugin-packages/`，普通部署
 * 不清理），并生成不可变的 `manifest-<随机>.json` 描述本次选集与缓存文件名——缓存不要求摘要等于
 * 作者声明或历史记录，只为避免缓存混淆并提供稳定 file: 引用。返回 `{ manifest, cacheManifest }`。
 */
export function composeReleases(releases, output, previous, verificationReports = [], { cacheRoot } = {}) {
  const plugins = releases.flatMap(release => release.plugins);
  const verification = mergeVerification(releases.map(release => release.verification), verificationReports, plugins);
  for (const field of ['id', 'package']) {
    const seen = new Set();
    for (const plugin of plugins) {
      if (seen.has(plugin[field])) throw new Error(`组合清单的 ${field} 重复：${plugin[field]}。请只保留一个版本。`);
      seen.add(plugin[field]);
    }
  }
  const variables = new Set();
  for (const plugin of plugins) for (const variable of [plugin.runtimeConfig?.variable, plugin.development?.rootVariable].filter(Boolean)) {
    if (variables.has(variable)) throw new Error(`组合清单的环境变量重复：${variable}。`);
    variables.add(variable);
  }
  const copies = new Map();
  function include(plugin, archive) {
    const target = resolve(output, archive);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (!within(output, target)) throw new Error(`归档目标路径越界：${archive}。`);
    if (['manifest.json', 'manifest.json.tmp'].some(name => {
      const reserved = resolve(output, name);
      const path = process.platform === 'win32' ? reserved.toLowerCase() : reserved;
      return key === path || key.startsWith(`${path}${sep}`);
    })) throw new Error(`归档占用发布清单保留路径：${archive}。`);
    for (const path of copies.keys()) if (path.startsWith(`${key}${sep}`) || key.startsWith(`${path}${sep}`)) {
      throw new Error(`归档目标文件与目录冲突：${archive}。`);
    }
    const existing = copies.get(key);
    if (existing && existing.sha256 !== plugin.sha256) throw new Error(`归档目标路径内容冲突：${archive}。`);
    copies.set(key, { target, source: plugin.archivePath, sha256: plugin.sha256 });
  }
  if (previous) for (const plugin of previous.plugins) include(plugin, plugin.archive);
  const manifest = { schemaVersion: 2, verification, plugins: plugins.map(({ directory, archivePath, ...plugin }) => {
    const archive = `${plugin.id}-${plugin.sha256}.tgz`;
    include({ ...plugin, archivePath }, archive);
    return { ...plugin, archive };
  }) };
  if (existsSync(output) && readdirSync(output).length) throw new Error('发布目录必须不存在或为空；不会覆盖旧操作产物。');
  mkdirSync(output, { recursive: true });
  for (const { target, source, sha256 } of copies.values()) {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    if (hash(readFileSync(target)) !== sha256) throw new Error('复制后的归档摘要与发布清单不一致。');
  }
  const temporary = resolve(output, 'manifest.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, resolve(output, 'manifest.json'));
  let cacheManifest;
  if (cacheRoot) {
    mkdirSync(cacheRoot, { recursive: true });
    for (const { target, source, sha256 } of copies.values()) {
      const cached = resolve(cacheRoot, target.split(/[\\/]/u).at(-1));
      if (!existsSync(cached)) cpSync(source, cached);
      if (hash(readFileSync(cached)) !== sha256) throw new Error(`归档缓存摘要不符：${target.split(/[\\/]/u).at(-1)}。`);
    }
    cacheManifest = `manifest-${randomUUID()}.json`;
    // 缓存清单是**容器内部署读路径**的输入（PLUGIN_MANIFEST_FILE → loadReleaseInputs）：必须携带
    // 完整安装契约（verifyFiles、入口、运行配置等），不能只留寻址字段，否则容器一启动就拒绝。
    // 归档名相对缓存根，与 manifest.json 同名同布局。
    writeFileSync(resolve(cacheRoot, cacheManifest), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { manifest, ...(cacheManifest ? { cacheManifest } : {}) };
}

export function main(args = process.argv.slice(2)) {
  const paths = [], reports = [], rest = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--manifest' && args[i + 1] && !args[i + 1].startsWith('--')) paths.push(args[i + 1]);
    else if (args[i] === '--verification-report' && args[i + 1] && !args[i + 1].startsWith('--')) reports.push(args[i + 1]);
    else rest.push(args[i], args[i + 1]);
  }
  const options = parseOptions(rest, ['root', 'output', 'previous']);
  if (!options.root || !options.output) throw new Error('compose-release 需要 --root 和 --output。');
  const root = resolve(options.root), output = resolve(root, options.output);
  composeRelease(paths.map(path => resolve(root, path)), output, options.previous && resolve(root, options.previous), reports.map(path => resolve(root, path)));
  console.log(`组合发布清单：${resolve(output, 'manifest.json')}`);
}
