import { randomUUID } from 'node:crypto';
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/** Atomically claim a lock file; never steal it based on age or a disappeared PID. */
export function acquireFileLock(path, message = `Operation is locked: ${path}`) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(message); throw error; }
  const owner = { pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), token: randomUUID() };
  let closed = false;
  const write = fields => {
    const text = `${JSON.stringify({ ...fields, ...owner })}\n`;
    ftruncateSync(fd, 0); writeSync(fd, text, 0, 'utf8');
  };
  try { write({}); } catch (error) { closeSync(fd); throw error; }
  const release = () => {
    if (closed) return;
    closed = true; closeSync(fd);
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (current.token !== owner.token) throw new Error(`Lock ownership changed; retained ${path}`);
    rmSync(path);
  };
  release.update = fields => {
    if (closed) throw new Error('Cannot update a released lock.');
    const current = JSON.parse(readFileSync(path, 'utf8'));
    if (current.token !== owner.token) throw new Error(`Lock ownership changed; retained ${path}`);
    write(fields);
  };
  release.retain = () => { if (!closed) { closed = true; closeSync(fd); } };
  return release;
}

/**
 * 串行化一把锁的元数据操作：取锁、退役残留、显式解锁都先取同一把 control 锁。
 *
 * 没有这一步，"读一遍确认它是旧记录 → 把它移走" 与 "另一个进程新建锁" 之间就有窗口：搬走的可能
 * 是别人刚取得的锁，对方释放时报 ENOENT。control 锁只覆盖元数据操作本身，不覆盖持锁期间的工作。
 */
export function withLockControl(lockPath, action) {
  const control = `${lockPath}.control`;
  const release = acquireFileLock(control, `锁元数据正在操作或上次操作被强制终止；确认没有并发的安装后删除 ${control} 再重试。`);
  try { return action(); } finally { release(); }
}
