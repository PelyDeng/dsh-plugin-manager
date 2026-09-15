/** Site preferences are separate from the manager's generated deployment inputs. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveDeployment } from './config.mjs';
import { decodeFrameworkConfig, deploymentFields, imageDefaults, readFrameworkConfig, renderFrameworkConfig, resolveSiteConfig, siteDefaults, validateImageConfig } from './framework-config.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './private-files.mjs';

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/**
 * Generate a site once, importing existing deployment preferences without modifying them.
 *
 * `legacy` 与 `initialize: false` 只给一次性迁移入口使用：前者允许读取带已移除字段的旧 `.conf`，
 * 后者在配置文件不存在时退回既有旧 JSON（site.json/deployment.json）而不生成新配置——迁移预览
 * 必须只读，不能靠初始化配置来“读现场”。
 */
export function loadSite(root, filename, { imagePlatform, desktop = false, inputKind = 'source', legacy = false, initialize = true } = {}) {
  const defaults = siteDefaults(inputKind);
  const runtimePath = resolve(root, '.local/deployment.json');
  // 旧运行记录不再决定输入来源：站点偏好固定为 .local/env.conf（或显式 --config）。
  const sitePath = resolve(root, filename ?? '.local/env.conf');
  if (sitePath === runtimePath) throw new Error('Use .local/env.conf for site preferences; .local/deployment.json is generated.');
  if (!existsSync(sitePath)) {
    if (!initialize) {
      const existing = [resolve(root, '.local/site.json'), runtimePath].find(path => existsSync(path));
      if (!existing) throw new Error(`站点配置不存在：${sitePath}；也没有可迁移的旧配置。`);
      return { site: resolveSiteConfig(root, readJson(existing), { inputKind }), sitePath: existing, runtimePath, source: undefined };
    }
    if (filename) throw new Error(`Site configuration does not exist: ${sitePath}. Run build.ps1 (Windows) or build.sh (macOS/Linux) without --config to initialize defaults.`);
    initializeFrameworkSite(root, sitePath, runtimePath, defaults, imagePlatform, desktop);
  }
  const source = sitePath.endsWith('.conf') ? readFrameworkConfig(sitePath, { allowRemovedFields: legacy }) : undefined;
  const overrides = source?.config ?? readJson(sitePath);
  const site = resolveSiteConfig(root, overrides, { inputKind, source });
  return { site, sitePath, runtimePath, source };
}

/** One-time import preserves legacy files and resolved paths; no official API keys are read. */
function initializeFrameworkSite(root, sitePath, runtimePath, defaults, imagePlatform, desktop) {
  const legacy = resolve(root, '.local/site.json');
  const previousPath = existsSync(legacy) ? legacy : existsSync(runtimePath) ? runtimePath : undefined;
  const previous = previousPath ? readJson(previousPath) : {};
  const { manifest, containerImage, hostImageConfig, dockerRuntime, pluginSource, ...preferences } = previous;
  if (pluginSource !== undefined) console.warn('旧字段 pluginSource 已移除且不导入：插件来源固定为 builtin 自动构建加 incoming 外部归档；旧选集请用 migrate-site 显式化。');
  const known = new Set(deploymentFields.map(([, field]) => field));
  const unknown = Object.keys(preferences).filter(key => !known.has(key));
  if (unknown.length) throw new Error(`Legacy fields require explicit JSON compatibility or migration: ${unknown.join(', ')}.`);
  // Imported settings retain their omissions; runtime defaults are applied by loadSite.
  const config = previousPath ? { ...preferences } : { ...defaults };
  // 新建站点把容器用户对齐当前非 root 用户：站点流程按同一个 uid/gid 起容器（`service.user`），
  // 运维用本人身份创建的持久目录才对容器可用；Windows 与 root（容器内运行）保持通用默认 1000。
  // 已有站点沿用自己记录的值，不被这里改写。
  if (!previousPath && process.platform !== 'win32' && process.getuid?.() > 0 && process.getgid?.() > 0) {
    config.containerUid = process.getuid(); config.containerGid = process.getgid();
  }
  delete config.hostImageConfig;
  if (previousPath) {
    // Legacy source JSON applied explicit site path defaults before resolving a partial override.
    const paths = { ...defaults, ...preferences };
    const current = resolveDeployment({ root, config: previousPath, 'data-root': paths.dataRoot, home: paths.home,
      workspace: paths.workspace, artifacts: paths.artifacts, profile: paths.profile }, {});
    for (const field of ['dataRoot', 'home', 'workspace', 'artifacts', 'authUrlFile', 'profile']) config[field] = current[field];
    config.publicUrl = previous.publicUrl ?? previous.publicOrigin ?? defaults.publicUrl;
    if (!existsSync(legacy) && typeof containerImage === 'string' && containerImage.includes('@sha256:')) config.publishImage = containerImage.split('@')[0];
  } else {
    config.authUrlFile = resolve(root, config.dataRoot, 'dsh-web-auth-url.txt');
  }
  const image = hostImageConfig ? validateImageConfig(readFrameworkConfig(resolve(root, hostImageConfig)).image) : previousPath ? {} : { ...imageDefaults };
  if (!previousPath && imagePlatform) image.DSH_IMAGE_PLATFORM = imagePlatform;
  const text = renderFrameworkConfig({ config, image, privateInput: true });
  decodeFrameworkConfig(text);
  ensurePrivateDirectory(dirname(sitePath));
  writePrivateFile(`${sitePath}.tmp`, text, { flag: 'wx' });
  renameSync(`${sitePath}.tmp`, sitePath);
  console.log(`Framework configuration initialized: ${sitePath}; legacy inputs retained.`);
}
