/** Repository entry: prepare source-only dependencies, then use the shared site operation. */
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { siteArguments, readSiteJson } from '../../packages/plugin-manager/src/site-record.mjs';
import { readFrameworkConfig } from '../../packages/plugin-manager/src/framework-config.mjs';
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
    if (options.help) console.log('Windows: .\\build.ps1 [--config <env.conf>] [--rebuild-plugins <id,...> | --verify-plugin-check | --resume | --recover --data-compatible]\nLinux/macOS: bash build.sh [相同参数]\nsource 构建源码；archives 读取 incoming 完整发布目录。插件检查默认跳过（CI 已跑过，产物不变），要本机确认时加 --verify-plugin-check。doctor 只读诊断锁；unlock-source 安全解锁。');
    else {
      frameworkVersion(repositoryRoot);
      const file = resolve(repositoryRoot, options.config ?? '.local/env.conf');
      const kind = existsSync(file) ? (file.endsWith('.conf') ? readFrameworkConfig(file).config : readSiteJson(file)).pluginSource ?? 'source' : 'source';
      if (kind === 'archives') {
        const { prepareManagerTooling } = await import('../../scripts/manager-tooling.mjs');
        const { ensurePinnedPnpm } = await import('./bootstrap.mjs');
        const env = normalizeEnvironment(process.env);
        ensurePinnedPnpm(repositoryRoot, env, command);
        const prepared = prepareManagerTooling({ root: repositoryRoot, output: resolve(repositoryRoot, '.local/artifacts', `site-tools-${randomUUID()}`), execute: command, env });
        command(process.execPath, [resolve(dirname(prepared.cli), 'site-release.mjs'), ...process.argv.slice(2), '--root', repositoryRoot], { cwd: repositoryRoot, env: { ...env, DSH_SITE_TOOL_ROOT: prepared.toolRoot } });
      } else {
        const { bootstrapSource } = await import('./bootstrap.mjs');
        bootstrapSource(repositoryRoot, process.argv.slice(2), normalizeEnvironment(process.env), command);
        await loadSource();
        release({ config: options.config, resume: options.resume, recover: options.recover, dataCompatible: options['data-compatible'], rebuildPlugins: options['rebuild-plugins'], verifyPluginCheck: options['verify-plugin-check'] });
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  if (typeof process.send === 'function') {
    if (interrupted) process.disconnect();
    else process.send({ type: 'source-build-finished', code: process.exitCode ?? 0 }, () => process.disconnect());
  }
}
