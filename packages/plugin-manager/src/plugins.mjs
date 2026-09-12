/** Discover independently packaged plugins and validate their repository metadata. */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isPluginPath } from '@dsh-plugin-manager/plugin-kit/route-path';
import { validateConfiguration } from './plugin-settings.mjs';
import { environmentName } from './state.mjs';

/** User configuration and deployment state cannot be package resources. */
export function privatePackagePath(path) {
  return path.split('/').some(part => part === 'env.conf' || part === '.env' || /^\.env\.(?!example$)/u.test(part)
    || ['.local', 'data', 'deploy-artifacts', '.tmp', '.git', 'registry.conf', 'token.txt', '.credentials.yaml'].includes(part));
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} 必须是对象。`);
  for (const key of Object.keys(value)) requireValue(keys.includes(key), `${label} 未知字段：${key}。`);
}

function variable(value, label) {
  requireValue(environmentName(value), `${label} 不是有效环境变量名，或使用了进程或部署保留变量。`);
  return value;
}

/** Validate a package-relative file, including existing symlink ancestors. */
function pluginFile(root, input, label, { required = false, standard = false } = {}) {
  const value = standard && typeof input === 'string' && input.startsWith('./') ? input.slice(2) : input;
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9._/-]*$/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..'), `${label} 必须是插件内的相对文件路径。`);
  let ancestor = resolve(root, value);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const resolved = relative(realpathSync(root), realpathSync(ancestor));
  requireValue(!isAbsolute(resolved) && resolved !== '..' && !resolved.startsWith(`..${sep}`), `${label} 指向插件目录之外。`);
  const path = resolve(root, value);
  if (required || existsSync(path)) requireValue(existsSync(path) && statSync(path).isFile(), `${label} 文件不存在或不是普通文件：${value}。`);
  return value;
}

/** Read one explicit source package without requiring a workspace or running its code. */
export function readPlugin(root) {
  requireValue(root && existsSync(root) && lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), '插件根必须是存在的真实目录。');
  const packageLabel = basename(root);
  pluginFile(root, 'package.json', packageLabel, { required: true });
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  requireValue(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'package.json 必须是对象。');
  requireValue(Object.hasOwn(manifest, 'deepseekPlugin'), '显式插件缺少 deepseekPlugin。');
  const meta = manifest.deepseekPlugin;
  const label = `${packageLabel}/package.json#deepseekPlugin`;
  requireValue(meta && meta.schemaVersion === 3, `${label}.schemaVersion 仅支持 3；旧 env 声明请迁移为 runtimeConfig，并从 files 移除用户配置。`);
  object(meta, ['schemaVersion', 'id', 'defaultEnabled', 'runtimeConfig', 'configuration', 'healthPath', 'verifyFiles', 'development', 'displayName', 'entryPath', 'permissions', 'category'], label);
  validateConfiguration(meta.configuration, label);
  requireValue(typeof meta.id === 'string' && /^[a-z][a-z0-9-]*$/u.test(meta.id) && !['all', 'none', 'dsh-console'].includes(meta.id), `${label}.id 无效或为保留字。`);
  requireValue(typeof manifest.name === 'string' && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(manifest.name), `${packageLabel} 包名无效。`);
  requireValue(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(manifest.version), `${packageLabel} 必须声明版本。`);
  requireValue(manifest.description === undefined || typeof manifest.description === 'string', `${packageLabel}.description 必须是文本。`);
  requireValue(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.every(file => typeof file === 'string' && file.trim()), `${packageLabel} 必须声明 npm files。`);
  requireValue(!manifest.files.some(privatePackagePath), `${packageLabel}.files 不得包含用户配置或部署数据。`);
  for (const task of ['build', 'check']) requireValue(typeof manifest.scripts?.[task] === 'string' && manifest.scripts[task].trim(), `${packageLabel} 缺少 scripts.${task}。`);
  for (const hook of ['prepare', 'prepack', 'postpack']) requireValue(!manifest.scripts?.[hook], `${packageLabel} 不得声明 ${hook}；构建由统一流水线执行。`);
  pluginFile(root, 'README.md', packageLabel, { required: true });
  const main = pluginFile(root, manifest.main, `${packageLabel}.main`, { standard: true });
  const patch = pluginFile(root, manifest.dsh?.bundle?.patch, `${packageLabel}.dsh.bundle.patch`, { required: true, standard: true });
  requireValue(meta.defaultEnabled === undefined || typeof meta.defaultEnabled === 'boolean', `${label}.defaultEnabled 必须是布尔值。`);
  let runtimeConfig;
  if (meta.runtimeConfig !== undefined) {
    object(meta.runtimeConfig, ['variable', 'template', 'required'], `${label}.runtimeConfig`);
    requireValue(meta.runtimeConfig.required === undefined || typeof meta.runtimeConfig.required === 'boolean', `${label}.runtimeConfig.required 必须为布尔值。`);
    runtimeConfig = {
      variable: variable(meta.runtimeConfig.variable, `${label}.runtimeConfig.variable`),
      ...(meta.runtimeConfig.template === undefined ? {} : { template: pluginFile(root, meta.runtimeConfig.template, `${label}.runtimeConfig.template`, { required: true }) }),
      required: meta.runtimeConfig.required ?? true,
    };
  }
  let development;
  if (meta.development !== undefined) {
    object(meta.development, ['patch', 'rootVariable'], `${label}.development`);
    development = {
      patch: pluginFile(root, meta.development.patch, `${label}.development.patch`, { required: true }),
      rootVariable: variable(meta.development.rootVariable, `${label}.development.rootVariable`),
    };
  }
  requireValue(meta.healthPath === undefined || (typeof meta.healthPath === 'string' && /^\/[a-zA-Z0-9_~./-]*$/u.test(meta.healthPath)
    && !meta.healthPath.startsWith('//') && !meta.healthPath.split('/').some(part => part === '.' || part === '..')), `${label}.healthPath 无效。`);
  requireValue(meta.displayName === undefined || (typeof meta.displayName === 'string' && meta.displayName.trim().length > 0), `${label}.displayName 必须是非空文本。`);
  requireValue(meta.entryPath === undefined || isPluginPath(meta.entryPath), `${label}.entryPath 必须是规范的非根插件路由。`);
  // 插件分类只用于认证页面分组与牛马大总管端成员过滤；取值不设枚举，第三方插件可以自定义。
  requireValue(meta.category === undefined || (typeof meta.category === 'string' && meta.category.trim().length > 0 && meta.category.trim().length <= 40), `${label}.category 必须是不超过 40 字的非空文本。`);
  const permissions = meta.permissions ?? [];
  requireValue(Array.isArray(permissions) && permissions.every(permission => typeof permission === 'string'
    && new RegExp(`^${meta.id}:[a-z][a-z0-9-]*$`, 'u').test(permission)) && new Set(permissions).size === permissions.length,
  `${label}.permissions 必须是本插件 id 命名空间内不重复的权限列表。`);
  requireValue(meta.verifyFiles === undefined || Array.isArray(meta.verifyFiles), `${label}.verifyFiles 必须是数组。`);
  requireValue(!runtimeConfig || !development || runtimeConfig.variable !== development.rootVariable, '插件环境变量重复。');
  const verifyFiles = [...new Set(['package.json', 'README.md', main, patch, ...(runtimeConfig?.template ? [runtimeConfig.template] : []),
    ...(meta.verifyFiles ?? []).map(file => pluginFile(root, file, `${label}.verifyFiles`))])];
  requireValue(!verifyFiles.some(privatePackagePath), `${packageLabel} 的公开资源不得指向用户配置或部署数据。`);
  return { id: meta.id, package: manifest.name, version: manifest.version,
    displayName: meta.displayName ?? manifest.name, description: manifest.description, entryPath: meta.entryPath, permissions,
    category: meta.category?.trim(), defaultEnabled: meta.defaultEnabled ?? true, runtimeConfig, configuration: meta.configuration, development, healthPath: meta.healthPath, verifyFiles };
}

