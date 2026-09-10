/** Site preferences are separate from the manager's generated deployment inputs. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveDeployment } from './config.mjs';
import { decodeFrameworkConfig, deploymentFields, imageDefaults, readFrameworkConfig, renderFrameworkConfig, resolveSiteConfig, siteDefaults, validateImageConfig } from './framework-config.mjs';
import { ensurePrivateDirectory, writePrivateFile } from './private-files.mjs';
import { readSitePointer, readSiteRecord, needsSiteResume } from './site-record.mjs';

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Generate a site once, importing existing deployment preferences without modifying them. */
export function loadSite(root, filename, { imagePlatform, desktop = false, inputKind = 'source' } = {}) {
  const defaults = siteDefaults(inputKind);
  const runtimePath = resolve(root, '.local/deployment.json');
  const prior = readSitePointer(root);
  const interrupted = prior && needsSiteResume(prior.status);
  const original = interrupted ? readSiteRecord(root, prior.operation).sitePath : undefined;
  // An unfinished operation keeps its original input, including legacy JSON, until resumed.
  const sitePath = resolve(root, filename ?? original ?? '.local/env.conf');
  if (sitePath === runtimePath) throw new Error('Use .local/env.conf for site preferences; .local/deployment.json is generated.');
  if (!existsSync(sitePath)) {
    if (filename) throw new Error(`Site configuration does not exist: ${sitePath}. Run build.ps1 (Windows) or build.sh (macOS/Linux) without --config to initialize defaults.`);
    if (original) throw new Error('The original interrupted site input is missing; restore it before resuming.');
    initializeFrameworkSite(root, sitePath, runtimePath, defaults, imagePlatform, desktop);
  }
  const source = sitePath.endsWith('.conf') ? readFrameworkConfig(sitePath) : undefined;
  const overrides = source?.config ?? readJson(sitePath);
  const site = resolveSiteConfig(root, overrides, { inputKind, source });
  return { site, sitePath, runtimePath, source };
}

/** One-time import preserves legacy files and resolved paths; no official API keys are read. */
function initializeFrameworkSite(root, sitePath, runtimePath, defaults, imagePlatform, desktop) {
  const legacy = resolve(root, '.local/site.json');
  const previousPath = existsSync(legacy) ? legacy : existsSync(runtimePath) ? runtimePath : undefined;
  const previous = previousPath ? readJson(previousPath) : {};
  const { manifest, containerImage, hostImageConfig, dockerRuntime, ...preferences } = previous;
  const known = new Set(deploymentFields.map(([, field]) => field));
  const unknown = Object.keys(preferences).filter(key => !known.has(key));
  if (unknown.length) throw new Error(`Legacy fields require explicit JSON compatibility or migration: ${unknown.join(', ')}.`);
  // Imported settings retain their omissions; runtime defaults are applied by loadSite.
  const config = previousPath ? { ...preferences } : { ...defaults };
  if (!previousPath && desktop && process.platform === 'darwin' && process.getuid?.() > 0 && process.getgid?.() > 0) {
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
