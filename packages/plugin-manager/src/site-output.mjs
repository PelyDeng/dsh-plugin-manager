/** Keep source-release progress on the terminal and tool output in a private log. */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ensurePrivateDirectory } from './private-files.mjs';
import { normalizeEnvironment } from './process.mjs';

const marker = 'DSH_BUILD_PROGRESS ';
function report(event) {
  if (process.env.DSH_BUILD_PROGRESS === '1') writeSync(process.stdout.fd, marker + JSON.stringify(event) + '\n');
}

/**
 * 阶段序号。`id` 让展示端能分辨重叠的阶段：并行构建时上一个还没结束，下一个的 `start`
 * 就到了。没有 `id` 的事件（旧工具快照）由展示端按标签归一，仍能显示。
 *
 * 带上进程号：一次发布里有多个进程各自上报（构建 worker、打包子进程、工具子进程），
 * 它们各自的计数器都从 1 开始，只靠序号会撞车 —— 实测一次发布里 16 个阶段有 6 组撞号，
 * 展示端按 id 归并时把并行的阶段算成了一个。
 */
let stageSequence = 0;
const stagePrefix = `stage-${process.pid}-`;

/**
 * 报告一个可能与其他阶段并行的阶段，返回它的结束回调。
 *
 * 需要并行的地方（例如并行打包多个插件）自己调度，用 `done` / `fail` 交代结果；
 * 单线执行的阶段直接用 {@link buildStep}。
 */
export function startStage(label) {
  const id = `${stagePrefix}${++stageSequence}`;
  const started = performance.now();
  let settled = false;
  report({ type: 'start', id, label });
  const finish = type => {
    if (settled) return;
    settled = true;
    report({ type, id, label, elapsedMs: performance.now() - started });
  };
  return { id, label, done: () => finish('done'), fail: () => finish('failed') };
}

/**
 * Report a build step without changing its result or failure.
 *
 * 阶段体可以是异步的：并行打包时一个阶段要等若干子进程，`done` 只在它真的结束后才报。
 */
export function buildStep(label, action) {
  const stage = startStage(label);
  try {
    const result = action();
    if (result && typeof result.then === 'function') {
      return result.then(
        value => { stage.done(); return value; },
        error => { stage.fail(); throw error; },
      );
    }
    stage.done();
    return result;
  } catch (error) {
    stage.fail();
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

/**
 * 各阶段耗时表：日志末尾自带归因，不必再回头 grep 进度行。
 *
 * 每行带开始时刻：阶段之间的间隙（文件复制、镜像打标一类没有被计时的部分）由此一眼可见，
 * 不必再靠「墙钟减去相加」去猜。
 *
 * 两行合计都给：逐项相加是「工具自己花了多少时间」，并行阶段互相重叠时它会大于墙钟；
 * 墙钟是「首个阶段开始到末个阶段结束」，阶段之间还有间隙，所以它也可能大于相加。只给一个数，
 * 另一个看起来就像算错了。两张表（这里与 timings.json）用同一条时间线和同一个墙钟口径。
 */
function stageSummary(stages, { wallMs = 0 } = {}) {
  const width = Math.max(...stages.map(stage => textWidth(stage.label)));
  const cell = label => label + ' '.repeat(Math.max(2, width - textWidth(label) + 2));
  const total = stages.reduce((sum, stage) => sum + Math.max(0, stage.elapsedMs), 0);
  const clock = startedAt => {
    const date = new Date(startedAt);
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, '0')).join(':');
  };
  return [
    '各阶段耗时（含进程启动；方括号为开始时刻）：',
    ...stages.map(stage => `  ${stage.startedAt === undefined ? '--:--:--' : clock(stage.startedAt)}  ${cell(stage.label)}${duration(stage.elapsedMs)}${stage.unfinished ? '（未结束）' : stage.ok ? '' : '（失败）'}`),
    `  ${cell('相加（逐项）')}${duration(total)}`,
    `  ${cell('墙钟（首末阶段之间）')}${duration(wallMs)}`,
  ].join('\n');
}

/**
 * 结构化计时记录（唯一实现）：把一次构建的逐步耗时落成可排查的 JSON。
 *
 * 与终端汇总表同源：`stages` 是同一条时间线（含失败与未结束阶段），`wallMs` 是同一个墙钟口径
 * （首个阶段开始到末个已结束阶段），`sumMs` 是各阶段耗时之和；并行阶段会重叠，所以 `sumMs` 可能
 * 大于 `wallMs`（`overlapMs` 记下差值）。`processMs` 另外给出「首个阶段开始到构建进程退出」的
 * 全程，用来发现末个阶段之后的收尾耗时。缺字段或时间戳不可用时退化为不报错的最小记录。
 */
