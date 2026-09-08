/** 无工作区依赖的 pnpm 进程入口，也供首次安装前置检查使用。 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { commandSpec, normalizeEnvironment } from './process.mjs';

/** Run pnpm without a command shell; forward captured diagnostics only on failure. */
export function runPnpm(args, cwd, options = {}) {
  const env = normalizeEnvironment(options.env ?? process.env);
  let spec;
  try { spec = commandSpec('pnpm', { env, cwd }); }
  catch (error) {
    // Preserve explicit pnpm JS runners, but prefer this operation's pinned PATH first.
    const entry = env.npm_execpath;
    if (process.platform !== 'win32' || !entry || !/pnpm\.(?:c?js)$/u.test(entry) || !existsSync(entry)) throw error;
    spec = commandSpec(entry, { env, cwd });
  }
  const { command, prefix } = spec;
  const result = spawnSync(command, [...prefix, ...args], { cwd, stdio: 'inherit', ...options, env, shell: false });
  if (result.error || result.status !== 0) {
    if (result.stdout?.length) process.stdout.write(result.stdout);
    if (result.stderr?.length) process.stderr.write(result.stderr);
    throw result.error ?? new Error(`pnpm ${args[0]} 失败，退出码 ${result.status ?? result.signal}。`);
  }
  return result;
}
