import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDeployment, checkDataSelection } from '../src/config.mjs';
import { migrationPaths, migrateData, inventory, checkCapacity } from '../src/migrate-data.mjs';

function fixture(t) {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh local paths ')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'project'); mkdirSync(root);
  return { parent, root };
}

test('new defaults are project-relative; each old directory needs an explicit choice', t => {
  const { root, parent } = fixture(t);
  assert.throws(() => resolveDeployment({}, {}), /--root/);
  const fresh = resolveDeployment({ root }, {});
  assert.equal(fresh.home, join(root, '.local/data/dsh-home'));
  assert.equal(fresh.artifacts, join(root, '.local/artifacts'));
  assert.doesNotThrow(() => checkDataSelection(fresh, parent));
  mkdirSync(join(root, 'data')); mkdirSync(join(root, 'deploy-artifacts'));
  mkdirSync(join(root, '.local/data'), { recursive: true });
  assert.throws(() => checkDataSelection(fresh, parent), /旧目录/);
  assert.throws(() => checkDataSelection(resolveDeployment({ root, home: 'data/home' }, {}), parent), /旧目录/);
  assert.doesNotThrow(() => checkDataSelection(resolveDeployment({ root, home: 'data/home', artifacts: 'deploy-artifacts' }, {}), parent));
});

test('repository-local path aliases cannot redirect defaults outside the project', t => {
  const { root, parent } = fixture(t);
  const external = join(parent, 'outside'); mkdirSync(external);
  symlinkSync(external, join(root, '.local'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => resolveDeployment({ root }, {}), /目录联接/);
});

test('artifact copying retains exact archives and recovery records independently of data', t => {
  const { root } = fixture(t);
  const source = join(root, 'deploy-artifacts'); mkdirSync(source);
  const target = join(root, '.local/artifacts'), backup = join(root, '.local/backups/release');
  writeFileSync(join(source, 'example.tgz'), 'immutable fixture bytes');
  const originalRecord = JSON.stringify({ schemaVersion: 1, status: 'built', resultFile: join(source, 'host-image.json'), imageId: 'fixture' });
  writeFileSync(join(source, 'host-image.json'), originalRecord);
  const stopped = join(root, 'stopped.json');
  writeFileSync(stopped, JSON.stringify({ schemaVersion: 1, source, target, manager: 'fixture-build-manager', instanceId: 'fixture', allWritersStopped: true, stoppedAt: new Date().toISOString() }));
  const options = { root, kind: 'artifacts', source, target, backup, 'stopped-file': stopped };
  const result = migrateData({ ...options, apply: true });
  assert.equal(result.status, 'copied');
  assert.equal(readFileSync(join(target, 'host-image.json'), 'utf8'), originalRecord);
  assert.deepEqual(inventory(source, 'artifacts'), inventory(target, 'artifacts'));
  assert.equal(existsSync(join(root, '.local/data')), false);
  assert.throws(() => migrationPaths({ ...options, backup: join(root, '.local/artifacts/backup') }), /备份/);
});

test('unfinished artifact operations and insufficient space reject before copy', t => {
  const { root } = fixture(t);
  const source = join(root, 'deploy-artifacts'); mkdirSync(source);
  const options = { root, kind: 'artifacts', source, target: join(root, '.local/artifacts'), backup: join(root, '.local/backups/release') };
  writeFileSync(join(source, 'host-image.json'), JSON.stringify({ status: 'publish-failed' }));
  assert.throws(() => migrateData(options), /尚未完成/);
  rmSync(join(source, 'host-image.json'));
  writeFileSync(join(source, 'archive.tgz'), 'some bytes');
  const paths = migrationPaths(options), entries = inventory(source, 'artifacts');
  assert.throws(() => checkCapacity(paths, entries, () => ({ bavail: 0n, bsize: 4096n })), /空间不足/);
  const bytes = BigInt(entries.find(entry => entry.kind === 'file').size);
  assert.throws(() => checkCapacity(paths, entries, () => ({ bavail: bytes, bsize: 1n })), /空间不足/);
  assert.equal(existsSync(options.target), false);
  assert.equal(existsSync(options.backup), false);
});
