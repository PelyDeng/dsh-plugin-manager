import { canonical, environmentName, fail, json, within } from './state.mjs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { closeSync, existsSync, openSync, statSync } from 'node:fs';
/** Parse CLI options without interpreting user text as shell code. */
export function parseArguments(args) {
  const result = { action: args[0] && !args[0].startsWith('--') ? args.shift() : 'deploy' };
  const flags = new Set(['offline', 'resume', 'recover', 'data-compatible', 'rebuild', 'container', 'help']);
  const keys = new Set(['root', 'config', 'plugins', 'manifest', 'profile', 'data-root', 'home', 'workspace', 'auth-url-file', 'artifacts', 'harness-root', 'dsh-cli', 'dsh-cli-js', 'mode', 'host-mode', 'stopped-file', 'started-file', 'store-dir', 'offline-store', 'cache-dir', 'offline-cache', 'base-url', 'output', 'port', 'host', 'trusted-hosts', 'public-url']);
  while (args.length) {
    const option = args.shift();
    if (!option.startsWith('--')) fail(`未知参数：${option}`);
    const key = option.slice(2);
    if (Object.hasOwn(result, key)) fail(`重复参数：${option}`);
    if (flags.has(key)) result[key] = true;
    else if (keys.has(key) && args.length && !args[0].startsWith('--')) result[key] = args.shift();
    else fail(`未知参数或缺少值：${option}`);
  }
  return result;
}

/** All user relative paths are anchored at the plugin repository root. */
export function resolveDeployment(options = {}, env = process.env) {
  if (!options.root) fail('必须显式指定 --root 项目根目录。');
  const root = canonical(options.root);
  const configPath = options.config ?? env.DEPLOYMENT_CONFIG;
  const config = configPath ? json(resolve(root, configPath)) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('部署配置必须是对象。');
  const pick = (option, variable, field, fallback) => options[option] ?? env[variable] ?? config[field] ?? fallback;
  const path = value => {
    const lexical = resolve(root, value);
    const result = canonical(lexical);
    const rel = relative(root, lexical);
    const inProject = !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    if (inProject && !within(root, result)) fail('仓库内路径不能通过目录联接跳转到外部；请显式指定真实外部路径。');
    return result;
  };
  const dataRoot = path(pick('data-root', 'DSH_DATA_DIR', 'dataRoot', '.local/data'));
  const home = path(pick('home', 'DSH_HOME', 'home', join(dataRoot, 'dsh-home')));
  const workspace = path(pick('workspace', 'DSH_WORKSPACE', 'workspace', join(dataRoot, 'workspace')));
  const authUrlFile = path(pick('auth-url-file', 'DSH_AUTH_URL_FILE', 'authUrlFile', join(dataRoot, 'dsh-web-auth-url.txt')));
  const artifacts = path(pick('artifacts', 'DSH_DEPLOY_ARTIFACTS', 'artifacts', '.local/artifacts'));
  const allowedData = location => ['data', '.local/data'].some(folder => within(join(root, folder), location));
  if (within(root, dataRoot) && !allowedData(dataRoot)) fail('仓库内 dataRoot 必须位于 .local/data/ 或显式选择的 data/。');
  for (const location of [home, workspace, authUrlFile]) {
    if (within(root, location) && !allowedData(location)) fail('仓库内持久路径必须位于 .local/data/ 或显式选择的 data/。');
    if (within(artifacts, location) || within(location, artifacts)) fail('持久路径与部署操作目录不能重叠。');
  }
  const profile = options.profile ?? env.DSH_PROFILE ?? config.profile ?? 'web';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile)) fail('profile 名称无效。');
  const mode = options.mode ?? config.mode ?? 'release';
  if (!['release', 'development'].includes(mode)) fail('mode 必须是 release 或 development。');
  const hostMode = options['host-mode'] ?? config.hostMode ?? 'external';
  if (!['external', 'owned'].includes(hostMode)) fail('host-mode 必须是 external 或 owned。');
  const instances = config.instances ?? {};
  if (!instances || typeof instances !== 'object' || Array.isArray(instances)) fail('instances 必须是以插件 ID 为键的对象。');
  const publicOrigin = env.DSH_PUBLIC_ORIGIN ?? config.publicOrigin ?? options['public-url'] ?? env.DSH_PUBLIC_URL ?? config.publicUrl;
  return { root, config: { ...config, ...(publicOrigin ? { publicOrigin } : {}) }, configPath: configPath && resolve(root, configPath), dataRoot, home, workspace, authUrlFile, artifacts,
    profile, profileRoot: join(home, 'profiles', profile), mode, hostMode, instances,
    explicitArtifacts: options.artifacts !== undefined || env.DSH_DEPLOY_ARTIFACTS !== undefined || config.artifacts !== undefined,
    explicitData: options.home !== undefined || env.DSH_HOME !== undefined || config.home !== undefined || options['data-root'] !== undefined || env.DSH_DATA_DIR !== undefined || config.dataRoot !== undefined,
    manifest: options.manifest ?? env.PLUGIN_MANIFEST_FILE ?? config.manifest,
    selection: options.plugins ?? config.plugins,
    store: pick('store-dir', 'DSH_STORE_DIR', 'storeDir', undefined),
    offlineStore: pick('offline-store', 'DSH_OFFLINE_STORE_DIR', 'offlineStore', undefined),
    cache: pick('cache-dir', 'DSH_CACHE_DIR', 'cacheDir', undefined),
    offlineCache: pick('offline-cache', 'DSH_OFFLINE_CACHE_DIR', 'offlineCache', undefined),
    offline: options.offline ?? config.offline ?? false,
    baseUrl: options['base-url'] ?? config.baseUrl,
    options };
}

