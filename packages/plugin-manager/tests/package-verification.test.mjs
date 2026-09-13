/**
 * 归档核验按内容摘要复用。
 *
 * 核验一个发布包要跑三遍 tar（列表、类型、成员），24MB 的包约 3 秒；而一次发布里同一份归档
 * 会被核验好几遍（上一次发布的清单、本次合并后的清单、复用判定各读一次）。这里钉住三件事：
 * 同样的字节只解包一次、命中返回的是副本、字节变了必须重解。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadRelease } from '../src/release.mjs';
import { tarCommand } from '../src/state.mjs';
import { verificationStats } from '../src/verify-package.mjs';

const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');

/** 造一份最小发布：一个插件归档 + 引用它的清单。 */
function release(root, { id = 'alpha', body = 'export const name = "alpha";\n' } = {}) {
  const stage = join(root, 'stage', 'package');
  mkdirSync(stage, { recursive: true });
  const metadata = { name: `fixture-${id}`, version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } }, deepseekPlugin: { schemaVersion: 3, id } };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(metadata));
  writeFileSync(join(stage, 'index.js'), body);
  writeFileSync(join(stage, 'cordis.patch.yml'), '{}\n');
  const archive = `${id}.tgz`;
  const packed = spawnSync(tarCommand, ['-czf', join(root, archive), '-C', dirname(stage), 'package']);
  assert.equal(packed.status, 0, packed.stderr?.toString());
  const path = join(root, 'manifest.json');
  json(path, { schemaVersion: 1, plugins: [{ id, package: metadata.name, version: '1.0.0', directory: `plugins/${id}`,
    archive, sha256: digest(join(root, archive)), verifyFiles: ['package.json', 'index.js', 'cordis.patch.yml'] }] });
  return path;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-verify-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('identical archive bytes are inspected once and returned as a copy', t => {
  const root = fixture(t), manifest = release(root);
  const loaded = loadRelease(manifest);
  const first = verificationStats();
  assert.equal(first.inspected, 1, '第一次必须真的解包核验');

  // 同一份清单再读一遍：摘要刚核对过，字节相同，判定结论必然相同，不必再解包。
  assert.deepEqual(loadRelease(manifest).plugins.map(plugin => plugin.package), ['fixture-alpha']);
  const second = verificationStats();
  assert.equal(second.inspected, first.inspected, '同一份归档不该再解包');
  assert.equal(second.reused, first.reused + 1, '第二次应当命中复用');

  // 命中返回的是副本：调用方改动缓存里的对象不会影响下一次核验。
  loadRelease(manifest).plugins[0].package = 'mutated';
  assert.equal(loadRelease(manifest).plugins[0].package, 'fixture-alpha');

  // 打包流程会先写 fresh/，再把同样的归档合并到 plugins/：字节相同，同样只核验一次。
  const composed = join(root, 'composed'); mkdirSync(composed);
  copyFileSync(join(root, 'alpha.tgz'), join(composed, 'alpha.tgz'));
  copyFileSync(manifest, join(composed, 'manifest.json'));
  assert.deepEqual(loadRelease(join(composed, 'manifest.json')).plugins.map(plugin => plugin.id), ['alpha']);
  assert.equal(verificationStats().inspected, first.inspected, '同一份字节换一份清单引用仍不该重解');

  assert.ok(loaded.plugins[0].archivePath.endsWith('alpha.tgz'));
});

test('changed archive bytes are inspected again', t => {
  const root = fixture(t), manifest = release(root);
  loadRelease(manifest);
  const before = verificationStats();

  const changed = join(root, 'changed'); mkdirSync(changed);
  const rebuilt = release(changed, { body: 'export const name = "changed";\n' });
  assert.notEqual(digest(join(changed, 'alpha.tgz')), digest(join(root, 'alpha.tgz')));
  loadRelease(rebuilt);
  assert.equal(verificationStats().inspected, before.inspected + 1, '内容摘要不同的归档必须重新核验');

  // 摘要对不上时在核验之前就失败，不会被复用表掩盖。
  const tampered = JSON.parse(readFileSync(rebuilt, 'utf8'));
  tampered.plugins[0].sha256 = 'f'.repeat(64);
  json(rebuilt, tampered);
  assert.throws(() => loadRelease(rebuilt), /摘要不匹配/);
});
