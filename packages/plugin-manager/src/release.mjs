import { inspectArchiveIdentity, verifyPackage } from './verify-package.mjs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { digestPattern, environmentName, fail, hash, idPattern, json, packageName, same, within } from './state.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { validateConfiguration } from './plugin-settings.mjs';
import { selectVerification, validateVerification } from './verification.mjs';
/** Validate a public release manifest and its exact tarballs before profile writes. */
const pluginDirectory = /^plugins\/(?:builtin|external)\/[a-zA-Z0-9][a-zA-Z0-9._-]*$|^plugins\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
export function loadRelease(manifestPath) {
  const path = resolve(manifestPath);
  const manifest = json(path);
  if (![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.plugins)) fail('插件发布清单格式无效。');
  const ids = new Set(); const names = new Set();
  const plugins = manifest.plugins.map(plugin => {
    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.package !== 'string' || typeof plugin.version !== 'string' || !idPattern.test(plugin.id) || !packageName.test(plugin.package) || ids.has(plugin.id) || names.has(plugin.package)) fail('发布清单包含无效或重复插件。');
    ids.add(plugin.id); names.add(plugin.package);
    if (typeof plugin.archive !== 'string' || isAbsolute(plugin.archive) || !within(dirname(path), resolve(dirname(path), plugin.archive))) fail(`插件 ${plugin.id} 产物路径越界。`);
    const archive = resolve(dirname(path), plugin.archive);
    const sha256 = hash(readFileSync(archive));
    if (!digestPattern.test(plugin.sha256) || sha256 !== plugin.sha256) fail(`插件 ${plugin.id} 包摘要不匹配。`);
    if (!Array.isArray(plugin.verifyFiles) || plugin.verifyFiles.some(file => typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).includes('..'))) fail('verifyFiles 无效。');
    if (manifest.schemaVersion === 1) {
      // 插件源码按 plugins/builtin|external 分区；旧扁平布局（plugins/<目录>）仍按原样接受。
      if (typeof plugin.directory !== 'string' || !pluginDirectory.test(plugin.directory)) fail('插件源码目录必须位于 plugins/ 下一级，或在 plugins/builtin|external/ 下一级。');
    } else if (Object.keys(plugin).some(key => !['id', 'package', 'version', 'displayName', 'description', 'entryPath', 'permissions', 'category', 'defaultEnabled', 'runtimeConfig', 'configuration', 'development', 'healthPath', 'verifyFiles', 'archive', 'sha256'].includes(key))) {
      fail('发布清单 2 不接受源码目录或未知字段。');
    }
    if (plugin.healthPath !== undefined && (typeof plugin.healthPath !== 'string' || !/^\/[a-zA-Z0-9_~./-]*$/.test(plugin.healthPath) || plugin.healthPath.startsWith('//') || plugin.healthPath.split('/').includes('..'))) fail('healthPath 无效。');
    if (plugin.runtimeConfig && (!environmentName(plugin.runtimeConfig.variable) || (plugin.runtimeConfig.required !== undefined && typeof plugin.runtimeConfig.required !== 'boolean'))) fail('runtimeConfig 无效。');
    if (plugin.development && (!environmentName(plugin.development.rootVariable) || typeof plugin.development.patch !== 'string' || isAbsolute(plugin.development.patch) || plugin.development.patch.split(/[\\/]/).includes('..'))) fail('development 无效。');
    // 摘要刚核对过，交给核验：同一份归档在同一次发布里会被核验多遍，这样只解包一次。
    const packed = verifyPackage(plugin, archive, { sha256 });
    validateConfiguration(plugin.configuration, plugin.id);
    if (!same(plugin.configuration, packed.deepseekPlugin?.configuration)) fail(`${plugin.id}: configuration 与包内声明不一致。`);
    const packedRuntime = packed.deepseekPlugin?.runtimeConfig;
    if (packed.name !== plugin.package || packed.version !== plugin.version || packed.deepseekPlugin?.id !== plugin.id || !same(packedRuntime && { ...packedRuntime, required: packedRuntime.required ?? true }, plugin.runtimeConfig) || !same(packed.deepseekPlugin?.development, plugin.development)) fail(`${plugin.id}: 清单与包内元数据不一致。`);
    const mandatory = ['package.json', packed.main, packed.dsh?.bundle?.patch, packedRuntime?.template, ...(packed.deepseekPlugin?.verifyFiles ?? [])].filter(Boolean).map(file => file.replace(/^\.\//, ''));
    if (mandatory.some(file => !plugin.verifyFiles.includes(file)) || plugin.healthPath !== packed.deepseekPlugin?.healthPath) fail(`${plugin.id}: 清单省略或改变了包内验证声明。`);
    return { ...plugin, archivePath: archive };
  });
  const verification = validateVerification(manifest.verification, plugins);
  return { path, schemaVersion: manifest.schemaVersion, plugins, ...(verification ? { verification } : {}) };
}

