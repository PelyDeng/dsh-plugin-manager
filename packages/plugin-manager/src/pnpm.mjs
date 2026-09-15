/** 无工作区依赖的 pnpm 进程入口，也供首次安装前置检查使用。 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { commandSpec, normalizeEnvironment } from './process.mjs';

/**
 * 让本机 pnpm 与项目固定的版本一致；缺失或版本不符时在项目内准备一份。
 *
 * 固定版本始终按 `root` 的根清单决定：内置构建在**隔离视图**里安装依赖，而视图清单是复制来的，
 * 不能作为「本项目要哪个 pnpm」的权威来源。
 */
export function ensurePinnedPnpm(root, env, execute) {
  const run = (bin, args, options = {}) => execute(bin, args, { cwd: root, env, ...options });
  const capture = (bin, args) => run(bin, args, { stdio: 'pipe', encoding: 'utf8' });
  const pin = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).packageManager;
  if (!/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/.test(pin)) throw new Error('packageManager must pin a pnpm version.');
  let version;
  try { version = capture('pnpm', ['--version']); } catch { /* A missing or wrong pnpm is prepared locally. */ }
  if (version !== pin.slice(5)) {
    const tooling = resolve(root, '.local/tooling/pnpm');
    // 这里不用进度包装：本模块要保持无额外依赖，便于在还没有 node_modules 的检出里单独运行。
    console.log(`[准备构建工具] npm install --prefix ${tooling} ${pin}`);
    run('npm', ['install', '--prefix', tooling, '--ignore-scripts', '--no-audit', '--no-fund', pin]);
    env.PATH = `${resolve(tooling, 'node_modules/.bin')}${delimiter}${env.PATH ?? ''}`;
    if (capture('pnpm', ['--version']) !== pin.slice(5)) throw new Error('Could not prepare the pinned pnpm version.');
  }
}

function spec(args, cwd, env) {
  try { return commandSpec('pnpm', { env, cwd }); }
  catch (error) {
    // Preserve explicit pnpm JS runners, but prefer this operation's pinned PATH first.
    const entry = env.npm_execpath;
    if (process.platform !== 'win32' || !entry || !/pnpm\.(?:c?js)$/u.test(entry) || !existsSync(entry)) throw error;
    return commandSpec(entry, { env, cwd });
  }
}

function failure(args, result, captured) {
  if (captured.stdout?.length) process.stdout.write(captured.stdout);
  if (captured.stderr?.length) process.stderr.write(captured.stderr);
  const error = result.error ?? new Error(`pnpm ${args[0]} 失败，退出码 ${result.status ?? result.signal}。`);
  // 调用方据此识别已知报错形态并给出提示，不必再跑一遍。
  error.captured = { stdout: String(captured.stdout ?? ''), stderr: String(captured.stderr ?? '') };
  return error;
}

/** 同步但捕获输出：需要在失败时看懂报错的任务（检查一类）用它，成功的任务照旧继承 stdio。 */
export function runPnpmCaptured(args, cwd, options = {}) {
  const env = normalizeEnvironment(options.env ?? process.env);
  const { command, prefix } = spec(args, cwd, env);
  const result = spawnSync(command, [...prefix, ...args], { cwd, env, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024, ...options });
  const captured = { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (result.error || result.status !== 0) throw failure(args, result, captured);
  return captured;
}

/** Run pnpm without a command shell; forward captured diagnostics only on failure. */
export function runPnpm(args, cwd, options = {}) {
  const env = normalizeEnvironment(options.env ?? process.env);
  const { command, prefix } = spec(args, cwd, env);
  const result = spawnSync(command, [...prefix, ...args], { cwd, stdio: 'inherit', ...options, env, shell: false });
  if (result.error || result.status !== 0) throw failure(args, result, result);
  return result;
}

/**
 * 异步版：并行调度多个插件时用，输出先收在内存里，避免几个构建的日志互相穿插。
 *
 * 返回 `{ stdout, stderr }`；调用方按需呈现（成功时按插件分组回放，失败时原样转发）。
 * 超过 `maxBuffer` 的部分丢弃并标注，免得一个话多的工具把部署进程撑爆。
 */
export function runPnpmAsync(args, cwd, options = {}) {
  const env = normalizeEnvironment(options.env ?? process.env);
  const { command, prefix } = spec(args, cwd, env);
  const limit = options.maxBuffer ?? 32 * 1024 * 1024;
  const sink = (name, limit, stream) => {
    const chunks = [];
    let size = 0;
    let dropped = false;
    stream.on('data', chunk => {
      const room = limit - size;
      if (room <= 0) { dropped = true; return; }
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (kept.length < chunk.length) dropped = true;
      chunks.push(kept); size += kept.length;
    });
    return () => {
      const text = Buffer.concat(chunks).toString('utf8');
      return dropped ? `${text}\n[${name} 超过 ${limit} 字节，后续输出已丢弃]\n` : text;
    };
  };
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = sink('stdout', limit, child.stdout), err = sink('stderr', Math.min(limit, 4 * 1024 * 1024), child.stderr);
    const captured = () => ({ stdout: out(), stderr: err() });
    child.once('error', error => reject(failure(args, { error }, captured())));
    child.once('close', (status, signal) => {
      if (status === 0) resolve(captured());
      else reject(failure(args, { status, signal }, captured()));
    });
  });
}
