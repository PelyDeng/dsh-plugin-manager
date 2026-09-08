/** 无工作区依赖的 pnpm 进程入口，也供首次安装前置检查使用。 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, resolve } from 'node:path';

/** Run pnpm without a command shell; forward captured diagnostics only on failure. */
export function runPnpm(args, cwd, options = {}) {
  let command = 'pnpm';
  let prefix = [];
  if (process.platform === 'win32') {
    const candidates = [process.env.npm_execpath, ...(process.env.PATH ?? '').split(delimiter).flatMap(directory => [
      resolve(directory, 'node_modules/corepack/dist/pnpm.js'),
      resolve(directory, 'node_modules/pnpm/bin/pnpm.cjs'),
      resolve(directory, 'pnpm.cjs'),
    ])];
    const cli = candidates.find(candidate => candidate && /pnpm\.(?:c?js)$/u.test(candidate) && existsSync(candidate));
    if (!cli) throw new Error('找不到 pnpm JavaScript 入口；请安装 pnpm/Corepack 或通过 pnpm 运行本命令。');
    command = process.execPath;
    prefix = [cli];
  }
  const result = spawnSync(command, [...prefix, ...args], { cwd, stdio: 'inherit', ...options, shell: false });
  if (result.error || result.status !== 0) {
    if (result.stdout?.length) process.stdout.write(result.stdout);
    if (result.stderr?.length) process.stderr.write(result.stderr);
    throw result.error ?? new Error(`pnpm ${args[0]} 失败，退出码 ${result.status ?? result.signal}。`);
  }
  return result;
}
