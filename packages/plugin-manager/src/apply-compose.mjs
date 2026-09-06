/** Apply an isolated generated Compose document; source configuration stays user-owned. */
import { chownSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicJSON, fail, json } from './state.mjs';
import { renderCompose } from './compose.mjs';
import { resolvePluginSettings } from './plugin-settings.mjs';

/** Initialize missing settings and perform a controlled restart with readiness checks. */
export function applyCompose(deployment, release, execute = (args) => execFileSync('docker', args, { stdio: 'inherit' })) {
  const image = deployment.config.containerImage;
  if (typeof image !== 'string' || !/^\S+@sha256:[a-f0-9]{64}$/.test(image)) fail('apply-compose 需要 containerImage 不可变镜像摘要。');
  const project = deployment.config.composeProject ?? 'dsh-plugins';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) fail('composeProject 无效。');
  const settings = resolvePluginSettings(deployment, release);
  const uid = deployment.config.containerUid ?? 1000, gid = deployment.config.containerGid ?? 1000;
  if (![uid, gid].every(value => Number.isSafeInteger(value) && value > 0)) fail('containerUid/containerGid 必须是非 root 正整数。');
  const own = path => { if (process.platform !== 'win32' && process.getuid?.() === 0) chownSync(path, uid, gid); };
  const ensureDirectory = path => {
    if (existsSync(path)) return;
    ensureDirectory(dirname(path)); mkdirSync(path); own(path);
  };
  const checkAccess = (path, required) => {
    if (process.platform === 'win32') return;
    const info = statSync(path);
    const bits = info.uid === uid ? (info.mode >> 6) : info.gid === gid ? (info.mode >> 3) : info.mode;
    if ((bits & required) !== required) fail(`容器用户 ${uid}:${gid} 无法访问 ${path}；请先调整该路径权限。`);
  };
  for (const path of [deployment.dataRoot, deployment.home, deployment.workspace]) { ensureDirectory(path); checkAccess(path, 7); }
  for (const [id, file] of Object.entries(settings.files)) if (!existsSync(file)) {
    const plugin = release.plugins.find(plugin => plugin.id === id);
    ensureDirectory(dirname(file));
    atomicJSON(file, { schemaVersion: 1, enabled: true, ...(plugin.configuration.auth === 'consumer' ? { accessMode: 'authenticated' } : {}) }); own(file);
  }
  const output = join(deployment.artifacts, randomUUID(), 'compose');
  const generated = renderCompose(deployment, release, output);
  own(generated.configPath);
  const compose = json(generated.path);
  const service = compose.services.dsh;
  Object.assign(service, { image, user: `${uid}:${gid}`, restart: 'unless-stopped', init: true, network_mode: 'host', security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], stop_grace_period: '30s' });
  Object.assign(service.environment, { DSH_BIND_HOST: '127.0.0.1', DSH_PORT: String(deployment.config.port ?? 7902) });
  for (const mount of service.volumes) if (existsSync(mount.source)) checkAccess(mount.source, statSync(mount.source).isDirectory() ? 5 : mount.read_only ? 4 : 6);
  atomicJSON(generated.path, compose);
  const args = ['compose', '-p', project, '-f', generated.path];
  execute([...args, 'stop', 'dsh']);
  execute([...args, 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '180', 'dsh']);
  atomicJSON(join(deployment.artifacts, 'active-compose.json'), { schemaVersion: 1, project, path: generated.path, appliedAt: new Date().toISOString() });
  return { ...generated, project, status: 'ready' };
}
