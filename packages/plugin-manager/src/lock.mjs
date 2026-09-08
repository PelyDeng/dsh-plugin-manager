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