/** Avoid silently replacing an existing deployment with an empty default home. */
export function checkDataSelection(deployment, userHome = homedir()) {
  const candidates = [];
  if (!deployment.explicitData) candidates.push(...[join(deployment.root, 'data'), join(deployment.root, '../data'), join(userHome, '.dsh')].filter(path => existsSync(path)));
  if (!deployment.explicitArtifacts && existsSync(join(deployment.root, 'deploy-artifacts'))) candidates.push(join(deployment.root, 'deploy-artifacts'));
  if (candidates.length) fail(`检测到旧目录，请显式指定 --home/--data-root/--artifacts 沿用或先迁移：${candidates.join(', ')}`);
}

/** Resolve optional runtime files without inspecting business configuration values. */
export function runtimeEnvironment(deployment, plugins) {
  const variables = { DSH_HOME: deployment.home }; const configurations = {};
  for (const plugin of plugins) {
    const instance = deployment.instances[plugin.id] ?? {};
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) fail(`${plugin.id}: 实例配置必须是对象。`);
    const revision = instance.configRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) fail(`${plugin.id}: configRevision 必须是非负整数。`);
    const spec = plugin.runtimeConfig;
    let file;
    if (spec) {
      if (!environmentName(spec.variable) || Object.hasOwn(variables, spec.variable)) fail(`${plugin.id}: 运行配置变量无效或重复。`);
      file = canonical(resolve(deployment.root, instance.runtimeConfig ?? join(deployment.home, 'plugins', plugin.id, 'env.conf')));
      if (existsSync(file)) {
        const fd = openSync(file, 'r'); closeSync(fd);
        if (!statSync(file).isFile()) fail(`${plugin.id}: 配置不是普通文件。`);
        variables[spec.variable] = file;
      } else if (spec.required !== false) fail(`${plugin.id}: 缺少运行配置 ${file}`);
      else variables[spec.variable] = undefined;
    }
    configurations[plugin.id] = { configRevision: revision, ...(file ? { file } : {}) };
    if (plugin.development?.rootVariable) {
      if (!environmentName(plugin.development.rootVariable) || Object.hasOwn(variables, plugin.development.rootVariable)) fail(`${plugin.id}: 开发变量无效或重复。`);
      const source = canonical(resolve(deployment.root, plugin.directory));
      if (!within(join(deployment.root, 'plugins'), source)) fail('开发插件源码目录越界。');
      variables[plugin.development.rootVariable] = deployment.mode === 'development' ? source : undefined;
    }
  }
  return { variables, configurations };
}
