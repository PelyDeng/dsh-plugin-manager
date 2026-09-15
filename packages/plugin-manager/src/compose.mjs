import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { runtimeEnvironment } from './config.mjs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { atomicJSON, canonical, fail, within } from './state.mjs';
import { resolvePluginSettings } from './plugin-settings.mjs';
import { assertReleaseMode } from './release.mjs';
import { containerCredentialsPath, prepareFrameworkCredentials } from './framework-credentials.mjs';
import { writePrivateFile } from './private-files.mjs';
import { resolveSiteIdentity } from './site-binding.mjs';
/**
 * 持久目录在容器内的路径（设计 4.2、5.1）：dataRoot 挂到 /data，落在其内的 home/workspace 保持
 * 相对路径；不在 dataRoot 内的保持自身路径推导。渲染挂载与运行记录核对共用这一份，避免两处漂移。
 */
export function containerPaths(deployment) {
  const inside = location => within(deployment.dataRoot, location) ? `/data/${relative(deployment.dataRoot, location).split(sep).join('/')}` : undefined;
  return { home: inside(deployment.home) ?? '/dsh-home', workspace: inside(deployment.workspace) ?? '/dsh-workspace' };
}

/** Produce private Compose overrides with runtime-only configuration mounts. */
export function renderCompose(deployment, release, outputDirectory) {
  assertReleaseMode(release, deployment.mode);
  prepareFrameworkCredentials(deployment, { uid: deployment.config.containerUid ?? 1000, gid: deployment.config.containerGid ?? 1000 });
  mkdirSync(outputDirectory, { recursive: true });
  const settings = resolvePluginSettings(deployment, release);
  const runtime = runtimeEnvironment(deployment, settings.release.plugins);
  const configPath = join(outputDirectory, 'container-deployment.json');
  // 归档挂载指向追加式缓存根：本次清单由 site 流程生成的 manifest-<随机>.json 指向，旧的
  // file: 引用仍可达，普通部署不清理缓存。
  const packageRoot = deployment.config.pluginCacheRoot ?? dirname(release.path);
  const packageManifest = deployment.config.pluginCacheManifest ?? 'manifest.json';
  const mounts = [{ type: 'bind', source: deployment.dataRoot, target: '/data' },
    { type: 'bind', source: packageRoot, target: '/opt/plugin-packages', read_only: true }];
  const { home: containerHome, workspace: containerWorkspace } = containerPaths(deployment);
  if (!within(deployment.dataRoot, deployment.home)) mounts.push({ type: 'bind', source: deployment.home, target: containerHome });
  if (!within(deployment.dataRoot, deployment.workspace)) mounts.push({ type: 'bind', source: deployment.workspace, target: containerWorkspace });
  const directAuth = !within(deployment.dataRoot, deployment.authUrlFile);
  const containerAuth = directAuth ? '/run/dsh-auth-url.txt' : `/data/${relative(deployment.dataRoot, deployment.authUrlFile).split(sep).join('/')}`;
  if (directAuth) {
    mkdirSync(dirname(deployment.authUrlFile), { recursive: true });
    if (!existsSync(deployment.authUrlFile)) writePrivateFile(deployment.authUrlFile, '', { flag: 'wx' });
    if (process.platform !== 'win32') chmodSync(deployment.authUrlFile, 0o600);
    mounts.push({ type: 'bind', source: deployment.authUrlFile, target: containerAuth });
  }
  const patches = (deployment.config.patches ?? []).map((path, index) => {
    const source = canonical(resolve(deployment.root, path));
    if (!existsSync(source) || !statSync(source).isFile()) fail('用户 patch 不存在或不是普通文件。');
    const target = `/run/dsh-patches/${index}.yml`;
    mounts.push({ type: 'bind', source, target, read_only: true });
    return target;
  });
  const offlineSources = {};
  for (const [field, name] of [['offlineStore', 'store'], ['offlineCache', 'cache']]) if (deployment[field]) {
    const source = canonical(resolve(deployment.root, deployment[field]));
    if (!existsSync(source) || !statSync(source).isDirectory()) fail(`离线 ${name} 来源不存在。`);
    offlineSources[field] = `/opt/plugin-offline-${name}`;
    mounts.push({ type: 'bind', source, target: offlineSources[field], read_only: true });
  }
  const instances = {};
  let frameworkCredentials;
  if (deployment.config.frameworkCredentials) {
    const source = canonical(resolve(deployment.root, deployment.config.frameworkCredentials.file));
    const target = containerCredentialsPath;
    mounts.push({ type: 'bind', source, target, read_only: true });
    frameworkCredentials = { file: target, sha256: deployment.config.frameworkCredentials.sha256 };
  }
  for (const plugin of release.plugins) {
    instances[plugin.id] = { configRevision: runtime.configurations[plugin.id]?.configRevision ?? 0 };
    const settingsFile = settings.files[plugin.id];
    if (settingsFile && existsSync(settingsFile)) {
      const target = `/run/dsh-plugin-settings/${plugin.id}.json`;
      mounts.push({ type: 'bind', source: settingsFile, target, read_only: true });
      instances[plugin.id].settingsFile = target;
    }
    const variable = plugin.runtimeConfig?.variable;
    if (variable && runtime.variables[variable]) {
      const target = `/run/dsh-plugin-config/${plugin.id}/env.conf`;
      mounts.push({ type: 'bind', source: runtime.variables[variable], target, read_only: true });
      instances[plugin.id].runtimeConfig = target;
    }
  }
  // 容器内的站点身份只能来自本次部署配置：容器看不到宿主的 .local/site-binding.json，
  // 而 schema 3 授权集合要求 siteId/profile 齐备（设计 2.6）。候选配置已带 siteId，这里逐字传入；
  // 与绑定不一致时 resolveSiteIdentity 直接失败，不生成一份自相矛盾的容器配置。
  const siteId = resolveSiteIdentity(deployment.root, deployment.config?.siteId);
  atomicJSON(configPath, { ...(siteId ? { siteId } : {}), profile: deployment.profile, port: deployment.config.port ?? 7902, plugins: release.plugins.map(plugin => plugin.id), home: containerHome, workspace: containerWorkspace, authUrlFile: containerAuth, authUrlDirectWrite: directAuth, dataRoot: '/data', instances, patches, offline: deployment.offline, storeDir: '/data/plugin-store', cacheDir: '/data/plugin-cache', ...offlineSources,
    ...(deployment.config.publicUrl ? { publicUrl: deployment.config.publicUrl } : {}), ...(deployment.config.publicOrigin ? { publicOrigin: deployment.config.publicOrigin } : {}), ...(deployment.config.trustedHosts ? { trustedHosts: deployment.config.trustedHosts } : {}), ...(frameworkCredentials ? { frameworkCredentials } : {}) });
  mounts.push({ type: 'bind', source: configPath, target: '/run/dsh-deployment.json', read_only: true });
  const override = { services: { dsh: { environment: { DSH_HOME: containerHome, DSH_WORKSPACE: containerWorkspace, DSH_AUTH_URL_FILE: containerAuth, DSH_PROFILE: deployment.profile, DEPLOYMENT_CONFIG: '/run/dsh-deployment.json', PLUGIN_MANIFEST_FILE: `/opt/plugin-packages/${packageManifest}` }, volumes: mounts } } };
  override.services.dsh.healthcheck = { test: ['CMD', 'node', '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs', 'health', '--root', '/opt/plugin-project', '--config', '/run/dsh-deployment.json'], interval: '10s', timeout: '30s', retries: 3, start_period: '120s' };
  const path = join(outputDirectory, 'compose.override.json'); atomicJSON(path, override);
  return { path, configPath };
}
