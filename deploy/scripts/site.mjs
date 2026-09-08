/** Site preferences are separate from the manager's generated deployment inputs. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveDeployment } from '../../packages/plugin-manager/src/config.mjs';
import { decodeFrameworkConfig, deploymentFields, imageDefaults, publicDeploymentDefaults, readFrameworkConfig, renderFrameworkConfig } from '../../packages/plugin-manager/src/framework-config.mjs';
import { loadImageConfig, validateImageConfig } from '../../integrations/docker/host-image.mjs';
import { ensurePrivateDirectory, writePrivateFile } from '../../packages/plugin-manager/src/private-files.mjs';

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Generate a site once, importing existing deployment preferences without modifying them. */
export function loadSite(root, filename, { imagePlatform, desktop = false } = {}) {
  const defaults = readJson(resolve(root, 'deploy/config/site.defaults.json'));
  const runtimePath = resolve(root, '.local/deployment.json');
  const pointer = resolve(root, '.local/source-release.json');
  const prior = existsSync(pointer) ? readJson(pointer) : undefined;
  const interrupted = prior && ['prepared', 'backing-up', 'applying', 'deployment-failed'].includes(prior.status);
  const original = interrupted ? readJson(resolve(prior.operation, 'result.json')).sitePath : undefined;
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
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Site configuration must be a JSON object.');
  if ('manifest' in overrides || 'containerImage' in overrides) throw new Error('manifest and containerImage are generated; use hostImage only for an optional prebuilt host.');
  const site = { ...defaults, ...overrides };
  if (source) {
    site.home = overrides.home ?? resolve(root, site.dataRoot, 'dsh-home');
    site.workspace = overrides.workspace ?? resolve(root, site.dataRoot, 'workspace');
    site.publicUrl = overrides.publicUrl ?? overrides.publicOrigin ?? `http://127.0.0.1:${site.port}`;
    site.publicOrigin = overrides.publicOrigin ?? site.publicUrl;
    validateImageConfig(source.image);
    if (site.mode !== undefined && site.mode !== 'release') throw new Error('Source container deployment requires release mode.');
  }
  if (!Array.isArray(site.plugins) || site.plugins.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) || new Set(site.plugins).size !== site.plugins.length) throw new Error('plugins must contain unique plugin IDs.');
  if (!Number.isInteger(site.port) || site.port < 1 || site.port > 65535) throw new Error('port must be an integer from 1 to 65535.');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(site.composeProject)) throw new Error('Invalid composeProject.');
  for (const key of ['publicOrigin', 'publicUrl']) {
    let url;
    try { url = new URL(site[key]); } catch { throw new Error(`${key} must be an HTTP(S) origin.`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== site[key]) throw new Error(`${key} must be an HTTP(S) origin without credentials or a path.`);
  }
  if (site.publishImage !== null && (typeof site.publishImage !== 'string' || !/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*$/.test(site.publishImage) || site.publishImage.includes('..'))) throw new Error('publishImage must be null or a registry/repository without a tag.');
  if (site.hostImage !== null && (typeof site.hostImage !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/.test(site.hostImage))) throw new Error('hostImage must be null or an immutable registry digest.');
  if (site.hostImageConfig !== null && typeof site.hostImageConfig !== 'string') throw new Error('hostImageConfig must be null or a configuration path.');
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
  const config = previousPath ? { ...defaults, ...preferences } : { ...publicDeploymentDefaults, ...defaults };
  if (!previousPath && desktop && process.platform === 'darwin' && process.getuid?.() > 0 && process.getgid?.() > 0) {
    config.containerUid = process.getuid(); config.containerGid = process.getgid();
  }
  delete config.hostImageConfig;
  if (previousPath) {
    const current = resolveDeployment({ root, config: previousPath, 'data-root': config.dataRoot, home: config.home,
      workspace: config.workspace, artifacts: config.artifacts, profile: config.profile }, {});
    for (const field of ['dataRoot', 'home', 'workspace', 'artifacts', 'authUrlFile', 'profile']) config[field] = current[field];
    config.publicUrl = previous.publicUrl ?? previous.publicOrigin ?? defaults.publicUrl;
    if (!existsSync(legacy) && typeof containerImage === 'string' && containerImage.includes('@sha256:')) config.publishImage = containerImage.split('@')[0];
  } else {
    config.authUrlFile = resolve(root, config.dataRoot, 'dsh-web-auth-url.txt');
  }
  const image = hostImageConfig ? loadImageConfig(root, hostImageConfig) : previousPath ? {} : { ...imageDefaults };
  if (!previousPath && imagePlatform) image.DSH_IMAGE_PLATFORM = imagePlatform;
  const text = renderFrameworkConfig({ config, image, privateInput: true });
  decodeFrameworkConfig(text);
  ensurePrivateDirectory(dirname(sitePath));
  writePrivateFile(`${sitePath}.tmp`, text, { flag: 'wx' });
  renameSync(`${sitePath}.tmp`, sitePath);
  console.log(`Framework configuration initialized: ${sitePath}; legacy inputs retained.`);
}
