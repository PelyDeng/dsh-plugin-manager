import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { backupSources, validateSourceBackupRestore, verifySourceBackup } from '../../../deploy/scripts/backup.mjs';

// Match build.mjs: inherited output unless the helper explicitly requests captured UTF-8.
function buildRunner(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build command failed: ${result.stderr ?? ''}`);
  return result.stdout?.trim() ?? '';
}

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-source-backup-')));
  t.after(() => {
    assert.equal(dirname(root), realpathSync.native(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, '原始数据 with spaces'), backupDir = join(root, 'backup');
  mkdirSync(source); mkdirSync(backupDir, { mode: 0o700 }); mkdirSync(join(source, 'nested'));
  writeFileSync(join(source, 'nested', 'marker.txt'), '备份验证，不修改原数据\n', { mode: 0o640 });
  const compose = { services: { dsh: { volumes: [
    { type: 'bind', source: join(source, 'nested'), target: '/home/nested' },
    { type: 'bind', source, target: '/home' },
    { type: 'bind', source, target: '/home-again' },
  ] } } };
  return { root, source, backupDir, compose };
}
// Tiny adversarial tar fixtures keep path/link coverage independent from the host tar writer's safeguards.
function archive(file, entries) {
  const chunks = [];
  for (const { name, type = '0', link = '', content = '' } of entries) {
    const data = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000640\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100); header.write('ustar\0', 257); header.write('00', 263);
    const sum = header.reduce((a, b) => a + b, 0); header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  writeFileSync(file, gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)])));
  return { backupArchive: file };
}

test('source backup refuses invalid, missing, named-volume and recursively included output mounts before commands', t => {
  const f = fixture(t); let calls = 0;
  const run = () => { calls++; throw new Error('must not execute'); };
  for (const source of ['relative', parse(f.source).root, join(f.root, 'missing'), f.root]) {
    assert.throws(() => backupSources({ ...f, compose: { services: { dsh: { volumes: [{ type: 'bind', source, target: '/home' }] } } } }, run), /Invalid/);
  }
  assert.throws(() => backupSources({ ...f, compose: { services: { dsh: { volumes: [{ type: 'volume', source: 'named', target: '/home' }] } } } }, run), /Invalid/);
  assert.equal(calls, 0);
});

test('old Linux backup records remain readable without new mapping fields', t => {
  const f = fixture(t);
  const record = archive(join(f.backupDir, 'legacy.tar.gz'), [{ name: 'var/lib/dsh/marker', content: 'retained' }]);
  assert.equal(verifySourceBackup(record, {}, buildRunner).entries[0], 'var/lib/dsh/marker');
});

test('real isolated restore rejects traversal, escaping links and special nodes without host writes', { skip: !process.env.DSH_TEST_BACKUP_IMAGE }, t => {
  const f = fixture(t);
  for (const [index, entry] of [
    { name: '../escape', content: 'bad' }, { name: '/absolute', content: 'bad' },
    { name: 'C:/outside', content: 'bad' }, { name: 'sources\\outside', content: 'bad' },
    { name: 'link', type: '2', link: '../outside' }, { name: 'link', type: '1', link: '../outside' },
    { name: 'fifo', type: '6' },
  ].entries()) {
    const record = archive(join(f.backupDir, `unsafe-${index}.tar.gz`), [entry]);
    assert.throws(() => validateSourceBackupRestore(record, { image: process.env.DSH_TEST_BACKUP_IMAGE }));
    assert.equal(existsSync(join(f.root, 'escape')), false);
  }
});

test('backup digest validation rejects changed archive or mapping', t => {
  const f = fixture(t);
  const record = archive(join(f.backupDir, 'digest.tar.gz'), [{ name: 'sources/0/file', content: 'safe' }]);
  record.backupArchiveSha256 = '0'.repeat(64);
  assert.throws(() => verifySourceBackup(record), /archive digest mismatch/);
  record.backupArchiveSha256 = createHash('sha256').update(readFileSync(record.backupArchive)).digest('hex');
  record.backupMounts = join(f.backupDir, 'mounts.json'); writeFileSync(record.backupMounts, '{}');
  record.backupMountsSha256 = '0'.repeat(64);
  assert.throws(() => verifySourceBackup(record), /mapping digest mismatch/);
});

test('native Linux backup preserves the old absolute-name tar layout and every overlapping mapping', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t);
  const record = backupSources(f, buildRunner);
  const { mapping, entries } = verifySourceBackup(record, {}, buildRunner);
  assert.equal(mapping.roots.length, 1); assert.equal(mapping.mounts.length, 3);
  assert.equal(mapping.mounts[0].relativeSuffix, 'nested');
  assert.ok(entries.includes(`${f.source.slice(1)}/nested/marker.txt`));
  assert.equal(readFileSync(join(f.source, 'nested/marker.txt'), 'utf8'), '备份验证，不修改原数据\n');
});

test('real Desktop image backs up and restores isolated Unicode paths without touching originals', { skip: !process.env.DSH_TEST_BACKUP_IMAGE }, t => {
  const f = fixture(t), image = process.env.DSH_TEST_BACKUP_IMAGE;
  const record = backupSources({ ...f, desktop: true, image }, buildRunner);
  const { mapping, entries } = verifySourceBackup(record, { desktop: true, image }, buildRunner);
  assert.equal(mapping.roots.length, 1); assert.equal(mapping.mounts.length, 3);
  assert.equal(mapping.mounts[0].relativeSuffix, 'nested');
  assert.ok(entries.includes('sources/0/nested/marker.txt'));
  assert.equal(mapping.mounts[0].retainedSourceIndex, 0);
  const restored = validateSourceBackupRestore(record, { image }, buildRunner);
  const marker = restored.entries.find(entry => entry.path === 'sources/0/nested/marker.txt');
  assert.equal(marker.type, 'file');
  assert.equal(marker.sha256, createHash('sha256').update('备份验证，不修改原数据\n').digest('hex'));
  assert.equal(readFileSync(join(f.source, 'nested/marker.txt'), 'utf8'), '备份验证，不修改原数据\n');
  assert.equal(existsSync(join(f.source, 'restore')), false);
});

test('real tmpfs restore supports ordinary relative symlinks and hardlinks with content and mode evidence', { skip: !process.env.DSH_TEST_BACKUP_IMAGE }, t => {
  const f = fixture(t);
  const record = archive(join(f.backupDir, 'links.tar.gz'), [
    { name: 'home/package/index.js', content: 'module data' },
    { name: 'home/node_modules/package', type: '2', link: '../package' },
    { name: 'home/package/copy.js', type: '1', link: 'home/package/index.js' },
  ]);
  const result = validateSourceBackupRestore(record, { image: process.env.DSH_TEST_BACKUP_IMAGE });
  const symlink = result.entries.find(entry => entry.path === 'home/node_modules/package');
  assert.equal(symlink.type, 'symlink'); assert.equal(symlink.target, '../package');
  const original = result.entries.find(entry => entry.path === 'home/package/index.js');
  const copy = result.entries.find(entry => entry.path === 'home/package/copy.js');
  assert.equal(original.sha256, createHash('sha256').update('module data').digest('hex'));
  assert.equal(original.mode, 0o640); assert.equal(copy.sha256, original.sha256);
  assert.ok(original.hardlinkTo || copy.hardlinkTo);
});

test('restore identifies immutable host dependencies without following links outside the runtime closure', { skip: !process.env.DSH_TEST_BACKUP_IMAGE }, t => {
  const f = fixture(t), image = process.env.DSH_TEST_BACKUP_IMAGE;
  const record = archive(join(f.backupDir, 'runtime-links.tar.gz'), [
    { name: 'home/runtime', type: '2', link: '/opt/dsh-runtime' },
    { name: 'home/node_modules/host', type: '2', link: '../runtime' },
  ]);
  const result = validateSourceBackupRestore(record, { image });
  for (const path of ['home/runtime', 'home/node_modules/host']) {
    const entry = result.entries.find(entry => entry.path === path);
    assert.equal(entry.externalRuntime, true);
    assert.equal(entry.type, 'symlink');
    assert.equal(entry.sha256, undefined);
  }
  for (const [index, target] of ['/etc/passwd', '/opt/dsh-runtime/../plugin-manager', '/opt/dsh-runtime-other', '/opt/dsh-runtime/missing-backup-target'].entries()) {
    const invalid = archive(join(f.backupDir, `runtime-invalid-${index}.tar.gz`), [{ name: 'link', type: '2', link: target }]);
    assert.throws(() => validateSourceBackupRestore(invalid, { image }));
  }
  const chain = archive(join(f.backupDir, 'escaping-chain.tar.gz'), [{ name: 'aa', type: '2', link: 'zz' }, { name: 'zz', type: '2', link: '/etc' }]);
  assert.throws(() => validateSourceBackupRestore(chain, { image }));
});
