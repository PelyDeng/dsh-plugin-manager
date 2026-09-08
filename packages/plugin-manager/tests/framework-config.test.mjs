import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFrameworkConfig, renderFrameworkConfig, frameworkKeys, imageDefaults, publicDeploymentDefaults, assertPublicFrameworkConfig } from '../src/framework-config.mjs';
import { parseLiteralConfig } from '../src/literal-config.mjs';

test('public template records exact fixed defaults and leaves secrets, derived paths and generated fields empty', () => {
  const text = renderFrameworkConfig();
  const values = parseLiteralConfig(text, frameworkKeys);
  assert.equal(Object.keys(values).length, frameworkKeys.size);
  assertPublicFrameworkConfig(text);
  assert.equal(readFileSync(new URL('../../../env.conf', import.meta.url), 'utf8').replaceAll('\r\n', '\n'), text);
  assert.deepEqual(decodeFrameworkConfig(text), { config: { ...publicDeploymentDefaults, publicOrigin: publicDeploymentDefaults.publicUrl }, image: imageDefaults, credentials: {} });
  for (const key of ['DEEPSEEK_API_KEY', 'ZHIPU_API_KEY', 'REGISTRY_USERNAME', 'REGISTRY_PASSWORD', 'DSH_PUBLIC_ORIGIN', 'DSH_HOME', 'DSH_WORKSPACE', 'DSH_AUTH_URL_FILE', 'DSH_HOST_IMAGE', 'DSH_CONTAINER_IMAGE', 'DSH_MANIFEST']) assert.equal(values[key], '');
  assert.equal(values.DSH_CONTAINER_UID, '1000'); assert.equal(values.DSH_IMAGE_PLATFORM, 'linux/amd64');
});

test('migration preserves structured options and private values without interpolating them', () => {
  const value = { config: { plugins: [], instances: { sample: { runtimeConfig: '中文 目录/env.conf', configRevision: 2 } }, port: 7902, offline: false, publicUrl: 'https://dsh.example.com', publicOrigin: 'https://dsh.example.com' },
    image: { ...imageDefaults, REGISTRY_PASSWORD: 'private-$value' }, credentials: { ZHIPU_API_KEY: 'private.$value' } };
  assert.deepEqual(decodeFrameworkConfig(renderFrameworkConfig({ ...value, privateInput: true })), value);
});

test('invalid typed input rejects without exposing private values', () => {
  for (const text of ['DSH_PORT=private-value', 'DSH_OFFLINE=private-value', 'DSH_PLUGINS={"private-value":true}', 'DSH_INSTANCES=private-value']) {
    assert.throws(() => decodeFrameworkConfig(text), error => !error.message.includes('private-value'));
  }
  assert.deepEqual(decodeFrameworkConfig('DEEPSEEK_API_KEY=\nZHIPU_API_KEY=\n').credentials, {});
});

test('instance references do not absorb plugin business configuration', () => {
  for (const instances of [{ sample: { apiKey: 'private-sentinel' } }, { sample: { runtimeConfig: 3 } }, { sample: { configRevision: -1 } }, { '../invalid': {} }]) {
    assert.throws(() => decodeFrameworkConfig(renderFrameworkConfig({ config: { instances } })), error => !error.message.includes('private-sentinel'));
  }
  assert.throws(() => decodeFrameworkConfig('DSH_PATCHES=[true]'), /非空字符串/);
  assert.match(renderFrameworkConfig({ privateInput: true }), /私有运行配置/);
});

test('public config guard refuses configured credentials, nondefault environment values and missing or duplicate fields', () => {
  const template = renderFrameworkConfig();
  for (const [key, value] of [['DEEPSEEK_API_KEY', 'private-sentinel'], ['REGISTRY_PASSWORD', 'private-sentinel'], ['REGISTRY_USERNAME', 'private-sentinel'], ['DSH_PUBLIC_URL', 'https://private-sentinel.example'], ['DSH_PORT', '27913'], ['DSH_IMAGE_PLATFORM', 'linux/arm64'], ['DSH_CONTAINER_IMAGE', 'private-sentinel'], ['DSH_PLUGINS', '["private-sentinel"]']]) {
    const text = template.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
    assert.throws(() => assertPublicFrameworkConfig(text), error => error.message.includes('公开env.conf') && !error.message.includes('private-sentinel'));
  }
  assert.throws(() => assertPublicFrameworkConfig('DEEPSEEK_API_KEY=\n'));
  assert.throws(() => assertPublicFrameworkConfig(template + 'DSH_PORT=7902\n'));
  assert.throws(() => assertPublicFrameworkConfig(template + 'UNKNOWN_SECRET=private-sentinel\n'), error => !error.message.includes('private-sentinel'));
  const privateEmpty = parseLiteralConfig(renderFrameworkConfig({ privateInput: true }), frameworkKeys);
  assert.ok(Object.values(privateEmpty).every(value => value === ''), 'private migration must not add public defaults');
});
