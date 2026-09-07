/** Copy explicitly selected, stopped persistent data without removing its source. */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, statfsSync, symlinkSync, utimesSync, writeFileSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { canonical } from './state.mjs';

const LOCK = '.deepseek-plugin-migration-lock';
const fail = message => { throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function within(parent, child) {
  const path = relative(parent, child);
  return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function empty(path) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || readdirSync(path).length)) fail('目标或备份目录已存在内容；保留源、目标及备份，不合并或覆盖。');
}

/** Resolve explicit locations, accepting short names but rejecting symlink ancestors. */
export function migrationPaths(options) {
  if (!options.root) fail('必须显式指定 --root 项目根目录。');
  const root = canonical(resolve(options.root));
  const kind = options.kind ?? 'data';
  if (!['data', 'artifacts'].includes(kind)) fail('迁移类型必须是 data 或 artifacts。');
  const paths = { root, kind };
  for (const key of ['source', 'target', 'backup']) {
    if (typeof options[key] !== 'string' || !options[key]) fail(`必须显式指定 --${key}。`);
    const lexical = resolve(root, options[key]);
    const path = canonical(lexical);
    for (let ancestor = lexical; ; ancestor = dirname(ancestor)) {
      if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) fail('迁移根路径不得通过符号链接或目录联接跳转；请显式指定真实外部目录。');
      if (dirname(ancestor) === ancestor) break;
    }
    const folders = key === 'backup' ? ['.local/backups', 'data'] : kind === 'data' ? ['.local/data', 'data'] : ['.local/artifacts', 'deploy-artifacts'];
    if ((within(root, path) && !folders.some(folder => within(join(root, folder), path))) || within(path, root)) fail('仓库内迁移路径必须位于对应 .local/data/、.local/artifacts/ 或旧目录；备份只能位于 .local/backups/、data/ 或仓库外。');
    paths[key] = path;
  }
  for (const [left, right] of [['source', 'target'], ['source', 'backup'], ['target', 'backup']]) {
    if (within(paths[left], paths[right]) || within(paths[right], paths[left])) fail('源、目标和备份规范路径不能相同或互相包含。');
  }
  if (!existsSync(paths.source) || !lstatSync(paths.source).isDirectory()) fail('迁移源必须是已有普通目录。');
  empty(paths.target); empty(paths.backup);
  return paths;
}

/** Describe content without persisting file values or per-file credential hashes. */
export function inventory(root, kind = 'data') {
  const entries = [];
  function visit(path, name) {
    const stat = lstatSync(path);
    if (name.split('/').some(part => [LOCK, '.deepseek-plugin-lock', '.deepseek-plugin-owner.json', '.deepseek-plugin-pending.json'].includes(part))) fail('源目录包含运行或迁移状态，请先由原管理者核验未完成操作。');
    const entry = { path: name, mode: stat.mode & 0o7777, uid: stat.uid, gid: stat.gid };
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(path);
      if (isAbsolute(link) || !within(root, resolve(dirname(path), link)) || !existsSync(path) || !within(root, realpathSync.native(path))) {
        fail('源包含绝对、断开或外部链接；请沿用外部 home，或由原管理者重建安装后再迁移。');
      }
      entries.push({ ...entry, kind: 'link', link, directory: statSync(path).isDirectory() });
    } else if (stat.isDirectory()) {
      entries.push({ ...entry, kind: 'directory' });
      for (const child of readdirSync(path).sort()) visit(join(path, child), name ? `${name}/${child}` : child);
    } else if (stat.isFile()) {
      if (kind === 'artifacts' && /(?:\.tmp|\.lock)$/.test(name)) fail('产物包含未完成操作文件，请先由原管理者完成或恢复操作。');
      if (kind === 'artifacts' && name.endsWith('host-image.json')) {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (!['built', 'published'].includes(record.status)) fail('镜像操作尚未完成；请在原目录恢复后再复制产物。');
      }
      if (name.endsWith('.node')) fail('源包含原生依赖，不能保证目标运行环境兼容；请沿用外部 home，或先由原管理者重建受管安装。');
      if (name.endsWith('/.modules.yaml') || name === '.modules.yaml') fail('源包含 pnpm 安装定位信息；请沿用外部 home，或由原管理者移出安装产物并在目标重建，工具不会自动删除。');
      entries.push({ ...entry, kind: 'file', size: stat.size, sha256: hash(readFileSync(path)) });
    } else fail('源包含特殊文件，不能作为普通持久目录复制。');
  }
  visit(root, '');
  return entries;
}

