/** Freeze declared configuration inputs; configuration semantics stay in their existing owners. */
import { existsSync, readFileSync, lstatSync, chownSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { hash, canonical, json, same, readArchive } from './state.mjs';
import { resolveDeployment, runtimeEnvironment } from './config.mjs';
import { resolvePluginSettings } from './plugin-settings.mjs';
import { prepareFrameworkCredentials, rememberFrameworkInput } from './framework-credentials.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './private-files.mjs';
import { fileHash } from './site-record.mjs';

/** Only new archive sites use config/; existing instances and explicit user paths are untouched. */
export function initializeArchiveSettings(root, site, release, { fresh }) {
  if (!fresh) return site;
  const instances = { ...(site.instances ?? {}) }, missing = [];
  for (const plugin of release.plugins) {
    const instance = { ...(instances[plugin.id] ?? {}) };
    const directory = resolve(root, '.local/config/plugins', plugin.id);
    if (plugin.configuration && !instance.settingsFile) {
      const file = join(directory, 'plugin.json');
      instance.settingsFile = file;
      if (!existsSync(file)) writePrivateFile(file, JSON.stringify({ schemaVersion: 1, enabled: true, ...(plugin.configuration.auth === 'consumer' ? { accessMode: 'authenticated' } : {}), config: {} }, null, 2) + '\n', { flag: 'wx' });
    }
    if (plugin.runtimeConfig && !instance.runtimeConfig) {
      const file = join(directory, 'env.conf'); instance.runtimeConfig = file;
      if (!existsSync(file) && plugin.runtimeConfig.required !== false) {
        const bytes = plugin.runtimeConfig.template ? readArchive(plugin.archivePath, ['-xzOf', '-', `package/${plugin.runtimeConfig.template}`]) : Buffer.from('# 按插件 README 填写业务参数。\n');
        writePrivateFile(file, bytes, { flag: 'wx' }); missing.push(`${plugin.id}：请填写 ${file}，然后重新运行 build。`);
      }
    }
    if (Object.keys(instance).length) instances[plugin.id] = instance;
  }
  return { site: { ...site, instances }, missing };
}

export function freezeSiteInputs({ root, operation, site, sitePath, source, release }) {
  const directory = ensurePrivateDirectory(resolve(operation, 'private-inputs')), inputs = [];
  const deployment = resolveDeployment({ root, config: sitePath, 'data-root': site.dataRoot, home: site.home, workspace: site.workspace, artifacts: site.artifacts, profile: site.profile }, {});
  deployment.config = { ...site }; deployment.instances = site.instances ?? {};
  if (source) rememberFrameworkInput(deployment, source);
  function snapshot(kind, path, id, defaults) {
    path = resolve(root, path);
    const existed = existsSync(path);
    if (existed && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error(`配置必须是普通文件：${path}`);
    const bytes = existed ? readFileSync(path) : defaults;
    const target = join(directory, `${inputs.length}-${kind}${kind === 'settings' ? '.json' : '.conf'}`);
    if (bytes !== undefined) {
      writePrivateFile(target, bytes, { flag: 'wx' });
      if (process.platform !== 'win32' && process.getuid?.() === 0) chownSync(target, site.containerUid, site.containerGid);
    }
    inputs.push({ kind, ...(id ? { id } : {}), source: path, existed, ...(bytes === undefined ? {} : { sha256: hash(bytes), path: target }), ...(!existed && defaults ? { defaulted: true } : {}) });
    return bytes === undefined ? path : target;
  }
  snapshot('site', sitePath);
  const settings = resolvePluginSettings(deployment, release);
  const runtime = runtimeEnvironment(deployment, settings.release.plugins), instances = { ...(site.instances ?? {}) };
  for (const plugin of release.plugins) {
    const instance = { ...(instances[plugin.id] ?? {}) };
    if (settings.files[plugin.id]) instance.settingsFile = snapshot('settings', settings.files[plugin.id], plugin.id,
      Buffer.from(JSON.stringify({ schemaVersion: 1, enabled: true, ...(plugin.configuration.auth === 'consumer' ? { accessMode: 'authenticated' } : {}) }) + '\n'));
    if (plugin.runtimeConfig) {
      const file = canonical(resolve(root, site.instances?.[plugin.id]?.runtimeConfig ?? join(deployment.home, 'plugins', plugin.id, 'env.conf')));
      instance.runtimeConfig = snapshot('runtime', file, plugin.id);
    }
    if (Object.keys(instance).length) instances[plugin.id] = instance;
  }
  const patches = (site.patches ?? []).map(path => snapshot('patch', resolve(root, path)));
  prepareFrameworkCredentials(deployment, { uid: site.containerUid, gid: site.containerGid }, { directory: join(directory, 'credentials') });
  if (deployment.config.frameworkCredentials) {
    const credentials = deployment.config.frameworkCredentials;
    if (!source) credentials.file = snapshot('credentials', resolve(root, credentials.file));
    else inputs.push({ kind: 'credential-projection', source: credentials.file, path: credentials.file, existed: true, sha256: credentials.sha256 });
  }
  const candidate = { ...site, instances, patches, ...(deployment.config.frameworkCredentials ? { frameworkCredentials: deployment.config.frameworkCredentials } : {}) };
  const environment = Object.fromEntries(['DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'DSH_PUBLIC_ORIGIN', 'DSH_PUBLIC_URL'].map(key => [key, hash(process.env[key] ?? '')]));
  return { candidate, inputs, environment, enabled: settings.release.plugins.map(plugin => plugin.id) };
}

/** Original bytes are required for resume; recover may change only business configuration. */
export function verifySiteInputs(record, { recover = false } = {}) {
  if (record.schemaVersion !== 3) return;
  for (const [key, expected] of Object.entries(record.inputEnvironment ?? {})) if (hash(process.env[key] ?? '') !== expected) throw new Error(`原固定环境 ${key} 已变化；请恢复后重试。`);
  for (const input of record.inputs) {
    if (input.path && fileHash(input.path) !== input.sha256) throw new Error(`私有输入快照已变化：${input.kind}。`);
    const exists = existsSync(input.source), actual = exists ? readFileSync(input.source) : undefined;
    const unchanged = input.existed ? exists && hash(actual) === input.sha256 : !exists || input.defaulted && hash(actual) === input.sha256;
    if (unchanged) continue;
    if (recover && input.kind === 'runtime' && exists) continue;
    if (recover && input.kind === 'settings' && exists) {
      const before = input.path ? json(input.path) : { schemaVersion: 1 }, after = JSON.parse(actual.toString('utf8'));
      const controls = value => ({ ...value, config: undefined, enabled: value.enabled ?? true, accessMode: value.accessMode ?? (before.accessMode === 'authenticated' ? 'authenticated' : undefined) });
      if (same(controls(before), controls(after))) continue;
      throw new Error(`${input.id}：recover 只允许修改 config，不能更改 enabled/accessMode。`);
    }
    throw new Error(`原受管输入已变化：${input.source}。恢复原文件使用 --resume；业务配置修正使用 --recover --data-compatible。`);
  }
}

/** Create only a recorded default after prepared; never overwrite an existing user file. */
export function materializeSiteDefaults(record) {
  for (const input of record.inputs ?? []) if (input.defaulted) {
    if (!existsSync(input.source)) writePrivateFile(input.source, readFileSync(input.path), { flag: 'wx' });
    if (fileHash(input.source) !== input.sha256) throw new Error(`初始化配置与冻结默认值不一致：${input.source}`);
  }
}
