/** Keep source-release progress on the terminal and tool output in a private log. */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePrivateDirectory } from '../../packages/plugin-manager/src/private-files.mjs';
import { normalizeEnvironment } from '../../packages/plugin-manager/src/process.mjs';

const marker = 'DSH_BUILD_PROGRESS ';
function report(event) {
  if (process.env.DSH_BUILD_PROGRESS === '1') writeSync(process.stdout.fd, marker + JSON.stringify(event) + '\n');
}

/** Report a synchronous build step without changing its result or failure. */
export function buildStep(label, action) {
  const started = performance.now();
  report({ type: 'start', label });
  try {
    const result = action();
    report({ type: 'done', label, elapsedMs: performance.now() - started });
    return result;
  } catch (error) {
    report({ type: 'failed', label, elapsedMs: performance.now() - started });
    throw error;
  }
}

/** Keep final deployment locations visible when detailed output is redirected. */
export function buildMessage(message) {
  if (process.env.DSH_BUILD_PROGRESS === '1') report({ type: 'message', label: message });
  else console.log(message);
}

function duration(milliseconds) {
  const tenths = Math.floor(Math.max(0, milliseconds) / 100);
  return `${String(Math.floor(tenths / 36000)).padStart(2, '0')}:${String(Math.floor(tenths / 600) % 60).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

// Build labels use Chinese and ASCII; reserve the last column to avoid terminal wrapping.
const textWidth = text => [...text].reduce((size, char) => size + (/[\p{Script=Han}\u3000-\u303f\uff01-\uff60]/u.test(char) ? 2 : 1), 0);
function timedLine(text, elapsedMs, output) {
  const right = `耗时 ${duration(elapsedMs)}`;
  if (!output.isTTY) return `${text}  ${right}`;
  const available = Math.max(0, (output.columns || 80) - 1 - textWidth(right) - 2);
  if (textWidth(text) > available) {
    let shortened = '';
    for (const char of text) {
      if (textWidth(shortened + char) + 1 > available) break;
      shortened += char;
    }
    text = available ? shortened + '…' : '';
  }
  return text + ' '.repeat(Math.max(2, (output.columns || 80) - 1 - textWidth(text) - textWidth(right))) + right;
}

/** Run a build entry with live progress; return its exit code after closing its log. */
export async function presentBuild(entry, args, { logDirectory, output = process.stdout, env = process.env, cwd, onSpawn, onFinished } = {}) {
  const privateDirectory = ensurePrivateDirectory(resolve(logDirectory, `build-${Date.now()}-${randomUUID()}`));
  const log = resolve(privateDirectory, 'build.log');
  const fd = openSync(log, 'wx', 0o600);
  let active = '', frame = 0, percent = 0, started = 0, settling = false, finishedMs;
  let presentation = Promise.resolve();
  const tail = [];
  const clear = () => { if (output.isTTY) output.write('\r\x1b[2K'); };
  const line = text => { clear(); output.write(`${text}\n`); };
  const bar = (animate = false) => {
    const filled = Math.floor(percent / 5);
    const remaining = 20 - filled;
    const cursor = animate && remaining && frame++ % 2 === 0 ? '>' : '-';
    return `[${'='.repeat(filled)}${remaining ? cursor + '-'.repeat(remaining - 1) : ''}] ${String(percent).padStart(3)}%`;
  };
  const elapsed = () => finishedMs ?? performance.now() - started;
  const draw = () => { if (output.isTTY && active) { clear(); output.write(timedLine(`正在${active} ${bar(true)}`, elapsed(), output)); } };
  const show = async event => {
    if (event.type === 'start') {
      active = event.label; frame = 0; percent = 0; started = event.receivedAt; finishedMs = undefined;
      if (output.isTTY) draw(); else line(timedLine(`正在${active} ${bar()}`, 0, output));
    } else if (event.type === 'done') {
      finishedMs = Number.isFinite(event.elapsedMs) ? Math.max(0, event.elapsedMs) : event.receivedAt - started;
      settling = true;
      // Animate only the display; the build process continues without waiting.
      if (output.isTTY) {
        const from = percent;
        for (let frame = 1; frame <= 8; frame++) {
          await delay(30);
          percent = Math.floor(from + (100 - from) * frame / 9);
          draw();
        }
      }
      percent = 100; line(timedLine(`${event.label}已完成 ${bar()}`, elapsed(), output)); active = ''; settling = false;
    } else if (event.type === 'failed') {
      finishedMs = Number.isFinite(event.elapsedMs) ? Math.max(0, event.elapsedMs) : event.receivedAt - started;
      line(timedLine(`${event.label}失败 ${bar()}`, elapsed(), output)); active = '';
    } else if (event.type === 'message') line(event.label);
  };
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...normalizeEnvironment(env), DSH_BUILD_PROGRESS: '1' }, cwd,
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32', windowsHide: true,
  });
  child.on('message', message => {
    if (message?.type === 'source-build-finished' && Number.isInteger(message.code)) onFinished?.(message.code);
  });
  let interrupted;
  const forward = signal => {
    interrupted ??= signal;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') {
        // Terminate only the process tree created by this presenter. The source lock is retained.
        const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        if (result.error || result.status !== 0) child.kill(signal);
      } else process.kill(-child.pid, signal);
    }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  const timer = setInterval(() => {
    if (!active || settling) return;
    // Tools do not expose a common work counter. Estimated waiting progress stays below completion.
    percent = Math.min(95, Math.floor(95 * (1 - Math.exp(-(performance.now() - started) / 15000))));
    draw();
  }, 100);
  for (const [stream, progress] of [[child.stdout, true], [child.stderr, false]]) {
    stream.on('data', chunk => writeSync(fd, chunk));
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', text => {
      if (progress && text.startsWith(marker)) {
        let event;
        try { event = JSON.parse(text.slice(marker.length)); } catch { /* Tool text is retained as ordinary log output. */ }
        if (event && typeof event.label === 'string' && ['start', 'done', 'failed', 'message'].includes(event.type)) {
          event.receivedAt = performance.now();
          presentation = presentation.then(() => show(event));
          return;
        }
      }
      if (text.trim()) { tail.push(stripVTControlCharacters(text).slice(-500)); if (tail.length > 12) tail.shift(); }
    });
  }
  line(`详细日志：${log}`);
  try {
    const completed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        const stopped = interrupted ?? signal;
        resolve(stopped === 'SIGINT' ? 130 : stopped === 'SIGTERM' ? 143 : code ?? 1);
      });
    });
    try { onSpawn?.(child); } catch (error) { forward('SIGTERM'); await completed.catch(() => {}); throw error; }
    const code = await completed;
    const closedAt = performance.now();
    await presentation;
    if (code !== 0) {
      const failure = `${active || '构建发布'}失败（退出码 ${code}）${active ? ` ${bar()}` : ''}`;
      line(active ? timedLine(failure, finishedMs ?? closedAt - started, output) : failure);
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
