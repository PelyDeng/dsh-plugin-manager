/** 真实 Git 历史与真实归档字节检验「管理器工具能否复用」的判定边界。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveToolingReuse } from '../../../deploy/scripts/tooling-reuse.mjs';
import { managerToolInputsHash } from '../../../scripts/manager-tooling.mjs';

const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tooling-reuse-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gitAt = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  gitAt(root, ['init']);
  gitAt(root, ['config', 'user.name', 'Fixture']);
  gitAt(root, ['config', 'user.email', 'fixture@example.invalid']);
  save(join(root, 'package.json'), { name: 'dsh-plugin-manager-workspace', private: true, packageManager: 'pnpm@11.19.0' });
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  save(join(root, 'packages/plugin-kit/package.json'), { name: '@dsh-plugin-manager/plugin-kit', version: '0.0.1' });
  writeFileSync(join(root, 'packages/plugin-kit/index.ts'), 'export const kit = 1\n');
  save(join(root, 'packages/plugin-manager/package.json'), { name: '@dsh-plugin-manager/plugin-manager', version: '0.0.1' });
  writeFileSync(join(root, 'packages/plugin-manager/index.mjs'), 'export const manager = 1\n');
  mkdirSync(join(root, 'plugins/alpha'), { recursive: true });
  writeFileSync(join(root, 'plugins/alpha/index.mjs'), 'export const alpha = 1\n');
  const git = args => gitAt(root, args);
  const commit = message => { git(['add', '.']); git(['commit', '-qm', message]); return git(['rev-parse', 'HEAD']); };
  const revision = commit('基线');

  // 上一次成功发布：工具归档 + 记录里的输入哈希与摘要。
  const bytes = Buffer.from('fixture manager archive\n');
  const operation = join(root, '.local/artifacts/release-1');
  const archive = join(operation, 'tooling/plugin-manager.tgz');
  mkdirSync(dirname(archive), { recursive: true });
  writeFileSync(archive, bytes);
  save(join(root, '.local/source-release.json'), { schemaVersion: 3, operation, status: 'ready' });
  save(join(operation, 'result.json'), { schemaVersion: 3, operation, status: 'ready', inputKind: 'source',
    managerArchive: archive, managerHash: digest(bytes), managerInputs: managerToolInputsHash(git, revision) });
  return { root, archive, bytes, git, revision,
    resolve: () => resolveToolingReuse({ root, git, revision: git(['rev-parse', 'HEAD']) }),
    commit,
    reset: () => git(['checkout', '--', '.']),
  };
}

test('unchanged manager inputs reuse the verified archive of the last successful release', t => {
  const f = fixture(t);
  const decision = f.resolve();
  assert.equal(decision.inputs, managerToolInputsHash(f.git, f.revision));
  assert.equal(decision.reuse.sha256, digest(f.bytes));
  assert.equal(f.readFile?.(decision.reuse.archive) ?? readFileSync(decision.reuse.archive).equals(f.bytes), true);
});

test('changes outside the manager inputs keep the archive reusable', t => {
  const f = fixture(t);
  // 插件源码与文档都不是管理器工具的输入：这次发布仍可复用归档。
  writeFileSync(join(f.root, 'plugins/alpha/index.mjs'), 'export const alpha = 2\n');
  writeFileSync(join(f.root, 'README.md'), '文档改动\n');
  f.commit('插件与文档改动');
  assert.ok(f.resolve().reuse);
});

test('changes inside the manager inputs force a rebuild, with the reason reported', t => {
  const f = fixture(t);
  for (const [path, text] of [
    ['packages/plugin-manager/index.mjs', 'export const manager = 2\n'],
    ['packages/plugin-kit/index.ts', 'export const kit = 2\n'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9.0\nsettings: {}\n'],
    ['package.json', JSON.stringify({ name: 'dsh-plugin-manager-workspace', private: true, packageManager: 'pnpm@11.19.0', engines: { node: '>=22' } }, null, 2) + '\n'],
  ]) {
    writeFileSync(join(f.root, path), text);
    f.commit(`${path} 改动`);
    const decision = f.resolve();
    assert.equal(decision.reuse, null, `${path} 必须让归档不可复用`);
    assert.match(decision.reason, /构建输入已变化/u);
  }
});

test('a missing, damaged or unrecorded baseline cannot be reused', t => {
  const f = fixture(t);
  const recordPath = join(f.root, '.local/artifacts/release-1/result.json');
  const original = JSON.parse(readFileSync(recordPath, 'utf8'));

  writeFileSync(f.archive, Buffer.concat([f.bytes, Buffer.from('tampered')]));
  assert.match(f.resolve().reason, /摘要不一致/u);
  writeFileSync(f.archive, f.bytes);
  assert.ok(f.resolve().reuse);

  rmSync(f.archive);
  assert.match(f.resolve().reason, /已不存在/u);
  writeFileSync(f.archive, f.bytes);

  for (const [change, pattern] of [
    [record => { delete record.managerInputs; }, /没有记下管理器输入哈希/u],
    [record => { record.managerInputs = 'not-a-hash'; }, /没有记下管理器输入哈希/u],
    [record => { delete record.managerHash; }, /缺少管理器归档身份/u],
    [record => { record.status = 'deployment-failed'; }, /记录不可用/u],
  ]) {
    const record = structuredClone(original); change(record); save(recordPath, record);
    assert.match(f.resolve().reason, pattern);
  }
  save(recordPath, original);
  appendFileSync(recordPath, '\n');
  assert.ok(f.resolve().reuse, `记录内容不受无关格式影响时仍可复用：${f.resolve().reason}`);

  save(join(f.root, '.local/source-release.json'), { schemaVersion: 3, operation: join(f.root, '.local/artifacts/missing'), status: 'ready' });
  assert.match(f.resolve().reason, /记录不可用/u);
  rmSync(join(f.root, '.local/source-release.json'));
  assert.match(f.resolve().reason, /没有上一次发布记录/u);
});
