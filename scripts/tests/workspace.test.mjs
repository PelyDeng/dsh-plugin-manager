/** 仓库入口的选集核验必须先于任何构建：缺值参数不能先跑完一次共享包构建再报错（设计 7.4 第 2 项）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = args => spawnSync(process.execPath, ['scripts/workspace.mjs', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 300000 });

test('an incomplete --plugins value fails before any build output', () => {
  const result = run(['build', '--external', '--plugins']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /无效或重复参数：--plugins/);
  assert.equal(result.stdout.trim(), '', '参数校验失败不得先构建共享包');
});

test('an unknown plugin id fails before any build output', () => {
  const result = run(['build', '--plugins', 'ghost-plugin']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /未知插件：ghost-plugin/);
  assert.equal(result.stdout.trim(), '', '未知 ID 不得先构建共享包');
});

// 这一条在收紧之前也成立（旧实现只看参数名是否存在）；保留它作为回归保护，但它不证明本轮修复。
test('--external without a selection stays rejected before any build output', () => {
  const result = run(['check', '--external']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /--external 必须显式给出插件选集/);
  assert.equal(result.stdout.trim(), '', '选集缺失不得先构建共享包');
});

test('--help is answered without validation or build', () => {
  for (const args of [['build', '--help'], ['--help']]) {
    const result = run(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stdout, /build {2}\[--root <项目根>]/);
    assert.equal(result.stderr.trim(), '');
  }
});
