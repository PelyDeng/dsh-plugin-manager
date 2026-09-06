/** Apply an isolated generated Compose document; source configuration stays user-owned. */
import { chownSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { LOCK, OWNER, atomicJSON, canonical, fail, json, within } from './state.mjs';
import { renderCompose } from './compose.mjs';
import { resolvePluginSettings } from './plugin-settings.mjs';
import { assertReleaseMode } from './release.mjs';

/** Initialize missing settings and perform a controlled restart with readiness checks. */
export function applyCompose(deployment, release, execute = (args, options = { stdio: 'inherit' }) => execFileSync('docker', args, options)) {
  assertReleaseMode(release, deployment.mode);
  const image = deployment.config.containerImage;
  if (typeof image !== 'string' || !/^(?:sha256:[a-f0-9]{64}|\S+@sha256:[a-f0-9]{64})$/.test(image)) fail('apply-compose 需要 containerImage 不可变镜像 ID 或仓库摘要。');
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
  if (image.startsWith('sha256:')) service.pull_policy = 'never';
  const flags = ['rebuild', 'resume'].filter(flag => deployment.options[flag]).map(flag => `--${flag}`);
  if (flags.length) service.command = flags;
  for (const mount of service.volumes) if (existsSync(mount.source)) checkAccess(mount.source, statSync(mount.source).isDirectory() ? 5 : mount.read_only ? 4 : 6);
  atomicJSON(generated.path, compose);
  const args = ['compose', '-p', project, '-f', generated.path];
  execute([...args, 'stop', 'dsh']);
  const residuals = [LOCK, OWNER].filter(name => existsSync(join(deployment.profileRoot, name)));
  if (residuals.length) {
    const capture = args => execute(args, { encoding: 'utf8' }).trim();
    const ids = capture([...args, 'ps', '-a', '-q', 'dsh']).split(/\s+/).filter(Boolean);
    if (!ids.length) fail('缺少旧容器身份，保留残留运行记录；请按恢复文档核实原管理者。');
    const containers = JSON.parse(capture(['inspect', ...ids]));
    if (containers.length !== ids.length || containers.some(container => container.State?.Running !== false || container.State?.Restarting !== false)) fail('旧容器尚未全部停止，保留运行记录。');
    const proven = containers.filter(container => {
      const variables = Object.fromEntries((container.Config?.Env ?? []).map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)]; }));
      const home = variables.DSH_HOME;
      if (container.State?.Running !== false || container.State?.Restarting !== false || !home || variables.DSH_PROFILE !== deployment.profile) return false;
      const mount = (container.Mounts ?? []).filter(item => item.Type === 'bind' && (home === item.Destination || home.startsWith(`${item.Destination}/`))).sort((a, b) => b.Destination.length - a.Destination.length)[0];
      return mount && canonical(resolve(mount.Source, posix.relative(mount.Destination, home))) === deployment.home;
    });
    for (const name of residuals) {
      const record = json(join(deployment.profileRoot, name));
      if (!record.host || !proven.some(container => container.Config.Hostname === record.host && (name !== OWNER || (record.profile === deployment.profile && container.Config.Env.includes(`DSH_HOME=${record.home}`))))) fail('残留运行记录无法对应已停止的旧容器；保留记录，不自动解除锁。');
    }
    const saved = join(output, 'stopped-records'); mkdirSync(saved, { mode: 0o700 });
    for (const name of residuals) {
      const path = join(deployment.profileRoot, name);
      if (!within(deployment.profileRoot, canonical(path))) fail('运行记录路径越界。');
      copyFileSync(path, join(saved, name));
    }
    for (const name of residuals) rmSync(join(deployment.profileRoot, name));
  }
  execute([...args, 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '180', 'dsh']);
  atomicJSON(join(deployment.artifacts, 'active-compose.json'), { schemaVersion: 1, project, path: generated.path, appliedAt: new Date().toISOString() });
  return { ...generated, project, status: 'ready' };
}
