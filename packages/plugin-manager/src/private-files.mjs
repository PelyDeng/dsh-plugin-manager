import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, lstatSync, rmdirSync, writeFileSync, renameSync, linkSync, rmSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 读取前把私有配置收紧到 0600。
 *
 * 站点配置随仓库分发，而 Git 只记录可执行位、不携带 0600：部署机首次检出得到的通常是 0644，
 * 直接读取会被权限检查拒绝。这里只**收紧**、绝不放宽，所以安全检查仍然有效，新部署机也做到
 * 拉取即可用，不必手工 chmod。
 *
 * 失败一律交给读取方：文件不存在、不是普通文件或不允许修改属主时，`readPrivateConfig` 给出的
 * 诊断比这里更准确。
 */
export function tightenPrivateFile(path) {
  if (process.platform === 'win32') return;
  try {
    const absolute = resolve(path);
    const info = lstatSync(absolute);
    if (info.isFile() && (info.mode & 0o077) !== 0) chmodSync(absolute, 0o600);
  } catch { /* 交由 readPrivateConfig 诊断。 */ }
}

/** Protect only a newly created private directory; existing data permissions stay intact. */
export function ensurePrivateDirectory(path) {
  path = resolve(path);
  const parent = dirname(path);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('私有目录不能是文件或目录联接。');
    return path;
  }
  if (parent !== path) ensurePrivateDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop'; $path=$env:DSH_PRIVATE_DIRECTORY; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($sid in @($user,(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))) { $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; [System.IO.Directory]::SetAccessControl($path,$acl)`;
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, DSH_PRIVATE_DIRECTORY: path }, windowsHide: true, stdio: 'pipe' });
    } catch (error) { rmdirSync(path); throw error; }
  }
  return path;
}

/** Apply Windows ACLs before secret bytes exist, including under older public parents. */
export function writePrivateFile(path, bytes, options = {}) {
  path = resolve(path);
  ensurePrivateDirectory(dirname(path));
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('私有文件不能是符号链接。');
  if (process.platform !== 'win32') { writeFileSync(path, bytes, { mode: 0o600, ...options }); return; }
  const directory = ensurePrivateDirectory(join(dirname(path), `.private-${randomUUID()}`)), temporary = join(directory, 'content');
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    if (options.flag === 'wx') linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); rmdirSync(directory); }
}
