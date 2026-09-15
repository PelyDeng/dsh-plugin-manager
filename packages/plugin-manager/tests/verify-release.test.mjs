/** 发布目录校验必须独立可跑：合规放行、被篡改的产物必须报错且退出码非 0。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { formatReport, verifyRelease } from '../src/verify-release.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const repository = fileURLToPath(new URL('../../..', import.meta.url));

function pack(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-verify-release-'));
  t.after(() => { assert.equal(dirname(root), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); });
  const output = join(root, 'release');
  const packed = spawnSync(process.execPath, [cli, 'pack', '--root', repository, '--plugins', 'example', '--output', output], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  return { root, output };
}

test('完整的发布目录通过校验', t => {
  const f = pack(t);
  const result = verifyRelease(join(f.output, 'manifest.json'));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].id, 'example');
  assert.match(result.plugins[0].archive, /\.tgz$/);
  assert.match(formatReport([result]), /全部合规/);
});

test('归档被改动后按摘要报不合规，而不是靠文件名判断', t => {
  const f = pack(t);
  const archive = readdirSync(f.output).find(name => name.endsWith('.tgz'));
  appendFileSync(join(f.output, archive), 'tampered');
  const result = verifyRelease(join(f.output, 'manifest.json'));
  assert.equal(result.ok, false);
  assert.match(result.error, /摘要不匹配/);
  assert.match(formatReport([result]), /1 个不合规/);
});

test('清单缺失时按路径报错，不抛未处理异常', t => {
  const f = pack(t);
  const result = verifyRelease(join(f.root, 'missing', 'manifest.json'));
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
});

test('--release 必须精确指向含根 manifest.json 的目录，不递归猜测', t => {
  const f = pack(t);
  // f.root 本身没有 manifest.json（它在 f.output），即使子目录里有也不能递归去找。
  const result = spawnSync(process.execPath, [cli, 'verify-release', '--release', f.root], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest\.json/);
});

test('多目录一次报告，任一不合规即整体非零退出码', t => {
  const f = pack(t);
  const bad = join(f.root, 'bad'); cpSync(f.output, bad, { recursive: true });
  const archive = readdirSync(bad).find(name => name.endsWith('.tgz'));
  appendFileSync(join(bad, archive), 'tampered');
  const result = spawnSync(process.execPath, [cli, 'verify-release', '--release', f.output, '--release', bad], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /1 个不合规/);
});

test('CLI 全部合规时退出码为 0，未知参数明确报错', t => {
  const f = pack(t);
  const pass = spawnSync(process.execPath, [cli, 'verify-release', '--release', f.output], { encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /全部合规/);
  const unknown = spawnSync(process.execPath, [cli, 'verify-release', '--release', f.output, '--typo'], { encoding: 'utf8' });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /未知参数/);
});
