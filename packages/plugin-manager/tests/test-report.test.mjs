import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, realpathSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../../../scripts/test-report.mjs', import.meta.url));
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), '测试 report with spaces ')));
  function put(path, text) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  put('cli.mjs', "console.log('0.0.0-fixture');");
  put('package.json', '{"name":"entry-fixture","private":true,"packageManager":"pnpm@11.19.0"}');
  put('pnpm-lock.yaml', "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
  put('.local/env.conf', 'this file must not be parsed');
  put('.local/data/sentinel', 'preserve');
  for (const [path, stage, outputFlag, outputName] of [
    ['scripts/package-plugins.mjs', 'pack', '--output', 'manifest.json'],
    ['plugins/dsh-example/tests/host-smoke.mjs', 'test', '--report', ''],
    ['packages/plugin-manager/src/cli.mjs', 'compose', '--output', 'manifest.json'],
  ]) put(path, `
    import {appendFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
    import {dirname,resolve} from 'node:path';
    appendFileSync('stages.log', '${stage}\\n');
    if(process.env.FAIL_STAGE === '${stage}') process.exit(7);
    if('${stage}' === 'compose' && !existsSync(process.argv[process.argv.indexOf('--verification-report')+1])) process.exit(8);
    const output=resolve(process.argv[process.argv.indexOf('${outputFlag}')+1], ${JSON.stringify(outputName)});
    mkdirSync(dirname(output),{recursive:true}); writeFileSync(output,'{}');
  `);
  return { root, run: (extra = [], env = {}) => spawnSync(process.execPath, [entry, '--root', root, ...extra], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, DSH_TEST_CLI: join(root, 'absent.mjs'), ...env },
  }), close: () => { assert.equal(dirname(root), realpathSync.native(tmpdir())); rmSync(root, { recursive: true, force: true }); } };
}

test('无node_modules的新检出能显示帮助，并在打包前检查宿主和参数', () => {
  const f = fixture();
  try {
    for (const name of ['scripts/test-report.mjs', 'packages/plugin-manager/src/pnpm.mjs', 'packages/plugin-manager/src/process.mjs', 'packages/plugin-manager/src/state.mjs']) {
      const source = resolve(dirname(entry), '..', name), target = join(f.root, name);
      mkdirSync(dirname(target), { recursive: true }); cpSync(source, target);
    }
    const invoke = extra => spawnSync(process.execPath, [join(f.root, 'scripts/test-report.mjs'), '--root', f.root, ...extra], { encoding: 'utf8', env: { ...process.env, DSH_TEST_CLI: join(f.root, 'absent.mjs') } });
    const help = invoke(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(invoke([]).stderr, /缺少已构建/);
    assert.notEqual(f.run(['--unknown', 'value']).status, 0);
    assert.equal(existsSync(join(f.root, '.local/artifacts')), false);
    assert.equal(existsSync(join(f.root, 'node_modules')), false);
  } finally { f.close(); }
});

test('显式CLI相对root解析，每次使用新目录，按顺序交付且保留站点文件', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 2; i++) {
      const result = f.run(['--cli', 'cli.mjs']);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /测试及报告交付完成/);
    }
    assert.equal(readFileSync(join(f.root, 'stages.log'), 'utf8'), 'pack\ntest\ncompose\npack\ntest\ncompose\n');
    const operations = readdirSync(join(f.root, '.local/artifacts'));
    assert.equal(operations.length, 2);
    for (const op of operations) assert.ok(existsSync(join(f.root, '.local/artifacts', op, 'delivery/manifest.json')));
    assert.equal(readFileSync(join(f.root, '.local/data/sentinel'), 'utf8'), 'preserve');
    assert.equal(readFileSync(join(f.root, '.local/env.conf'), 'utf8'), 'this file must not be parsed');
  } finally { f.close(); }
});

for (const [stage, expected] of [['pack', 'pack\n'], ['test', 'pack\ntest\n'], ['compose', 'pack\ntest\ncompose\n']]) {
  test(`${stage}失败后非零退出，不执行后续阶段、不宣称交付成功`, () => {
    const f = fixture();
    try {
      const result = f.run(['--cli', 'cli.mjs'], { FAIL_STAGE: stage });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /测试及报告交付完成/);
      assert.equal(readFileSync(join(f.root, 'stages.log'), 'utf8'), expected);
    } finally { f.close(); }
  });
}
