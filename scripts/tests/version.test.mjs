import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { frameworkPackages, frameworkVersion, versionTemplates } from '../version.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'framework version 中文 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, content) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), content); };
  write('package.json', '{"private":true,"version":"0.13.0"}\n');
  for (const name of frameworkPackages) write(name, '{"version":"0.12.1","custom":"keep"}\n');
  for (const name of versionTemplates) write(name, '# 文档\n\n当前 {{FRAMEWORK_VERSION}}，归档 tool-{{FRAMEWORK_VERSION}}.tgz；从 0.3.3 开始支持。\n');
  write('plugins/custom/package.json', '{"version":"9.8.7"}\n');
  return { root, write, read: name => readFileSync(join(root, name), 'utf8') };
}

test('one version produces matching packages and readable docs without touching custom plugins or history', t => {
  const f = fixture(t);
  frameworkVersion(f.root, { mode: 'sync' });
  for (const name of frameworkPackages) assert.deepEqual(JSON.parse(f.read(name)), { version: '0.13.0', custom: 'keep' });
  for (const name of versionTemplates) {
    const output = f.read(name.slice(0, -5));
    assert.match(output, /当前 0\.13\.0，归档 tool-0\.13\.0\.tgz；从 0\.3\.3 开始支持/);
    assert.doesNotMatch(output, /\{\{FRAMEWORK_VERSION\}\}/);
    assert.match(f.read(name), /\{\{FRAMEWORK_VERSION\}\}/);
  }
  assert.equal(f.read('plugins/custom/package.json'), '{"version":"9.8.7"}\n');
  assert.equal(frameworkVersion(f.root).version, '0.13.0');
  assert.deepEqual(frameworkVersion(f.root, { mode: 'sync' }).changed, []);
  frameworkVersion(f.root, { mode: 'set', version: '0.14.0' });
  assert.equal(JSON.parse(f.read('package.json')).version, '0.14.0');
  assert.equal(frameworkVersion(f.root).version, '0.14.0');
});

test('check detects package and generated document drift without repairing files', t => {
  const f = fixture(t);
  frameworkVersion(f.root, { mode: 'sync' });
  f.write(frameworkPackages[2], '{"version":"0.12.1"}\n');
  f.write('doc/getting-started.md', 'stale documentation\n');
  assert.throws(() => frameworkVersion(f.root), /plugins\/dsh-auth\/package.json[\s\S]*doc\/getting-started.md/);
  assert.equal(f.read('doc/getting-started.md'), 'stale documentation\n');
  assert.equal(JSON.parse(f.read(frameworkPackages[2])).version, '0.12.1');
});

test('invalid templates and versions fail before any writes; versions cannot go backwards', t => {
  const f = fixture(t);
  const before = f.read('package.json');
  f.write(versionTemplates.at(-1), '{{FRAMEWORK_VERSION}} {{MISSPELLED_VERSION}}\n');
  assert.throws(() => frameworkVersion(f.root, { mode: 'set', version: '0.14.0' }), /未知版本模板变量/);
  assert.equal(f.read('package.json'), before);
  assert.equal(JSON.parse(f.read(frameworkPackages[0])).version, '0.12.1');
  for (const version of ['latest', '01.13.0', '0.14.0-beta.1', '${VERSION}', undefined]) {
    assert.throws(() => frameworkVersion(f.root, { mode: 'set', version }), /稳定版本/);
  }
  assert.throws(() => frameworkVersion(f.root, { mode: 'set', version: '0.5.0' }), /不能倒退/);
  f.write(frameworkPackages[0], '{"version":"0.14.0"}\n');
  assert.throws(() => frameworkVersion(f.root, { mode: 'sync' }), /低于/);
  assert.equal(f.read('package.json'), before);
});

test('CRLF checkout is accepted and the caller supplies the repository root', t => {
  const f = fixture(t);
  frameworkVersion(f.root, { mode: 'sync' });
  for (const name of [...frameworkPackages, ...versionTemplates.map(name => name.slice(0, -5))]) {
    f.write(name, f.read(name).replaceAll('\n', '\r\n'));
  }
  assert.deepEqual(frameworkVersion(f.root).changed, []);
});
