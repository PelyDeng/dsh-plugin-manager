import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSite } from '../../../deploy/scripts/site.mjs';
import { readFrameworkConfig, renderFrameworkConfig, imageDefaults } from '../src/framework-config.mjs';
import { parseLiteralConfig } from '../src/literal-config.mjs';
import { frameworkKeys } from '../src/framework-config.mjs';

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-site-defaults-')));
  t.after(() => { assert.equal(dirname(root), realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'deploy/config'), { recursive: true });
  mkdirSync(join(root, '.local'), { mode: 0o700 });
  copyFileSync(new URL('../../../deploy/config/site.defaults.json', import.meta.url), join(root, 'deploy/config/site.defaults.json'));
  return root;
}

test('new private env records effective site and image defaults without secrets or generated image/manifest', t => {
  const root = fixture(t);
  const { sitePath } = loadSite(root, undefined, { imagePlatform: 'linux/arm64', desktop: true });
  const value = readFrameworkConfig(sitePath);
  assert.equal(value.config.port, 7902); assert.deepEqual(value.config.plugins, ['auth', 'example']);
  assert.equal(value.config.composeProject, 'dsh-plugins'); assert.equal(value.config.publicOrigin, 'http://127.0.0.1:7902');
  assert.equal(value.config.home, '.local/data/dsh-home'); assert.equal(value.config.workspace, '.local/data/workspace');
  assert.equal(value.config.authUrlFile, resolve(root, '.local/data/dsh-web-auth-url.txt'));
  assert.equal(value.image.DSH_IMAGE_PLATFORM, 'linux/arm64'); assert.equal(value.image.HARBOR_ENABLED, imageDefaults.HARBOR_ENABLED);
  assert.deepEqual(value.credentials, {});
  const raw = parseLiteralConfig(readFileSync(sitePath, 'utf8'), frameworkKeys);
  for (const key of ['DEEPSEEK_API_KEY', 'REGISTRY_USERNAME', 'REGISTRY_PASSWORD', 'DSH_CONTAINER_IMAGE', 'DSH_MANIFEST']) assert.equal(raw[key], '');
  assert.equal(raw.DSH_OFFLINE, 'false'); assert.equal(raw.HARBOR_ENABLED, 'false'); assert.equal(raw.DSH_SOURCE_BASE_IMAGE, imageDefaults.DSH_SOURCE_BASE_IMAGE);
});

test('existing env bytes and explicit platform/user choices survive new initialization defaults', t => {
  const root = fixture(t), path = join(root, '.local/env.conf');
  const text = renderFrameworkConfig({ config: { publicUrl: 'http://127.0.0.1:27913', port: 27913, plugins: [], containerUid: 2001, containerGid: 2002 }, image: { DSH_IMAGE_PLATFORM: 'linux/amd64' }, privateInput: true });
  writeFileSync(path, text, { mode: 0o600 });
  const result = loadSite(root, undefined, { imagePlatform: 'linux/arm64', desktop: true });
  assert.equal(readFileSync(path, 'utf8'), text); assert.equal(result.site.port, 27913);
  assert.deepEqual(result.site.plugins, []); assert.equal(result.site.containerUid, 2001); assert.equal(result.site.containerGid, 2002);
  assert.equal(result.source.image.DSH_IMAGE_PLATFORM, 'linux/amd64');
});

test('legacy JSON migration retains selected data, origin and UID instead of injecting new public choices', t => {
  const root = fixture(t), path = join(root, '.local/site.json');
  const legacy = { dataRoot: '.local/data/old', home: '.local/data/old/custom-home', workspace: '.local/data/old/custom-workspace', publicOrigin: 'http://127.0.0.1:27913', port: 27913, containerUid: 2001, containerGid: 2002, plugins: [] };
  const bytes = JSON.stringify(legacy); writeFileSync(path, bytes);
  const { source } = loadSite(root, undefined, { imagePlatform: 'linux/arm64', desktop: true });
  assert.equal(readFileSync(path, 'utf8'), bytes); assert.equal(source.config.home, resolve(root, legacy.home));
  assert.equal(source.config.publicUrl, legacy.publicOrigin); assert.equal(source.config.containerUid, 2001);
  assert.deepEqual(source.config.plugins, []); assert.equal(source.config.host, undefined); assert.equal(source.config.mode, undefined);
  assert.equal(parseLiteralConfig(source.bytes.toString(), frameworkKeys).DSH_IMAGE_PLATFORM, '');
});

test('macOS initialization branch replaces generic user defaults only for a new private site', { skip: process.platform === 'win32' }, t => {
  const root = fixture(t);
  for (const [name, value] of [['platform', 'darwin'], ['getuid', () => 501], ['getgid', () => 20]]) {
    const descriptor = Object.getOwnPropertyDescriptor(process, name);
    Object.defineProperty(process, name, { value, configurable: true });
    t.after(() => descriptor ? Object.defineProperty(process, name, descriptor) : delete process[name]);
  }
  const result = loadSite(root, undefined, { imagePlatform: 'linux/arm64', desktop: true });
  assert.equal(result.source.config.containerUid, 501); assert.equal(result.source.config.containerGid, 20);
  assert.equal(result.source.image.DSH_IMAGE_PLATFORM, 'linux/arm64');
});
