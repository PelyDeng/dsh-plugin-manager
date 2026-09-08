/** Source-deployment backups. The caller must prove stop-write and protect backupDir first. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonical, json, tarCommand, within } from '../../packages/plugin-manager/src/state.mjs';

const immutableImage = value => typeof value === 'string' && /^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(value);
const captureOptions = { stdio: 'pipe', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 };
const safeRelative = value => typeof value === 'string' && !value.includes('\\') && !/[\x00-\x1f]/.test(value) && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.split('/').includes('..');
function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Backup command failed (${result.status}): ${result.stderr ?? ''}`);
  return result.stdout ?? '';
}
function digest(file) {
  const fd = openSync(file, 'r');
  try {
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    for (let size; (size = readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
function mount(source, target, readonly = true) {
  if (/[,\r\n\x00]/.test(source)) throw new Error('Backup mount paths cannot contain commas or control characters.');
  return ['--mount', `type=bind,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
}
function container(image, mounts, args, execute) {
  if (!immutableImage(image)) throw new Error('Backup requires an existing immutable Linux image ID or digest.');
  return execute('docker', ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--user', '0:0', ...mounts, '--entrypoint', 'tar', image, ...args], captureOptions);
}
function readTar(archive, flags, { desktop = false, image } = {}, execute = command) {
  // GNU tar otherwise quotes Unicode names according to the container's locale.
  if (desktop) return container(image, mount(dirname(archive), '/backup'), ['--quoting-style=literal', flags, `/backup/${basename(archive)}`], execute).toString();
  const fd = openSync(archive, 'r');
  try { return execute(tarCommand, [...(process.platform === 'linux' ? ['--quoting-style=literal'] : []), flags, '-'], { ...captureOptions, stdio: [fd, 'pipe', 'pipe'] }).toString(); }
  finally { closeSync(fd); }
}

/** Keep every original binding in the map, but archive overlapping parents only once. */
export function backupSources({ compose, backupDir, image, desktop = false }, execute = command) {
  const volumes = compose?.services?.dsh?.volumes;
  if (!Array.isArray(volumes)) throw new Error('Invalid persistent mounts for backup.');
  backupDir = canonical(backupDir);
  if (!existsSync(backupDir) || !statSync(backupDir).isDirectory()) throw new Error('Create and protect the private backup directory before backing up.');
  const originals = [];
  for (const volume of volumes) {
    if (!volume || typeof volume !== 'object' || typeof volume.target !== 'string' || !volume.target.startsWith('/') || volume.target.split('/').includes('..')) throw new Error('Invalid persistent mount target.');
    if (volume.read_only === true && !volume.target.startsWith('/run/')) continue;
    if (volume.type !== 'bind' || typeof volume.source !== 'string' || !isAbsolute(volume.source) || /[\x00-\x1f]/.test(volume.source)) throw new Error('Invalid persistent bind source.');
    const source = canonical(volume.source);
    if (source === parse(source).root || !existsSync(source) || (!statSync(source).isDirectory() && !statSync(source).isFile()) || within(source, backupDir)) throw new Error('Invalid backup source, or backup output lies inside a source.');
    if (desktop) mount(source, '/sources/0');
    originals.push({ source: volume.source, canonicalSource: source });
  }
  if (!originals.length) throw new Error('No persistent bind sources to back up.');
  const unique = [...new Set(originals.map(item => item.canonicalSource))];
  const sources = unique.filter(source => !unique.some(parent => parent !== source && within(parent, source)));
  const roots = sources.map((source, index) => ({ source, archivePrefix: desktop ? `sources/${index}` : source.replace(/^\/+/, '') }));
  const mappings = originals.map(item => {
    const retainedSourceIndex = sources.findIndex(source => within(source, item.canonicalSource));
    return { ...item, retainedSourceIndex, archivePrefix: roots[retainedSourceIndex].archivePrefix, relativeSuffix: relative(sources[retainedSourceIndex], item.canonicalSource).split(sep).join('/') };
  });
  const backupArchive = resolve(backupDir, `runtime-${randomUUID()}.tar.gz`);
  if (desktop) container(image, [...sources.flatMap((source, index) => mount(source, `/sources/${index}`)), ...mount(backupDir, '/backup', false)], ['-czf', `/backup/${basename(backupArchive)}`, '-C', '/', '--', ...roots.map(root => root.archivePrefix)], execute);
  else execute(tarCommand, ['-czf', backupArchive, '--', ...sources]);
  if (process.platform !== 'win32') chmodSync(backupArchive, 0o600);
  readTar(backupArchive, '-tzf', { desktop, image }, execute);
  const backupMounts = resolve(backupDir, `mounts-${basename(backupArchive, '.tar.gz')}.json`);
  writeFileSync(backupMounts, `${JSON.stringify({ schemaVersion: 1, format: desktop ? 'container-sources-v1' : 'linux-absolute-v1', roots, mounts: mappings }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const record = { backupArchive, backupArchiveSha256: digest(backupArchive), backupMounts, backupMountsSha256: digest(backupMounts) };
  verifySourceBackup(record, { desktop, image }, execute);
  return record;
}

/** Old Linux records have only backupArchive; new records bind archive and mapping digests. */
export function verifySourceBackup(record, options = {}, execute = command) {
  if (!record?.backupArchive || !lstatSync(record.backupArchive).isFile()) throw new Error('Missing backup archive.');
  if (record.backupArchiveSha256 && digest(record.backupArchive) !== record.backupArchiveSha256) throw new Error('Backup archive digest mismatch.');
  let mapping;
  if (record.backupMounts) {
    if (!record.backupArchiveSha256 || !record.backupMountsSha256 || !lstatSync(record.backupMounts).isFile() || digest(record.backupMounts) !== record.backupMountsSha256) throw new Error('Backup mapping digest mismatch.');
    mapping = json(record.backupMounts);
    if (mapping.schemaVersion !== 1 || !['container-sources-v1', 'linux-absolute-v1'].includes(mapping.format) || !Array.isArray(mapping.roots) || !mapping.roots.length || !Array.isArray(mapping.mounts) || !mapping.mounts.length) throw new Error('Invalid backup mapping.');
    for (const root of mapping.roots) if (typeof root.source !== 'string' || !isAbsolute(root.source) || !safeRelative(root.archivePrefix) || !root.archivePrefix) throw new Error('Invalid backup root mapping.');
    for (const item of mapping.mounts) {
      const root = mapping.roots[item.retainedSourceIndex];
      if (!Number.isInteger(item.retainedSourceIndex) || !root || item.archivePrefix !== root.archivePrefix || !safeRelative(item.relativeSuffix) || typeof item.source !== 'string' || !isAbsolute(item.source) || !within(root.source, item.source) || canonical(resolve(root.source, item.relativeSuffix)) !== canonical(item.source)) throw new Error('Invalid backup source mapping.');
    }
  } else if (record.backupMountsSha256) throw new Error('Missing backup mapping.');
  const entries = readTar(record.backupArchive, '-tzf', options, execute).trimEnd().split(/\r?\n/);
  if (!entries.length || !entries[0]) throw new Error('Backup archive is empty.');
  if (mapping?.format === 'container-sources-v1' && entries.some(entry => !mapping.roots.some(root => entry === root.archivePrefix || entry.startsWith(`${root.archivePrefix}/`)))) throw new Error('Backup archive escapes its mapped sources.');
  return { mapping, entries };
}

// All archive extraction happens on container tmpfs: no host-writable mounts exist, even for hostile links.
const restoreProbe = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const tar = require('node:child_process').spawnSync('tar', ['-xzf', process.argv[1], '-C', '/restore', '--no-same-owner'], { encoding: 'utf8' });
if (tar.error || tar.status !== 0) throw new Error('Backup extraction failed: ' + (tar.error?.message || tar.stderr));
const entries = [], inodes = new Map();
function inside(value) { return value === '/restore' || value.startsWith('/restore/'); }
function inRuntime(value) { return value === '/opt/dsh-runtime' || value.startsWith('/opt/dsh-runtime/'); }
function visit(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file), relative = path.relative('/restore', file);
    const item = { path: relative, mode: stat.mode & 0o7777 };
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file), resolved = path.resolve(path.dirname(file), target);
      const real = fs.realpathSync(file);
      const externalRuntime = inRuntime(real) && (inRuntime(resolved) || (!path.isAbsolute(target) && inside(resolved)));
      if (!externalRuntime && (path.isAbsolute(target) || !inside(resolved) || !inside(real))) throw new Error('Unsafe backup link: ' + relative);
      entries.push({ ...item, type: 'symlink', target, ...(externalRuntime ? { externalRuntime: true } : {}) });
    } else if (stat.isDirectory()) {
      entries.push({ ...item, type: 'directory' }); visit(file);
    } else if (stat.isFile()) {
      const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
      try { for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, size)); }
      finally { fs.closeSync(fd); }
      const key = stat.dev + ':' + stat.ino, hardlinkTo = inodes.get(key); inodes.set(key, relative);
      entries.push({ ...item, type: 'file', size: stat.size, sha256: hash.digest('hex'), ...(hardlinkTo ? { hardlinkTo } : {}) });
    } else throw new Error('Unsafe special backup entry: ' + relative);
  }
}
visit('/restore'); process.stdout.write(JSON.stringify(entries));
`;

/** Validate a real restore on disposable container tmpfs; never roll back or write original data. */
export function validateSourceBackupRestore(record, { image } = {}, execute = command) {
  const { mapping, entries } = verifySourceBackup(record, { desktop: true, image }, execute);
  if (entries.some(entry => !safeRelative(entry))) throw new Error('Unsafe backup archive entry.');
  const expected = digest(record.backupArchive);
  const output = execute('docker', ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--user', '0:0',
    '--tmpfs', '/restore:rw,nosuid,nodev,mode=0700', ...mount(dirname(record.backupArchive), '/backup'),
    '--entrypoint', 'node', image, '-e', restoreProbe, `/backup/${basename(record.backupArchive)}`], captureOptions);
  if (digest(record.backupArchive) !== expected) throw new Error('Backup archive changed during restore validation.');
  return { mapping, entries: JSON.parse(output) };
}