export function buildTimingRecord({ buildId, startedAtMs, finishedAtMs, processFinishedAtMs, code, stages = [], metadata } = {}) {
  const elapsed = stage => Number.isFinite(stage.elapsedMs) ? Math.max(0, stage.elapsedMs) : 0;
  const now = Date.now();
  const start = Number.isFinite(startedAtMs) ? startedAtMs : Number.isFinite(finishedAtMs) ? finishedAtMs : now;
  const finish = Number.isFinite(finishedAtMs) ? finishedAtMs : start;
  const wallMs = Math.max(0, finish - start);
  const sumMs = stages.reduce((total, stage) => total + elapsed(stage), 0);
  return {
    schemaVersion: 1,
    buildId,
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date(finish).toISOString(),
    wallMs: Math.round(wallMs),
    sumMs: Math.round(sumMs),
    overlapMs: Math.max(0, Math.round(sumMs - wallMs)),
    processMs: Number.isFinite(processFinishedAtMs) ? Math.round(Math.max(0, processFinishedAtMs - start)) : Math.round(wallMs),
    exitCode: code,
    status: code === 0 ? 'ready' : 'failed',
    stages: stages.map(stage => ({
      id: stage.id ?? null,
      label: stage.label,
      startedAt: stage.startedAtIso ?? null,
      finishedAt: stage.finishedAtIso ?? null,
      elapsedMs: Math.round(elapsed(stage)),
      status: stage.ok === true ? 'done' : stage.unfinished ? 'unfinished' : 'failed',
    })),
    environment: metadata ?? {},
  };
}

/** 原子写入计时记录；写失败不得改变部署结果，只清理半成品并返回 false。 */
export function writeTimings(path, value) {
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return true;
  } catch { rmSync(temporary, { force: true }); return false; }
}

