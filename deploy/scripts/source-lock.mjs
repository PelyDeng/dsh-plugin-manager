/** Source checkout recovery; independent of Docker, dependencies and profile locks. */
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireFileLock } from '../../packages/plugin-manager/src/lock.mjs';
import { ensurePrivateDirectory } from '../../packages/plugin-manager/src/private-files.mjs';

export const needsSourceResume = status => ['prepared', 'backing-up', 'applying', 'deployment-failed'].includes(status);
const sourcePath = root => resolve(root, '.local/source-release.node.lock');
const controlPath = root => resolve(root, '.local/source-release.control.lock');
const positive = value => Number.isSafeInteger(value) && value > 0;
const validBootId = (platform, value) => typeof value === 'string' && (platform === 'linux'
  ? /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  : platform === 'win32' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) && Number.isFinite(Date.parse(value)));

function bootId() {
  if (process.platform === 'linux') return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (process.platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")'],
  { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  throw new Error('本平台尚无可靠的启动身份检查');
}

/** The Linux coordinator group covers synchronous source-sync children, including orphans. */
export function sourceRecoveryIdentity() {
  try {
    const identity = { schema: 1, platform: process.platform, bootId: bootId() };
    if (!validBootId(identity.platform, identity.bootId)) throw new Error('启动身份格式无效');
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      identity.ownerGroup = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
      if (!positive(identity.ownerGroup)) throw new Error('无法读取协调进程组');
    }
    return identity;
  } catch { return { schema: 1, platform: process.platform }; }
}

/** Serialize only synchronous lock metadata changes, including direct Node entrypoints. */
function withControl(root, action) {
  const release = acquireFileLock(controlPath(root), '源码锁元数据正在操作或操作曾被强制终止；运行 doctor 查看 control 锁，保留现场。');
  try { return action(); } finally { release(); }
}

export function acquireSourceLock(root, message) {
  return withControl(root, () => acquireFileLock(sourcePath(root), message));
}

function readLock(path) {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('锁必须是普通文件，不能是符号链接');
  const bytes = readFileSync(path, 'utf8'), lock = JSON.parse(bytes);
  if (!lock || typeof lock !== 'object' || !positive(lock.pid) || typeof lock.host !== 'string' ||
      typeof lock.token !== 'string' || !lock.token || !Number.isFinite(Date.parse(lock.createdAt)) ||
      (lock.workerPid !== undefined && !positive(lock.workerPid))) throw new Error('锁内容不完整或格式无效');
  return { bytes, lock };
}

function processState(pid) {
  try { process.kill(pid, 0); return '运行中'; }
  catch (error) { return error.code === 'ESRCH' ? '已退出' : '无法核实'; }
}

function releaseState(root) {
  const path = resolve(root, '.local/source-release.json');
  if (!existsSync(path)) return 'none';
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof record.operation !== 'string' || !resolve(record.operation).startsWith(resolve(root, '.local/artifacts') + (process.platform === 'win32' ? '\\' : '/')) ||
      !['building', 'build-failed', 'ready', 'prepared', 'backing-up', 'applying', 'deployment-failed'].includes(record.status)) {
    throw new Error('发布记录无效，无法确定恢复方式');
  }
  return record.status;
}

function buildCommand(root) {
  return process.platform === 'win32' ? (existsSync(resolve(root, 'build.ps1')) ? '.\\build.ps1' : '.\\deploy\\build.ps1')
    : (existsSync(resolve(root, 'build.sh')) ? 'bash build.sh' : 'bash deploy/build.sh');
}