/**
 * 部署读路径：只做实际操作需要的输入边界检查。
 *
 * 与 `loadRelease` 的分工（设计 4.1）：完整清单约定、verifyFiles 完备性、归档结构、exports 与
 * 包内元数据一致性属于**交付侧**合规，由 `verify-release` 独立执行，部署不据此准入。部署只需要
 * 能安全地操作本次输入：清单可解析、身份唯一、产物路径不越界、归档成员名不越界、verifyFiles
 * 形状合法，并且**实际包名与版本来自归档本身**——作者误写 package 字段会让官方 CLI 覆盖另一个
 * 非受管包，这是操作边界而不是合规检查。
 *
 * 摘要只认归档实际字节：作者清单里的 sha256 写错不阻断安装，内部寻址、记录与提示统一用真实摘要。
 * 宿主验证记录只作提示，结构不合规时按「没有记录」处理，同样不阻断安装。
 */
export function loadReleaseInputs(manifestPath) {
  const path = resolve(manifestPath);
  const manifest = json(path);
  if (![1, 2].includes(manifest.schemaVersion) || !Array.isArray(manifest.plugins)) fail('插件发布清单格式无效。');
  const ids = new Set(); const names = new Set();
  const plugins = manifest.plugins.map(plugin => {
    if (!plugin || typeof plugin.id !== 'string' || typeof plugin.package !== 'string' || typeof plugin.version !== 'string' || !idPattern.test(plugin.id) || !packageName.test(plugin.package) || ids.has(plugin.id) || names.has(plugin.package)) fail('发布清单包含无效或重复插件。');
    ids.add(plugin.id); names.add(plugin.package);
    if (typeof plugin.archive !== 'string' || isAbsolute(plugin.archive) || !within(dirname(path), resolve(dirname(path), plugin.archive))) fail(`插件 ${plugin.id} 产物路径越界。`);
    if (!Array.isArray(plugin.verifyFiles) || plugin.verifyFiles.some(file => typeof file !== 'string' || isAbsolute(file) || file.split(/[\\/]/).includes('..'))) fail('verifyFiles 无效。');
    // 源码目录只做形状与越界检查：schema 2 不该带它，schema 1 的旧扁平布局仍接受。
    if (plugin.directory !== undefined && (typeof plugin.directory !== 'string' || !pluginDirectory.test(plugin.directory))) fail('插件源码目录必须位于 plugins/ 下一级，或在 plugins/builtin|external/ 下一级。');
    const archive = resolve(dirname(path), plugin.archive);
    if (!existsSync(archive)) fail(`插件 ${plugin.id} 的产物不存在：${plugin.archive}。`);
    const packed = inspectArchiveIdentity(archive);
    if (packed.name !== plugin.package || packed.version !== plugin.version) fail(`${plugin.id}: 清单声明的包名或版本与归档实际内容不一致。`);
    return { ...plugin, sha256: hash(readFileSync(archive)), archivePath: archive };
  });
  let verification;
  // 记录损坏不该把一次可安装的发布挡在门外；这里只把能读懂的记录带上，其余按无记录处理。
  try { verification = validateVerification(manifest.verification, plugins); } catch { verification = undefined; }
  return { path, schemaVersion: manifest.schemaVersion, plugins, ...(verification ? { verification } : {}) };
}

/** Reject source-mode requests for archive-only releases before changing deployment state. */
export function assertReleaseMode(release, mode) {
  if (release.schemaVersion === 2 && mode === 'development') fail('发布清单 2 仅支持 release 模式，不提供源码目录。');
}

/** A published release can install a subset without rebuilding or a source checkout. */
export function selectRelease(release, requested) {
  if (requested === undefined || requested === 'all') return release;
  const ids = Array.isArray(requested) ? requested : requested === 'none' ? [] : typeof requested === 'string' ? requested.split(',') : fail('插件选集必须是 ID 列表。');
  if (new Set(ids).size !== ids.length) fail('插件选集重复。');
  const plugins = ids.map(id => {
    const plugin = release.plugins.find(item => item.id === id);
    if (!plugin) fail(`发布清单未声明插件 ${id}。`);
    return plugin;
  });
  return { ...release, plugins, ...(release.verification ? { verification: selectVerification(release.verification, plugins) } : {}) };
}
