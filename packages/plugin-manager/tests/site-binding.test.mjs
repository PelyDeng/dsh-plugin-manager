/** 稳定站点绑定只认一次性写入的事实：路径变化、标记缺失或属于其他站点都要在写入前失败。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertBindingMatches, assertSiteMarks, initializeBinding, readBinding, resolveSiteIdentity, SITE_MARK, BINDING } from '../src/site-binding.mjs';

const resolved = root => ({
  dataRoot: join(root, '.local/data'),
  home: join(root, '.local/data/dsh-home'),
  workspace: join(root, '.local/data/workspace'),
  authUrlFile: join(root, '.local/data/dsh-web-auth-url.txt'),
  artifacts: join(root, '.local/artifacts'),
  profile: 'web',
  composeProject: 'web',
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('new site binding writes one mark per distinct persistent root', t => {
  const root = fixture(t);
  const binding = initializeBinding(root, resolved(root), 'site-abc');
  assert.equal(readBinding(root).siteId, 'site-abc');
  // home/workspace 都在 dataRoot 内：标记只写一次，不与 dataRoot 重复。
  assert.equal(existsSync(join(root, '.local/data', SITE_MARK)), true);
  assert.equal(existsSync(join(root, '.local/artifacts', SITE_MARK)), true);
  assert.equal(binding.composeProject, 'web');
});

test('bound paths must match the current resolution exactly', t => {
  const root = fixture(t);
  initializeBinding(root, resolved(root), 'site-abc');
  assert.doesNotThrow(() => assertBindingMatches(root, resolved(root), 'web'));
  assert.throws(() => assertBindingMatches(root, { ...resolved(root), home: join(root, 'elsewhere') }, 'web'), /绑定 home/);
  assert.throws(() => assertBindingMatches(root, resolved(root), 'other-project'), /composeProject/);
});

test('identity resolution refuses a config siteId that contradicts the binding', t => {
  const root = fixture(t);
  initializeBinding(root, resolved(root), 'site-abc');
  // 绑定在时，配置声明的 siteId 必须与它一致：否则本次会拿着别人的身份去写授权集合。
  assert.equal(resolveSiteIdentity(root, 'site-abc'), 'site-abc');
  assert.equal(resolveSiteIdentity(root), 'site-abc');
  assert.throws(() => resolveSiteIdentity(root, 'site-other'), /不一致/);
});

test('marks missing or owned by another site fail before writes', t => {
  const root = fixture(t);
  const binding = initializeBinding(root, resolved(root), 'site-abc');
  rmSync(join(root, '.local/artifacts', SITE_MARK));
  assert.throws(() => assertSiteMarks(binding), /缺少站点标记/);
  writeFileSync(join(root, '.local/artifacts', SITE_MARK), 'site-other\n');
  assert.throws(() => assertSiteMarks(binding), /其他站点/);
});

test('a bound persistent directory that disappeared is refused, never recreated', t => {
  const root = fixture(t);
  const binding = initializeBinding(root, resolved(root), 'site-abc');
  // workspace 里可能有用户文件：绑定之后就属于「原目录缺失」，不能当成可再生目录补建（设计 5.1）。
  rmSync(join(root, '.local/data/workspace'), { recursive: true, force: true });
  assert.throws(() => assertSiteMarks(binding), /持久目录缺失/);
  assert.equal(existsSync(join(root, '.local/data/workspace')), false);
  mkdirSync(join(root, '.local/data/workspace'));
  rmSync(join(root, '.local/artifacts'), { recursive: true, force: true });
  assert.throws(() => assertSiteMarks(binding), /持久目录缺失/);
  // 迁移重入可以补写标记，但目录仍然必须存在。
  assert.throws(() => assertSiteMarks(binding, { allowMissingMarks: true }), /持久目录缺失/);
  mkdirSync(join(root, '.local/artifacts'));
  assert.doesNotThrow(() => assertSiteMarks(binding, { allowMissingMarks: true }));
  assert.throws(() => assertSiteMarks(binding), /缺少站点标记/);
  // rebind 只核对仍在场的旧位置：物理搬迁后旧目录可以不在。
  assert.doesNotThrow(() => assertSiteMarks({ ...binding, artifacts: join(root, 'moved/artifacts') }, { requireData: false }));
});

test('malformed or tampered binding files are rejected instead of regenerated', t => {
  const root = fixture(t);
  initializeBinding(root, resolved(root), 'site-abc');
  writeFileSync(join(root, BINDING), '{broken');
  assert.throws(() => readBinding(root), SyntaxError);
  writeFileSync(join(root, BINDING), JSON.stringify({ schemaVersion: 1, siteId: 'x', root: join(root), dataRoot: join(root, 'd') }));
  assert.throws(() => readBinding(root), /字段/);
  writeFileSync(join(root, BINDING), JSON.stringify({ schemaVersion: 2, siteId: 'x' }));
  assert.throws(() => readBinding(root), /格式无效/);
});

test('a missing binding is a fresh site, not an error', t => {
  const root = fixture(t);
  assert.equal(readBinding(root), null);
  assert.equal(assertBindingMatches(root, resolved(root), 'web'), null);
});