/** Check the original manager's explicit attestation and any listed local PIDs. */
export function checkStoppedEvidence(file, paths) {
  if (!file) fail('--apply 需要原管理者的 --stopped-file 停写证据。');
  let evidence;
  try { evidence = JSON.parse(readFileSync(resolve(paths.root, file), 'utf8')); }
  catch { fail('停写证据不是可读取的 JSON 文件。'); }
  const stoppedAt = Date.parse(evidence?.stoppedAt);
  if (evidence?.schemaVersion !== 1 || evidence.allWritersStopped !== true || typeof evidence.manager !== 'string' || !evidence.manager.trim()
    || typeof evidence.instanceId !== 'string' || !evidence.instanceId.trim() || typeof evidence.source !== 'string' || typeof evidence.target !== 'string'
    || canonical(resolve(paths.root, evidence.source)) !== paths.source || canonical(resolve(paths.root, evidence.target)) !== paths.target
    || !Number.isFinite(stoppedAt) || stoppedAt > Date.now() || Date.now() - stoppedAt > 15 * 60 * 1000) fail('停写证据须在 15 分钟内、绑定源和目标，并由原管理者确认全部写入实例已停止。');
  if (evidence.pids !== undefined && (!Array.isArray(evidence.pids) || evidence.pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0))) fail('停写证据 pids 必须为正整数数组。');
  for (const pid of evidence.pids ?? []) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') continue; throw new Error('无法确认停写证据中的进程已退出。'); }
    fail('停写证据中的进程仍在运行。');
  }
}

function permissions(source, target, entries) {
  if (process.platform === 'win32') {
    const mapping = entries.filter(entry => entry.kind !== 'link').map(entry => ({ source: join(source, entry.path), target: join(target, entry.path) }));
    // Windows may add the auto-inherited marker when persisting an unchanged DACL.
    const script = `$ErrorActionPreference="Stop"
function ComparableDescriptor($acl) {
  $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  $descriptor.SetFlags($descriptor.ControlFlags -band (-bnot [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited))
  $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::All)
}
[Console]::InputEncoding=[Text.UTF8Encoding]::new()
$items=[Console]::In.ReadToEnd() | ConvertFrom-Json
foreach($item in $items) {
  $acl=Get-Acl -LiteralPath $item.source
  Set-Acl -LiteralPath $item.target -AclObject $acl
  if((ComparableDescriptor (Get-Acl -LiteralPath $item.target)) -cne (ComparableDescriptor $acl)) { throw "ACL verification failed" }
}`;
    const args = ['-NoProfile', '-NonInteractive', '-Command', script];
    const options = { input: JSON.stringify(mapping), encoding: 'utf8' };
    let result = spawnSync('pwsh', args, options);
    if (result.error?.code === 'ENOENT') {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
      result = spawnSync('powershell.exe', args, { ...options, env });
    }
    if (result.error || result.status !== 0) fail(`Windows ACL 复制或校验失败；保留备份和目标，请使用原权限管理者恢复。${result.error?.message ?? result.stderr.trim()}`);
  } else {
    for (const entry of [...entries].reverse()) {
      if (entry.kind === 'link') continue;
      const path = join(target, entry.path);
      const current = lstatSync(path);
      if (current.uid !== entry.uid || current.gid !== entry.gid) chownSync(path, entry.uid, entry.gid);
      chmodSync(path, entry.mode);
    }
  }
}