/** Return all declared plugins in stable id order; malformed declarations fail before work starts. */
export function discoverPlugins(root) {
  if (!root) throw new Error('必须显式指定 --root 项目根目录。');
  pluginFile(root, 'pnpm-lock.yaml', '工作目录统一锁文件', { required: true });
  const plugins = [];
  const container = resolve(root, 'plugins');
  if (!existsSync(container)) return plugins;
  requireValue(lstatSync(container).isDirectory() && !lstatSync(container).isSymbolicLink(), 'plugins 必须是仓库内的真实目录。');
  requireValue(!existsSync(resolve(container, 'package.json')), 'plugins 是容器目录，不得声明 package.json。');
  for (const entry of readdirSync(container, { withFileTypes: true })) {
    requireValue(!entry.isSymbolicLink(), `插件目录不得为符号链接：${entry.name}。`);
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const pluginRoot = resolve(container, entry.name);
    const manifestPath = resolve(pluginRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    pluginFile(pluginRoot, 'package.json', entry.name, { required: true });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    requireValue(manifest && typeof manifest === 'object' && !Array.isArray(manifest), `${entry.name}/package.json 必须是对象。`);
    if (!Object.hasOwn(manifest, 'deepseekPlugin')) {
      requireValue(!manifest.dsh?.bundle, `${entry.name} 声明了 DSH bundle，但缺少 deepseekPlugin。`);
      continue;
    }
    requireValue(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(entry.name), `插件目录名称无效：${entry.name}。`);
    plugins.push({ ...readPlugin(pluginRoot), directory: `plugins/${entry.name}` });
  }
  for (const field of ['id', 'package']) {
    const seen = new Set();
    for (const plugin of plugins) {
      requireValue(!seen.has(plugin[field]), `插件 ${field} 重复：${plugin[field]}。`);
      seen.add(plugin[field]);
    }
  }
  const variables = new Set();
  for (const plugin of plugins) {
    for (const name of [plugin.runtimeConfig?.variable, plugin.development?.rootVariable].filter(Boolean)) {
      requireValue(!variables.has(name), `插件环境变量重复：${name}。`);
      variables.add(name);
    }
  }
  return plugins.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Select the default set, all plugins, or a comma-separated list preserving explicit order. */
export function selectPlugins(plugins, requested) {
  let selected;
  if (requested === undefined) selected = plugins.filter(plugin => plugin.defaultEnabled);
  else if (requested === 'all') selected = [...plugins];
  else if (requested === 'none') selected = [];
  else {
    requireValue(typeof requested === 'string' && requested.length > 0, '插件选择不能为空。');
    const seen = new Set();
    selected = requested.split(',').map(id => {
      const plugin = plugins.find(candidate => candidate.id === id);
      requireValue(plugin, `未知插件：${id || '(空项)'}。`);
      requireValue(!seen.has(id), `重复选择插件：${id}。`);
      seen.add(id);
      return plugin;
    });
  }
  return selected;
}

/** Select either an explicit single package or the existing workspace inventory. */
export function sourcePlugins(root, requested, packageDirectory) {
  if (!root) throw new Error('必须显式指定 --root 项目根目录。');
  if (packageDirectory === undefined) return selectPlugins(discoverPlugins(root), requested);
  requireValue(packageDirectory === '.' && requested === undefined, '--package 仅支持 .，且不能与 --plugins 同用。');
  return [readPlugin(root)];
}

/** Parse repository options once for every CLI consumer. */
export function parseOptions(args, allowed = ['root', 'plugins', 'format'], boolean = []) {
  if (args[0] === '--') args = args.slice(1);
  const options = {};
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index].startsWith('--') ? args[index].slice(2) : null;
    // 无值开关单独成项；其余参数仍是严格的 --name value 成对形式。
    if (name !== null && boolean.includes(name) && !Object.hasOwn(options, name)) { options[name] = true; continue; }
    rest.push(args[index]);
  }
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index].slice(2);
    requireValue(rest[index].startsWith('--') && allowed.includes(name) && !Object.hasOwn(options, name)
      && rest[index + 1] && !rest[index + 1].startsWith('--'), `无效或重复参数：${rest[index]}。`);
    options[name] = rest[index + 1];
  }
  return options;
}

/** Preserve the runtime record format without evaluating any metadata as shell source. */
export function pluginRecord(plugin) {
  return [plugin.id, plugin.defaultEnabled ? '1' : '0', plugin.directory, plugin.package,
    plugin.runtimeConfig?.variable ?? '-', plugin.runtimeConfig?.template ?? '-', plugin.healthPath ?? '-', plugin.verifyFiles.join(',')].join('|');
}

export function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  const plugins = discoverPlugins(options.root);
  const selected = selectPlugins(plugins, options.plugins);
  if (!options.format || options.format === 'json') process.stdout.write(`${JSON.stringify({ plugins, selected })}\n`);
  else if (options.format === 'records') {
    for (const plugin of plugins) process.stdout.write(`catalog|${pluginRecord(plugin)}\n`);
    for (const plugin of selected) process.stdout.write(`selected|${plugin.id}\n`);
  } else throw new Error(`未知输出格式：${options.format}。`);
}
