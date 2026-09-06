/** Resolve versioned per-plugin settings without importing business implementations. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicJSON, canonical, fail, hash } from './state.mjs';

/** Validate declaration shared by source discovery and archive consumption. */
export function validateConfiguration(value, label) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['entryId', 'auth'].includes(key))
    || typeof value.entryId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.entryId)
    || (value.auth !== undefined && !['provider', 'consumer'].includes(value.auth))) fail(`${label}: configuration 声明无效。`);
}

/** Resolve settings once; absence uses authenticated defaults, malformed files fail closed. */
export function resolvePluginSettings(deployment, candidates) {
  const files = {}, entries = [], plugins = [], entryIds = new Set();
  for (const plugin of candidates.plugins) {
    const spec = plugin.configuration;
    if (!spec) { plugins.push(plugin); continue; }
    validateConfiguration(spec, plugin.id);
    if (entryIds.has(spec.entryId)) fail(`重复配置入口：${spec.entryId}`);
    entryIds.add(spec.entryId);
    const file = canonical(resolve(deployment.root, deployment.instances[plugin.id]?.settingsFile ?? join(deployment.home, 'plugins', plugin.id, 'plugin.json')));
    let settings = {};
    if (existsSync(file)) {
      try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { fail(`${plugin.id}: plugin.json 不是有效 JSON。`); }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || settings.schemaVersion !== 1
        || Object.keys(settings).some(key => !['schemaVersion', 'enabled', 'accessMode', 'config'].includes(key))) fail(`${plugin.id}: plugin.json 字段或 schemaVersion 无效。`);
    }
    if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') fail(`${plugin.id}: enabled 必须是布尔值。`);
    if (settings.accessMode !== undefined && (spec.auth !== 'consumer' || !['authenticated', 'standalone'].includes(settings.accessMode))) fail(`${plugin.id}: accessMode 无效。`);
    const config = settings.config ?? {};
    if (!config || typeof config !== 'object' || Array.isArray(config) || ['accessMode', 'publicOrigin'].some(key => Object.hasOwn(config, key))) fail(`${plugin.id}: config 无效，accessMode 和 publicOrigin 由公共规范管理。`);
    files[plugin.id] = file;
    if (settings.enabled === false) continue;
    if (!plugin.healthPath) fail(`${plugin.id}: 标准配置插件必须声明 healthPath。`);
    plugins.push(plugin);
    const merged = { ...config };
    if (spec.auth === 'consumer') merged.accessMode = settings.accessMode ?? 'authenticated';
    if (spec.auth === 'provider' || merged.accessMode === 'authenticated') {
      const origin = deployment.config.publicOrigin ?? deployment.config.publicUrl;
      let url;
      try { url = new URL(origin); } catch { fail('认证需要部署配置 publicOrigin 或 publicUrl。'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin) fail('publicOrigin/publicUrl 必须是不带路径的 HTTP(S) origin。');
      merged.publicOrigin = origin;
    }
    entries.push({ id: spec.entryId, config: merged });
  }
  const providers = plugins.filter(plugin => plugin.configuration?.auth === 'provider');
  if (providers.length > 1) fail('只能启用一个认证提供者。');
  if (entries.some(entry => entry.config.accessMode === 'authenticated') && providers.length !== 1) fail('要求认证的插件必须同时启用一个认证提供者；拒绝自动降级匿名访问。');
  return { release: { ...candidates, plugins }, entries, files };
}

/** Keep generated patches immutable so a candidate cannot hot-edit a running host. */
export function applyPluginSettings(deployment, settings) {
  if (!settings.entries.length) return;
  const value = JSON.stringify(settings.entries);
  const file = join(deployment.dataRoot, '.deployment-private', `settings-${hash(value)}.patch.yml`);
  if (!existsSync(file)) atomicJSON(file, settings.entries);
  deployment.config = { ...deployment.config, patches: [...(deployment.config.patches ?? []), file] };
}
