/** Repository entry: prepare source-only dependencies, then use the shared site operation. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { siteArguments } from '../../packages/plugin-manager/src/site-record.mjs';
import { commandSpec, normalizeEnvironment } from '../../packages/plugin-manager/src/process.mjs';
import { frameworkVersion } from '../../scripts/version.mjs';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
let interrupted = false;
function command(bin, args, options) {
  const cli = commandSpec(bin, options);
  const result = spawnSync(cli.command, [...cli.prefix, ...args], { stdio: 'inherit', windowsHide: true, ...options });
  if (result.signal) interrupted = true;
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error(`${bin} ${args[0]} failed (${result.status ?? result.signal}). ${result.stderr ?? ''}`), { signal: result.signal });
  return result.stdout?.trim() ?? '';
}
let releaseSite, sourceAdapter, validate;
async function loadSource() {
  ({ releaseSite } = await import('../../packages/plugin-manager/src/site-release.mjs'));
  ({ sourceAdapter, validateBase: validate } = await import('./source-input.mjs'));
}
if (!direct) await loadSource();
export function validateBase(reference, info) {
  return validate(reference, info);
}
export function release({ root = repositoryRoot, ...options } = {}, execute = command, buildHost, tooling) {
  return releaseSite({ root, inputKind: 'source', ...options }, execute, sourceAdapter({ ...(buildHost ? { buildHost } : {}), ...(tooling ? { tooling } : {}) }));
}
if (direct) {
  try {
    const options = siteArguments(process.argv.slice(2));
    if (options.help) console.log('Windows: .\\build.ps1 [--config <env.conf>]\nLinux/macOS: bash build.sh [相同参数]\nsource 构建内置源码并合并 incoming 外部产物；archives 入口由发行包自带的 build 脚本提供。内置插件固定全量构建，外部产物来自 incoming，不再按旧记录复用；构建只做构建与打包，插件检查由仓库 CI 与 check 命令承担。doctor 只读诊断锁；unlock-source 安全解锁。');
    else {
      frameworkVersion(repositoryRoot);
      // 源码检出入口固定 source：插件来源不再由站点配置字段二选一，也没有第二套准备逻辑。
      const { bootstrapSource } = await import('./bootstrap.mjs');
      bootstrapSource(repositoryRoot, process.argv.slice(2), normalizeEnvironment(process.env), command);
      await loadSource();
      release({ config: options.config });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  if (typeof process.send === 'function') {
    if (interrupted) process.disconnect();
    else process.send({ type: 'source-build-finished', code: process.exitCode ?? 0 }, () => process.disconnect());
  }
}
