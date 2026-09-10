/** Read-only prerequisites shared by both site inputs. No package installation here. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commandSpec, normalizeEnvironment } from './process.mjs';
import { tarCommand, canonical, within } from './state.mjs';
import { inspectDocker } from './docker-runtime.mjs';
import { ensurePrivateDirectory } from './private-files.mjs';

export function checkSourceNode(platform = process.platform, version = process.versions.node) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error('Source deployment supports Windows, macOS and Linux.');
  const [major, minor] = version.split('.').map(Number);
  if (!(major === 22 && minor >= 19 || major >= 24)) throw new Error('Use Node.js ^22.19 or >=24.');
}

export function prepareSiteRelease(root, { inputKind = 'source', recovery = false } = {}) {
  checkSourceNode();
  const env = normalizeEnvironment(process.env), errors = [];
  for (const name of [tarCommand, ...(inputKind === 'source' && !recovery ? ['git', 'npm'] : [])]) {
    try {
      const cli = commandSpec(name, { env, cwd: root });
      const result = spawnSync(cli.command, [...cli.prefix, '--version'], { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (result.error || result.status !== 0) throw new Error(`Missing or unusable prerequisite: ${name}.`);
    } catch (error) { errors.push(error.message); }
  }
  let runtime;
  try { runtime = inspectDocker(); } catch (error) { errors.push(`Docker/Compose：${error.message}；镜像与挂载尚未检查，请启动本机 Linux Docker 引擎。`); }
  if (errors.length) throw new Error(`运行环境检查未通过：\n${errors.join('\n')}`);
  console.log(`环境：Node ${process.versions.node}；Linux/${runtime.architecture}；Docker Compose 可用。`);
  for (const key of Object.keys(env)) if (['DOCKER_HOST', 'DOCKER_CONTEXT'].includes(key.toUpperCase())) delete env[key];
  env.DOCKER_HOST = runtime.endpoint;
  const local = resolve(root, '.local');
  if (!within(canonical(root), canonical(local))) throw new Error('Project .local must stay inside the explicit repository root.');
  ensurePrivateDirectory(local);
  return { env, runtime };
}
export const prepareSourceRelease = root => prepareSiteRelease(root);
