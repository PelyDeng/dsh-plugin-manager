/** Persistent migration fixtures never use a real DSH home or business configuration. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { inventory, migrateData, migrationPaths, parseMigrationArguments } from '../src/migrate-data.mjs';

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-migrate-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'data/old home');
  const target = join(root, 'data/new home 中文');
  const backup = join(root, 'data/backup');
  mkdirSync(join(source, 'sessions'), { recursive: true });
  writeFileSync(join(source, 'env.conf'), 'FIXTURE_SECRET=not-a-real-credential\n', { mode: 0o600 });
  writeFileSync(join(source, 'sessions/event.jsonl'), '{"event":"fixture"}\n', { mode: 0o640 });
  const stopped = join(root, 'stopped.json');
  const evidence = { schemaVersion: 1, source, target, manager: 'fixture-service-manager', instanceId: 'fixture', allWritersStopped: true, stoppedAt: new Date().toISOString(), pids: [] };
  writeFileSync(stopped, JSON.stringify(evidence));
  return { root, source, target, backup, 'stopped-file': stopped, evidence };
}

test('default dry-run reports paths and counts without creating backup or target', t => {
  const options = fixture(t);
  const original = inventory(options.source);
  const result = migrateData(options);
  assert.equal(result.status, 'dry-run');
  assert.equal(result.files, 2);
  assert.equal(existsSync(options.target), false);
  assert.equal(existsSync(options.backup), false);
  assert.deepEqual(inventory(options.source), original);
  assert.equal(JSON.stringify(result).includes('FIXTURE_SECRET'), false);
});

test('Windows short directory names resolve to the same migration locations', { skip: process.platform !== 'win32' }, t => {
  const options = fixture(t);
  const result = spawnSync('cmd.exe', ['/d', '/c', 'for %I in (.) do @echo %~sI'], { cwd: options.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const root = result.stdout.trim();
  if (root === options.root) { t.skip('8.3 directory names are disabled on this volume'); return; }
  const aliased = { ...options, root, source: join(root, 'data/old home'), target: join(root, 'data/new home 中文'), backup: join(root, 'data/backup') };
  assert.deepEqual(migrateData(aliased), migrateData(options));
  assert.equal(existsSync(options.target), false);
  assert.equal(existsSync(options.backup), false);
});

test('apply creates a verified backup and copy, preserving source and private modes', t => {
  const options = fixture(t);
  const original = inventory(options.source);
  const result = migrateData({ ...options, apply: true });
  assert.equal(result.status, 'copied');
  assert.deepEqual(inventory(options.source), original);
  assert.deepEqual(inventory(options.target), original);
  assert.deepEqual(inventory(join(options.backup, 'data')), original);
  const record = readFileSync(result.recordFile, 'utf8');
  assert.equal(JSON.parse(record).stage, 'verified');
  assert.equal(record.includes('FIXTURE_SECRET'), false);
  assert.equal(record.includes('not-a-real-credential'), false);
  assert.deepEqual(readdirSync(options.backup).sort(), ['data', 'migration.json']);
});

test('apply requires fresh source/target-specific manager evidence and rejects a live PID', t => {
  const options = fixture(t);
  assert.throws(() => migrateData({ ...options, apply: true, 'stopped-file': undefined }), /停写证据/u);
  for (const mutation of [
    { allWritersStopped: false }, { manager: '' }, { source: options.target },
    { stoppedAt: '2000-01-01T00:00:00Z' }, { stoppedAt: 'invalid' }, { pids: [process.pid] }, { pids: ['123'] },
  ]) {
    writeFileSync(options['stopped-file'], JSON.stringify({ ...options.evidence, ...mutation }));
    assert.throws(() => migrateData({ ...options, apply: true }));
    assert.equal(existsSync(options.backup), false);
  }
});

test('a failed permission-copy step keeps the source and a value-free recovery record', t => {
  if (process.platform !== 'win32') { t.skip('Exercises the Windows ACL helper failure'); return; }
  const options = fixture(t);
  const original = inventory(options.source);
  const script = resolve(import.meta.dirname, '../src/migrate-data.mjs');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  env.PATH = join(options.root, 'missing-tools');
  const result = spawnSync(process.execPath, [script, '--root', options.root, '--source', options.source, '--target', options.target,
    '--backup', options.backup, '--apply', '--stopped-file', options['stopped-file']], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(inventory(options.source), original);
  const record = readFileSync(join(options.backup, 'migration.json'), 'utf8');
  assert.equal(JSON.parse(record).status, 'failed');
  assert.equal(record.includes('FIXTURE_SECRET'), false);
  assert.equal(existsSync(join(options.backup, 'data/env.conf')), true);
  assert.equal(existsSync(options.target), false);
});

test('same paths, containment, artifact locations and nonempty outputs never get overwritten', t => {
  const options = fixture(t);
  for (const mutation of [
    { target: options.source }, { target: join(options.source, 'child') }, { target: join(options.source, '..') },
    { backup: options.target }, { backup: join(options.target, 'backup') },
    { target: join(options.root, 'deploy-artifacts/data') }, { backup: join(options.root, 'plugins/backup') },
  ]) assert.throws(() => migrationPaths({ ...options, ...mutation }));
  mkdirSync(options.target); writeFileSync(join(options.target, 'keep'), 'destination');
  assert.throws(() => migrateData({ ...options, apply: true }), /不合并或覆盖/u);
  assert.equal(readFileSync(join(options.target, 'keep'), 'utf8'), 'destination');
  assert.equal(readFileSync(join(options.source, 'env.conf'), 'utf8'), 'FIXTURE_SECRET=not-a-real-credential\n');
});

test('external explicit locations are allowed, while root directory aliases are rejected', t => {
  const options = fixture(t);
  const external = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-migrate-external-')));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  assert.equal(migrationPaths({ ...options, target: join(external, 'target') }).target, join(external, 'target'));
  symlinkSync(external, join(options.root, 'data/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => migrationPaths({ ...options, target: join(options.root, 'data/alias/target') }), /真实外部目录/u);
});

test('native dependencies and pnpm store metadata stop before any copying', t => {
  for (const filename of ['binding.node', '.modules.yaml']) {
    const options = fixture(t);
    writeFileSync(join(options.source, filename), 'fixture');
    assert.throws(() => migrateData({ ...options, apply: true }), /沿用外部 home/u);
    assert.equal(existsSync(options.backup), false);
  }
});

test('absolute and external links are rejected without following them into the copy', t => {
  const options = fixture(t);
  const outside = join(options.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(options.source, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => migrateData({ ...options, apply: true }), /外部链接/u);
  assert.equal(existsSync(options.target), false);
});

test('internal relative links preserve their topology when the platform permits them', t => {
  const options = fixture(t);
  try { symlinkSync('sessions/event.jsonl', join(options.source, 'event-link'), 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Windows file symlink privilege unavailable'); return; }
    throw error;
  }
  migrateData({ ...options, apply: true });
  assert.equal(readlinkSync(join(options.target, 'event-link')), 'sessions/event.jsonl');
  assert.equal(readFileSync(join(options.target, 'event-link'), 'utf8'), '{"event":"fixture"}\n');
});

test('CLI relative paths use the declared repository root even from another cwd', t => {
  const options = fixture(t);
  const script = resolve(import.meta.dirname, '../src/migrate-data.mjs');
  const result = spawnSync(process.execPath, [script, '--root', options.root, '--source', 'data/old home', '--target', 'data/new home', '--backup', 'data/backup'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).source, options.source);
  assert.deepEqual(parseMigrationArguments(['--source', 'a', '--target', 'b', '--backup', 'c']), { source: 'a', target: 'b', backup: 'c' });
  for (const args of [['--apply', '--apply'], ['--unknown'], ['--source']]) assert.throws(() => parseMigrationArguments(args));
});