/** Run a build entry with live progress; return its exit code after closing its log. */
export async function presentBuild(entry, args, { logDirectory, output = process.stdout, env = process.env, cwd, onSpawn, onFinished, metadata, timingsPath } = {}) {
  const privateDirectory = ensurePrivateDirectory(resolve(logDirectory, `build-${Date.now()}-${randomUUID()}`));
  const log = resolve(privateDirectory, 'build.log');
  const timings = timingsPath ?? resolve(privateDirectory, 'timings.json');
  // 计时事件用的是进程单调时钟（performance.now），记录要落成可读的挂钟时间：先算出两者的固定偏移。
  const wallStart = Date.now() - performance.now();
  const fd = openSync(log, 'wx', 0o600);
  let settling = false;
  let presentation = Promise.resolve();
  const tail = [];
  /** 每个已完成（或已失败）阶段的耗时，末尾汇总成一张表。 */
  const stages = [];
  /**
   * 正在进行的阶段。并行构建时会有多个：展示端按 `id` 分别计时，逐个收尾。
   *
   * 键是「id + 标签」而不是只有 id：`id` 由上报方生成，不同进程的计数器可能撞号
   * （实测撞过），只按 id 归并会把两个同时进行的阶段当成一个。旧工具快照的事件没有
   * `id`，按标签归一，行为与单线时一致。
   */
  const active = new Map();
  let drawnLines = 0, firstStart, lastFinish;
  const stageKey = event => `${typeof event.id === 'string' && event.id ? event.id : 'label'}::${event.label}`;
  /**
   * 擦掉当前进度块。
   *
   * 约定：{@link draw} 结束后光标停在块首行行首，所以这里从光标处逐行清空即可。
   */
  const eraseBlock = () => {
    if (!output.isTTY || !drawnLines) return;
    for (let index = 0; index < drawnLines; index++) {
      output.write('\r\x1b[2K');
      if (index < drawnLines - 1) output.write('\n');
    }
    if (drawnLines > 1) output.write(`\x1b[${drawnLines - 1}A`);
    output.write('\r');
    drawnLines = 0;
  };
  const line = text => { eraseBlock(); if (output.isTTY) output.write('\r\x1b[2K'); output.write(`${text}\n`); };
  const bar = (stage, animate = false) => {
    const filled = Math.floor(stage.percent / 5);
    const remaining = 20 - filled;
    const cursor = animate && remaining && stage.frame++ % 2 === 0 ? '>' : '-';
    return `[${'='.repeat(filled)}${remaining ? cursor + '-'.repeat(remaining - 1) : ''}] ${String(stage.percent).padStart(3)}%`;
  };
  const elapsed = stage => stage.finishedMs ?? performance.now() - stage.startedAt;
  const stageLine = (stage, animate) => timedLine(`正在${stage.label} ${bar(stage, animate)}`, elapsed(stage), output);
  /**
   * 重画进度块：并行时每个阶段一行，单线时仍是一行原地刷新（输出与只有单个阶段时一致）。
   *
   * 结束后光标停在块首行行首、`drawnLines` 记为块高，{@link eraseBlock} 依赖这个约定。
   */
  const draw = () => {
    if (!output.isTTY) return;
    eraseBlock();
    if (!active.size) return;
    let index = 0;
    for (const stage of active.values()) {
      output.write(`\r\x1b[2K${stageLine(stage, true)}`);
      if (index++ < active.size - 1) output.write('\n');
    }
    drawnLines = active.size;
    if (drawnLines > 1) output.write(`\x1b[${drawnLines - 1}A`);
    output.write('\r');
  };
  const show = async event => {
    if (event.type === 'start') {
      const stage = { id: typeof event.id === 'string' && event.id ? event.id : null, label: event.label, startedAt: event.receivedAt, startedAtIso: new Date(wallStart + event.receivedAt).toISOString(), percent: 0, frame: 0, finishedMs: undefined };
      active.set(stageKey(event), stage);
      firstStart ??= event.receivedAt;
      if (output.isTTY) draw(); else line(stageLine(stage, false));
      return;
    }
    if (event.type === 'message') { line(event.label); return; }
    const key = stageKey(event);
    const stage = active.get(key) ?? { id: typeof event.id === 'string' && event.id ? event.id : null, label: event.label, startedAt: event.receivedAt, startedAtIso: new Date(wallStart + event.receivedAt).toISOString(), percent: 0, frame: 0 };
    active.delete(key);
    stage.finishedMs = Number.isFinite(event.elapsedMs) ? Math.max(0, event.elapsedMs) : event.receivedAt - stage.startedAt;
    lastFinish = event.receivedAt;
    const ok = event.type === 'done';
    stages.push({ id: stage.id, label: stage.label, elapsedMs: elapsed(stage), ok, startedAt: stage.startedAt, startedAtIso: stage.startedAtIso, finishedAtIso: new Date(wallStart + event.receivedAt).toISOString() });
    // 补满动画只在这一阶段是最后一个时做：还有阶段在跑时，动画会盖住它们的进度。
    if (ok && output.isTTY && !active.size) {
      settling = true;
      const from = stage.percent;
      for (let frame = 1; frame <= 8; frame++) {
        await delay(30);
        stage.percent = Math.floor(from + (100 - from) * frame / 9);
        output.write(`\r\x1b[2K${stageLine(stage, true)}`);
      }
      settling = false;
    }
    // 失败时保留它当时的进度：报满 100% 会让人以为这一步做完了。
    if (ok) stage.percent = 100;
    line(timedLine(`${stage.label}${ok ? '已完成' : '失败'} ${bar(stage)}`, elapsed(stage), output));
    // 完成的这一行写在原块首行；还在跑的阶段立刻回到屏幕上，不必等下一次计时刷新。
    if (active.size) draw();
  };
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...normalizeEnvironment(env), DSH_BUILD_PROGRESS: '1', DSH_BUILD_TIMINGS: timings }, cwd,
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
    if (!active.size || settling) return;
    // Tools do not expose a common work counter. Estimated waiting progress stays below completion.
    for (const stage of active.values()) stage.percent = Math.min(95, Math.floor(95 * (1 - Math.exp(-(performance.now() - stage.startedAt) / 15000))));
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
      // 还在跑的阶段就是没来得及报结束的那些：按它们的名字与已等待时间收尾。
      const running = [...active.values()];
      const failure = `${running.map(stage => stage.label).join('、') || '构建发布'}失败（退出码 ${code}）${running.length ? ` ${bar(running[0])}` : ''}`;
      line(running.length ? timedLine(failure, running[0].finishedMs ?? closedAt - running[0].startedAt, output) : failure);
      if (tail.length) line(tail.join('\n'));
      line(`完整日志：${log}`);
    }
    // 汇总放在最后：发布记录、失败原因都在上面，接着就是「时间花在哪」。
    // 终端表与 timings.json 用同一条时间线和同一个墙钟口径：还在跑的阶段按已等待时间一并列出，
    // 失败也写记录，运维排查慢步骤不必只靠终端回滚。
    const timeline = [...stages, ...[...active.values()].map(stage => ({ id: stage.id, label: stage.label, elapsedMs: stage.finishedMs ?? closedAt - stage.startedAt, ok: false, unfinished: true, startedAt: stage.startedAt, startedAtIso: stage.startedAtIso }))];
    // 孤立终止事件（只有 done/failed、没有 start）时 `firstStart` 是空的：退回最早一个阶段自己的
    // 开始时间，免得记录的 startedAt 比它内部的阶段还晚。
    const earliest = timeline.reduce((value, stage) => Number.isFinite(stage.startedAt) ? Math.min(value, stage.startedAt) : value, firstStart ?? Infinity);
    const startedAtMs = wallStart + (Number.isFinite(earliest) ? earliest : closedAt);
    const record = buildTimingRecord({ buildId: basename(privateDirectory), startedAtMs, finishedAtMs: wallStart + (lastFinish ?? closedAt), processFinishedAtMs: wallStart + closedAt, code, stages: timeline, metadata });
    if (writeTimings(timings, record)) line(`时间记录：${timings}`);
    else line(`时间记录写入失败：${timings}（不影响本次构建结果）`);
    if (timeline.length) line(stageSummary(timeline, { wallMs: record.wallMs }));
    return code;
  } finally {
    clearInterval(timer); eraseBlock(); closeSync(fd);
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
