/** 公开构建元数据的交付：逐字节、来自同一份公共输入、材料缺失或不匹配时明确失败。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverPublicInputs, INPUT_DIRECTORY, locatePublicInput, verifyDeliveredInputs } from '../deliver-public-inputs.mjs';

const VERSION = '0.17.0';
const FILES = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];

function fixture(t, { version = VERSION, external = false, crlf = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-public-inputs-'));
  t.after(() => { rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'private'); mkdirSync(root);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'private-integration', version: VERSION }, null, 2)}\n`);
  const source = join(base, 'public'); mkdirSync(source);
  writeFileSync(join(source, 'package.json'), `${JSON.stringify({ name: 'dsh-plugin-manager-workspace', version }, null, 2)}\n`);
  writeFileSync(join(source, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'plugins/builtin/*'\n  - 'plugins/external/*'\n");
  writeFileSync(join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  if (external) mkdirSync(join(source, 'plugins/external'), { recursive: true });
  // Windows 检出常见形态：工作区是 CRLF，而 Git 索引/干净检出是 LF。
  if (crlf) for (const name of FILES) writeFileSync(join(source, name), readFileSync(join(source, name), 'utf8').replace(/\n/gu, '\r\n'));
  return { base, root, source };
}

test('交付逐字节复制三个文件并记录来源摘要', t => {
  const f = fixture(t);
  const record = deliverPublicInputs({ root: f.root, source: f.source });
  for (const name of FILES) {
    assert.deepEqual(readFileSync(join(f.root, INPUT_DIRECTORY, name)), readFileSync(join(f.source, name)), name);
  }
  assert.equal(record.frameworkVersion, VERSION);
  assert.equal(record.sourceKind, 'release');
  assert.equal(record.newline, 'lf');
  const written = JSON.parse(readFileSync(join(f.root, INPUT_DIRECTORY, 'input.json'), 'utf8'));
  assert.deepEqual(Object.keys(written.files).sort(), [...FILES].sort());
  assert.match(written.files['pnpm-lock.yaml'], /^[a-f0-9]{64}$/u);
});

test('CRLF 来源按 LF 交付，记录与干净 LF 检出一致', t => {
  const f = fixture(t, { crlf: true });
  const record = deliverPublicInputs({ root: f.root, source: f.source });
  for (const name of FILES) {
    const delivered = readFileSync(join(f.root, INPUT_DIRECTORY, name), 'utf8');
    assert.equal(delivered.includes('\r'), false, `${name} 必须以 LF 交付`);
  }
  // 工作区（CRLF 来源）校验通过。
  assert.equal(verifyDeliveredInputs(f.root).frameworkVersion, VERSION);
  // 模拟 Git 干净检出：三件套是 LF 的同一份字节，摘要仍然一致。
  assert.equal(readFileSync(join(f.root, INPUT_DIRECTORY, 'pnpm-workspace.yaml'), 'utf8'), readFileSync(join(f.source, 'pnpm-workspace.yaml'), 'utf8').replace(/\r\n/gu, '\n'));
  assert.equal(verifyDeliveredInputs(f.root).files['pnpm-workspace.yaml'], record.files['pnpm-workspace.yaml']);
});

test('记录与交付物不一致、缺失或版本不符时校验失败', t => {
  const f = fixture(t, { crlf: true });
  deliverPublicInputs({ root: f.root, source: f.source });
  // 真正的字节改动必须被发现（换行差异不算改动）。
  const lock = join(f.root, INPUT_DIRECTORY, 'pnpm-lock.yaml');
  writeFileSync(lock, `${readFileSync(lock, 'utf8')}# tampered\n`);
  assert.throws(() => verifyDeliveredInputs(f.root), /与记录不一致：pnpm-lock\.yaml/);
  deliverPublicInputs({ root: f.root, source: f.source });
  rmSync(join(f.root, INPUT_DIRECTORY, 'input.json'));
  assert.throws(() => verifyDeliveredInputs(f.root), /缺少交付记录.*deliver-public-inputs\.mjs/u);
  deliverPublicInputs({ root: f.root, source: f.source });
  const recordPath = join(f.root, INPUT_DIRECTORY, 'input.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  writeFileSync(recordPath, `${JSON.stringify({ ...record, frameworkVersion: '0.16.0' }, null, 2)}\n`);
  assert.throws(() => verifyDeliveredInputs(f.root), /版本（0\.16\.0）与框架版本（0\.17\.0）不一致/);
  writeFileSync(recordPath, `${JSON.stringify({ ...record, newline: 'crlf' }, null, 2)}\n`);
  assert.throws(() => verifyDeliveredInputs(f.root), /换行规则无法识别/);
});

test('缺失、私有来源与版本不一致都明确失败且不落盘', t => {
  const f = fixture(t);
  assert.throws(() => deliverPublicInputs({ root: f.root, source: join(f.base, 'absent') }), /公共输入不存在/);
  rmSync(join(f.source, 'pnpm-lock.yaml'));
  assert.throws(() => deliverPublicInputs({ root: f.root, source: f.source }), /公共输入不完整/);
  const foreign = fixture(t, { external: true });
  assert.throws(() => deliverPublicInputs({ root: foreign.root, source: foreign.source }), /不是公共框架输入/);
  const stale = fixture(t, { version: '0.16.0' });
  assert.throws(() => deliverPublicInputs({ root: stale.root, source: stale.source }), /与本仓库框架版本/);
  assert.equal(existsSync(join(stale.root, INPUT_DIRECTORY, 'package.json')), false);
});

test('发行目录布局（source/ 与 tools/builtin-build/）同样可交付', t => {
  const f = fixture(t);
  const bundle = join(f.base, 'bundle');
  mkdirSync(join(bundle, 'tools/builtin-build'), { recursive: true });
  mkdirSync(join(bundle, 'source'));
  writeFileSync(join(bundle, 'source/package.json'), readFileSync(join(f.source, 'package.json')));
  for (const name of FILES) writeFileSync(join(bundle, 'tools/builtin-build', name), readFileSync(join(f.source, name)));
  assert.equal(locatePublicInput(bundle).directory, join(bundle, 'tools/builtin-build'));
  const record = deliverPublicInputs({ root: f.root, source: bundle });
  assert.equal(record.frameworkVersion, VERSION);
  assert.deepEqual(readFileSync(join(f.root, INPUT_DIRECTORY, 'pnpm-lock.yaml')), readFileSync(join(f.source, 'pnpm-lock.yaml')));
});

test('公共检出带未提交改动时拒绝交付，除非显式允许并记录该差异', t => {
  const f = fixture(t);
  const git = (...args) => execFileSync('git', [...args], { cwd: f.source, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'add', '-A');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'public input');
  const clean = deliverPublicInputs({ root: f.root, source: f.source });
  assert.equal(clean.sourceKind, 'checkout');
  assert.match(clean.sourceCommit, /^[a-f0-9]{40}$/u);
  assert.deepEqual(clean.sourceModified, []);
  writeFileSync(join(f.source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/plugin-kit: {}\n");
  assert.throws(() => deliverPublicInputs({ root: f.root, source: f.source }), /与 .* 的记录不同/);
  assert.equal(readFileSync(join(f.root, INPUT_DIRECTORY, 'pnpm-lock.yaml'), 'utf8'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  const dirty = deliverPublicInputs({ root: f.root, source: f.source, allowDirty: true });
  assert.deepEqual(dirty.sourceModified, ['pnpm-lock.yaml']);
  assert.match(readFileSync(join(f.root, INPUT_DIRECTORY, 'pnpm-lock.yaml'), 'utf8'), /packages\/plugin-kit/);
});