/** No time-based expiry and no PID-only recovery: absence of the managed groups is required. */
export function inspectSourceLock(root, { ignoreControl = false } = {}) {
  const result = { root, path: sourcePath(root), reasons: [], processes: [] };
  try {
    const status = releaseState(root);
    result.status = status;
    result.next = `${buildCommand(root)}${needsSourceResume(status) ? ' --resume' : ''}`;
  } catch (error) { result.reasons.push(error.message); }
  if (!ignoreControl && existsSync(controlPath(root))) {
    result.reasons.push(`control 锁尚未释放：${controlPath(root)}；不要自动删除，需核实元数据操作已结束`);
  }
  const legacy = resolve(root, '.local/source-release.lock');
  if (!ignoreControl && process.platform === 'linux' && existsSync(legacy)) {
    let fd;
    try {
      // Probe an existing inode read-only; doctor must never create or truncate a lock file.
      fd = openSync(legacy, 'r');
      const probe = spawnSync('flock', ['-n', '-E', '75', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
      if (probe.error || probe.status !== 0) result.reasons.push('Linux 外层 flock 被占用或无法核实，不能解锁');
    } catch { result.reasons.push('无法读取 Linux 外层 flock，不能解锁'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  let saved;
  try { saved = readLock(result.path); }
  catch (error) { result.reasons.push(`无法读取源码锁：${error.message}`); return result; }
  if (!saved) { result.absent = true; return result; }
  const { lock } = saved;
  result.owner = { host: lock.host, pid: lock.pid, workerPid: lock.workerPid, createdAt: lock.createdAt };
  if (lock.host !== hostname()) { result.reasons.push('锁属于其他主机，不能在本机核验'); return result; }
  const identity = lock.recovery;
  const validIdentity = identity?.schema === 1 && identity.platform === process.platform && validBootId(identity.platform, identity.bootId);
  if (!validIdentity) {
    result.reasons.push('旧锁或缺少进程组/启动身份信息；需人工核实持锁者及全部子进程，不能自动解锁');
  }
  let rebooted = false;
  if (validIdentity) {
    try {
      const current = bootId();
      if (!validBootId(process.platform, current)) throw new Error('当前启动身份格式无效');
      rebooted = current !== identity.bootId;
    }
    catch (error) { result.reasons.push(`无法核实系统启动身份：${error.message}`); }
  }
  // After a verified reboot no process from the recorded boot can survive; reused PIDs are unrelated.
  if (rebooted) { result.rebooted = true; return result; }
  for (const pid of [lock.pid, lock.workerPid].filter(positive)) {
    const state = processState(pid); result.processes.push({ pid, state });
    if (state !== '已退出') result.reasons.push(`进程 ${pid} ${state}`);
  }
  if (process.platform === 'linux' && identity?.schema === 1) {
    const groups = [identity.ownerGroup, ...(lock.workerPid === undefined ? [] : [identity.workerGroup])];
    if (groups.some(group => !positive(group)) || (lock.workerPid !== undefined && identity.workerGroup !== lock.workerPid)) {
      result.reasons.push('进程组记录不完整，无法核实遗留子进程');
    } else for (const group of new Set(groups)) {
      const state = processState(-group); result.processes.push({ group, state });
      if (state !== '已退出') result.reasons.push(`进程组 ${group} ${state}，可能仍有构建或同步子进程`);
    }
  } else if (identity?.schema === 1) {
    result.reasons.push('本平台同一次启动中无法证明所有子进程已退出；保留锁，需人工核验');
  }
  return result;
}

function printReport(report) {
  console.log(`项目目录：${report.root}（下列命令在此目录执行）`);
  console.log(`源码锁：${report.absent ? '不存在' : report.path}`);
  if (report.owner) console.log(`主机：${report.owner.host}；PID：${report.owner.pid}；workerPid：${report.owner.workerPid ?? '未启动'}；创建时间：${report.owner.createdAt}`);
  for (const item of report.processes) console.log(`${item.group ? '进程组' : '进程'} ${item.group ?? item.pid}：${item.state}`);
  if (report.rebooted) console.log('已核实系统在上次持锁后重新启动。');
  console.log(`发布状态：${report.status ?? '无法读取'}`);
  if (report.reasons.length) for (const reason of report.reasons) console.log(`保留原因：${reason}`);
  else if (!report.absent) console.log('进程检查通过；unlock-source 将在互斥保护下复核并备份旧锁。');
  if (report.next) console.log(`${report.absent ? '下一步' : '解锁后下一步'}：${report.next}`);
}

export function unlockSource(root) {
  return withControl(root, () => {
    const before = readLock(sourcePath(root));
    const report = inspectSourceLock(root, { ignoreControl: true });
    printReport(report);
    if (report.reasons.length) throw new Error('无法安全解锁，原锁和发布记录已保留。');
    if (!before) return;
    const directory = ensurePrivateDirectory(resolve(root, '.local/artifacts/source-lock-recovery'));
    const backup = resolve(directory, `source-release-${Date.now()}-${randomUUID()}.json`);
    // Recheck after inspection/backup preparation; never move a different generation of the lock.
    if (readLock(sourcePath(root))?.bytes !== before.bytes) throw new Error('检查期间源码锁已变化，停止解锁。');
    renameSync(sourcePath(root), backup);
    console.log(`源码锁已解除；旧锁备份：${backup}`);
    console.log(`下一步：${report.next}`);
  });
}

export function sourceLockCommand(root, args) {
  const [action, ...flags] = args;
  if (!['doctor', 'unlock-source'].includes(action) || flags.some(flag => flag !== '--help') || flags.length > 1) {
    throw new Error('用法：build 脚本 doctor | unlock-source [--help]；不提供强制解锁。');
  }
  if (flags.includes('--help')) {
    console.log('doctor：只读检查源码锁与发布状态；unlock-source：核实后备份并解除源码锁，不启动构建、不更新 Git、不清理 profile 锁。'); return 0;
  }
  if (action === 'doctor') {
    const report = inspectSourceLock(root); printReport(report); return report.reasons.length ? 1 : 0;
  }
  if (!existsSync(sourcePath(root))) {
    const report = inspectSourceLock(root); printReport(report); return report.reasons.length ? 1 : 0;
  }
  if (process.platform === 'linux') {
    // The command route intentionally bypasses the shell build lock, then takes it exactly once here.
    const child = spawnSync('flock', ['-n', '-E', '75', resolve(root, '.local/source-release.lock'), process.execPath,
      fileURLToPath(import.meta.url), '--under-flock', root], { stdio: 'inherit', windowsHide: true });
    if (child.error || child.status === 75) throw new Error('无法取得 Linux 外层锁：仍有部署在运行或 flock 不可用；原锁已保留。');
    return child.status ?? 1;
  }
  unlockSource(root); return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== '--under-flock' || process.argv.length !== 4 || process.platform !== 'linux') throw new Error('请通过 build 脚本 doctor / unlock-source 使用。');
    unlockSource(resolve(process.argv[3]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
