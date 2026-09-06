/** Keep source-release progress on the terminal and tool output in a private log. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const marker = 'DSH_BUILD_PROGRESS ';
function report(event) {
  if (process.env.DSH_BUILD_PROGRESS === '1') writeSync(process.stdout.fd, marker + JSON.stringify(event) + '\n');
}

/** Report a synchronous build step without changing its result or failure. */
export function buildStep(label, action) {
  report({ type: 'start', label });
  try {
    const result = action();
    report({ type: 'done', label });
    return result;
  } catch (error) {
    report({ type: 'failed', label });
    throw error;
  }
}

/** Keep final deployment locations visible when detailed output is redirected. */
export function buildMessage(message) {
  if (process.env.DSH_BUILD_PROGRESS === '1') report({ type: 'message', label: message });
  else console.log(message);
}

/** Run a build entry with live progress; return its exit code after closing its log. */
export async function presentBuild(entry, args, { logDirectory, output = process.stdout } = {}) {
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  const log = resolve(logDirectory, `build-${Date.now()}-${randomUUID()}.log`);
  const fd = openSync(log, 'wx', 0o600);
  let active = '', dots = 0;
  const tail = [];
  const clear = () => { if (output.isTTY) output.write('\r\x1b[2K'); };
  const line = text => { clear(); output.write(`${text}\n`); };
  const draw = () => { if (output.isTTY && active) { clear(); output.write(`正在${active}${'.'.repeat(dots++ % 3 + 1)}`); } };
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, DSH_BUILD_PROGRESS: '1' },
    stdio: ['inherit', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
  });
  const forward = signal => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const timer = setInterval(draw, 250);
  for (const [stream, progress] of [[child.stdout, true], [child.stderr, false]]) {
    stream.on('data', chunk => writeSync(fd, chunk));
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', text => {
      if (progress && text.startsWith(marker)) {
        let event;
        try { event = JSON.parse(text.slice(marker.length)); } catch { /* Tool text is retained as ordinary log output. */ }
        if (event && typeof event.label === 'string') {
          if (event.type === 'start') { active = event.label; dots = 0; if (output.isTTY) draw(); else line(`正在${active}...`); return; }
          if (event.type === 'done') { line(`${event.label}已完成`); active = ''; return; }
          if (event.type === 'failed') { line(`${event.label}失败`); active = ''; return; }
          if (event.type === 'message') { line(event.label); return; }
        }
      }
      if (text.trim()) { tail.push(stripVTControlCharacters(text).slice(-500)); if (tail.length > 12) tail.shift(); }
    });
  }
  line(`详细日志：${log}`);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
    });
    if (code !== 0) {
      line(`${active || '构建发布'}失败（退出码 ${code}）`);
      if (tail.length) line(tail.join('\n'));
      line(`完整日志：${log}`);
    }
    return code;
  } finally {
    clearInterval(timer); clear(); closeSync(fd);
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await presentBuild(fileURLToPath(new URL('./build.mjs', import.meta.url)), process.argv.slice(2), {
      logDirectory: fileURLToPath(new URL('../../.local/artifacts/build-logs/', import.meta.url)),
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
