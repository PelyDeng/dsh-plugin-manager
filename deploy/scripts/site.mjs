/** Site preferences are separate from the manager's generated deployment inputs. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveDeployment } from '../../packages/plugin-manager/src/config.mjs';

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

/** Generate a site once, importing existing deployment preferences without modifying them. */
export function loadSite(root, filename) {
  const defaults = readJson(resolve(root, 'deploy/config/site.defaults.json'));
  const runtimePath = resolve(root, '.local/deployment.json');
  const sitePath = resolve(root, filename ?? '.local/site.json');
  if (sitePath === runtimePath) throw new Error('Use .local/site.json for site preferences; .local/deployment.json is generated.');
  if (!existsSync(sitePath)) {
    if (filename) throw new Error(`Site configuration does not exist: ${sitePath}. Run bash deploy/build.sh without --config to initialize defaults.`);
    const previous = existsSync(runtimePath) ? readJson(runtimePath) : {};
    const { manifest, containerImage, ...preferences } = previous;
    const site = { ...defaults, ...preferences };
    if (existsSync(runtimePath)) {
      const current = resolveDeployment({ root, config: runtimePath }, {});
      for (const field of ['dataRoot', 'home', 'workspace', 'artifacts', 'authUrlFile', 'profile']) site[field] = current[field];
      site.publicUrl = previous.publicUrl ?? previous.publicOrigin ?? defaults.publicUrl;
    }
    if (typeof containerImage === 'string' && containerImage.includes('@sha256:')) site.publishImage = containerImage.split('@')[0];
    saveJson(sitePath, site);
    console.log(`Site configuration initialized: ${sitePath}`);
  }
  const overrides = readJson(sitePath);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Site configuration must be a JSON object.');
  if ('manifest' in overrides || 'containerImage' in overrides) throw new Error('manifest and containerImage are generated; use hostImage only for an optional prebuilt host.');
  const site = { ...defaults, ...overrides };
  if (!Array.isArray(site.plugins) || site.plugins.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) || new Set(site.plugins).size !== site.plugins.length) throw new Error('plugins must contain unique plugin IDs.');
  if (!Number.isInteger(site.port) || site.port < 1 || site.port > 65535) throw new Error('port must be an integer from 1 to 65535.');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(site.composeProject)) throw new Error('Invalid composeProject.');
  for (const key of ['publicOrigin', 'publicUrl']) {
    const url = new URL(site[key]);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== site[key]) throw new Error(`${key} must be an HTTP(S) origin without credentials or a path.`);
  }
  if (site.publishImage !== null && (typeof site.publishImage !== 'string' || !/^[a-z0-9][a-z0-9.:-]*\/[a-z0-9][a-z0-9._/-]*$/.test(site.publishImage) || site.publishImage.includes('..'))) throw new Error('publishImage must be null or a registry/repository without a tag.');
  if (site.hostImage !== null && (typeof site.hostImage !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/.test(site.hostImage))) throw new Error('hostImage must be null or an immutable registry digest.');
  if (site.hostImageConfig !== null && typeof site.hostImageConfig !== 'string') throw new Error('hostImageConfig must be null or a configuration path.');
  return { site, sitePath, runtimePath };
}
