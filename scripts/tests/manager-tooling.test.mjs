import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { installManagerArchive } from '../manager-tooling.mjs';
import { tarCommand } from '../../packages/plugin-manager/src/state.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'dsh 工具 relocation ')));
  writeFileSync(resolve(root, 'package.json'), '{"name":"source-project","private":true}\n');
  mkdirSync(resolve(root, 'package/dist'), { recursive: true });
  writeFileSync(resolve(root, 'package/package.json'), JSON.stringify({ name: '@dsh-plugin-manager/plugin-manager', version: '0.0.1', type: 'module' }));
  writeFileSync(resolve(root, 'package/dist/cli.mjs'), 'import {readFileSync} from "node:fs"; const value=JSON.parse(readFileSync(new URL("../package.json",import.meta.url))); console.log(process.argv[2]==="--version"?value.version:"{}");\n');
  const archive = resolve(root, 'manager.tgz');
  const result = spawnSync(tarCommand, ['-czf', archive, '-C', root, 'package'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return { root, archive };
}

test('tool archive is installed offline and remains executable after its original location is removed', () => {
  const { root, archive } = fixture();
  try {
    const sourceManifest = readFileSync(resolve(root, 'package.json'));
    const output = resolve(root, '.local/old tools');
    const result = installManagerArchive({ archive, output, version: '0.0.1' });
    assert.deepEqual(readFileSync(resolve(root, 'package.json')), sourceManifest);
    assert.equal(existsSync(resolve(root, 'node_modules')), false);
    assert.equal(existsSync(resolve(root, 'package-lock.json')), false);
    assert.equal(result.toolRoot, output);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    const moved = resolve(root, '新目录');
    renameSync(output, moved);
    rmSync(archive);
    const actual = spawnSync(process.execPath, [resolve(moved, 'node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs'), '--version'], { cwd: dirname(root), encoding: 'utf8' });
    assert.equal(actual.status, 0, actual.stderr);
    assert.equal(actual.stdout.trim(), '0.0.1');
    assert.doesNotMatch(readFileSync(resolve(moved, 'package.json'), 'utf8'), /old tools|manager\.tgz.*file:\//u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tool installation rejects a mismatched package version and refuses an occupied output', () => {
  const { root, archive } = fixture();
  try {
    const output = resolve(root, 'tools');
    assert.throws(() => installManagerArchive({ archive, output, version: '0.0.2' }), /版本/u);
    const before = readFileSync(resolve(output, 'plugin-manager.tgz'));
    assert.throws(() => installManagerArchive({ archive, output, version: '0.0.1' }), /必须为空/u);
    assert.deepEqual(readFileSync(resolve(output, 'plugin-manager.tgz')), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
