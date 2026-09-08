import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, lstatSync, rmdirSync, writeFileSync, renameSync, linkSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