function copyTree(source, target, entries) {
  for (const entry of entries) {
    const from = join(source, entry.path); const to = join(target, entry.path);
    if (entry.kind === 'directory') mkdirSync(to, { recursive: true, mode: 0o700 });
    else if (entry.kind === 'file') {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      const stat = lstatSync(from); utimesSync(to, stat.atime, stat.mtime);
    } else symlinkSync(entry.link, to, entry.directory ? 'dir' : 'file');
  }
  permissions(source, target, entries);
}

function verifyTree(root, expected, kind) {
  if (!isDeepStrictEqual(inventory(root, kind), expected)) fail('文件、权限或链接核验失败；保留恢复依据，不切换运行位置。');
}

/** Check space for both copies, including destinations on the same filesystem. */
export function checkCapacity(paths, entries, filesystem = statfsSync) {
  const bytes = entries.reduce((total, entry) => total + BigInt(entry.size ?? 0), 0n);
  const volumes = new Map();
  for (const destination of [paths.target, paths.backup]) {
    let ancestor = destination;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const device = statSync(ancestor).dev;
    const current = volumes.get(device) ?? { path: ancestor, required: 0n };
    current.required += bytes;
    volumes.set(device, current);
  }
  for (const { path, required } of volumes.values()) {
    const stats = filesystem(path, { bigint: true });
    if (stats.bavail * stats.bsize < required) fail('可用空间不足以保存备份和目标副本；未写入迁移目标。');
  }
  return { sourceBytes: bytes.toString(), requiredCopyBytes: (bytes * 2n).toString() };
}

/** Preview or copy a portable directory; no service is started and no source is removed. */
export function migrateData(options) {
  const paths = migrationPaths(options);
  if (options.apply) checkStoppedEvidence(options['stopped-file'], paths);
  const entries = inventory(paths.source, paths.kind);
  const capacity = checkCapacity(paths, entries);
  const summary = { kind: paths.kind, source: paths.source, target: paths.target, backup: paths.backup, ...capacity, files: entries.filter(entry => entry.kind === 'file').length, links: entries.filter(entry => entry.kind === 'link').length,
    ...(paths.kind === 'artifacts' ? { recovery: 'Original records and paths are retained. Copying does not relocate resume/recover operations.' } : {}) };
  if (!options.apply) return { status: 'dry-run', ...summary };
  const operationId = randomUUID();
  mkdirSync(paths.backup, { recursive: true, mode: 0o700 });
  const recordFile = join(paths.backup, 'migration.json');
  const lockFile = join(paths.backup, LOCK);
  const fd = openSync(lockFile, 'wx', 0o600); closeSync(fd);
  const record = { schemaVersion: 1, operationId, status: 'pending', stage: 'backup', ...summary };
  function recordState() {
    const temporary = `${recordFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, recordFile);
  }
  recordState();
  try {
    const snapshot = join(paths.backup, 'data');
    copyTree(paths.source, snapshot, entries);
    verifyTree(snapshot, entries, paths.kind); verifyTree(paths.source, entries, paths.kind);
    record.stage = 'target'; recordState();
    empty(paths.target);
    copyTree(snapshot, paths.target, entries);
    verifyTree(paths.target, entries, paths.kind); verifyTree(paths.source, entries, paths.kind);
    record.status = 'copied'; record.stage = 'verified'; recordState();
    rmSync(lockFile);
    return { ...record, recordFile };
  } catch (error) {
    record.status = 'failed'; recordState();
    throw new Error(`迁移未完成，源未删除；保留备份、目标及恢复记录 ${recordFile}。${error instanceof Error ? error.message : '复制失败。'}`);
  }
}

/** Accept only explicit locations and opt-in mutation. */
export function parseMigrationArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index].slice(2);
    if (!args[index].startsWith('--') || Object.hasOwn(options, key)) fail('未知或重复迁移参数。');
    if (key === 'apply') options.apply = true;
    else if (['root', 'source', 'target', 'backup', 'stopped-file'].includes(key) && args[index + 1] && !args[index + 1].startsWith('--')) options[key] = args[++index];
    else fail('用法：migrate-data.mjs --source <源> --target <目标> --backup <备份> [--apply --stopped-file <证据>]');
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(migrateData(parseMigrationArguments(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : '迁移失败。'); process.exitCode = 1; }
}
