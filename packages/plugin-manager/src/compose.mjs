import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { runtimeEnvironment } from './config.mjs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { atomicJSON, canonical, fail, within } from './state.mjs';
import { resolvePluginSettings } from './plugin-settings.mjs';
import { assertReleaseMode } from './release.mjs';
import { containerCredentialsPath, prepareFrameworkCredentials } from './framework-credentials.mjs';
import { writePrivateFile } from './private-files.mjs';
/** Produce private Compose overrides with runtime-only configuration mounts. */
export function renderCompose(deployment, release, outputDirectory) {
  assertReleaseMode(release, deployment.mode);
  prepareFrameworkCredentials(deployment, { uid: deployment.config.containerUid ?? 1000, gid: deployment.config.containerGid ?? 1000 });
  mkdirSync(outputDirectory, { recursive: true });
  const settings = resolvePluginSettings(deployment, release);
  const runtime = runtimeEnvironment(deployment, settings.release.plugins);
  const configPath = join(outputDirectory, 'container-deployment.json');
  const mounts = [{ type: 'bind', source: deployment.dataRoot, target: '/data' },
    { type: 'bind', source: dirname(release.path), target: '/opt/plugin-packages', read_only: true }];
  const containerHome = within(deployment.dataRoot, deployment.home) ? `/data/${relative(deployment.dataRoot, deployment.home).split(sep).join('/')}` : '/dsh-home';
  const containerWorkspace = within(deployment.dataRoot, deployment.workspace) ? `/data/${relative(deployment.dataRoot, deployment.workspace).split(sep).join('/')}` : '/dsh-workspace';
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
  atomicJSON(configPath, { profile: deployment.profile, port: deployment.config.port ?? 7902, plugins: release.plugins.map(plugin => plugin.id), home: containerHome, workspace: containerWorkspace, authUrlFile: containerAuth, authUrlDirectWrite: directAuth, dataRoot: '/data', instances, patches, offline: deployment.offline, storeDir: '/data/plugin-store', cacheDir: '/data/plugin-cache', ...offlineSources,
    ...(deployment.config.siteOperation ? { siteOperation: deployment.config.siteOperation } : {}),
    ...(deployment.config.siteRecovery ? { siteRecovery: deployment.config.siteRecovery } : {}),
    ...(deployment.config.publicUrl ? { publicUrl: deployment.config.publicUrl } : {}), ...(deployment.config.publicOrigin ? { publicOrigin: deployment.config.publicOrigin } : {}), ...(deployment.config.trustedHosts ? { trustedHosts: deployment.config.trustedHosts } : {}), ...(frameworkCredentials ? { frameworkCredentials } : {}) });
  mounts.push({ type: 'bind', source: configPath, target: '/run/dsh-deployment.json', read_only: true });
  const override = { services: { dsh: { environment: { DSH_HOME: containerHome, DSH_WORKSPACE: containerWorkspace, DSH_AUTH_URL_FILE: containerAuth, DSH_PROFILE: deployment.profile, DEPLOYMENT_CONFIG: '/run/dsh-deployment.json', PLUGIN_MANIFEST_FILE: '/opt/plugin-packages/manifest.json' }, volumes: mounts } } };
  override.services.dsh.healthcheck = { test: ['CMD', 'node', '/opt/plugin-manager/node_modules/@dsh-plugin-manager/plugin-manager/dist/cli.mjs', 'health', '--root', '/opt/plugin-project', '--config', '/run/dsh-deployment.json'], interval: '10s', timeout: '30s', retries: 3, start_period: '120s' };
  const path = join(outputDirectory, 'compose.override.json'); atomicJSON(path, override);
  return { path, configPath };
}
