import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { materializePluginConfigs } from '../src/site-inputs.mjs';

/** 插件声明 runtimeConfig 才需要运行配置文件；变量名取什么都不影响派生。 */
const plugin = (id, declared = true) => ({ id, ...(declared ? { runtimeConfig: { variable: `${id.toUpperCase()}_CONFIG`, required: true } } : {}) });
const ids = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plugin-config-'));
  return { root, home: join(root, '.local', 'data', 'dsh-home') };
}

test('站点配置里的插件业务配置派生到插件运行位置', t => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const section = { $comment: '业务配置', dsn: 'postgresql://user:pw@127.0.0.1:5432/db', nested: { flag: true } };
  const derived = materializePluginConfigs({ root, home, plugins: [plugin('sample')], site: { pluginConfig: { sample: section } }, ...ids });
  const file = join(home, 'plugins', 'sample', 'env.conf');
  assert.equal(derived.length, 1);
  assert.ok(existsSync(file), '派生文件必须落在插件默认运行位置');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), section);
});

test('站点配置里写了就以它为准：内容一致不重写，内容不同则覆盖', t => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(home, 'plugins', 'sample', 'env.conf');
  mkdirSync(join(home, 'plugins', 'sample'), { recursive: true });
  const section = { dsn: '站点值' };
  writeFileSync(file, JSON.stringify(section, null, 2) + '\n');
  assert.deepEqual(materializePluginConfigs({ root, home, plugins: [plugin('sample')], site: { pluginConfig: { sample: section } }, ...ids }), [],
    '内容一致时不重写，保留既有权限与属主');
  writeFileSync(file, '{"dsn":"现场旧值"}\n');
  assert.deepEqual(materializePluginConfigs({ root, home, plugins: [plugin('sample')], site: { pluginConfig: { sample: section } }, ...ids }), [file]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), section, '改了站点配置必须生效');
});

test('没有写进站点配置的插件沿用现场文件', t => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(home, 'plugins', 'sample', 'env.conf');
  mkdirSync(join(home, 'plugins', 'sample'), { recursive: true });
  writeFileSync(file, '{"dsn":"现场值"}\n');
  assert.deepEqual(materializePluginConfigs({ root, home, plugins: [plugin('sample')], site: { pluginConfig: { other: { dsn: 'x' } } }, ...ids }), []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { dsn: '现场值' });
});

test('没有运行配置声明或没有站点条目的插件都不派生', t => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const derived = materializePluginConfigs({ root, home, ...ids,
    plugins: [plugin('undeclared', false), plugin('absent'), plugin('present')],
    site: { pluginConfig: { undeclared: { dsn: 'x' }, present: { dsn: 'y' } } } });
  assert.equal(derived.length, 1);
  assert.ok(existsSync(join(home, 'plugins', 'present', 'env.conf')));
  assert.ok(!existsSync(join(home, 'plugins', 'undeclared')), '未声明运行配置的插件不产生文件');
  assert.ok(!existsSync(join(home, 'plugins', 'absent')), '站点配置里没有条目的插件不产生文件');
});

test('实例显式引用的路径优先于默认位置', t => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const explicit = resolve(root, '.local/config/plugins/sample/env.conf');
  const derived = materializePluginConfigs({ root, home, plugins: [plugin('sample')], site: { pluginConfig: { sample: { dsn: 'z' } }, instances: { sample: { runtimeConfig: explicit } } }, ...ids });
  assert.deepEqual(derived, [explicit]);
  assert.deepEqual(JSON.parse(readFileSync(explicit, 'utf8')), { dsn: 'z' });
});

test('多个插件各派生到自己的位置，内容互不串台', t => {
  const { root, home } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const derived = materializePluginConfigs({ root, home, plugins: [plugin('first'), plugin('second')], ...ids,
    site: { pluginConfig: { first: { dsn: 'first-dsn' }, second: { dsn: 'second-dsn' } } } });
  assert.equal(derived.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'plugins', 'first', 'env.conf'), 'utf8')), { dsn: 'first-dsn' });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'plugins', 'second', 'env.conf'), 'utf8')), { dsn: 'second-dsn' });
});
