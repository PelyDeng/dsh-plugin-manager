/** Freeze declared configuration inputs; configuration semantics stay in their existing owners. */
import { existsSync, readFileSync, lstatSync, chownSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { hash, canonical, within, readArchive } from './state.mjs';
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

/**
 * 把站点配置里的插件业务配置（`DSH_PLUGIN_CONFIG`）派生为各插件的运行配置文件。
 *
 * 站点配置是插件业务参数**唯一**的人工维护处：运行配置文件只是它的机械投影，不需要单独维护，
 * 也不需要在部署机上手工创建。部署机因此可以只靠站点配置收敛，不再依赖现场已有的运行文件。
 *
 * 目标路径与 `runtimeEnvironment` 的解析规则一致（实例显式引用优先，否则数据根下的插件目录），
 * 于是派生结果同时满足两条既有读取路径：DSH 按 `runtimeConfig` 挂载给容器，插件自己也从默认
 * 路径读到同一份内容。
 *
 * **在站点配置里写了某个插件的配置，就以它为准**：内容一致时不重写（保留既有权限与属主），
 * 内容不同时覆盖。否则改了站点配置却不生效，站点配置也就不再是唯一来源；没有写进
 * `DSH_PLUGIN_CONFIG` 的插件完全不受影响，仍然沿用现场文件。
 *
 * 容器以非 root 用户读取这份配置，所以新建的目录与文件都要交给容器用户，否则部署机上的
 * 0700 root 目录会挡住容器内的进程。
 */
export function materializePluginConfigs({ root, site, plugins, home, uid, gid }) {
  const derived = [];
  const asRoot = process.platform !== 'win32' && process.getuid?.() === 0;
  for (const plugin of plugins ?? []) {
    const section = site.pluginConfig?.[plugin.id];
    if (section === undefined || !plugin.runtimeConfig) continue;
    const file = canonical(resolve(root, site.instances?.[plugin.id]?.runtimeConfig ?? join(home, 'plugins', plugin.id, 'env.conf')));
    const content = JSON.stringify(section, null, 2) + '\n';
    if (existsSync(file) && readFileSync(file, 'utf8') === content) continue;
    const fresh = [];
    for (let path = dirname(file); within(home, path); path = dirname(path)) if (!existsSync(path)) fresh.push(path);
    writePrivateFile(file, content);
    if (asRoot) {
      for (const path of fresh.reverse()) chownSync(path, uid, gid);
      chownSync(file, uid, gid);
    }
    derived.push(file);
  }
  return derived;
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

/**
 * 核对本次记录里的输入快照：快照在本次操作内必须保持一致，供稳定启动配置使用。
 *
 * 不跨次冻结（设计 3 节）：新发布可以用新输入，因此没有 resume/recover 分支；输入变化只报错，
 * 修正输入后重新运行普通 build。
 */
export function verifySiteInputs(record) {
  if (record.schemaVersion !== 3) return;
  for (const [key, expected] of Object.entries(record.inputEnvironment ?? {})) if (hash(process.env[key] ?? '') !== expected) throw new Error(`原固定环境 ${key} 已变化；请恢复后重试。`);
  for (const input of record.inputs) {
    if (input.path && fileHash(input.path) !== input.sha256) throw new Error(`私有输入快照已变化：${input.kind}。`);
    const exists = existsSync(input.source), actual = exists ? readFileSync(input.source) : undefined;
    const unchanged = input.existed ? exists && hash(actual) === input.sha256 : !exists || input.defaulted && hash(actual) === input.sha256;
    if (unchanged) continue;
    throw new Error(`原受管输入已变化：${input.source}。修正输入后重新运行普通 build；已移除的恢复参数不再提供。`);
  }
}

/** Create only a recorded default after prepared; never overwrite an existing user file. */
export function materializeSiteDefaults(record) {
  for (const input of record.inputs ?? []) if (input.defaulted) {
    if (!existsSync(input.source)) writePrivateFile(input.source, readFileSync(input.path), { flag: 'wx' });
    if (fileHash(input.source) !== input.sha256) throw new Error(`初始化配置与冻结默认值不一致：${input.source}`);
  }
}
