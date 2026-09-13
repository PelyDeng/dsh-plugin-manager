/** 两类高频报错的识别与提示：识别不了就什么都不加，绝不改变失败本身。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseToolFailure } from '../src/build-diagnostics.mjs';

test('a duplicate module identity is explained instead of left as a bare TS2717', () => {
  const real = [
    "src/index.ts(12,3): error TS2717: Subsequent property declarations must have the same type.  Property 'ecosystem/catalog' must be of type '(accept: (entry: CatalogEntry) => void) => void', but here has type '(accept: (entry: CatalogEntry) => void) => void'.",
  ].join('\n');
  const hint = diagnoseToolFailure(real);
  assert.match(hint, /两条路径/u);
  assert.match(hint, /events\.ts/u);
  assert.match(hint, /declare module/u);
});

test('a source-only internal package is explained instead of left as MISSING_EXPORT', () => {
  const real = 'MISSING_EXPORT: "AgentParticipant" is not exported by "../../packages/common/src/index.d.ts"';
  const hint = diagnoseToolFailure(real);
  assert.match(hint, /源码相对路径|声明文件/u);
  assert.match(hint, /MISSING_EXPORT/u);
});

test('unrelated failures and empty output stay untouched', () => {
  assert.equal(diagnoseToolFailure(''), null);
  assert.equal(diagnoseToolFailure('   \n'), null);
  assert.equal(diagnoseToolFailure(undefined), null);
  assert.equal(diagnoseToolFailure('src/index.ts(3,1): error TS2304: Cannot find name "x".'), null);
  assert.equal(diagnoseToolFailure('pnpm typecheck 失败，退出码 2。'), null);
});
