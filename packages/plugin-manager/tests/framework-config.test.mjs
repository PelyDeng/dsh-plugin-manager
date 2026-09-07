import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFrameworkConfig, renderFrameworkConfig, frameworkKeys, imageDefaults } from '../src/framework-config.mjs';
import { parseLiteralConfig } from '../src/literal-config.mjs';

test('public template contains every documented key, with no configured values', () => {
  const text = renderFrameworkConfig();
  const values = parseLiteralConfig(text, frameworkKeys);
  assert.equal(Object.keys(values).length, frameworkKeys.size);
  assert.ok(Object.values(values).every(value => value === ''));
  assert.deepEqual(decodeFrameworkConfig(text), { config: {}, image: imageDefaults, credentials: {} });
});

test('migration preserves structured options and private values without interpolating them', () => {
  const value = { config: { plugins: [], instances: { sample: { runtimeConfig: '中文 目录/env.conf', configRevision: 2 } }, port: 7902, offline: false, publicUrl: 'https://dsh.example.com', publicOrigin: 'https://dsh.example.com' },
    image: { ...imageDefaults, REGISTRY_PASSWORD: 'private-$value' }, credentials: { ZHIPU_API_KEY: 'private.$value' } };
  assert.deepEqual(decodeFrameworkConfig(renderFrameworkConfig(value)), value);
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
